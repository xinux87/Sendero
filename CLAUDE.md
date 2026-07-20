# CLAUDE.md

Contexto para trabajar en **Sendero** (bitácora autoalojada de rutas de montaña).
El README explica *qué hace* y cómo desplegarlo; este archivo cubre lo que necesitas
para tocar el código sin romperlo. Si algo de aquí contradice al README, este manda.

## Qué es, en una frase
Monolito Flask + SQLite que sube/visualiza GPX y FIT, les asocia fotos (locales o de
Immich por referencia), genera thumbnails PNG de cada track y guarda un resumen por ruta.

## Comandos
```bash
# desarrollo
pip install -r requirements-dev.txt   # incluye requirements.txt + pytest
python app.py                      # http://localhost:8080, init_db() automático
python -m pytest                   # tests unitarios (tests/): editing, parsers, FIT, gps_analysis

# producción / como se despliega de verdad
docker compose up -d --build       # servicio 'sendero' + servicio 'watcher'
# Puerto en docker-compose.yml: "8090:8080" en esta instalación.

# Smoke test rápido tras un cambio:
#   1) arranca el server
#   2) sube un GPX:  curl -F "gpx=@ruta.gpx" localhost:8090/api/routes
#   3) GET /api/routes  →  comprueba stats, geojson y thumb_file
#   4) GET /api/routes/1/thumb  →  debe devolver imagen PNG
# La lógica de Immich se prueba con unittest.mock parcheando requests.
```

## Publicar una versión
`APP_VERSION` en `core/config.py` es la única fuente de verdad. Al publicar `X.Y.Z`,
todos estos deben coincidir con ese número (si no, quedan desincronizados):
1. `APP_VERSION` en `core/config.py`.
2. Entrada nueva en `CHANGELOG.md` (`## [X.Y.Z] — AAAA-MM-DD`, pasando lo de "Sin publicar").
3. El default de `SENDERO_VERSION` en los compose (`${SENDERO_VERSION:-X.Y.Z}` en
   `docker-compose.prod.yml` y `.un.yml`) y en **`.env.example`**. El tag real de
   despliegue lo fija `.env` (`SENDERO_VERSION=`), que no se versiona.
4. Tag de git `vX.Y.Z` y la imagen Docker `xinux87/sendero:X.Y.Z` (+ `:X.Y` y `:latest`)
   publicada en Docker Hub.

Los puntos 1-3 van en el commit de versión. Los puntos 4 (tag + imagen) son acciones
hacia fuera: tras hacer el commit de versión, **devuelve siempre estos comandos** para
que el usuario los ejecute (build+push de Docker y tag de git), sustituyendo `X.Y.Z`
por la versión y `X.Y` por la minor:
```bash
# (si hace falta) docker login
# 1) Build con los tres tags: patch, minor y latest
docker build -t xinux87/sendero:X.Y.Z -t xinux87/sendero:X.Y -t xinux87/sendero:latest .
# 2) Push de los tres tags
docker push xinux87/sendero:X.Y.Z
docker push xinux87/sendero:X.Y
docker push xinux87/sendero:latest
# 3) Tag de git y push
git tag vX.Y.Z
git push origin master --tags
```

Rutas host configurables por `.env` (`SENDERO_DATA_DIR` → `/data`, `SENDERO_WATCH_DIR`
→ `/watch`); los compose usan `${VAR:-default}`, así funcionan sin `.env`.

## Mapa del código

### Backend — blueprints, no monolito
`app.py` es el punto de entrada: registra blueprints y llama a `init_db()` + `refresh_config()`.
La lógica real está repartida en dos paquetes:

```
core/
  config.py     — paths (GPX_DIR, PHOTO_DIR, THUMB_DIR, VERSIONS_DIR, DB_PATH) y variables Immich
  database.py   — init_db(), close_db(), helper db() (conexión por request vía g.db)
  parsers.py    — analyse_gpx() y analyse_fit() → devuelven (stats, coords, elev, name, creator).
                  FIT con garmin-fit-sdk (SDK oficial); _fit_dt() normaliza datetimes a naive-UTC
                  como hacía fitparse — no devolver datetimes aware (rompe merge_gpx e Immich)
  thumbs.py     — generate_thumb(coords, gpx_file) → PNG 400px en data/thumbs/
  editing.py    — lógica pura del editor: extract_points(), apply_ops(), fit_to_gpx()
  summaries.py  — auto_summary() y auto_summary_planned()
  exif.py       — extrae lat/lon/taken_at de fotos subidas
  geocode.py    — reverse_geocode(lat,lon) → 'Localidad, Región' o None. Best-effort
                  (nunca rompe import/rescan, como thumbs/gps_issues). Endpoint
                  compatible Nominatim configurable (GEOCODE_URL, Ajustes → Editor;
                  vacío = desactivado). _format_locality() es pura (tests/test_geocode.py)
  immich.py     — cliente HTTP para Immich (immich_get, immich_search, min_dist_to_track)
  mifit/        — cliente Huami (Mi Fit/Zepp) vendorizado de roadmap/mifit exporter:
                  api.py (HTTP+modelos), points.py (decodifica el detalle crudo),
                  gpx.py (build_gpx/workout_filename), sync.py (iter_new_workouts).
                  Solo el camino GPX-por-token; añade únicamente 'pydantic' a deps.

api/
  routes.py     — CRUD de rutas + rescan + thumb + stats
  editor.py     — editor de rutas: página, /points, guardado por ops, versiones
  photos.py     — subida y borrado de fotos locales; proxy de fotos Immich
  planned.py    — CRUD de rutas planificadas
  immich_api.py — candidatos Immich, selección, proxy de miniaturas
  settings.py   — lectura/escritura de ajustes (Immich, tipos GPX personalizados)
  mifit.py      — ajustes/estado/disparo de la auto-importación Mi Fit/Zepp
```

`watch.py` — importador de carpeta. Proceso **independiente**, no parte del server.

`mifit_sync.py` — sincronizador Mi Fit/Zepp. Proceso **independiente** (servicio
`mifit-sync` en docker-compose), como el watcher: cada `MIFIT_POLL` s lee settings
y, si toca (por intervalo o por el flag manual `MIFIT_SYNC_REQUESTED`), descarga los
entrenamientos nuevos con `core.mifit` y los sube a `/api/routes` (201/409/err, misma
semántica que watch.py). Escribe el estado en settings para que la UI lo lea. NO es
un hilo de gunicorn (evita duplicar el importador con 2 workers).

`tests/` — pytest sin BD ni Flask (funciones puras): `conftest.py` trae un constructor
de GPX sintéticos (`make_gpx_xml`) y un FIT de muestra (`tests/fixtures/Activity.fit`).
Si tocas una op del editor o el aplanado, añade/ajusta el test correspondiente.

Rendimiento transversal: la BD corre en WAL (`init_db()`), las respuestas de texto van
con gzip/brotli (flask-compress en `app.py`, mínimo 500 bytes), y los binarios llevan
caché: thumbs con ETag/304 (revalidación: se regeneran con el mismo nombre), fotos
locales inmutables con max-age 1 año, proxys Immich con caché privada de 7 días.

### Frontend — SPA en `app.html`

**La app es un SPA** servido desde una sola plantilla `templates/app.html`.
Las rutas `/dashboard`, `/rutas` y `/planificacion` renderan todas `app.html`
con el parámetro Jinja `initial_section`. El router JS en `app.html` muestra/oculta
secciones y actualiza el `history` sin recargar la página.

> **TRAMPA CRÍTICA:** Si tocas "Mis Rutas" o "Dashboard", el archivo es `app.html`,
> NO `rutas.html` ni `dashboard.html`. Esos archivos legacy siguen en disco pero
> ya no los sirve ninguna ruta Flask.

| Archivo | Ruta Flask | Contenido |
|---------|-----------|-----------|
| `templates/base.html` | — | CSS global, header, toast, helpers JS (`$`, `fmtKm`, `fmtDur`, `fmtDate`, `esc`). Carga `static/shared.js` ANTES del script inline: ahí viven `ACTIVITIES`/`activityOf`/`iconSvg`/`genericIconSvg`/`_loadActImages` y `BASEMAP_TILES`/`buildStyle` — no los redeclares en una plantilla (dos `const` globales con el mismo nombre en scripts distintos = SyntaxError) |
| `templates/app.html` | `GET /dashboard` · `/rutas` · `/planificacion` | SPA con tres secciones: Dashboard, Mis Rutas, Mis Planes. Usa MapLibre GL para el mapa de visión general. |
| `templates/sendero.html` | `GET /Sendero/<nombre>` | Detalle de ruta: mapa MapLibre GL, stats, perfil de elevación (Chart.js), notas, fotos, modal Immich, lightbox. Botón "✎ Editar" → editor. |
| `templates/editor.html` | `GET /Sendero/<nombre>/editor` | Editor de rutas (F1+F2): recorte/eliminación de tramos, invertir, editar vértices, simplificar, corregir picos, dividir, undo/redo, historial de versiones, zoom en gráficas. |
| `templates/plan_detalle.html` | `GET /Plan/<nombre>` | Detalle de ruta planificada: mapa, stats, notas, descarga GPX. |
| `templates/rutas.html` *(legacy)* | — | Ya no se sirve. No editar. |
| `templates/overview.html` *(legacy)* | — | Ya no se sirve. No editar. |
| `templates/planificacion.html` *(legacy)* | — | Ya no se sirve. No editar. |

### Navegación
- Tarjeta en "Mis Rutas" → `location.href = '/Sendero/' + encodeURIComponent(name)`
- Cambio de sección (Dashboard ↔ Mis Rutas ↔ Mis Planes) → SPA con `_showSec(name)`
- Botón "← Volver" en detalle → `location.href = '/rutas'`
- Renombrar ruta → `history.replaceState` (actualiza URL sin recargar)
- El botón Atrás del navegador funciona vía `window.addEventListener('popstate', ...)`

### Rutas Flask completas

| Método | URL | Handler |
|--------|-----|---------|
| GET | `/` | redirect → `/dashboard` |
| GET | `/dashboard` | `app.html` (sección dashboard) |
| GET | `/rutas` | `app.html` (sección rutas) |
| GET | `/planificacion` | `app.html` (sección planes) |
| GET | `/Sendero/<name>` | `sendero.html` con JSON inyectado |
| GET | `/Plan/<name>` | `plan_detalle.html` con JSON inyectado |
| GET | `/api/routes` | lista paginada (incluye `thumb_file`); sin `limit` devuelve todas (es barata, ~130 KB/500 rutas) |
| GET | `/api/routes/geojson` | FeatureCollection de líneas decimadas (props: id, name, activity, year, km). Acepta `?bbox=minLon,minLat,maxLon,maxLat`; sin él devuelve todas (no lo usa el dashboard salvo fallback) |
| POST | `/api/routes` | crea ruta desde GPX o FIT; genera thumb. Dedup (ver sección): 409 exacta (hash) o blanda (firma); `?auto=1` importa la blanda marcada (`dup_suspect_of`) en vez de bloquear; `?force=1` la importa limpia (el usuario ya la aceptó en la web) |
| GET | `/api/routes/<id>` | dict completo de la ruta |
| PATCH | `/api/routes/<id>` | actualiza name/notes/activity_type/immich_checked/device; `dup_suspect_of=null` descarta el aviso de posible duplicada |
| DELETE | `/api/routes/<id>` | borra ruta + fotos + GPX + thumb + versiones |
| POST | `/api/routes/<id>/rescan` | re-parsea GPX/FIT; regenera thumb |
| GET | `/api/routes/<id>/thumb` | sirve el PNG del track (image/png) |
| GET | `/api/routes/<id>/gpx` | descarga el archivo GPX/FIT original |
| GET | `/Sendero/<name>/editor` | `editor.html` con JSON ligero inyectado (sin geojson) |
| GET | `/api/routes/<id>/points` | puntos completos para el editor: arrays paralelos lonlat/ele/time/hr 1:1 con los trkpt + `segments` + `version` |
| POST | `/api/routes/<id>/edit` | guarda edición: `{base_version, summary, ops}`; 409 si base_version ≠ actual |
| POST | `/api/routes/<id>/split` | divide en el punto `index`: la original se recorta (versión nueva) y la 2ª mitad pasa a ruta nueva; las fotos se quedan en la original |
| POST | `/api/routes/merge` | `{ids, name}` → RUTA NUEVA con las rutas unidas (originales intactas); orden cronológico, tiempos descartados si se solapan (`times_kept` en la respuesta) |
| POST | `/api/routes/<id>/elevation-dem` | recalcula la elevación de todos los puntos contra el OpenTopoData de Ajustes (versión nueva); 400 sin `DEM_URL`, 409 por `base_version`, 502 si el DEM falla |
| GET | `/api/routes/<id>/versions` | historial de versiones (desc) |
| POST | `/api/routes/<id>/versions/<vn>/restore` | restaura la versión vn como versión nueva |
| GET | `/api/routes/<id>/versions/<vn>/gpx` | descarga el archivo de esa versión |
| GET/POST | `/api/routes/<id>/immich/candidates` | fotos Immich en ventana temporal |
| POST | `/api/routes/<id>/immich/select` | asocia fotos Immich a la ruta |
| POST | `/api/routes/<id>/photos` | sube fotos locales |
| GET | `/api/photos/<pid>/file` | sirve foto local o proxy Immich |
| DELETE | `/api/photos/<pid>` | borra foto |
| GET | `/api/stats` | estadísticas globales (desde caché en settings) |
| POST | `/api/stats/refresh` | recalcula y guarda caché de stats |
| GET | `/api/planned` | lista rutas planificadas |
| POST | `/api/planned` | crea ruta planificada desde GPX |
| GET | `/api/planned/<id>` | dict completo del plan |
| PATCH | `/api/planned/<id>` | actualiza nombre/notas/actividad del plan |
| DELETE | `/api/planned/<id>` | borra plan |
| GET | `/api/planned/<id>/gpx` | descarga GPX del plan |
| GET | `/api/config` | estado Immich (enabled, margin, dist) |
| GET | `/api/settings` | ajustes actuales |
| POST | `/api/settings` | guarda ajustes Immich |
| GET/POST | `/api/settings/gpx-types` | tipos GPX personalizados |
| GET/POST | `/api/settings/gps-thresholds` | umbrales GPS por actividad (vel. máx km/h, ascenso máx m/s, altitud máx m); GET devuelve los efectivos (custom con fallback a defaults) |
| GET | `/api/immich/thumb/<asset_id>` | proxy miniatura Immich |
| GET/POST | `/api/mifit/settings` | ajustes Mi Fit/Zepp (GET enmascara el token) |
| POST | `/api/mifit/sync` | encola sincronización manual (flag en settings); body `{reset:true}` reinicia la marca (reimportar desde fecha) |
| GET | `/api/mifit/status` | estado de la última sincronización Mi Fit/Zepp |

### Helper `_build_route_dict(rid)` en `api/routes.py`
Construye el dict completo de una ruta (geojson, elevation, heart_rate, speed, photos,
auto_summary, thumb_file, `version`…). Lo usan `get_route()` (API JSON) y
`sendero_page()` (inyección en template). **Si añades campos al objeto ruta,
añádelos aquí.** El campo `version` se deriva de `MAX(version_n)` en
`route_versions` (0 = nunca editada); no hay columna `version` en `routes` a propósito.

### Editor de rutas (`api/editor.py` + `core/editing.py` + `templates/editor.html`)
Fase 1: recortar inicio/fin, eliminar tramo intermedio, invertir ruta, con
versionado completo. Fase 2: dos modos de edición — "Seleccionar" (tramos A–B) y
"Editar puntos" (arrastrar vértice = `move_point`, Alt+click = `delete_points`,
click en línea = `insert_point`) — más simplificación Douglas-Peucker con preview
(compila a `delete_points`), corrección de picos de elevación (`set_ele`),
corrección de velocidad excesiva (saltos de GPS: puntos que exigirían superar el
umbral de la actividad — Ajustes → "GPS incorrecto", inyectado como
`gps_max_speed` en la página del editor — se eliminan vía `delete_points`) y
dividir ruta en dos (`POST /split`, server-side sobre el estado guardado).
Fase 3: `shift_time` (desplazar todos los timestamps; reactiva el cruce Immich),
waypoints (`wpt_add`/`wpt_move`/`wpt_rename`/`wpt_del`, sobre `gpx.waypoints`;
Shift+click en modo "Editar puntos" añade, popup del marker ⚑ renombra/borra),
unir rutas (`POST /api/routes/merge`, ruta NUEVA), elevación DEM
(`POST /elevation-dem`, requiere `DEM_URL` en Ajustes → Editor; servicio
OpenTopoData comentado en docker-compose.yml) e integración con `gps_issues`:
la página inyecta los avisos, el panel "⚠ Avisos GPS" los lista con bandas rojas
en las gráficas y tramos rojos en el mapa (solo sin cambios pendientes: los km
son del estado guardado), y "Corregir" hace zoom al tramo y abre la herramienta
según `type` (speed → velocidad excesiva con el umbral del aviso; elevation →
picos). El roadmap de la fase 4 está en `roadmap/editorplan.md`.

**Paridad cliente/servidor**: el cliente mantiene el estado con `idxMap`
(orden/supervivencia) + `posOverride`/`eleOverride` (valores editados por índice
original; los insertados se añaden al final de los arrays de `P`). Cliente y
servidor deben aplicar cada op EXACTAMENTE igual — si añades una op nueva,
impleméntala en `doOp()` (editor.html) y en `apply_ops()` (core/editing.py) y
verifica que la misma secuencia produce las mismas coordenadas en ambos.
`delete_points` (puntos sueltos) NO parte el segmento; `delete_range` sí.

**Principio central: el cliente manda OPERACIONES por índice de punto, nunca
coordenadas.** El servidor re-parsea el GPX con gpxpy, aplica las ops sobre los
`GPXTrackPoint` reales (conservan time/HR/extensiones que el parser no extrae) y
serializa con `to_xml()`. El aplanado punto[i] ↔ i-ésimo trkpt usa el mismo triple
bucle tracks→segments→points que `analyse_gpx()`: **si cambias ese orden de
iteración en un sitio, cámbialo en los dos** (`core/parsers.py` y `core/editing.py`).

**Versionado (append-only):**
- Archivos inmutables en `data/gpx/versions/<route_id>/v<N>.<ext>`; metadatos en
  la tabla `route_versions`. Una ruta nunca editada no tiene filas (versión 0).
- **Invariante: el archivo activo en `data/gpx/` == la versión más alta.**
- Primer guardado: el original se archiva como v1 ANTES de tocar el activo; el
  resultado editado es v2. Restaurar la vk no borra posteriores: crea v(n+1).
- El activo **no cambia de nombre** entre versiones (los thumbs `<stem>.png` y la
  validación 409 de duplicados dependen de ello). Excepción: al editar un `.fit`
  por primera vez se materializa `<stem>.gpx` (mismo stem) y el `.fit` queda como v1.
- Un `delete_range` interior a un segmento lo **parte en dos** (no se fabrica
  distancia en línea recta sobre el hueco). `reverse` elimina todos los `<time>`
  (timestamps descendentes serían inválidos); el frontend avisa con confirm.
- Concurrencia: el POST de guardado lleva `base_version`; si no coincide con
  `MAX(version_n)` → 409 `version_conflict`.
- `DELETE /api/routes/<id>` borra también `route_versions` y `versions/<id>/`.

### Deduplicación de importaciones (`core/dedup.py` + `create_route`)
Para no importar dos veces el mismo track. Dos niveles, ambos funciones puras en
`core/dedup.py` (tests en `tests/test_dedup.py`):

1. **Dura — `content_hash(raw)`** (SHA-256 de los bytes crudos): reimportar los
   MISMOS bytes, aunque con otro nombre → **409 siempre**, en la web y en la ingesta
   automática. Cero falsos positivos. Se comprueba tras leer el archivo, antes de
   parsear ni escribir nada.
2. **Blanda — `route_signature(...)`** (firma semántica): pilla el mismo entreno
   reexportado en otro formato/fuente (bytes distintos). Puede tener falsos positivos,
   así que la respuesta depende de quién sube:
   - **Web** (sin flags): **409 `{soft_duplicate, existing_id, existing_name}`**; la UI
     de subida pregunta y reintenta con `?force=1` (importa limpia, sin marca).
   - **Automático** (`?auto=1`, lo mandan `mifit_sync.py` y `watch.py`): **importa igual
     (201)** pero deja `dup_suspect_of` apuntando a la ruta parecida — nada se pierde en
     silencio ni se fusiona sin revisión humana. La respuesta lleva `soft_duplicate` +
     `existing_id` para que el importador la cuente/logee.

**Política de diseño (no romper):** la ingesta automática **nunca** borra ni fusiona
por su cuenta; el exacto se descarta (seguro), el semántico se conserva **marcado** y
lo revisa una persona (badge en `makeCard`, banner en `sendero.html` con "descartar
aviso"/ir a la parecida → borrar o `POST /api/routes/merge`).

**Borrado masivo de duplicadas (frontend):** el modo edición de "Mis Rutas" tiene un
botón "⚠ Borrar duplicados (N)" (`deleteDuplicates()` en `app.html`, visible solo si hay
`dup_suspect_of` en `allRoutes`). NO es un endpoint nuevo: selecciona las rutas marcadas
y reusa `deleteSelected()` (mismo confirm con recuento + barra de progreso + `DELETE
/api/routes/<id>`). Se borra la ruta MARCADA (la sospechosa), no la original a la que se
parece.

`content_hash`/`signature` se fijan **al importar y no se recalculan** al editar/
reescanear: la pregunta que responden es "¿ya vi este archivo/entreno?", referida al
original. Backfill único de las rutas previas en `init_db()` (firma desde la BD,
hash leyendo el archivo; solo filas con `content_hash IS NULL`). Al añadir la columna
`dup_suspect_of` al listado se creó `idx_routes_list_cov2` (regla 12); al añadir después
`locality` se sustituyó por `idx_routes_list_cov3` (se descartan `idx_routes_list_cov` y
`idx_routes_list_cov2`).

### Thumbnails de track (`core/thumbs.py`)
`generate_thumb(coords, gpx_file)` genera un PNG:
- Fondo `#17241c` (= `--panel`), línea blanca, 400 px de alto, ancho proporcional
  al bounding-box del track (ratio corregido por latitud, acotado 1:4 – 4:1), 40 px
  de padding interior.
- Se llama automáticamente en `create_route` y `rescan_route`; también en el script
  de backfill manual.
- El archivo se llama igual que el GPX con extensión .png (`<stem>.png`), se guarda
  en `data/thumbs/` y se referencia en `thumb_file`.
- Al borrar una ruta, se borra también el thumb.
- En `makeCard` de `app.html`: se muestra como elemento absoluto en el lateral derecho
  de la tarjeta con degradado izquierda→transparente para no tapar el texto.

### Auto-importación Mi Fit / Zepp (`core/mifit/` + `mifit_sync.py` + `api/mifit.py`)
Descarga los entrenamientos del reloj Amazfit/Zepp/Mi Fit (API de Huami) y los
importa como rutas. Plan completo en `roadmap/mifit-sync.md` (fase 4 = auth por
navegador `mifit-auth`, pendiente). Implementado (fases 1-3):
- **`core/mifit/`** — vendorizado de `roadmap/mifit exporter` (solo GPX-por-token).
  `iter_new_workouts(api, since_trackid)` genera `(trackid, nombre, gpx_str)` de lo
  nuevo con GPS, en orden ascendente; salta los indoor (sin puntos). El GPX nombra el
  track `"DD-MM-YYYY hiking"` etc.: esas palabras inglesas ya están en las keywords de
  `_detect_activity()`, así que Sendero asigna la actividad española **sin adaptador**.
- **Dedup por nombre de archivo**: `workout_filename()` es determinista
  (`Workout--YYYY-MM-DD--HH-MM-SS.gpx`), así que reimportar el mismo workout choca con
  el 409 de `create_route` por nombre (antes incluso de leer el cuerpo). Sobre eso
  actúa la dedup general (hash/firma, ver sección "Deduplicación de importaciones");
  la sync manda `?auto=1`, así que una posible duplicada semántica se importa marcada
  (`dup_suspect_of`) y cuenta como `sospechosas` en `MIFIT_LAST_RESULT`.
- **`mifit_sync.py`** (servicio aparte): bucle que sube a `/api/routes`.
  `MIFIT_LAST_TRACKID` avanza solo por un **prefijo contiguo de éxitos** (un fallo no
  hace saltar por encima; se reintenta) y se **persiste cada `WATERMARK_FLUSH_EVERY`
  (10) rutas** durante un backfill (más en las ramas de error/token caducado), para que
  una interrupción no obligue a re-descargar todo. El suelo de importación lo da
  `effective_since(rows) = max(MIFIT_LAST_TRACKID, MIFIT_SINCE_DATE)`; con la marca a 0
  y sin fecha, la **primera sync trae todo el historial** (backfill), por eso existe el
  campo "Importar desde" (`MIFIT_SINCE_DATE`, `trackid` = timestamp de inicio).
- **Reimportar desde fecha**: `POST /api/mifit/sync {reset:true}` borra
  `MIFIT_LAST_TRACKID` antes de encolar, de modo que el suelo vuelve a ser
  `MIFIT_SINCE_DATE` (la única forma de bajar la marca; la dedup evita duplicados). En la
  UI, botón "⟳ Reimportar desde la fecha" (con confirm). "↻ Sincronizar ahora" es
  incremental (`{reset:false}`). Estado en settings: `MIFIT_STATUS`
  (`ok`/`running`/`no_token`/`token_expired`/`needs_login`/`error`),
  `MIFIT_LAST_SYNC`, `MIFIT_LAST_RESULT` (JSON `{nuevas,duplicadas,errores,mensaje}`).
- **`api/mifit.py`**: `GET/POST /api/mifit/settings` (token enmascarado en el GET:
  `has_token`+`token_last4`; el POST solo sobrescribe el token si viene no vacío),
  `POST /api/mifit/sync` (encola: pone `MIFIT_SYNC_REQUESTED`, no hace trabajo pesado),
  `GET /api/mifit/status`. UI en `base.html` (sección "Mi Fit / Zepp" del modal de
  Ajustes): token, región, intervalo, toggle, badge de estado y botón "Sincronizar
  ahora" (sondea `/status` cada 3 s hasta que deja de estar `running`).

### Estado JS relevante en `sendero.html`
| Variable | Contenido |
|----------|-----------|
| `current` | objeto completo de la ruta (geojson, elevation, heart_rate, photos…) — poblado desde el HTML, sin fetch |
| `photoMarkers` | `{id: marker}` — marcadores MapLibre de fotos con GPS |
| `lbIdx` | índice en `current.photos` de la foto visible en el lightbox |
| `immichCands` / `immichSel` | candidatos de Immich y Set de índices seleccionados |
| `IMMICH` | booleano; activado tras `/api/config`, controla el botón Immich |
| `hoverD` | distancia (km) resaltada ahora mismo en el hover sincronizado mapa↔gráficos, o `null` |
| `trackCumKm` | distancia acumulada (km) por punto de `current.geojson`, recalculada en cada `renderMap()` |

### Hover sincronizado mapa↔gráficos en `sendero.html`
Pasar el ratón por la línea del track en el mapa, o por el perfil de elevación/velocidad/FC,
resalta la misma posición en los otros 3 elementos y muestra un cuadro flotante en el mapa
con altitud/velocidad/FC en ese punto. Punto de entrada único: `setHoverD(d)` (d en km o `null`).
- **`elevation`/`speed`/`heart_rate` son series independientes**, cada una con su propio muestreo
  de `d` (no todos los puntos del track tienen elevación/velocidad/FC). `_nearestByD(arr,d)` busca
  el punto más cercano por distancia (binary search, arrays ya vienen ordenados por `d`); no asumas
  mismo índice entre series.
- **Mapa → gráficos**: capa `ruta-linea-hit` (línea ancha invisible sobre `ruta-linea`, mismo
  patrón que `dash-lines-hit` en `app.html`) recibe `mousemove`/`mouseleave`; busca el vértice de
  `current.geojson` más cercano al cursor (scan lineal, barato incluso con miles de puntos porque
  solo corre mientras el cursor está sobre la línea) y llama a `setHoverD(trackCumKm[idx])`.
- **Gráficos → mapa**: cada chart usa `options.onHover(e,els,chart)` leyendo
  `chart.scales.x.getValueForPixel(e.x)` (posición interpolada, no snapeada al punto de dato más
  cercano) en vez de depender de `els`/`intersect`. `ctx.onmouseleave=()=>setHoverD(null)` limpia
  al salir — usa asignación directa (no `addEventListener`) porque `renderElev/renderSpeed/renderHR`
  destruyen y recrean el `Chart` en cada `renderAll()` (tras reescanear) pero reutilizan el mismo
  `<canvas>`: con `addEventListener` los listeners se irían acumulando en cada re-render.
- **Crosshair en los charts**: `_crosshairPlugin()` (plugin Chart.js genérico, `afterDatasetsDraw`)
  lee `hoverD` del scope compartido y dibuja línea+punto leyendo `chart.data.datasets[0].data`
  directamente — funciona igual en los 3 gráficos sin lookup adicional a `current.*`.
- **Marcador + cuadro en el mapa**: fuente/capa GeoJSON `hover-point` (un solo Point, `setData()`
  en cada hover) en vez de un `maplibregl.Marker` DOM — más barato de mover en cada `mousemove`.
  El cuadro flotante (`.hover-infobox`) es un `<div>` posicionado con `map.project(lngLat)`,
  añadido a `map.getContainer()`. **TRAMPA**: la clase CSS trae `display:none` por defecto (para
  que no aparezca antes del primer hover); para mostrarlo hay que forzar `display='block'`, no
  `display=''` — limpiar el inline style solo hace que caiga de vuelta al `none` de la clase.
- `renderMap()` resetea `hoverD=null` y `hoverBoxEl=null` al principio (el mapa se destruye y
  recrea por completo en cada `renderAll()`, así que cualquier estado de hover anterior queda huérfano).

### Mapa de visión general en `app.html` (sección Mis Rutas)
Usa **MapLibre GL** (no Leaflet), basemap **Satélite** (Esri) por defecto con selector de
4 capas (Topográfico/Callejero/Satélite/Oscuro) — a diferencia del dashboard, que no tiene
selector y usa siempre CartoDB Oscuro fijo. La fuente GeoJSON de puntos se actualiza con
`setData()` sin reconstruir el mapa. Soporta clustering nativo. Los iconos de actividad se
cargan como imágenes PNG en base64 con `map.addImage()` (`_loadActImages()`, compartida con
el dashboard). Al cambiar la capa base se llama a `getSource('basemap').setTiles(...)`.

Como el dashboard, dibuja las rutas con **dos representaciones según el zoom** (mismo
patrón, ver más abajo, pero adaptado a que aquí sí hay filtros de lista activos):
- **Bolitas/clusters (`routes`/`clusters`/`unclustered`)**: a partir del array `ovRoutes`
  (ya filtrado por actividad/fecha/búsqueda desde `renderList()`). `unclustered` tiene
  `maxzoom: OV_POINTS_MAXZOOM` (12) para dar paso a las líneas reales por encima de ese zoom.
- **Líneas reales (`ov-lines`/`ov-lines-hit`)**: igual que `dash-lines` del dashboard —
  se piden a `GET /api/routes/geojson?bbox=...` por la zona visible (+50% margen), debounce
  350ms en `moveend` (`_ovScheduleLineLoad`/`_ovLoadLinesForView`), solo si el zoom pasó
  `OV_LINES_PREFETCH_ZOOM` (`OV_LINES_MINZOOM-2`). `ovLineIds`/`ovLineFeaturesAll` acumulan
  TODO lo descargado por bbox (nunca se recorta), pero **a diferencia del dashboard, la capa
  se filtra por los filtros activos de la lista**: `_ovApplyLineFilter()` recalcula qué
  subconjunto de `ovLineFeaturesAll` mostrar cada vez que cambia `ovRoutes` (filtro de
  actividad/fecha/búsqueda), sin volver a pedir red — el endpoint `/api/routes/geojson` solo
  filtra por bbox, así que el filtrado por actividad/fecha es 100% cliente.
- **Invalidación de caché**: `clearRouteCache()` (ya usada para invalidar `allRoutes`)
  también vacía `ovLineIds`/`ovLineFeaturesAll` y limpia la fuente `ov-lines` — si añades un
  nuevo punto de mutación de rutas (upload/rescan/delete), reutiliza esa función en vez de
  inventar otra invalidación; si el caché queda vacío pero hay rutas que mostrar,
  `_ovApplyLineFilter()` relanza `_ovLoadLinesForView()` sola.
- **Encuadre inicial instantáneo**: `fitMap(true)` en la creación del mapa usa
  `duration:0` — el centro/zoom del constructor (`[-84,10]`, un placeholder en Costa Rica)
  nunca se ve, salta directo a la posición real de las rutas. Sin el `true`, MapLibre anima
  el vuelo desde ese placeholder cada vez que se (re)crea el mapa, aunque tus rutas estén al
  otro lado del mundo. El resto de llamadas a `fitMap()` (botón "centrar", cambios de filtro)
  sí animan, ahí tiene sentido.

### Mapa del dashboard en `app.html` (sección Dashboard)
Segundo mapa MapLibre (`dashMap`). Dibuja las rutas con **dos representaciones según el
zoom** en vez de cargar siempre las 500 líneas completas:
- **Bolitas/clusters (`dash-points`/`dash-clusters`/`dash-unclustered`)**: se pintan casi
  al instante a partir de `dashRoutesLite` (el mismo `GET /api/routes` ligero, ~130 KB,
  sin geojson) — clustering nativo de MapLibre, igual patrón que el mapa de "Mis Rutas".
  Visibles siempre que no haya filtro de actividad/año activo.
- **Líneas reales (`dash-lines`)**: solo `minzoom: DASH_LINES_MINZOOM` (9). Se piden a
  `GET /api/routes/geojson?bbox=...` **solo para la zona visible** (+ 50% de margen) en
  el listener `dashMap.on('moveend', _dashScheduleLineLoad)` (debounce 350 ms), y solo si
  el zoom ya pasó `DASH_LINES_PREFETCH_ZOOM` (`DASH_LINES_MINZOOM - 2`, para que estén
  listas antes de que se vuelvan visibles). `dashLineIds` (Set) evita volver a pedir
  rutas ya cargadas; `dashLineFeatures` acumula el FeatureCollection mostrado.
- **Filtros combinados**: `_dashApplyFilters()` aplica un filtro MapLibre `['all', ...]`
  combinando año (`dashSelectedYear`) y actividades (`dashActiveActs`) **solo sobre
  `dash-lines`** — los clusters no tienen `activity`/`year` en sus propiedades (son
  agregados de MapLibre), así que con cualquier filtro activo se ocultan
  `dash-clusters`/`dash-unclustered` y se confía en las líneas filtradas.
- **Barras de año clicables** (`toggleDashYear(year)`) / **filas de actividad clicables**
  (`toggleDashAct(actId)`): togglean filtros/visibilidad como antes.
- **`_refreshActRows()`**: re-renderiza "Por actividad" desde `dashRoutesLite` (no del
  geojson pesado), respetando el año seleccionado.
- **`_reloadDashboard()`**: se llama en cada visita al dashboard. `initDashMap()` está
  guardado (`if(dashMapLoaded||dashMap)return`) así que no repite el setup ni el fetch
  ligero en revisitas dentro de la misma sesión.
- **TRAMPA**: `dashActiveActs` se inicializa dentro de `initDashMap()` (no en la declaración) porque `ACTIVITIES` se define más abajo en el mismo fichero y causaría ReferenceError.
- Si añades una representación nueva por zoom (p.ej. una capa intermedia), sigue el mismo
  patrón: dato ligero primero (instantáneo), dato pesado filtrado por bbox después, en
  segundo plano, sin loader que bloquee.

### Listado de rutas en `app.html` (sección Mis Rutas) — scroll infinito
Cada tarjeta (`makeCard`) muestra nombre, fecha, **distancia** (`fmtKm(r.distance_m)`) y
**localidad** (`r.locality`, con icono de pin `_pinSvg()`) en una línea `.card-meta`, más
el badge de posible duplicada. `distance_m` y `locality` vienen ya en `/api/routes` (por
eso al añadir `locality` se subió la clave de caché a `sendero_routes_v3`, regla 11).

`loadList()` trae **todas** las rutas en una sola llamada a `/api/routes` (sin `limit`;
es barata, no hace falta paginar la red). Lo que se pagina es el **renderizado de
tarjetas**, no la petición:
- `renderList()` filtra/ordena/agrupa por mes el array completo, pero solo manda a
  `appendBatchToDOM()` las primeras `PAGE_SIZE` (30) vía `loadNextListPage()`.
- Un `<div id="list-sentinel">` al final de `#routes`, observado con
  `IntersectionObserver` (`rootMargin:"800px"`), llama a `loadNextListPage(PAGE_SIZE)`
  cuando entra en viewport — así se van añadiendo tarjetas al hacer scroll.
- En modo edición (`editMode`) se renderiza todo de golpe (`pendingRoutes.length`),
  porque "Selec. mes"/"Seleccionar visibles" necesitan que la tarjeta ya exista en el DOM.
- `visibleRoutes` solo contiene lo que ya está renderizado (no todo lo cargado); úsalo
  con eso en mente si tocas selección.
- El mapa de overview (`renderOverviewMap`) sigue recibiendo el array **completo**
  filtrado de una vez (es barato, son solo puntos), independientemente de cuántas
  tarjetas estén ya en el DOM.

### Header (`base.html`)
El logo de la cabecera es `static/icon.svg` (La Traza). La carpeta `static/` se copia en el Dockerfile; si añades assets estáticos, asegúrate de que el `COPY static ./static` siga en el Dockerfile.

## Bugs corregidos (no reintroducir)

- **Re-detección de actividad borraba la elegida a mano y falseaba los umbrales GPS**
  — `_reanalyse_and_update` (rescan + todos los guardados del editor) recalculaba
  `activity_type` desde el nombre y el `<type>` del GPX; con nombre tipo fecha y un
  GPX reescrito por el editor (to_xml() no conserva un `<type>` que gpxpy no leyó),
  quedaba None → los `gps_issues` se calculaban con los umbrales de 'otros'
  (40 km/h) en vez de los de la actividad real (15 de senderismo), y "Corregir
  todo" limpiaba con el umbral equivocado dejando 0 avisos aparentes. Regla: si la
  re-detección no da nada, **conservar** la actividad ya guardada.

- **Ajustes obsoletos en el otro worker de gunicorn** — un POST de ajustes solo
  ejecutaba `refresh_config()` en el worker que lo atendía; el segundo worker
  seguía en memoria con los umbrales GPS/Immich/DEM viejos y aplicaba valores
  distintos según qué worker tocara. Solución: `refresh_config()` en
  `before_request` (app.py) — un SELECT de ~10 filas por request, despreciable.

- **`dashActiveActs` inicializado fuera de orden** — declarar `dashActiveActs=new Set(ACTIVITIES.map(...))` en el `let` del módulo lanza `ReferenceError` porque `ACTIVITIES` se define más abajo. Siempre inicializar dentro de `initDashMap()`.



- **`init_db()` a nivel de módulo** — Gunicorn importa `app:app` sin ejecutar el
  bloque `__main__`; sin `init_db()` al importar falla en el primer request.

- **Especificidad CSS del modal Immich** (`sendero.html`): la regla
  `.overlay.hidden{display:none}` (especificidad doble) debe estar inmediatamente
  después de `.overlay{display:flex}`. Sin ella el modal Immich aparece al cargar.

- **SPA en `app.html`, no en archivos separados** — el antiguo CLAUDE.md decía
  "app multi-página"; ya no es cierto. Editar `rutas.html` no tiene efecto.

- **Columnas pequeñas añadidas con `ALTER TABLE` después de `geojson`/`elevation`/
  `heart_rate` hacen lentísima cualquier query que las lea**, aunque no pidas el geojson.
  `ALTER TABLE ADD COLUMN` añade la columna al final del registro físico de cada fila;
  para leer una columna que viene *después* de un blob de cientos de KB, SQLite tiene que
  atravesar igualmente las páginas de overflow de ese blob (son una lista enlazada, no se
  puede saltar). Con ~500 rutas esto se notaba como 7-9 s en `/api/routes` (que ni
  siquiera pedía `geojson`). Solución: índices de cobertura que incluyan exactamente las
  columnas que la query necesita (`idx_routes_list_cov`, `idx_routes_stats_cov`,
  `idx_routes_bbox`), para que SQLite resuelva la query desde el índice sin tocar la fila
  completa. Si añades una columna nueva con `ALTER TABLE` y la vas a leer junto a otras en
  una query frecuente (listados, stats, filtros), añade también su índice de cobertura en
  `init_db()` — no asumas que basta con la columna.

- **`fitMap()` sin `duration:0` en el primer encuadre del mapa de "Mis Rutas"** (`app.html`)
  animaba un "vuelo" visible desde el centro placeholder del constructor (`[-84,10]`, zona de
  Costa Rica) hasta la posición real de las rutas, cada vez que se creaba el mapa. Solución:
  `fitMap(true)` (parámetro `instant`) solo en ese primer encuadre; el resto de usos (botón
  "centrar", cambios de filtro) siguen animados a propósito.

- **`init_db()` corre en cada worker de gunicorn por separado** (no hay `--preload`), así
  que con `--workers 2` dos procesos ejecutan las migraciones a la vez contra el mismo
  archivo SQLite. Sin `PRAGMA busy_timeout`, el segundo `ALTER TABLE`/`UPDATE` que choca
  con el primero falla al instante con `database is locked` y tumba ese worker (gunicorn
  lo reintenta, puede entrar en bucle de crash-reinicio si la migración tarda). Por eso
  `db()` e `init_db()` ponen `PRAGMA busy_timeout=20000` (en `core/database.py`) — y aun
  así, los `ALTER TABLE ADD COLUMN` que puedan chocar por carrera están en un
  `try/except sqlite3.OperationalError` tolerando `"duplicate column"`. Si añades una
  migración nueva en `init_db()`, asume que puede ejecutarse dos veces en paralelo.

## Reglas que evitan romper cosas

1. **El frontend NO tiene build step.** Todo el JS va inline en Jinja2. No introduzcas
   npm, bundlers, React ni paso de compilación.

2. **Una foto es local O de Immich.** En `photos`, las locales tienen `file` y las de
   Immich tienen `immich_id` (`file = NULL`). Todo código que toque el disco DEBE
   comprobar `if p["file"]:` primero. Las fotos Immich se guardan **por referencia**.

3. **El watcher corre una sola vez.** Es un servicio aparte en docker-compose para que
   no se duplique con los workers de gunicorn. NO lo hagas hilo de fondo en Flask.

4. **El cruce con Immich es por tiempo.** Requiere `started_at` no NULL. Si es NULL,
   el endpoint devuelve 400 a propósito. No inventes fallback silencioso.

5. **El filtro de cercanía nunca excluye fotos sin GPS.** `dist_m == null` ⇒ siempre
   visibles. Muchas fotos de montaña no llevan GPS.

6. **Migraciones de esquema** — sigue el patrón `ALTER TABLE` defensivo de `init_db()`
   comprobando `PRAGMA table_info`. No asumas BD limpia.

7. **Persistencia solo en `/data`** (`SENDERO_DATA`): `sendero.db`, `gpx/`, `photos/`,
   `thumbs/`. No escribas estado fuera de este volumen Docker.

8. **Idioma** — UI y mensajes al usuario en **español**. Código y comentarios pueden
   mezclar español/inglés como ya están.

9. **Identidad visual** — paleta CSS (`--gr-red`, `--pr-yellow`, `--panel` #17241c,
   curvas de nivel en header). No metas framework de UI ni cambies la paleta sin pedirlo.

10. **`{{ route_json | safe }}` en sendero.html** — intencional. El JSON viene de
    `json.dumps()` sobre datos de la BD, no de input de usuario. No lo escapes dos veces.

11. **Caché de rutas en sessionStorage** (`sendero_routes_v1`, TTL 10 min) — si cambias
    los campos que devuelve `/api/routes`, cambia también la clave de caché para forzar
    refresco en todos los clientes. Añadir `thumb_file` sin cambiar la clave causó que
    los usuarios vieran tarjetas sin thumbnail hasta que la caché expiró.

12. **Toda columna nueva que se vaya a leer en un listado o agregado frecuente necesita
    su índice de cobertura en `init_db()`**, no solo el `ALTER TABLE`. Ver "Bugs
    corregidos" — sin esto, leer una columna añadida tarde en el esquema obliga a SQLite
    a atravesar los blobs grandes (`geojson`/`elevation`/`heart_rate`) de cada fila.

13. **Cualquier migración en `init_db()` debe asumir que puede ejecutarse dos veces en
    paralelo** (gunicorn arranca 2 workers, cada uno corre `init_db()` por su cuenta).
    `PRAGMA busy_timeout` ya está puesto; para `ALTER TABLE ADD COLUMN` que puedan
    chocar, envuélvelos en `try/except sqlite3.OperationalError` tolerando
    `"duplicate column"`.

## Modelo de datos

### Tabla `routes`
| Columna | Tipo | Notas |
|---------|------|-------|
| id | INTEGER PK | |
| name | TEXT | |
| notes | TEXT | resumen del usuario |
| gpx_file | TEXT | nombre en `data/gpx/` (puede ser .fit) |
| distance_m, ascent_m, descent_m | REAL | |
| duration_s, moving_s | REAL | |
| ele_min, ele_max, avg_speed | REAL | |
| started_at | TEXT | ISO 8601; NULL si el GPX no tiene timestamps |
| geojson | TEXT JSON | lista `[[lon,lat], …]` |
| elevation | TEXT JSON | lista `[{d, e}, …]` (d en km, e en m) |
| heart_rate | TEXT JSON | lista `[{d, hr}, …]` o NULL |
| hr_avg, hr_max | INTEGER | NULL si no hay FC |
| speed | TEXT JSON | lista `[{d, v}, …]` (v en km/h) o NULL. GPX: derivada de posición/tiempo con ventana móvil de `SPEED_WINDOW_S` (15s) para suavizar ruido GPS — requiere `<time>` por punto, si no hay queda vacío. FIT: `enhanced_speed`/`speed` del propio dispositivo, sin suavizar |
| gps_issues | TEXT JSON | tramos GPS anómalos (`core/gps_analysis.py::detect_gps_anomalies`, umbrales por actividad de Ajustes → "GPS incorrecto"); lista `[{type: speed\|elevation\|altitude, d_from, d_to, value_max, threshold, severity}, …]` o NULL. `altitude` (puntos por encima de `max_ele_m`) se detecta incluso sin timestamps. Lo calculan `create_route` y `_reanalyse_and_update` (rescan + guardados del editor); el editor lo premarca. OJO: `app.py` hace `refresh_config()` en `before_request` porque con 2 workers un POST de ajustes solo refrescaba el worker que lo atendía |
| created_at | TEXT | |
| activity_type | TEXT | senderismo/bicicleta/caminata/correr/esqui/otros |
| device | TEXT | fabricante/modelo del dispositivo |
| immich_checked | INTEGER | 0/1 |
| start_lat, start_lon | REAL | primer punto del track |
| thumb_file | TEXT | nombre en `data/thumbs/` (PNG) |
| bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat | REAL | bounding box del track completo; lo calcula `_route_bbox()` en `create_route`/`rescan_route`. Usado por `/api/routes/geojson?bbox=` (mapa del dashboard) para no cargar rutas fuera de la zona visible |
| content_hash | TEXT | SHA-256 de los bytes crudos del archivo importado (`core/dedup.py`). Dedup DURA: reimportar los mismos bytes (aunque con otro nombre) → 409. Índice propio `idx_routes_content_hash`. Solo se fija al importar; NO se recalcula al editar/reescanear (la pregunta es "¿ya vi este archivo?", referida al original) |
| signature | TEXT | Huella SEMÁNTICA del entreno (`route_signature`): `started_at` al minuto + primer/último punto a 4 decimales (~11 m). Sin timestamps cae a distancia(100 m)+nº puntos. Dedup BLANDA. Índice propio `idx_routes_signature`. Deliberadamente NO incluye distancia cuando hay hora (el hash por igualdad daría falsos negativos en las fronteras de cubo). Solo al importar, no se recalcula |
| dup_suspect_of | INTEGER | id de la ruta a la que se parece, cuando la ingesta AUTOMÁTICA (`?auto=1`) la importó pese al aviso semántico. NULL = limpia. Se lee en el listado → va en `idx_routes_list_cov3` (regla 12). Se limpia al editar la ruta o con `PATCH {dup_suspect_of:null}` ("descartar aviso") |
| locality | TEXT | Sitio donde se hizo la ruta ("Localidad, Región"), por geocoding inverso del punto de inicio (`core/geocode.py`, `GEOCODE_URL` en Ajustes → Editor). Se rellena best-effort al importar (`create_route`) y al reescanear una ruta que aún no la tenga (`_reanalyse_and_update`, backfill vía "Re-escanear"); NULL = servicio desactivado o geocoding fallido. Se lee en el listado y se muestra en la tarjeta de "Mis Rutas" y en el detalle → va en `idx_routes_list_cov3` (regla 12) |

### Tabla `route_versions`
Historial del editor de rutas (append-only, ver sección "Editor de rutas").
`route_id`, `version_n` (UNIQUE juntos), `file` (nombre en
`data/gpx/versions/<route_id>/`), `summary` (en español), `distance_m`,
`ascent_m`, `n_points`, `created_at`. Sin filas = ruta nunca editada (versión 0).
El archivo activo de la ruta es siempre idéntico a la versión más alta.

### Tabla `photos`
`route_id`, `file` XOR `immich_id`, `original`, `lat`, `lon`, `taken_at`

### Tabla `planned_routes`
`name`, `source` (`gpx` | `dibujada`), `source_url`, `activity_type`,
`distance_m`, `ascent_m`, `descent_m`, `ele_min`, `ele_max`, `start_lat`,
`start_lon`, `geojson`, `elevation`, `notes`, `gpx_data` (BLOB), `created_at`,
`draw_anchors` (columna heredada del planner interno ya eliminado; siempre NULL
en filas nuevas, no se lee ni se escribe — la migración se conserva por no
reconstruir la tabla, ver `init_db()`)

### Tabla `settings`
Clave-valor: `IMMICH_URL`, `IMMICH_API_KEY`, `IMMICH_MARGIN_MIN`, `IMMICH_DIST_M`,
`DEM_URL` (OpenTopoData para el editor; vacío = desactivado),
`PLANNER_URL` (web externa que abre "Dibujar ruta nueva"; por defecto
brouter-web), `GEOCODE_URL` (servicio Nominatim-compatible para la localidad de
cada ruta; por defecto el Nominatim público de OSM, vacío = desactivado — a
diferencia de PLANNER_URL, un valor vacío SÍ desactiva, no cae al default),
`GPX_TYPE_CUSTOM` (JSON), `GPS_THRESHOLDS_CUSTOM` (JSON),
`stats_cache` (JSON con estadísticas globales). Los ajustes de settings
sobreescriben los de `.env`/variables de entorno.

Mi Fit/Zepp (auto-importación): editables por `api/mifit.py` y en `_SETTINGS_KEYS`
(refrescadas por `refresh_config`): `MIFIT_ENABLED` (0/1), `MIFIT_TOKEN` (apptoken),
`MIFIT_ENDPOINT` (región Huami), `MIFIT_INTERVAL_MIN` (0 = solo manual),
`MIFIT_SINCE_DATE` (YYYY-MM-DD; suelo de fecha, vacío = todo el historial). De solo
estado, escritas por `mifit_sync.py` (NO en `_SETTINGS_KEYS`, no editables por UI):
`MIFIT_SYNC_REQUESTED`, `MIFIT_LAST_SYNC`, `MIFIT_LAST_TRACKID`, `MIFIT_LAST_RESULT`,
`MIFIT_STATUS`.

## Quirks conocidos
- La validación de extensión en `create_route` acepta cualquier nombre que termine en
  `gpx` o `.fit`. No endurezcas sin revisar el watcher.
- No hay autenticación. Intencional para LAN.
- `rutas.html`, `overview.html`, `planificacion.html` — archivos legacy en `templates/`.
  No los borres (pueden servir de referencia) pero no los edites; el app no los usa.
- **Docker Desktop sobre WSL2 (esta instalación) puede dejar procesos `gunicorn`/
  `watch.py` huérfanos** tras varios `docker compose down`/`up --build` seguidos: el
  proceso sigue vivo (visible en `ps aux` del host, propiedad de `root`) y sigue
  atendiendo el puerto publicado con código *antiguo*, aunque `docker ps` ya no liste
  ningún contenedor y el contenedor "actual" tenga el código correcto. Síntoma: cambios
  en el código que no se reflejan en `localhost:8090` aunque el build no dé error y
  `docker compose exec` confirme que el archivo en el contenedor es el correcto.
  Diagnóstico: `ps aux | grep gunicorn` — si hay procesos con una hora de arranque muy
  anterior al último `docker compose up`, son huérfanos. Solución: `sudo kill -9
  <esos PIDs>` y volver a `docker compose up -d --build` (puede generar un nuevo huérfano
  si lo que mueres es el proceso supervisado por `restart: unless-stopped`; conviene
  `docker compose down` primero para quitar esa política antes de matar).

## Antes de dar por buena una tarea
- ¿Sigue arrancando `python app.py` e `init_db()` sin error?
- Si tocaste `create_route` o `rescan_route`: ¿se genera el thumb y se guarda `thumb_file`?
- Si tocaste fotos: ¿probaste los dos caminos (local y `immich_id`)?
- Si tocaste el esquema: ¿añadiste la migración defensiva en `init_db()`?
- ¿La UI sigue en español y sin paso de build?
- Si tocaste el CSS del modal Immich en `sendero.html`: comprueba que `.overlay.hidden`
  sigue ocultando el modal al cargar la ruta.
- Si tocaste `_build_route_dict()`: verifica que `/api/routes/<id>` y
  `/Sendero/<nombre>` devuelven los mismos campos.
- Si añadiste columnas a `/api/routes` (lista): actualiza la clave `ROUTE_CACHE`
  en `app.html` para invalidar el sessionStorage de los clientes.
- Si tocaste `app.html` (`makeCard`, CSS de `.card`): recuerda que tanto "Mis Rutas"
  como las tarjetas del mapa de overview están en ese mismo archivo.
- Si tocaste el mapa del dashboard: verifica que `_reloadDashboard()` limpia los contenedores antes de repoblar y que `initDashMap()` no se llama dos veces (guarda `if(dashMapLoaded||dashMap)return`).
- Si añades assets estáticos a `static/`: el `COPY static ./static` ya está en el Dockerfile.
- Si añadiste una columna a `routes` que se lee en un listado/agregado frecuente:
  ¿le añadiste también su índice de cobertura en `init_db()`? (ver regla 12).
- Si tocaste algo en `init_db()`: ¿sobrevive a ejecutarse dos veces en paralelo
  (2 workers de gunicorn)? (ver regla 13).
- Si tocaste el editor (`core/editing.py`/`api/editor.py`): ¿el orden de aplanado
  sigue siendo idéntico al de `analyse_gpx()`? ¿El activo sigue siendo igual a la
  versión más alta tras guardar y tras restaurar? ¿Los `<time>`/HR sobreviven a un
  recorte? (smoke test en `roadmap/editorplan.md` §8).
- Si tras `docker compose up -d --build` los cambios no se reflejan en `localhost:8090`
  pese a que el build no falla: revisa el quirk de procesos huérfanos de Docker
  Desktop/WSL2 antes de sospechar del código.
- Si tocaste el mapa de "Mis Rutas" (`app.html`): ¿las líneas (`ov-lines`) siguen
  respetando los filtros de actividad/fecha/búsqueda vía `_ovApplyLineFilter()`, o se
  te ha colado un caso que las muestra sin filtrar? ¿sigue usando `fitMap(true)` en el
  primer encuadre (sin animación de vuelo)?
- Si tocaste `renderElev/renderSpeed/renderHR` o el mapa en `sendero.html`: ¿el hover
  sincronizado sigue funcionando en las 4 direcciones (mapa→gráficos y cada gráfico→resto)?
  Si añades un `Chart` nuevo, usa `ctx.onmouseleave=...` (asignación directa, no
  `addEventListener`) para no acumular listeners en cada `renderAll()`.
