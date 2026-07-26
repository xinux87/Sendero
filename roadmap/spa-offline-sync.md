# Plan: SPA completa, funcionamiento sin conexión (mapas incluidos) y sincronización delta

Objetivo triple, en este orden de dependencia:

1. **SPA completa** — un único documento HTML sirve todas las vistas (dashboard, rutas,
   planes, detalle de ruta, detalle de plan, editor). *(Al escribir el plan solo 3 de 6
   lo eran; hoy, las 6.)*
2. **Sin conexión** — la app arranca y se usa sin internet, **mapas incluidos**. Requiere
   dos cosas independientes: (a) que el servidor no dependa de ningún host externo,
   (b) que el navegador sobreviva sin el servidor (PWA + Service Worker).
3. **Sincronización delta** — un endpoint barato responde "no ha cambiado nada" en ~0 bytes;
   si algo cambió, el cliente descarga **solo la diferencia** y puede **corroborar** que su
   copia local coincide con el servidor sin descargarla entera.

## Estado de implementación (actualizar al avanzar)

**Última versión publicada con avance de este plan: v0.6.0 (2026-07-25)** = fases 1, 4 y
6.1 completas + la fase 2/3 arrancada (shell + sección `plan`).

**Sin publicar (en `master`)**: el plan está **terminado**. Las 6 vistas son
secciones de un único shell (fases 2 y 3), la PWA funciona (5), el prefetch de detalles y
el panel de gestión están en Ajustes → Sin conexión (6.3) y la cola de escrituras tiene su
UI (7). Verificado con `tests/e2e_spa.py`: ~115 comprobaciones en un navegador real.

> ### ▶ POR DÓNDE VAMOS — nada urgente: el plan está cerrado
>
> Las 6 vistas son secciones de `templates/shell.html` y no queda ninguna recarga de
> documento. Lo que hay pendiente es opcional y está acotado:
>
> 1. **Publicar** — `APP_VERSION` invalida el precache del Service Worker, así que este
>    trabajo no debe salir sin subir la versión (los 4 puntos de "Publicar una versión" de
>    CLAUDE.md).
> 2. ~~**Borrar las plantillas legacy**~~ — **hecho** justo después de v0.7.1: fuera las
>    siete (`app.html`, `sendero.html`, `editor.html`, `rutas.html`, `overview.html`,
>    `planificacion.html`, `plan_detalle.html`), 6.410 líneas, más el endpoint muerto
>    `/api/routes/by-name/<name>`. En `templates/` solo quedan `base.html`, `shell.html`
>    y `sec/`. Recuperables con `git show v0.7.1:templates/<archivo>`.

| Fase | Estado | Qué hay hecho |
|---|---|---|
| 1 Vendorizar | **hecha** | `static/vendor/` (maplibre 4.7.1, chart 4.4.1, pmtiles 3.0.6), `static/fonts/` con `fonts.css`, Leaflet fuera (`plan_detalle.html` pasó a MapLibre), `<script>`/`<link>` externos eliminados de las plantillas |
| 4 Sync delta | **hecha** | `sync_seq`/`sync_log`/9 triggers + epoch + backfill en `core/database.py`; `api/sync.py` (`/state` con ETag→304, `/changes`, `/manifest`); ETag por `rev` y `?lite=1` en `GET /api/routes/<id>`; `core/sync.py` puro + `tests/test_sync.py`; cliente `static/js/core/store.js` (IndexedDB, delta, verify, outbox). Las 6 secciones leen del Store: ya no queda ningún `fetch('/api/routes')` suelto ni caché en `sessionStorage` |
| 2 Extraer JS | **hecha** | `static/js/core/`: `chrome.js` (helpers + Ajustes + SW + badge + panel Sin conexión), `loader.js`, `router.js`, `store.js`. `static/js/sec/`: las 6 secciones. Ni una línea de lógica de vista queda en las plantillas |
| 3 SPA completa | **hecha (6 de 6)** | `templates/shell.html` aloja dashboard, rutas, planes, detalle, plan y editor. Todas las URLs de vista sirven el mismo shell; `hosted()` siempre acierta y no queda ninguna recarga de documento. Acciones de cabecera por sección con `data-sec-actions` (las conmuta el router) |
| 6.1 PMTiles | **hecha** | `api/maps.py` (`/tiles/<name>` con Range/206, `/api/maps`), `TILES_DIR`, capa `OFFLINE_LAYER` + `buildStyle`/`applyBasemap`/`defaultBasemap` en `shared.js`, Ajustes → Mapas, y los 5 mapas de la app pasan ya por `buildStyle()` |
| 5 PWA/SW | **hecha** | `api/pwa.py` (`/sw.js` con `APP_VERSION` inyectada, `/manifest.webmanifest`, `/app-shell`), `static/sw.js`, iconos 192/512/maskable en `static/icons/`, badge `#net-badge` en el header. Ver las 3 desviaciones respecto al plan más abajo (§5) |
| 6.3 Datos offline | **hecha** | Ajustes → Sin conexión: estado de la copia local (rutas, planes, detalles, bytes, última sincronización), "Descargar todas las rutas" con progreso (`Store.prefetchAll`), "Comprobar sincronización" (`Store.verify`, por manifiesto) y "Vaciar copia local" |
| 6.2 Teselas offline | **hecha, replanteada** | Ya no se descargan zonas, sino el **corredor de una ruta**: `static/js/core/tiles.js` + botón «⬇ Mapa sin conexión» en detalle y plan + caché `sendero-tiles-v1` servida por el SW. 40 km = ~380 teselas (~9 MB). Descargar regiones enteras sigue descartado (política de uso de las capas). Ver §6.2 |
| 7 Escrituras | **hecha** | `Store.patch()` + `outbox` + `flushOutbox()`, usados por `plan`, `detalle` y el editor; badge en el header (§5.4) y panel en Ajustes → Sin conexión con lista de pendientes, "Enviar ahora" y "Descartar todo" |

No queda nada pendiente del plan. §6.2 se replanteó a mitad (mapa por ruta en vez de por
zona) y eso resultó ser más pequeño Y más útil: ver ahí.

Restricciones que se respetan (CLAUDE.md): **sin build step** (regla 1), UI en español
(regla 8), paleta actual (regla 9), persistencia solo en `/data` (regla 7), migraciones
defensivas y re-ejecutables en paralelo por 2 workers (reglas 6 y 13), índices de cobertura
para columnas nuevas leídas en listados (regla 12).

> "Sin build step" no impide separar el JS en archivos propios cargados a demanda: los sirve
> el navegador tal cual, sin npm, sin bundler, sin transpilar. Lo que sí desaparece es el JS
> inline dentro de Jinja — y eso no es cosmética, es **requisito** del punto 2 (ver §3).
>
> **Decisión al implementar** (no eran módulos ES, y el motivo importa): las secciones son
> `<script>` clásicos inyectados por `loadOnce()` (`static/js/core/loader.js`), cada uno
> envuelto en su IIFE y publicando su API en `window.SEC.<sec>`. Con `type="module"` las
> funciones no quedan en el ámbito global y los **121 atributos `onclick=`** de las
> plantillas se romperían todos; migrarlos a `addEventListener` es un cambio mucho mayor que
> el de esta fase. El resultado es equivalente para el Service Worker (una URL cacheable por
> sección) y para la carga a demanda.

---

## 0. Diagnóstico (HISTÓRICO: estado de partida, antes de la migración)

> Esta sección describe cómo estaba el código **antes** de empezar, con números de línea
> de entonces. Se conserva porque explica de dónde salen las decisiones de las fases
> siguientes, pero NO es el estado actual: hoy las 6 vistas son secciones de un shell
> único y las plantillas que se citan aquí son legacy.

### Lo que ya es SPA

`templates/app.html` sirve `/dashboard`, `/rutas` y `/planificacion` con un router propio:
`_curSec` (`app.html:494`), `_showSec()` (`app.html:742`), `history.pushState`
(`app.html:755`), `_spaNavTo` + `popstate` (`app.html:777-778`). Funciona bien y es el
patrón a extender, no a sustituir.

### Lo que no es SPA (recarga completa de página)

| Vista | Handler | Plantilla | Cómo se navega hoy |
|---|---|---|---|
| Detalle de ruta | `api/routes.py:175` | `sendero.html` (1001 líneas) | `location.href='/Sendero/'+name` |
| Detalle de plan | `api/planned.py` (`/Plan/<name>`) | `plan_detalle.html` (368 líneas) | `location.href` |
| Editor | `api/editor.py:101` | `editor.html` (1693 líneas) | `location.href` |

Las tres reciben sus datos **inyectados por Jinja** (`{{ route_json | safe }}`), no por
fetch. Eso es rápido online y **imposible offline**: sin servidor no hay documento, y con
Service Worker cachear el documento significaría cachear datos congelados dentro del HTML.

### Dependencias de hosts externos (bloqueantes para "sin conexión")

| Recurso | Dónde | Host |
|---|---|---|
| `maplibre-gl.js` + `.css` 4.7.1 | `app.html:5-6`, `sendero.html:5-6`, `editor.html:5-6` | unpkg.com |
| `Chart.js` 4.4.1 | `sendero.html:7`, `editor.html:7`, `plan_detalle.html:7` | cdnjs.cloudflare.com |
| **Leaflet 1.9.4** | `plan_detalle.html:5-6` | cdnjs.cloudflare.com |
| Fuentes Saira Condensed / Inter / Space Mono | `base.html:9` | fonts.googleapis.com (+ gstatic) |
| Teselas de mapa (4 capas) | `static/shared.js:91-96` | opentopomap, openstreetmap, arcgisonline, cartocdn |
| Teselas del dashboard | `app.html:599-601` (hardcoded) | cartocdn |
| Geocoding inverso | `core/config.py:46` `GEOCODE_URL` | nominatim.openstreetmap.org |
| Planificador externo | `core/config.py:39` `PLANNER_URL` | brouter.de |

Hallazgo colateral: **`plan_detalle.html` sigue en Leaflet**, no en MapLibre — CLAUDE.md
dice lo contrario. Hay que unificar antes de vendorizar (§1), o habrá que vendorizar dos
librerías de mapas.

No existe nada de PWA: cero referencias a `serviceWorker`, `manifest.json` o
`.webmanifest` en todo el repo.

### Estado de la sincronización hoy

- `GET /api/routes` (`api/routes.py:275`) devuelve **todo el listado siempre** (14 columnas,
  ~130 KB con 500 rutas). No hay condicional, ni `since`, ni ETag.
- El cliente cachea en `sessionStorage` con clave `sendero_routes_v4` y TTL de 10 min
  (`app.html:979`), e invalida a mano con `clearRouteCache()` en cada mutación local.
  Un cambio hecho **desde otro dispositivo** (o por `watch.py` / `mifit_sync.py`) tarda
  hasta 10 min en verse, y cuando se ve, se re-descarga el listado completo.
- No hay ninguna columna de fecha de modificación: `routes` tiene `created_at` y nada más.
  Y las mutaciones están repartidas en **13 sitios** (`api/routes.py:406,407,414,464,530,
  548,549`, `api/editor.py:76,205,470`, `api/photos.py:28,65`, `api/immich_api.py:70`,
  `api/planned.py:92,125,135`). Cualquier esquema que dependa de "acuérdate de tocar el
  contador aquí" se romperá en el primer sitio que se olvide → **triggers de SQLite** (§4).

### Presupuesto de datos (medido en la BD de desarrollo, 48 rutas)

| Dato | 48 rutas | Extrapolado a 500 |
|---|---|---|
| `geojson` completo | 6,0 MB (~125 KB/ruta) | ~60 MB |
| `elevation`+`heart_rate`+`speed` | 16,2 MB (~340 KB/ruta) | ~170 MB |
| Listado (`/api/routes`) | ~13 KB | ~130 KB |
| `data/` completo (fotos incluidas) | 252 MB | — |

Conclusión que gobierna todo el diseño offline: **el listado es gratis, el detalle no**.
Sincronizar metadatos de 500 rutas es trivial; guardar los 230 MB de series completas en el
navegador no lo es. De ahí la separación en dos niveles de §4 y la variante ligera de §6.3.

---

## 1. Fase 1 — Cortar las dependencias externas (vendorizar)

Fase independiente y de valor inmediato: la app ya funciona en una LAN sin internet, salvo
mapas. Sin esto, ninguna fase posterior sirve de nada.

1. **Unificar `plan_detalle.html` en MapLibre** y borrar Leaflet. Es la única plantilla con
   Leaflet; mantener dos librerías de mapas duplica el peso a vendorizar y el trabajo de §6.
2. **Vendorizar en `static/vendor/`**: `maplibre-gl.js`, `maplibre-gl.css`, `chart.umd.min.js`.
   Con versión en el nombre (`maplibre-gl-4.7.1.js`) para que el Service Worker pueda
   cachearlas con `immutable` sin miedo a servir una versión vieja tras actualizar.
   `COPY static ./static` ya está en el Dockerfile — no hay que tocarlo.
3. **Vendorizar las fuentes**: descargar los `.woff2` de las 3 familias a
   `static/fonts/` y sustituir `base.html:9` por `@font-face` locales. Ahorra además el
   FOUT actual y una conexión externa por carga.
4. **Cabeceras de caché** para `static/`: `max-age=31536000, immutable` en `vendor/` y
   `fonts/` (nombres versionados), y revalidación normal en el resto.
5. **Verificación honesta**: DevTools → *Network* con "Offline" desactivado pero bloqueando
   dominios externos; la única petición externa restante debe ser la de teselas (§6) y, si
   están configurados, `GEOCODE_URL`/`PLANNER_URL` — que son **best-effort por diseño**
   (`core/geocode.py` nunca rompe un import) y quedan fuera del alcance offline.

**Criterio de aceptación**: `grep -rn "https://" templates/ static/` no devuelve ninguna
etiqueta `<script>`/`<link>`; solo URLs de teselas y de servicios opcionales.

---

## 2. Fase 2 — Extraer el JS de las plantillas a módulos ES

Hoy hay ~5.800 líneas de JS dentro de 5 plantillas Jinja. El Service Worker no puede
cachear "el JS de `app.html`" por separado del HTML, y el HTML lleva datos dentro. Hay que
separar **código** (cacheable, inmutable) de **datos** (sincronizables).

Reparto propuesto (`static/js/`, scripts clásicos cargados por `loadOnce()`, sin bundler):

```
static/js/
  core/       dom.js         $ , fmtKm, fmtDur, fmtDate, esc, toast   (de base.html)
              router.js      _showSec/_spaNavTo/popstate generalizado (de app.html:742-778)
              api.js         wrapper fetch + manejo de 409/offline
              store.js       IndexedDB (fase 4)
              activities.js  ACTIVITIES/activityOf/iconSvg/_loadActImages (de shared.js)
              basemaps.js    BASEMAP_TILES/buildStyle (de shared.js)
              charts.js      _crosshairPlugin y helpers comunes de Chart.js
  sec/        dashboard.js   sección Dashboard      (de app.html)
              rutas.js       sección Mis Rutas      (de app.html)
              planes.js      sección Mis Planes     (de app.html)
              detalle.js     detalle de ruta        (de sendero.html)
              plan.js        detalle de plan        (de plan_detalle.html)
              editor.js      editor                 (de editor.html)
```

Reglas de la extracción:

- **Un módulo por sección, con contrato fijo**: `window.SEC.<sec> = {mount(params, opts),
  unmount()}` (`mount` puede ser async). `unmount()` **debe** destruir el mapa MapLibre y los `Chart`
  de la sección: hoy `renderMap()` los recrea enteros en cada `renderAll()`, y al pasar a
  SPA sin recarga de página cualquier listener huérfano se acumula para siempre. Es la
  trampa nº 1 de esta fase (ya documentada en CLAUDE.md para `ctx.onmouseleave` en
  `sendero.html`: con `addEventListener` los listeners se acumulaban en cada re-render).
- **Migración incremental, sección por sección**, no un big-bang. Orden recomendado:
  `core/` → `plan.js` (368 líneas, la más simple, valida el contrato) → `detalle.js` →
  `dashboard/rutas/planes` → `editor.js` (el último: 1693 líneas y la lógica de paridad
  cliente/servidor de las ops, lo más delicado del repo).
- **La paridad de `doOp()` con `apply_ops()` no se toca en esta fase.** Mover el código de
  sitio sí; cambiar una op, no. Si hay que tocar ambas, es otro commit.
- `shared.js` desaparece al final; hasta entonces convive (los módulos importan de
  `activities.js`, las plantillas aún no migradas siguen con el `<script src>` global).

**Criterio de aceptación**: cada sección migrada se monta y desmonta 20 veces seguidas sin
crecer en memoria (DevTools → Memory, heap estable) y sin duplicar marcadores ni listeners.

---

## 3. Fase 3 — SPA de verdad: un shell, todas las vistas

1. **Un solo documento**: `templates/shell.html` (hereda de `base.html`) con los
   contenedores de las 6 secciones y **cero datos inyectados**. Flask sirve el mismo shell
   para todas las URL de vista:

   | URL | Sección |
   |---|---|
   | `/dashboard`, `/rutas`, `/planificacion` | como hoy |
   | `/Sendero/<public_id>` | `detalle` |
   | `/Plan/<public_id>` | `plan` |
   | `/Sendero/<public_id>/editor` | `editor` |

2. **URLs por `public_id`, no por nombre.** Hoy `/Sendero/<name>` resuelve por nombre con
   `ORDER BY … LIMIT 1` (`api/routes.py:176`) — ambiguo con nombres repetidos (habituales:
   `mifit_sync` nombra por fecha) y frágil al renombrar. El `public_id` ya existe, es opaco
   y no enumerable (v0.5.2), y es la clave natural para la caché offline. Mantener
   `/Sendero/<name>` como **redirect 302** al `public_id` para no romper enlaces guardados.
3. **El router carga la sección la primera vez que se visita** (`loadOnce()` inyecta el
   `<script>` y su CSS y memoiza por URL): el editor, el módulo más grande, no se descarga si
   nunca se abre. Mientras queden vistas sin migrar, `hosted()` comprueba si el contenedor
   `#sec-<sec>` existe en el documento y, si no, cae a `location.href` — así la navegación
   funciona igual durante toda la migración.
4. **Los datos vienen del store, no de Jinja.** `detalle.js` pide la ruta a
   `store.getRoute(public_id)`, que resuelve desde IndexedDB y/o red (§4). Aquí se pierde
   la inyección SSR: para que la primera carga no sea más lenta que hoy, el shell hace
   `fetch` del detalle **en paralelo** al `import()` del módulo (dos peticiones concurrentes
   en vez de un documento grande) y, en visitas posteriores, sirve desde IndexedDB.
   Medir antes/después: si el detalle tarda más que hoy en frío, mantener la inyección como
   optimización solo para la carga inicial directa (el shell puede llevar un
   `<script type="application/json" id="bootstrap">` que el store consume y luego ignora).
5. **`{{ route_json | safe }}` desaparece** de `sendero.html` cuando la vista se migre.
   Cuando ya no quede ninguna inyección, la regla 10 de CLAUDE.md queda obsoleta y hay
   que borrarla.
   → **Al implementarlo se decidió lo contrario, y a propósito**: la inyección se conserva
   como `bootstrap_json` (punto 4) para no pagar un fetch extra en la carga directa, en
   `detalle` igual que en `plan`. Va en su variante **ligera** (`?lite=1`), la misma que
   pide la sección, porque si el servidor inyectara la completa y la sección pidiera la
   ligera el Store guardaría una copia con la etiqueta equivocada y volvería a pedir el
   detalle en la siguiente visita. Lo garantiza `_route_payload()` en `api/routes.py`,
   compartida por `GET /api/routes/<id>` y `sendero_page()`. La regla 10 de CLAUDE.md sigue
   viva, reescrita para `bootstrap_json`. El precio está en §5.6, punto 3: por eso el
   Service Worker **no** cachea esos documentos.
6. **Legacy**: `rutas.html`, `overview.html`, `planificacion.html` ya no se sirven;
   `sendero.html`, `plan_detalle.html` y `editor.html` se les unen al migrarse. Propuesta:
   **borrarlos todos en el mismo commit** que completa la fase (están en git, recuperables)
   en vez de acumular 6 plantillas muertas.

**Criterio de aceptación**: navegar dashboard → rutas → detalle → editor → atrás ×4 no
genera **ninguna** petición de documento HTML (solo `fetch` de API), y el botón Atrás
recorre las 6 vistas en orden inverso.

---

## 4. Fase 4 — Sincronización delta

El corazón del punto 3 del objetivo. Dos niveles, igual que la dedup: **metadatos** (baratos,
se sincronizan todos) y **detalle** (caro, se sincroniza a demanda y se invalida por `rev`).

### 4.1 Esquema: `sync_log` + contador, mantenidos por triggers

**No** se añade columna a `routes`: iría físicamente después de `geojson`/`elevation`/
`heart_rate` y obligaría a rehacer el índice de cobertura (regla 12, y el bug de los 7-9 s
documentado en CLAUDE.md). Tabla lateral:

```sql
-- Contador monotónico global. Una sola fila.
CREATE TABLE IF NOT EXISTS sync_seq (id INTEGER PRIMARY KEY CHECK (id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_seq(id, n) VALUES (1, 0);

-- Un registro por entidad viva o borrada. Las filas nunca se borran: op='del' es la
-- tombstone que permite que un cliente que estuvo semanas apagado sepa qué desapareció.
CREATE TABLE IF NOT EXISTS sync_log (
    entity    TEXT NOT NULL,          -- 'route' | 'photo' | 'planned'
    entity_id INTEGER NOT NULL,       -- id interno (la PK entera)
    public_id TEXT,                   -- el id opaco expuesto al cliente
    rev       INTEGER NOT NULL,
    op        TEXT NOT NULL,          -- 'up' | 'del'
    PRIMARY KEY (entity, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_log_rev ON sync_log(rev, entity, public_id, op);
```

Y un trigger por (tabla × operación), 9 en total:

```sql
CREATE TRIGGER IF NOT EXISTS trg_routes_ai AFTER INSERT ON routes BEGIN
  UPDATE sync_seq SET n = n + 1 WHERE id = 1;
  INSERT INTO sync_log(entity, entity_id, public_id, rev, op)
    VALUES ('route', NEW.id, NEW.public_id, (SELECT n FROM sync_seq WHERE id=1), 'up')
  ON CONFLICT(entity, entity_id) DO UPDATE SET
    rev = excluded.rev, op = excluded.op, public_id = excluded.public_id;
END;
-- …_au (AFTER UPDATE) idéntico; …_ad (AFTER DELETE) con op='del' y OLD.*
```

Por qué triggers y no código Python:

- Las mutaciones están en **13 sitios** repartidos por 5 blueprints (§0). Un trigger cubre
  también los que se añadan mañana, el backfill de `init_db()`, y cualquier `UPDATE` hecho a
  mano con `sqlite3` sobre `data/sendero.db`.
- `photos` cuelga de `routes` con `ON DELETE CASCADE`: **ojo**, el CASCADE solo dispara el
  trigger de `photos` si la conexión tiene `PRAGMA foreign_keys=ON`, que hoy **no** se
  activa en `core/database.py:db()` (por eso `api/routes.py:442` borra las fotos a mano
  antes de la ruta). Mientras siga siendo un borrado explícito, el trigger se dispara solo.
  Si algún día se activa `foreign_keys`, revisar esto.
- Cuidado con la recursión: `PRAGMA recursive_triggers` está **off** por defecto, así que un
  `UPDATE` dentro de un `AFTER UPDATE` sobre otra tabla no reentra. No se toca ese PRAGMA.

**Epoch**: `settings['sync_epoch']`, un token aleatorio generado la primera vez que corre la
migración. Si alguien restaura un backup, reconstruye la BD o el `rev` retrocede por
cualquier motivo, el epoch cambia y **todos los clientes hacen recarga completa** sin
quedarse con datos fantasma. Es la red de seguridad del esquema entero.

Migración en `init_db()`: todo con `CREATE … IF NOT EXISTS` + `INSERT OR IGNORE`, sin
`ALTER TABLE` → re-ejecutable por los 2 workers en paralelo (regla 13) sin `try/except`.
Backfill inicial: una pasada que inserta todas las filas existentes en `sync_log` con
`rev = 1..N` (o todas con `rev=1`, da igual: lo que importa es que un cliente nuevo con
`since=0` reciba todo).

### 4.2 Endpoint "¿ha cambiado algo?" — el más importante

```http
GET /api/sync/state
→ 200 {"epoch":"kJ8s_1cQ","cursor":12873,"counts":{"routes":48,"photos":42,"planned":3}}
  ETag: "kJ8s_1cQ:12873"
  Cache-Control: no-cache

GET /api/sync/state       (con If-None-Match: "kJ8s_1cQ:12873")
→ 304 Not Modified        ← sin cuerpo. Esta es la respuesta normal.
```

Coste en el servidor: `SELECT n FROM sync_seq` + 3 `COUNT(*)`. Coste en la red: unos cientos
de bytes de cabeceras. El cliente lo consulta al arrancar, al recuperar el foco de la
pestaña y cada N minutos: si es 304, **no hace nada más**. Eso sustituye el TTL de 10 min de
`sendero_routes_v4` por algo correcto: los cambios de otro dispositivo, de `watch.py` o de
`mifit_sync.py` aparecen en el siguiente sondeo, y un listado sin cambios no cuesta nada.

Los `counts` no son decorativos: son la comprobación de cordura barata contra el
`check.total!==allRoutes.length` que ya hace `app.html:1462` a mano.

### 4.3 Endpoint de diferencias

```http
GET /api/sync/changes?since=12873&limit=500
→ {
    "epoch": "kJ8s_1cQ",
    "cursor": 12920,
    "complete": true,                  ← false ⇒ volver a pedir con since=cursor
    "reset": false,                    ← true  ⇒ vaciar el store y empezar de cero
    "routes":  {"upserted":[{…14 columnas del listado…, "rev":12875}, …],
                "deleted":["Ab3xY_ttQ", …]},
    "planned": {"upserted":[…], "deleted":[…]},
    "photos":  {"upserted":[…], "deleted":[…]}
  }
```

Contrato:

- `since=0` ⇒ carga inicial completa (lo que hoy hace `GET /api/routes`).
- `reset:true` si `epoch` no coincide con el que manda el cliente (`?epoch=`), o si
  `since > cursor` (BD retrocedida), o si `since < settings['sync_min_rev']` (ver GC abajo).
- Paginación por `rev` con `limit`: el cliente itera hasta `complete:true`. Sin ventanas de
  tiempo ni offsets — el `rev` es un cursor estable.
- **Los `upserted` de rutas llevan exactamente las columnas del listado actual**
  (`api/routes.py:275`) más `rev`. Nada de `geojson`/`elevation`/`heart_rate`: eso es §4.4.
- Índice: `idx_sync_log_rev` cubre el filtro `rev > ?`; los datos de cada fila salen del
  `JOIN` con `routes` resuelto por `idx_routes_list_cov4` (que ya cubre las 14 columnas).
  Con `dup_suspect_of` hay que resolver además `dup_suspect_name`/`dup_suspect_public`, que
  hoy solo hace `_build_route_dict`; en el listado basta el `public_id` de la parecida.

**GC de tombstones**: no hacerlo. Una fila de `sync_log` son ~40 bytes; con 500 rutas y un
borrado ocasional, la tabla no llega a 100 KB en años. Se evita así toda la rama
"`since` demasiado viejo → recarga completa". `sync_min_rev` queda como escotilla por si
algún día hace falta purgar.

### 4.4 Detalle por ruta, invalidado por `rev`

El `rev` de la fase anterior es también el **validador de caché exacto** del detalle:

```http
GET /api/routes/<public_id>          (con If-None-Match: "12875")
→ 304 si la ruta no ha cambiado desde que el cliente la guardó
→ 200 {…dict completo…}  ETag: "12875"
```

El `ETag` es el `rev` de `sync_log`, así que:

- El store guarda `{public_id, rev, detalle}` en IndexedDB.
- Al abrir un detalle, si el `rev` del último `/api/sync/changes` coincide con el guardado,
  **se pinta desde IndexedDB sin tocar la red**. Si no coincide, se descarga solo esa ruta.
- Al editar una ruta (que ya crea versión nueva) el trigger sube el `rev` → el detalle se
  re-descarga automáticamente en todos los dispositivos. No hay que acordarse de invalidar
  nada en el frontend: desaparece la necesidad de `clearRouteCache()` disperso.

Lo mismo aplica a `/api/routes/<id>/points` (editor) y `/api/planned/<id>`.

### 4.5 Corroborar sin descargar: el manifiesto

Para responder "¿mi copia local es realmente igual a la del servidor?" sin bajar los datos:

```http
GET /api/sync/manifest
→ {"epoch":"kJ8s_1cQ","cursor":12920,
   "routes":[["Ab3xY_ttQ",12875],["Cd9zW_uuR",12801], …]}   ← [public_id, rev]
```

~30 bytes por ruta ⇒ **~15 KB con 500 rutas**, comprimido con brotli (flask-compress ya
está activo) bastante menos. El cliente compara conjuntos y detecta las tres anomalías que
un delta por `since` no puede ver por sí solo:

- **Sobrantes** locales que el servidor no tiene (una tombstone perdida por un fallo a
  medias, o una escritura offline que nunca llegó).
- **Faltantes** que el servidor tiene y el cliente no (delta interrumpido).
- **Divergentes**: mismo `public_id`, `rev` distinto (detalle obsoleto sin darse cuenta).

Y descarga **solo** las divergentes/faltantes. Es la operación de "verificar y reparar":
se lanza a mano desde Ajustes ("Comprobar sincronización"), tras un `reset`, y
automáticamente si `counts` de `/api/sync/state` no cuadra con lo que hay en el store.

### 4.6 Cliente: store en IndexedDB

`static/js/core/store.js`, object stores: `meta` (epoch, cursor, ajustes de sync),
`routes` (listado, key `public_id`), `route_detail` (`{public_id, rev, data}`),
`planned`, `photos`, `outbox` (§7).

- Sustituye `sessionStorage['sendero_routes_v4']` (5 MB de límite y se pierde al cerrar la
  pestaña) por IndexedDB (cientos de MB, persistente). La clave versionada de la regla 11
  sigue teniendo sentido: `DB_VERSION` de IndexedDB + `onupgradeneeded` que vacía los stores
  cuyo formato cambió.
- `navigator.storage.persist()` al instalar la PWA, para que el navegador no evacúe la caché
  por presión de disco.
- Toda lectura del frontend pasa por el store; el store decide red/local. Ninguna sección
  llama a `fetch` directamente.

**Criterio de aceptación**: (a) con la app abierta en dos navegadores, subir una ruta en uno
la hace aparecer en el otro en el siguiente sondeo, descargando solo esa ruta; (b) recargar
con el listado ya sincronizado genera **un 304 y nada más**; (c) borrar a mano una fila del
store y pulsar "Comprobar sincronización" la restaura.

---

## 5. Fase 5 — PWA: arrancar sin servidor

1. **`static/manifest.webmanifest`**: nombre "Sendero", `start_url:"/rutas"`,
   `display:"standalone"`, `theme_color:"#17241c"` (= `--panel`), iconos derivados de
   `static/icon.svg` (192/512 px PNG + maskable). Enlazado desde `base.html`.
2. **`static/sw.js`** (scope `/`, registrado desde el shell). Estrategias por tipo:

   | Recurso | Estrategia |
   |---|---|
   | Shell HTML | Precache + *stale-while-revalidate*, con **navigation fallback** al shell para cualquier URL de vista |
   | `static/vendor/`, `static/fonts/`, `static/js/` | *Cache-first* (nombres versionados) |
   | `/api/sync/*`, `/api/routes*` | *Network-first* con fallback a IndexedDB; offline ⇒ el store responde |
   | Miniaturas `/api/routes/<id>/thumb` | *Cache-first* con revalidación (ya llevan ETag/304) |
   | Fotos locales `/api/photos/<id>/file` | *Cache-first* (ya son `immutable`, max-age 1 año) |
   | Proxy Immich | *Network-only* + placeholder offline (caché privada de 7 días, no se puede garantizar) |
   | Teselas | ver §6 |

3. **Versionado del precache**: `CACHE = 'sendero-' + APP_VERSION`. Inyectar `APP_VERSION`
   (`core/config.py:20`, única fuente de verdad) en `sw.js` sirviéndolo desde una ruta Flask
   (`/sw.js` con `render_template`) en vez de como archivo estático, y borrar las cachés de
   versiones anteriores en el `activate`. **Añadir esto a la checklist de publicar versión**
   de CLAUDE.md: una versión nueva que no invalida el precache deja usuarios con JS viejo
   hablando con una API nueva, que es el fallo más difícil de diagnosticar de toda la fase.
4. **Indicador de estado offline** en el header (badge junto al logo): `online` /
   `sin conexión` / `sincronizando` / `N cambios pendientes`, leyendo del store y de
   `navigator.onLine`.
5. **Sin autenticación** (quirk conocido, intencional para LAN): no hay tokens en caché ni
   riesgo de servir datos de otro usuario desde la caché. Si algún día se añade login, hay
   que purgar la caché en el logout.

**Criterio de aceptación**: con el servidor **parado**, abrir la PWA muestra dashboard,
listado, mapa (§6) y el detalle de las rutas visitadas, con el badge en "sin conexión".

### 5.6 Implementado — y las tres desviaciones respecto a lo de arriba

Hecho: `api/pwa.py` (`/sw.js`, `/manifest.webmanifest`, `/app-shell`), `static/sw.js`,
`static/icons/` (192, 512 y maskable al 80%, generados de `static/icon.svg` con cairosvg),
`<link rel="manifest">` + `theme-color` en `base.html`, registro del SW y badge
`#net-badge` en `static/js/core/chrome.js`. Prueba de humo: `node tests/sw_smoke.js`
(ejecuta el SW con `caches`/`fetch` simulados: install, install con un 404, activate
borrando cachés viejas, y qué estrategia le toca a cada URL).

Tres cosas salieron distintas de lo planeado, y el motivo es el mismo en las tres — la
migración está a medias:

1. **El SW se registra desde `chrome.js`, no desde el shell.** Registrándolo solo en el
   shell, `/dashboard`, `/rutas` y `/planificacion` (que sirve `app.html`, las vistas más
   usadas) se quedarían sin caché de código. `chrome.js` lo carga `base.html`, así que
   cubre los dos mundos.
2. **No hay *navigation fallback* general al shell.** Solo caen al shell las rutas que el
   shell aloja hoy (`SHELL_PATHS` = `/Sendero/<id>` y `/Plan/<id>`); las demás reciben su
   documento cacheado y, si no lo tienen, una página de aviso. Servir el shell para
   `/rutas` daría una página en blanco, porque el shell no sabe montar esa sección
   todavía. Al migrar las tres vistas, `SHELL_PATHS` pasa a ser "cualquier vista".
3. **Los documentos de las vistas del shell NO se cachean** (el plan decía
   *stale-while-revalidate* del shell HTML). `/Sendero/<id>` lleva la ruta dentro como
   `bootstrap_json`: su HTML es una copia de los **datos**, y `Store.route()` confía en el
   bootstrap sin preguntar. Cachearlo haría que al recargar sin conexión ese bootstrap
   viejo pisara en IndexedDB una edición hecha sin conexión. Se precachea `/app-shell`
   (sin datos) y de los datos se encarga el Store, que es el único que sabe qué está
   obsoleto. Está como regla 16 en CLAUDE.md.

4. **Nuestro propio código no va *cache-first*, va *stale-while-revalidate*.** La tabla de
   arriba metía `static/js/` en cache-first "porque los nombres van versionados", y eso es
   verdad de `static/vendor/**` (`maplibre-gl-4.7.1.js`) pero **falso** de
   `static/js/**`, `static/css/**` y `shared.js`. Con caché primero, editar `detalle.js`
   sin subir `APP_VERSION` dejaría al navegador con el archivo viejo indefinidamente — el
   mismo fallo que §5.3 quiere evitar, pero por la puerta de atrás y sin publicar nada.
   Con revalidación por detrás el cambio llega en la siguiente carga aunque nadie toque la
   versión, y sin conexión se sigue sirviendo la copia guardada. Cache-first se queda para
   vendor, fuentes, iconos y manifiesto.

Consecuencia honesta del punto 2 mientras dure: **sin conexión funcionan los detalles de
rutas y planes ya sincronizados, pero no los listados.** El listado sigue leyendo de
`sessionStorage`/red, no del Store; eso se arregla en el paso siguiente, no aquí.

---

## 6. Fase 6 — Mapas sin conexión

La parte con más sustancia técnica y la que hay que decidir explícitamente, porque hay dos
escenarios de "sin conexión" con soluciones distintas:

- **Escenario A — el servidor está accesible, internet no** (LAN, Tailscale, casa sin ADSL).
  Es el caso mayoritario y el que se resuelve del todo: las teselas las sirve Sendero.
- **Escenario B — ni servidor ni internet** (móvil en el monte). Solo se puede mostrar lo
  que el navegador haya guardado antes, en una zona y unos zooms acotados.

### 6.1 Escenario A: basemap autoalojado con PMTiles

1. Un archivo **PMTiles** (un solo archivo, se lee por *range requests*, sin servidor de
   teselas) en `data/tiles/basemap.pmtiles`. Extracto regional generado con `planetiler` a
   partir de un `.osm.pbf` de Geofabrik, o descargado ya construido. Tamaño de referencia:
   España entera en vectorial, ~1-2 GB; una comunidad autónoma, decenas de MB.
2. Servirlo desde Flask con **soporte de `Range`** (`send_file` con `conditional=True` ya
   responde 206) en `/tiles/basemap.pmtiles`, o directamente por el reverse proxy.
   Persistencia en `/data` (regla 7). **Añadir `data/tiles/` a `.gitignore`** y documentar
   el volumen en los compose.
3. Vendorizar `pmtiles.js` (`static/vendor/`) y registrar el protocolo en MapLibre —
   3 líneas, sin build step:
   ```js
   const p = new pmtiles.Protocol();
   maplibregl.addProtocol('pmtiles', p.tile);
   ```
4. **Style, glyphs y sprite locales**: un basemap vectorial necesita, además de las teselas,
   un `style.json`, las fuentes en PBF (`glyphs`) y el `sprite`. Los tres se vendorizan en
   `static/map/` y el `style.json` apunta a rutas relativas. **Esto es lo que se olvida y
   deja el mapa sin etiquetas offline**: si `glyphs` sigue apuntando a un CDN, los nombres
   de los pueblos desaparecen sin internet aunque las teselas estén locales.
5. **Nueva capa "Offline (local)" en `BASEMAP_TILES`** (`static/shared.js:91`, que pasa a
   `core/basemaps.js`), y `buildStyle()` acepta tanto raster (las 4 actuales) como el estilo
   vectorial local. **Y arreglar `app.html:599-601`**: el mapa del dashboard tiene CartoDB
   hardcoded, así que hoy ignoraría cualquier capa nueva. Debe pasar por `buildStyle()`.
6. **Selección de capa por defecto configurable** en Ajustes → nueva sección "Mapas":
   `MAP_DEFAULT_LAYER` y `MAP_OFFLINE_PMTILES` (ruta/URL del archivo; vacío = capa offline
   oculta), en `settings` y en `_SETTINGS_KEYS` de `core/config.py:67` para que
   `refresh_config()` las recoja.

### 6.2 Escenario B: caché de teselas en el navegador, por zona

1. **Oportunista**: el Service Worker cachea con *cache-first* toda tesela que se pinte, con
   un límite (p. ej. 2.000 teselas / 200 MB, LRU). Coste cero de UI y cubre "las zonas por
   donde ya he navegado". Aplica solo a la capa offline local: **cachear masivamente teselas
   de OpenStreetMap u OpenTopoMap va contra su política de uso**, y de Esri/ArcGIS contra
   sus condiciones. La capa "Satélite" no tiene salida offline legal: hay que degradar
   mostrando un aviso ("esta capa necesita conexión"), no un mapa gris sin explicación.
2. **Deliberada**: botón "Descargar esta zona para uso sin conexión" en el mapa de Mis
   Rutas: toma el bbox visible, un rango de zooms (p. ej. 10-14), estima el número de
   teselas y los MB **antes** de empezar, pide confirmación y las precarga en Cache Storage
   con barra de progreso. Para PMTiles el equivalente es descargar los rangos de bytes
   necesarios, o —más simple y robusto— permitir descargar un `.pmtiles` recortado que el
   servidor genere para ese bbox y guardarlo en OPFS. **Recomendación**: empezar por la
   variante de teselas en Cache Storage (mucho más simple) y dejar el `.pmtiles` recortado
   como mejora posterior; la estimación de tamaño previa es obligatoria en ambas.
3. **Gestión del espacio** en Ajustes → Mapas: cuánto ocupa la caché, qué zonas hay
   descargadas, botón de vaciar. Sin esto la PWA se convierte en un agujero negro de disco
   que el usuario no puede inspeccionar.


#### Estado: **hecho, pero replanteado** — el mapa de UNA ruta, no de una zona

Al llegar aquí, la conversación con el usuario cambió el planteamiento, y a mejor:

> «que los mapas offline solo sean de las rutas, no hace falta de todos los mapas de todas
> las zonas, y el objetivo sería tener el mapa de una de las rutas a hacer en el futuro»

Eso convierte un problema grande en uno pequeño. Los números, medidos sobre la BD real:

| Ruta | Teselas z10-15 | Tamaño |
|---|---|---|
| 39 km en bici | 254 | ~6 MB |
| 34 km | 235 | ~6 MB |
| 14 km andando | 120 | ~3 MB |

Un **corredor** a lo largo del track (las teselas que pisa más un anillo de vecinas) son
**cientos** de teselas, no cientos de miles. Y resuelve el escenario que de verdad
importaba —el móvil en el monte con el servidor apagado en casa—, que la capa PMTiles de
§6.1 **no** resuelve, porque esa la sirve Sendero y necesita el servidor encendido.

**Implementación**
- `static/js/core/tiles.js`: `forTrack(coords)` calcula el corredor (zoom 10-15, anillo de
  1 tesela, ordenado de zoom bajo a alto para que una descarga cortada deje al menos la
  vista general); `download()` las guarda en la caché `sendero-tiles-v1`;
  `downloadForTrack()`/`statusForTrack()` son el flujo con su UI, compartidos por las dos
  vistas que lo ofrecen.
- Botón **«⬇ Mapa sin conexión»** en el detalle de ruta y en el de plan, con estimación y
  confirmación antes de empezar, barra de progreso, y aviso al reabrir la ruta si ya está.
- `static/sw.js`: las peticiones a otro host con forma `/{z}/{x}/{y}` van por
  `tileFirstNetwork()` — **red primero** (con conexión, la tesela real; una guardada puede
  ser de hace meses) y la caché como respaldo. Si no está, un 504 vacío: MapLibre lo trata
  como hueco y sigue pintando el track, que es lo que importa.
- La caché de teselas **no** lleva la versión en el nombre y `activate` no la borra: son
  megas que el usuario pidió a mano, y tirarlas al publicar sería quitarle el mapa que se
  llevó al monte. Se gestiona en Ajustes → Sin conexión (cuánto ocupa, borrar).

**Sobre los términos de uso**, que es lo que bloqueaba el planteamiento original: las 4
capas son de terceros y sus políticas piden no descargar en masa. La versión por ruta se
mantiene del lado razonable por construcción: es una acción explícita del usuario sobre una
ruta concreta, con tope duro (`MAX_TILES = 3000`), 3 descargas en paralelo y una pausa de
60 ms entre teselas (~50/s como techo). Descargar **regiones** sigue descartado.

**Lo que sigue sin hacerse, y ya como nota al pie**: guardar un `.pmtiles` completo en el
navegador con un `Source` propio de pmtiles.js. Con el mapa por ruta funcionando, deja de
ser necesario para el caso de uso real; y seguiría sin poderse probar, porque no hay ningún
`.pmtiles` en `data/tiles/`.

**Prueba**: `node tests/tiles_smoke.js` (geometría del corredor: tamaño, sin repetidos,
orden por zoom, URLs) y el bloque «Mapa sin conexión de UNA ruta» de `tests/e2e_spa.py`,
que descarga de verdad, corta la red y comprueba que la tesela del corredor se sirve (200)
y que una que no se descargó da 504 controlado. Ese test **quita su propio stub de teselas**
antes de comprobarlo: con el stub puesto respondería él y la prueba no demostraría nada.

### 6.3 Datos de ruta offline

Además de los mapas, para ver una ruta offline hace falta su detalle. Dos modos en Ajustes:

- **A demanda** (por defecto): se guarda el detalle de lo que se visita. Coste natural.
- **Todo el historial**: prefetch de las 500 rutas. Con el detalle completo son ~230 MB
  (§0), demasiado. Por eso `GET /api/routes/<id>?lite=1`: `geojson` decimado (como ya hace
  `/api/routes/geojson`, 1 de cada 4 puntos) y series de elevación/FC/velocidad remuestreadas
  a ~500 puntos ⇒ **~20-30 KB/ruta, ~15 MB para 500 rutas**. Suficiente para mapa, perfil y
  stats; el detalle completo se descarga si hay conexión al abrir el editor. El editor, que
  necesita los puntos exactos 1:1 con los `trkpt`, **no funciona offline** salvo para rutas
  cuyo `/points` esté cacheado, y eso hay que decirlo en la UI en vez de fallar raro.

**Criterio de aceptación**: en modo avión, con la zona descargada, el mapa de Mis Rutas
pinta basemap + líneas + iconos, y el detalle de una ruta prefetcheada muestra mapa y perfil
de elevación.

---

## 7. Fase 7 — Escrituras sin conexión

Solo tiene sentido tras §4-§6, y conviene mantenerlo deliberadamente pequeño.

1. **Cola `outbox`** en IndexedDB: las mutaciones *pequeñas e idempotentes* se encolan y se
   reenvían al recuperar conexión (Background Sync API donde exista, o al `online`):
   `PATCH /api/routes/<id>` (nombre, notas, actividad), `PATCH /api/planned/<id>`,
   `PATCH {dup_suspect_of:null}`.
2. **Lo que NO se encola**: subir GPX/FIT, subir fotos, guardados del editor, merge, split,
   elevación DEM. Motivos concretos, no pereza: la subida puede ser de decenas de MB; la
   dedup por `content_hash` y el 409 de `base_version` son **decisiones del servidor** que el
   cliente no puede simular; y el editor guarda por `ops` sobre un `base_version` que puede
   haber cambiado. En offline estos botones se deshabilitan con un tooltip explícito
   ("necesita conexión"), que es honesto y cuesta una línea.
3. **Conflictos**: el `PATCH` que vuelve de la cola gana por *last-write-wins* (son campos
   de texto editados por una sola persona; inventar CRDTs aquí sería absurdo). Excepción: si
   la ruta fue **borrada** mientras estaba offline, el `PATCH` da 404 → se descarta el ítem y
   se avisa con un toast. Si un guardado del editor encolado (caso 2, no aplicable hoy)
   diera 409 `version_conflict`, se descartaría igual con aviso.
4. **Visibilidad**: la cola se ve en el badge del header y se puede inspeccionar/vaciar
   desde Ajustes. Nada de reintentos infinitos silenciosos.

---

## 8. Orden de ejecución y valor entregado

| Fase | Entrega | Depende de |
|---|---|---|
| 1 Vendorizar | LAN sin internet funciona (salvo mapas) | — |
| 4 Sync delta | Cambios de otros dispositivos visibles; deja de re-descargar el listado | — (independiente del frontend) |
| 2 Extraer JS | Código cacheable, sin regresiones funcionales | 1 |
| 3 SPA completa | Navegación sin recargas en las 6 vistas | 2, 4 |
| 6.1 PMTiles | Mapas sin internet en escenario A | 1 |
| 5 PWA/SW | Arranca sin servidor | 2, 3, 4 |
| 6.2/6.3 Offline real | Mapas y rutas en modo avión | 5, 6.1 |
| 7 Escrituras | Editar metadatos offline | 5 |

**Las fases 1 y 4 son independientes entre sí y del resto**: se pueden hacer y publicar ya,
cada una con su valor propio y sin tocar la arquitectura del frontend. La 4 sola ya arregla
el TTL de 10 minutos y el re-descargar el listado completo en cada invalidación.

Sugerencia de versionado: `0.6.0` = fases 1+4 (API y caché nuevas, sin cambio visible
grande) · `0.7.0` = fases 2+3 (SPA completa) · `0.8.0` = fases 5+6 (PWA offline con mapas) ·
`0.9.0` = fase 7. Cada una con su entrada en `CHANGELOG.md` y los 4 puntos de "Publicar una
versión" de CLAUDE.md.

---

## 9. Riesgos y trampas concretas

1. **Los triggers no se disparan si alguien escribe con `executescript` en otra conexión sin
   ellos.** No es el caso hoy (los triggers viven en el esquema, no en la conexión), pero sí
   pasa si un script externo abre la BD y hace `PRAGMA ignore_check_constraints` o escribe
   por `.import`. `watch.py` y `mifit_sync.py` suben por HTTP a `/api/routes`, así que están
   cubiertos. Verificarlo en el smoke test, no asumirlo.
2. **`rev` no es una fecha.** No usarlo para ordenar por antigüedad ni mostrarlo al usuario.
   Es un cursor opaco; si se filtra a la UI, alguien acabará dependiendo de su valor.
3. **Fuga de memoria al convertir a SPA** (§2): sin `unmount()` que destruya mapas y charts,
   navegar 20 veces entre secciones degrada el navegador. Es el riesgo más probable de todo
   el plan porque no falla de golpe, se degrada.
4. **Precache del Service Worker desactualizado** (§5.3): la causa nº 1 de "he desplegado y
   no se ve el cambio" en cualquier PWA — y en esta instalación ya existe un quirk casi
   idéntico con los procesos `gunicorn` huérfanos de Docker Desktop/WSL2. Ante un cambio que
   no se refleja, **descartar primero el SW** (DevTools → Application → Unregister) y
   **después** mirar los huérfanos: si no, se depuran dos capas de caché a la vez.
5. **Tamaño del PMTiles** (§6.1): un extracto de más de ~2 GB en `/data` sobre un bind mount
   de WSL2 va lento en *range requests*. Medir con la zona real de uso antes de decidir el
   alcance geográfico.
6. **Políticas de uso de teselas** (§6.2): la descarga masiva de OSM/OpenTopoMap/Esri no está
   permitida. El offline de mapas se apoya en teselas propias; las 4 capas actuales siguen
   siendo online-only y hay que decirlo en la UI.
7. **`counts` vs realidad**: si `/api/sync/state` dice 500 y el store tiene 499, el cliente
   debe ir al manifiesto (§4.5), no re-descargar todo. Si la reparación por manifiesto
   también falla, entonces sí, `reset`.
8. **La primera carga del detalle puede empeorar** al quitar la inyección Jinja (§3.4). Es un
   coste real de la SPA; medirlo con Network throttling y, si duele, usar el `bootstrap` JSON.

---

## 10. Tests y smoke test

`tests/` corre sin BD ni Flask (funciones puras). Lo que encaja ahí:

- `tests/test_sync.py`: la lógica pura de diff del manifiesto (dado `local` y `remoto`,
  devolver faltantes/sobrantes/divergentes) extraída a `core/sync.py` como función pura.
- Para los triggers hace falta BD: test con `sqlite3` en memoria que aplique el mismo DDL de
  `init_db()` y compruebe que `INSERT`/`UPDATE`/`DELETE` sobre `routes` mueven `sync_seq` y
  dejan la fila correcta en `sync_log`. Es el único test nuevo que toca SQLite y merece la
  excepción a la regla de "sin BD" (o un `conftest` que construya la BD en `tmp_path`).

Además, dos pruebas de humo de JS que se lanzan con **Node a pelo** (sin npm, sin
dependencias: regla 1; pytest ignora los `.js`):

```bash
node tests/sw_smoke.js    # SW con caches/fetch simulados: install (y con un 404),
                          # activate borrando cachés viejas, estrategia por URL,
                          # y el comportamiento sin conexión de cada tipo de vista
node tests/sec_smoke.js   # carga sec/detalle.js contra los ids REALES del markup:
                          # pilla un selector que ya no existe y comprueba que
                          # unmount() es seguro antes del primer mount()
```

Smoke test manual, tras cada fase:

```bash
# Fase 1
#   Bloquear unpkg/cdnjs/fonts.googleapis en DevTools → la app debe cargar entera.
# Fase 4
curl -s localhost:8090/api/sync/state                       # cursor N
curl -F "gpx=@ruta.gpx" localhost:8090/api/routes           # 201
curl -s localhost:8090/api/sync/state                       # cursor > N
curl -s "localhost:8090/api/sync/changes?since=N"           # 1 upserted, la nueva
curl -si -H 'If-None-Match: "<epoch>:<cursor>"' localhost:8090/api/sync/state   # 304
curl -s localhost:8090/api/sync/manifest | head -c 300      # [public_id, rev]
curl -X DELETE localhost:8090/api/routes/<public_id>
curl -s "localhost:8090/api/sync/changes?since=N"           # ahora en deleted
# Fase 5 (hecha)
curl -si localhost:8090/sw.js | head -3            # 1ª línea: self.APP_VERSION = "X.Y.Z"
curl -sI localhost:8090/manifest.webmanifest       # application/manifest+json
curl -s localhost:8090/app-shell | grep -c bootstrap   # 0: el shell precacheado va sin datos
#   Y que TODAS las URLs de PRECACHE_URLS devuelvan 200 (un 404 no rompe la instalación,
#   pero deja esa pieza sin cachear y la app no arranca sin conexión).
#   DevTools → Application → Service Workers → "Offline"; recargar un /Sendero/<id> ya
#   visitado: debe pintarse entero (shell precacheado + detalle de IndexedDB), y el badge
#   del header decir "sin conexión". Editar las notas ahí: se guardan y el badge pasa a
#   "1 sin enviar"; volver a poner red → se envía solo y el badge desaparece.
#   Parar el contenedor y repetir: mismo resultado.
#   Lo que AÚN NO funciona sin conexión: /rutas y /dashboard (listado por red, §5.6).
```

Y las comprobaciones que ya exige CLAUDE.md y que este plan pone en riesgo:

- ¿Sigue arrancando `python app.py` con `init_db()` (dos veces en paralelo) sin error?
- ¿El thumb se genera y `thumb_file` se guarda tras `create_route`/`rescan_route`?
- ¿Los dos caminos de fotos (local y `immich_id`) siguen funcionando?
- ¿La paridad `doOp()` ↔ `apply_ops()` sigue intacta tras mover `editor.js`?
- ¿`_build_route_dict()` y `/api/routes/<id>` devuelven los mismos campos?
- ¿El hover sincronizado del detalle (`static/js/sec/detalle.js`) sigue funcionando en las
  4 direcciones?

---

## 11. Actualizaciones pendientes de CLAUDE.md (al implementar)

No dejar esto para el final: CLAUDE.md es la fuente de verdad del proyecto y varias de sus
afirmaciones dejarán de ser ciertas.

- La tabla de plantillas y la lista de rutas Flask: 6 vistas en un shell, no 6 archivos.
  → **hecho** para `plan` y `detalle`; queda actualizarla al migrar las otras 4.
- La regla 10 (`{{ route_json | safe }}`) desaparece cuando se quite la inyección.
  → **no se quita** (ver §3, punto 5): reescrita para `bootstrap_json`. Y regla **16**
  nueva: el SW no cachea documentos con datos inyectados dentro.
- La regla 11 (clave de caché en `sessionStorage`) pasa a ser la versión de IndexedDB.
  → pendiente: hoy sigue habiendo las dos (`sendero_routes_v4` en `app.html` y
  `DB_VERSION` en `store.js`), y muere la primera al migrar `rutas`/`dashboard`.
- La checklist de publicar versión: `APP_VERSION` también invalida el precache del SW.
  → **hecho**.
- Sección nueva de `sync_log`/`sync_seq`/triggers en "Modelo de datos", con la nota de que
  **toda tabla nueva sincronizable necesita sus 3 triggers**.
- Sección nueva del Service Worker, y **`APP_VERSION` como versión del precache** añadido a
  la checklist de "Publicar una versión".
- Corregir el dato de que `plan_detalle.html` usa MapLibre (hoy usa Leaflet) — al unificar
  en la fase 1 pasa a ser cierto.
- Quirk nuevo: al depurar "no se refleja el cambio", descartar el Service Worker antes de
  los procesos `gunicorn` huérfanos.
