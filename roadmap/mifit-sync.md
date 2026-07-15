# Plan: Auto-importación de rutas desde Mi Fit / Zepp

> **Estado:** Fases 1-3 implementadas (`core/mifit/`, `mifit_sync.py`, `api/mifit.py`,
> UI en `base.html`, servicio `mifit-sync` en docker-compose, `pydantic` en
> requirements, tests en `tests/test_mifit.py`). Funcional con **token pegado a mano**.
> Fase 4 (servicio `mifit-auth` con Firefox/noVNC para "Conectar con un clic")
> **pendiente**.
>
> **Robustez añadida tras validar en real:** (1) la marca incremental se persiste
> cada 10 rutas durante un backfill (no solo al terminar); (2) botón "Reimportar
> desde la fecha" (`POST /api/mifit/sync {reset:true}`) que reinicia la marca desde
> la UI. Además: fecha/hora de última sync visible en Ajustes y fix del `input[type=date]`
> en tema oscuro (`color-scheme:dark`).


Integrar la herramienta de `roadmap/mifit exporter` en Sendero para descargar
automáticamente los entrenamientos del reloj (Amazfit/Zepp/Mi Fit) como GPX,
importándolos por el mismo pipeline que el resto de rutas.

Objetivos que pidió el usuario:
1. Obtener las credenciales del usuario desde **Ajustes** de Sendero.
2. Programar desde Ajustes **cada cuánto** se sincroniza.
3. Un **botón** para sincronizar manualmente.

Decisiones tomadas:
- **Ejecución en un servicio aparte** (patrón `watcher`), no en los workers de gunicorn.
- **Autenticación** mediante un servicio-navegador (Firefox headed) que se **consume
  desde la propia app de Sendero** vía noVNC, replicando el flujo Playwright de la
  herramienta pero usable en un despliegue Docker headless.

---

## 1. Panorama de la herramienta (lo que reutilizamos)

`roadmap/mifit exporter/` — exporter de entrenamientos de Huami (Mi Fit/Zepp).

- **Auth (`src/auth.py`)**: NO usa usuario/contraseña. Usa un `apptoken` de Huami.
  Lo obtiene lanzando **Firefox headed con Playwright** contra la página GDPR de
  Huami (`https://user.huami.com/privacy2/index.html`), donde el usuario inicia
  sesión; luego lee la cookie `apptoken`. También acepta el token pegado a mano.
- **API (`src/api.py`)**: `Api(endpoint, token)` con dos llamadas:
  `/v1/sport/run/history.json` (paginado por `trackid`) y
  `/v1/sport/run/detail.json`. Lanza `TokenExpiredError` en 401/403.
- **Parseo + GPX (`src/exporters/base_exporter.py`, `gpx_exporter.py`)**:
  `parse_points(summary, detail)` decodifica lat/lon/alt/hr/cadencia; `GpxExporter`
  escribe un GPX 1.1 con `<time>`, `<ele>` y `<ns3:hr>` por punto. El nombre del
  track queda como `"DD-MM-YYYY hiking"` (o `cycling`/`walking`/`running`/`skiing`).
- **Scraper (`src/scraper.py`)**: recorre el historial, baja el detalle de cada
  workout y lo exporta. Filtra por rango de fechas usando `trackid` (= timestamp
  de inicio en segundos).

### Qué vendorizamos y qué NO

Solo el camino GPX-por-token. **No** copiamos el exporter geopandas ni el auth por
Playwright dentro de la imagen principal de Sendero:

| Archivo origen | Destino | Dependencia nueva |
|---|---|---|
| `src/api.py` | `core/mifit/api.py` | `pydantic` |
| `src/exporters/base_exporter.py` | `core/mifit/points.py` | `pydantic` |
| `src/exporters/gpx_exporter.py` | `core/mifit/gpx.py` | — |
| `src/scraper.py` | (reescrito en `core/mifit/sync.py`) | — |
| `device_names.json`, `workout_types.json` | `core/mifit/` | — |

- **Única dependencia nueva en `requirements.txt`: `pydantic`.** Se evitan
  `geopandas`/GDAL (exporter no usado) y `playwright`/`furl` (auth, que vive en su
  propio servicio, ver §3).
- Ajustar imports (`from src...` → `from core.mifit...`) y quitar el `# type: ignore`
  si molesta a nadie (no hay type-checker en CI).

### Mapeo de actividad — resuelto sin código extra

El GPX generado nombra el track `"DD-MM-YYYY hiking"` etc. Esas palabras inglesas
(`hiking`, `cycling`, `walking`, `running`, `skiing`) **ya están en las keywords de
`_detect_activity()`** (`core/parsers.py`), así que Sendero asigna la actividad
española correcta (senderismo/bicicleta/caminata/correr/esqui) al importar, sin
adaptador. Los tipos indoor (cinta, remo, bádminton) no traen puntos GPS y
`parse_points()` los descarta solos. **No hay que tocar el mapeo.**

---

## 2. Arquitectura: tres servicios

```
docker-compose:
  sendero      (ya existe)  — Flask/gunicorn. UI de Ajustes, endpoints de estado y
                              disparo manual. Escribe/lee settings en la BD.
  mifit-sync   (NUEVO)      — Bucle tipo watcher. Lee intervalo y token de settings,
                              descarga workouts nuevos y los POSTea a /api/routes.
                              Escribe estado (última sync, resultado) en settings.
  mifit-auth   (NUEVO,      — Servicio-navegador: Firefox headed + noVNC + Playwright.
                on-demand)    Captura el apptoken (silencioso si hay sesión; interactivo
                              vía noVNC si no). Devuelve el token a Sendero.
```

Flujo de datos (sin acoplar procesos por RPC directo; el estado va por la BD):

```
[UI Ajustes] --POST /api/mifit/sync--> settings.MIFIT_SYNC_REQUESTED = <ts>
[mifit-sync] bucle 30s: lee settings; si REQUESTED o toca por intervalo -> sync()
             sync(): Api(token).history -> detail -> GPX -> POST /api/routes (201/409/err)
             escribe MIFIT_LAST_SYNC / MIFIT_LAST_RESULT / MIFIT_STATUS
[UI Ajustes] GET /api/mifit/status (polling) -> pinta estado

[UI Ajustes] "Conectar" -> POST /api/mifit/auth/start -> mifit-auth lanza Firefox
             UI embebe noVNC (iframe) -> usuario hace login en Huami
             mifit-auth captura apptoken -> lo guarda en settings.MIFIT_TOKEN
             UI GET /api/mifit/auth/status (polling) -> "Conectado ✓"
```

Por qué la BD como bus: es lo que ya usa el proyecto para propagar ajustes entre
procesos (`refresh_config()` en `before_request` existe justo por eso). Nada de
sockets ni colas nuevas.

---

## 3. Autenticación: servicio `mifit-auth` (el "Docker de Firefox")

Replica el `get_app_token()` de la herramienta pero **consumible desde Sendero**:
Firefox corre dentro de un contenedor con display virtual y se ve/opera desde el
navegador del usuario vía **noVNC**. Playwright pilota ese mismo Firefox, así que
puede **leer la cookie `apptoken`** igual que hoy (`page.context.cookies()`).

### Composición del contenedor
- Base: `python:3.12-slim` + `xvfb` + `x11vnc` + `websockify`/noVNC + Firefox.
  (Alternativa: partir de una imagen tipo `linuxserver/firefox`/KasmVNC y añadir
  Python+Playwright; a evaluar. Recomendado construir a medida para controlar
  versiones de Playwright/Firefox.)
- Playwright con Firefox (`install-playwright` como en la herramienta).
- Un micro-servidor HTTP (Flask/FastAPI) dentro del contenedor con:
  - `POST /start` → lanza Firefox headed en el `:99` de Xvfb apuntando a la URL GDPR.
    Primero intenta **refresh silencioso** (perfil persistido, §3.2); si ya hay
    sesión, captura el token sin intervención y responde `{status: "connected"}`.
    Si no, deja Firefox abierto y responde `{status: "awaiting_login"}`.
  - `GET /status` → `awaiting_login | connected | error`, y el token si `connected`.
  - noVNC servido en `/vnc.html` (websockify → x11vnc → display :99).

### 3.1 Integración con Sendero
- Sendero **no proxy-ea** noVNC (websockets sobre gunicorn es engorroso). Se publica
  el puerto noVNC (p.ej. `6080`) y la sección Ajustes lo embebe en un `<iframe>`
  `http://<host>:6080/vnc.html?autoconnect=1&resize=scale`. LAN, sin auth — coherente
  con "sin autenticación, intencional para LAN" del proyecto. (Nota de reverse-proxy
  opcional en §11.)
- Endpoints en Sendero (`api/mifit.py`, ver §5) que hablan con `mifit-auth` por HTTP
  interno (`http://mifit-auth:PORT`) y, al recibir `connected`, guardan el token en
  `settings.MIFIT_TOKEN` + `MIFIT_STATUS=ok`.

### 3.2 Sesión persistente → login casi nunca
- Volumen para el **perfil de Firefox** (`./data/mifit-profile:/profile` o dentro de
  `/data`). Playwright usa `launch_persistent_context(user_data_dir=/profile)`.
- Tras el primer login interactivo, la sesión de Huami sobrevive en el perfil. En
  renovaciones posteriores, `mifit-auth` reabre la página GDPR y **captura el token
  sin que el usuario haga nada** (refresh silencioso). Solo cuando esa sesión expira
  se necesita el flujo noVNC otra vez.
- El servicio `mifit-auth` puede estar **parado la mayor parte del tiempo** (auth es
  ocasional). Opciones: `restart: "no"` y arrancarlo bajo demanda, o dejarlo idle
  (Firefox no corre hasta un `/start`). Recomiendo dejarlo levantado pero ocioso
  (coste bajo si Firefox no está lanzado).

### 3.3 Caducidad del token durante la sync
- `core/mifit/sync.py` captura `TokenExpiredError`. Al ocurrir:
  1. `mifit-sync` intenta un **refresh silencioso** llamando a `mifit-auth /start`.
  2. Si vuelve `connected`, reintenta la sync con el token nuevo (como hace
     `main.py` de la herramienta: re-autenticar y `run_scraper` otra vez).
  3. Si vuelve `awaiting_login`, escribe `MIFIT_STATUS=needs_login` y para; la UI
     muestra "Reconecta tu cuenta" con el botón que abre el noVNC.

---

## 4. Modelo de datos (settings)

Nuevas claves en la tabla `settings` (clave-valor, mismo patrón que Immich/DEM).
Añadir las **editables** a `cfg._SETTINGS_KEYS` y a `refresh_config()`; las de
**estado** las escribe solo `mifit-sync` (no en `_SETTINGS_KEYS`, no editables por UI).

Editables (Ajustes):
| Clave | Def. | Notas |
|---|---|---|
| `MIFIT_ENABLED` | `0` | 0/1. Si 0, `mifit-sync` no hace nada. |
| `MIFIT_TOKEN` | `""` | apptoken. Lo escribe `mifit-auth`; editable/pegable a mano como fallback. Sensible (§11). |
| `MIFIT_ENDPOINT` | `https://api-mifit.huami.com` | Región (`api-mifit-de.huami.com`, etc.). |
| `MIFIT_INTERVAL_MIN` | `360` | Minutos entre syncs. `0` = solo manual. |

Estado (solo lectura desde UI, escritas por `mifit-sync`):
| Clave | Notas |
|---|---|
| `MIFIT_SYNC_REQUESTED` | timestamp puesto por el botón manual; `mifit-sync` lo consume y lo limpia. |
| `MIFIT_LAST_SYNC` | ISO 8601 de la última sync completada. |
| `MIFIT_LAST_TRACKID` | mayor `trackid` ya importado (marca incremental). |
| `MIFIT_LAST_RESULT` | JSON `{nuevas, duplicadas, errores, mensaje}`. |
| `MIFIT_STATUS` | `ok \| running \| no_token \| token_expired \| needs_login \| error`. |

No hace falta columna nueva en `routes`: la deduplicación se apoya en el nombre de
archivo GPX (ver §6), que ya devuelve 409 en `create_route`. → **No hay migración de
esquema, ni índices de cobertura nuevos** (reglas 12/13 no aplican aquí).

Nota: no hay que tocar la clave de caché `ROUTE_CACHE` del frontend porque no
cambian los campos de `/api/routes`.

---

## 5. Backend en Sendero: `api/mifit.py` (nuevo blueprint)

Registrar `mifit_bp` en `app.py` junto al resto. Endpoints:

| Método | URL | Función |
|---|---|---|
| GET | `/api/mifit/settings` | Devuelve config (token **enmascarado**: `has_token`+últimos 4) + intervalo + endpoint + enabled. |
| POST | `/api/mifit/settings` | Guarda `MIFIT_ENABLED/ENDPOINT/INTERVAL_MIN` (y token si se pega a mano). `refresh_config()`. |
| POST | `/api/mifit/sync` | Pone `MIFIT_SYNC_REQUESTED=now`. Responde 202 "encolado". |
| GET | `/api/mifit/status` | Devuelve `MIFIT_STATUS`, `MIFIT_LAST_SYNC`, `MIFIT_LAST_RESULT`. |
| POST | `/api/mifit/auth/start` | Llama a `mifit-auth /start`. Responde `awaiting_login`/`connected`, y la URL de noVNC para el iframe. |
| GET | `/api/mifit/auth/status` | Sondea `mifit-auth /status`; si `connected`, guarda `MIFIT_TOKEN` en settings y responde ok. |

`/api/mifit/sync` **no** hace el trabajo pesado (respeta gunicorn): solo encola. El
runner es `mifit-sync`.

---

## 6. Servicio `mifit-sync.py` (nuevo, raíz del repo)

Mismo espíritu que `watch.py`: proceso independiente, un solo importador.

```
bucle cada MIFIT_POLL (def. 30s):
  lee settings (conexión sqlite directa a DB_PATH, como refresh_config)
  si not MIFIT_ENABLED: continue
  due = MIFIT_SYNC_REQUESTED presente
        or (MIFIT_INTERVAL_MIN>0 and now-MIFIT_LAST_SYNC >= intervalo)
  si not due: continue
  MIFIT_STATUS = running; limpia MIFIT_SYNC_REQUESTED
  sync()
```

`sync()`:
1. `token = MIFIT_TOKEN`. Si vacío → `MIFIT_STATUS=no_token`, return.
2. `Api(MIFIT_ENDPOINT, token)`; recorre `history.json` paginado.
3. Para cada summary con `trackid > MIFIT_LAST_TRACKID`: baja `detail.json`,
   `parse_points()`; si no hay puntos, se salta (indoor).
4. Genera el GPX en memoria (adaptar `GpxExporter` para devolver `str`/`bytes` en
   vez de escribir a fichero). Nombre `Workout--YYYY-MM-DD--HH-MM-SS.gpx` (del
   `trackid`) → **deduplicación gratis**: si ya existe, `create_route` responde 409.
5. `POST http://sendero:8080/api/routes` con `files={"gpx": (nombre, bytes, ...)}`.
   Interpreta 201 (nueva) / 409 (duplicada) / otro (error) — **misma lógica que
   `watch.py::process`**.
6. Actualiza `MIFIT_LAST_TRACKID` (máx procesado), `MIFIT_LAST_SYNC`,
   `MIFIT_LAST_RESULT`, `MIFIT_STATUS=ok`.
7. `TokenExpiredError` → intenta refresh silencioso vía `mifit-auth` (§3.3);
   éxito → reintenta; fallo → `needs_login`.

Variables de entorno del servicio: `SENDERO_API` (=`http://sendero:8080`),
`SENDERO_DATA` (para leer la BD), `MIFIT_POLL`, `MIFIT_AUTH_URL` (=`http://mifit-auth:PORT`).

Nota: el POST reutiliza `create_route`, que **genera el thumbnail y detecta la
actividad**. Nada que reimplementar.

---

## 7. UI: sección "Mi Fit / Zepp" en Ajustes (`app.html` / plantilla de Ajustes)

En español, sin build step, JS inline (regla 1 y 8). Nueva tarjeta en Ajustes:

- **Estado de conexión**: badge desde `GET /api/mifit/status` +
  `/api/mifit/settings` (`Conectado ✓` / `Sin token` / `Token caducado, reconecta` /
  `Sincronizando…`). Muestra `MIFIT_LAST_SYNC` y `MIFIT_LAST_RESULT` legible
  ("3 nuevas, 12 duplicadas").
- **Botón "Conectar / renovar cuenta"**: `POST /api/mifit/auth/start`. Si
  `awaiting_login`, abre un modal con el `<iframe>` de noVNC; hace polling a
  `/api/mifit/auth/status` hasta `connected` y cierra el modal con "Conectado ✓".
- **Endpoint/región** (select o input) → `MIFIT_ENDPOINT`.
- **Intervalo de sincronización**: input de minutos o presets (Manual / 1h / 6h /
  24h) → `MIFIT_INTERVAL_MIN`. Guardar → `POST /api/mifit/settings`.
- **Activar sincronización automática**: toggle → `MIFIT_ENABLED`.
- **Botón "Sincronizar ahora"**: `POST /api/mifit/sync`; deshabilita y hace polling
  de estado hasta que `MIFIT_STATUS` vuelve a `ok`, mostrando el resultado con el
  toast/`showToast` existente.

Sin token pegado a mano visible por defecto (usar el flujo Conectar); dejar un
"avanzado: pegar token" plegado como fallback.

---

## 8. docker-compose

```yaml
  mifit-sync:
    build: .
    container_name: sendero-mifit-sync
    command: ["python", "mifit_sync.py"]
    volumes:
      - ./data:/data          # lee la BD (settings, MIFIT_LAST_TRACKID)
    environment:
      - SENDERO_API=http://sendero:8080
      - SENDERO_DATA=/data
      - MIFIT_POLL=30
      - MIFIT_AUTH_URL=http://mifit-auth:7900
    depends_on: [sendero]
    restart: unless-stopped

  mifit-auth:
    build: ./mifit-auth        # Dockerfile propio (Xvfb+x11vnc+noVNC+Playwright+Firefox)
    container_name: sendero-mifit-auth
    ports:
      - "6080:6080"            # noVNC (iframe en Ajustes)
    volumes:
      - ./data/mifit-profile:/profile   # perfil Firefox persistente (sesión Huami)
    restart: unless-stopped
```

- El `Dockerfile` principal necesita copiar `mifit_sync.py` (añadir a la línea
  `COPY app.py watch.py ./`).
- `mifit-auth` es una imagen aparte (pesada por Firefox/Playwright); por eso vive en
  su propio directorio y NO contamina la imagen de Sendero.
- Documentar en README que ambos servicios son **opcionales** (como el watcher/DEM):
  quien no use Mi Fit los borra.

---

## 9. Seguridad y notas

- **Token sensible**: `GET /api/mifit/settings` no debe devolver el token completo
  (enmascarar). Precedente flojo: hoy `GET /api/settings` sí devuelve
  `IMMICH_API_KEY` en claro — aprovechar para no repetir el patrón aquí.
- **noVNC sin auth** en LAN: coherente con el modelo del proyecto (sin auth
  intencional). Si se expone fuera de LAN (Tailscale/VPN), documentar que el puerto
  6080 queda accesible mientras dure la conexión; opción de proteger con contraseña
  de VNC (`x11vnc -passwd`).
- **Perfil de Firefox** guarda cookies de sesión de Huami → tratarlo como dato
  sensible dentro de `/data` (regla 7: persistencia solo en `/data`).
- **Región/endpoint**: cuentas europeas suelen usar `api-mifit-de.huami.com`; por eso
  el endpoint es configurable.
- **`refresh_config()`**: añadir las claves `MIFIT_*` editables al bloque de
  `refresh_config()` para que ambos workers las vean consistentes (mismo motivo que
  el bug ya corregido de "ajustes obsoletos en el otro worker").

---

## 10. Fases de implementación (entregables incrementales)

1. **Vendorizar** `core/mifit/` (api, points, gpx, jsons) + `pydantic` en
   requirements. Test unitario: dado un `detail.json` de muestra, `parse_points` +
   generar GPX → GPX válido con `<time>`/`<hr>` (sin red, con fixture). Encaja con
   `tests/` (funciones puras, sin BD/Flask).
2. **`mifit_sync.py`** (bucle + `sync()` con dedup por nombre) + claves de settings +
   `refresh_config()`. Probable primer test end-to-end con un token real.
3. **`api/mifit.py`** (settings/status/sync) + registro del blueprint + UI de Ajustes
   con intervalo, toggle y botón "Sincronizar ahora" (sin auth por navegador todavía:
   token pegado a mano). **Ya cumple los 3 requisitos del usuario** de forma mínima.
4. **`mifit-auth`** (servicio Firefox/noVNC/Playwright) + endpoints `auth/start` /
   `auth/status` + modal noVNC en Ajustes + refresh silencioso + manejo de
   `token_expired`/`needs_login`. Esto es lo que convierte el "pegar token" en
   "Conectar con un clic".
5. **docker-compose** + README (servicios opcionales) + smoke test completo.

Fase 3 ya es funcional (auto-sync + botón manual con token pegado). La fase 4 es la
que pediste específicamente (auth tipo Playwright consumible desde la app) y puede
ir después sin bloquear el resto.

---

## 11. Smoke test

1. `docker compose up -d --build` (sendero + mifit-sync + mifit-auth).
2. Ajustes → Mi Fit → "Conectar" → login en el iframe noVNC → "Conectado ✓"
   (token en `settings.MIFIT_TOKEN`).
3. Poner intervalo = Manual, pulsar "Sincronizar ahora" → estado `running` → `ok`,
   resultado "N nuevas".
4. `GET /api/routes` → las rutas nuevas aparecen con actividad correcta
   (hiking→senderismo, etc.), con thumbnail (`thumb_file`), FC si el reloj la trae.
5. Pulsar "Sincronizar ahora" otra vez → resultado "0 nuevas, N duplicadas"
   (dedup por nombre de GPX funciona).
6. Poner intervalo = 1h y `MIFIT_ENABLED=1`; comprobar en logs de `mifit-sync` que
   dispara sola pasado el intervalo.
7. Forzar token inválido → `MIFIT_STATUS=token_expired`/`needs_login`, la UI ofrece
   "Reconectar" y el refresh silencioso/interactivo lo recupera.

## 12. Riesgos / dudas abiertas
- Región del endpoint por cuenta (configurable, mitigado).
- Estabilidad del login de Huami en Playwright/Firefox headed (captcha/2FA/Xiaomi
  account) — el humano lo resuelve en noVNC, pero la automatización de "esperar a que
  aparezca la cookie" hay que validarla contra el login real actual.
- Peso de la imagen `mifit-auth` (Firefox+Playwright ~ cientos de MB). Aceptable por
  ser servicio opcional y ocioso.
- `to_xml()`/nombre del track: verificar que `_detect_activity` acierta con el idioma
  del nombre generado (validado en teoría en §1; confirmar con datos reales).
