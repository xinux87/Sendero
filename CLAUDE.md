# CLAUDE.md

Contexto para trabajar en **Sendero** (bitácora autoalojada de rutas de montaña).
El README explica *qué hace* y cómo desplegarlo; este archivo cubre lo que necesitas
para tocar el código sin romperlo. Si algo de aquí contradice al README, este manda.

## Qué es, en una frase
Monolito Flask + SQLite que sube/visualiza GPX y FIT, les asocia fotos (locales o de
Immich por referencia), genera thumbnails PNG de cada track y guarda un resumen por ruta.

## Qué forma tiene hoy
**Una SPA**: las 6 vistas (dashboard, rutas, planes, detalle de ruta, detalle de plan,
editor) son secciones de un único documento (`templates/shell.html`), y todo el JS de
vista vive en `static/js/sec/` (ver "Frontend"). Cambiar de sección no pide ningún
documento nuevo: solo el JSON que haga falta, y a menudo ni eso.

**Y una PWA que funciona sin conexión**, apoyada en un Service Worker que precachea el
shell y el código, y en un almacén local (IndexedDB) que se pone al día con
sincronización delta. Lo que eso significa en la práctica:

- **Funciona sin conexión**: abrir la app en cualquier vista (shell y código
  precacheados), los listados de rutas y planes, el dashboard (con las últimas
  estadísticas guardadas, avisando), el detalle de rutas y planes ya sincronizados, el
  mapa base si hay un `.pmtiles` en `data/tiles/`, y editar nombre/notas/actividad (se
  encolan y se envían al volver la red).
- **NO funciona sin conexión, a propósito**: el **editor** (opera sobre el estado
  guardado en el servidor y cada guardado lleva `base_version`; encolar eso sería
  inventarse decisiones del servidor), subir rutas o fotos, Immich, reescanear y borrar.
  Todas avisan en vez de fallar en silencio.
- **Mapa sin conexión por ruta**: el botón «⬇ Mapa sin conexión» del detalle de una ruta
  o de un plan descarga solo el **corredor** de teselas del track (40 km ≈ 250-380
  teselas ≈ 6-9 MB), no una región. Es lo que hace que el mapa se vea con el **servidor
  apagado** — la capa PMTiles la sirve Sendero, así que esa necesita el servidor encendido.
  Descargar regiones enteras está descartado: las 4 capas son de terceros y su política
  de uso no lo admite.
- **Al publicar**: `APP_VERSION` invalida el precache del Service Worker, así que ningún
  cambio de frontend debe salir sin subir la versión (ver "Publicar una versión").

> Lo que queda por hacer, lo que falta por probar y lo que se ha descartado a propósito
> está en **`WHATS_NEXT.md`**. Míralo antes de proponer trabajo nuevo: la lista de
> descartados existe para no reabrir discusiones ya cerradas.

## Comandos
```bash
# desarrollo
pip install -r requirements-dev.txt   # incluye requirements.txt + pytest
python app.py                      # http://localhost:8080, init_db() automático
python -m pytest                   # tests unitarios (tests/): editing, parsers, FIT, gps_analysis, columnas del listado
node tests/sw_smoke.js             # Service Worker: install/activate + estrategias (solo Node)
node tests/sec_smoke.js            # sec/detalle.js carga contra los ids reales del markup
node tests/tiles_smoke.js          # geometría del corredor de teselas (§6.2)
node tests/speedfix_smoke.js       # velocidad excesiva y convergencia de «Corregir todo»
node tests/gps_parity_smoke.js     # el detector de avisos GPS del cliente == el del servidor

# end-to-end en un navegador real (Playwright; NO va en requirements-dev.txt)
python -m venv /tmp/pw && /tmp/pw/bin/pip install playwright
/tmp/pw/bin/playwright install chromium
SENDERO_DATA=/tmp/sendero-e2e python app.py &        # ¡datos de PRUEBA, no los reales!
python tests/e2e_seed.py http://localhost:8080       # siembra 3 rutas + 1 plan
SENDERO_E2E_URL=http://localhost:8080 /tmp/pw/bin/python tests/e2e_spa.py

# y una de SOLO LECTURA que sí se puede lanzar contra la instalación real:
SENDERO_E2E_URL=http://localhost:8090 /tmp/pw/bin/python tests/e2e_real_readonly.py

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

`APP_VERSION` también **invalida el precache del Service Worker**: `/sw.js` la inyecta
delante del archivo (`api/pwa.py`), así que al cambiarla el archivo cambia, el navegador
instala el SW nuevo y su `activate` borra las cachés `sendero-shell-*`/`sendero-doc-*` de
versiones anteriores. Por eso el punto 1 no es opcional: publicar cambios de frontend sin
subir `APP_VERSION` deja a los clientes con el JS viejo hablando con la API nueva, que es
el fallo más difícil de diagnosticar que tiene este proyecto.

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
  config.py     — paths (GPX_DIR, PHOTO_DIR, THUMB_DIR, VERSIONS_DIR, TILES_DIR, DB_PATH),
                  variables Immich y de mapas (MAP_OFFLINE_FILE/MAP_DEFAULT_LAYER…)
  database.py   — init_db(), close_db(), helper db() (conexión por request vía g.db),
                  public_id (set_public_id/rid_from_public/plan_id_from_public) y el
                  esquema de sincronización: sync_seq/sync_log + los 9 triggers,
                  sync_cursor()/sync_epoch()/entity_rev()
  sync.py       — lógica PURA de la sincronización: diff_manifest(local, remoto) →
                  {missing, stale, extra}, decimate() y resample() para ?lite=1
                  (tests en tests/test_sync.py)
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
  mifit/        — cliente Huami (Mi Fit/Zepp) vendorizado de MiFitDataExport:
                  api.py (HTTP+modelos), points.py (decodifica el detalle crudo),
                  gpx.py (build_gpx/workout_filename), sync.py (iter_new_workouts).
                  Solo el camino GPX-por-token; añade únicamente 'pydantic' a deps.

api/
  routes.py     — CRUD de rutas + rescan + thumb + stats
  editor.py     — editor de rutas: página, /points, guardado por ops, versiones
  photos.py     — subida y borrado de fotos locales; proxy de fotos Immich
  planned.py    — CRUD de rutas planificadas
  immich_api.py — candidatos Immich, selección, proxy de miniaturas
  settings.py   — lectura/escritura de ajustes (Immich, tipos GPX personalizados) y
                  /api/storage (tamaño de /data por carpeta, con un stat por archivo)
  mifit.py      — ajustes/estado/disparo de la auto-importación Mi Fit/Zepp
  sync.py       — sincronización delta: /api/sync/state (ETag → 304), /changes, /manifest
  maps.py       — mapa base offline: sirve data/tiles/*.pmtiles con Range (206) y
                  /api/maps; map_cfg() se inyecta en <body data-map-cfg>
  pwa.py        — /sw.js (static/sw.js con APP_VERSION inyectada delante),
                  /manifest.webmanifest y /app-shell (el shell SIN datos, lo que
                  precachea el SW). Las tres en la raíz a propósito: el ámbito de
                  un Service Worker es su carpeta, desde /static no controlaría nada
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
Además hay cinco pruebas de humo de JavaScript que se lanzan con **Node a pelo** (sin npm
ni dependencias, regla 1; pytest ignora los `.js`): `node tests/sw_smoke.js` ejecuta
`static/sw.js` con `caches`/`fetch` simulados y comprueba install/activate y qué
estrategia le toca a cada URL; `node tests/sec_smoke.js` carga `static/js/sec/detalle.js`
contra los ids reales de `templates/sec/detalle.html` (pilla un selector que ya no existe);
`node tests/tiles_smoke.js` mide el corredor de teselas; y `node tests/speedfix_smoke.js`
extrae del propio `sec/editor.js` la geometría de la corrección de velocidad excesiva
(`planSpeedFix`/`detectSpeedErr`) y la ejecuta contra tracks sintéticos con saltos de GPS.

Rendimiento transversal: la BD corre en WAL (`init_db()`), las respuestas de texto van
con gzip/brotli (flask-compress en `app.py`, mínimo 500 bytes), y los binarios llevan
caché: thumbs con ETag/304 (revalidación: se regeneran con el mismo nombre), fotos
locales inmutables con max-age 1 año, proxys Immich con caché privada de 7 días.

### Frontend — una SPA, un documento, 6 secciones

**Todas las vistas viven en `templates/shell.html`**, que no lleva datos dentro y
aloja las 6 secciones. Cada una son tres archivos con el mismo nombre:

| Sección | URL | Markup | Lógica | Estilos |
|---|---|---|---|---|
| `dashboard` | `/dashboard` | `templates/sec/dashboard.html` | `static/js/sec/dashboard.js` | `static/css/dashboard.css` |
| `rutas` | `/rutas` | `sec/rutas.html` | `js/sec/rutas.js` | `css/rutas.css` |
| `planes` | `/planificacion` | `sec/planes.html` | `js/sec/planes.js` | `css/planes.css` |
| `detalle` | `/Sendero/<public_id>` | `sec/detalle.html` | `js/sec/detalle.js` | `css/detalle.css` |
| `plan` | `/Plan/<public_id>` | `sec/plan.html` | `js/sec/plan.js` | `css/plan.css` |
| `editor` | `/Sendero/<public_id>/editor` | `sec/editor.html` | `js/sec/editor.js` | `css/editor.css` |

El router (`static/js/core/router.js`) monta la sección según `location.pathname`,
así que **navegar entre vistas no pide ningún documento**: solo el JSON que haga
falta, y a menudo ni eso (lo tiene el Store).

**Las seis vistas siguen el rediseño**, con la opción **2a** en pantalla grande y
la **2d** en móvil: `detalle`, `rutas` y `dashboard` desde la v0.9.0, `planes` +
`plan` desde la v0.9.3 y `editor` desde la v0.9.4. El patrón, si añades una
séptima: panel `--panel` + borde `--line` + radio 12, título de panel en
`.panel-title`, cifras en Oswald, datos en mono, y las unidades en el título del
panel en vez de en el eje de la gráfica.

> **La carpeta `redesign/` ya no existe** (ni en disco ni en git; era local y se
> perdió). Las referencias que quedaban a `redesign/README.md` y
> `redesign/screenshots/` no llevan a ninguna parte: la fuente de verdad del
> patrón son las vistas ya hechas, sobre todo `sec/detalle.*` y `sec/rutas.*`.

### Tokens de diseño — están en `templates/base.html` y en ningún otro sitio
| Token | Valor | Uso |
|---|---|---|
| `--bg` / `--bg-deep` | `#0b120e` / `#070c09` | fondo de app / lienzo |
| `--panel` / `--panel-2` | `#101a14` / `#16241c` | tarjetas y paneles / inputs y filas realzadas |
| `--line` / `--line-strong` | `rgba(236,229,216,.09)` / `.16` | borde de tarjeta / de control |
| `--ink` | `#ece5d8` | texto principal (crema) |
| `--muted` / `--muted-dim` / `--muted-faint` | `#8b9a8f` / `#7f9184` / `#68786d` | texto secundario / etiquetas / ejes y fechas |
| `--sage` | `#8fb69f` | títulos de panel y curvas de nivel |
| `--pr-yellow` | `#e3b23c` | ámbar: cifras clave, estado activo, avisos |
| `--gr-red` | `#e2492c` | rojo: acción primaria (`--gr-red-hover` al pasar) |
| `--display` / `--mono` | Oswald / IBM Plex Mono | títulos y cifras / datos y etiquetas |

Los colores de actividad viven en `ACTIVITIES` (`static/shared.js`), no en CSS:
`senderismo #e8863c` · `bicicleta #3d9be9` · `caminata #43b97f` · `correr #e34b4b` ·
`esquí #a86ee0` · `otros #e055c0`, con el glifo del icono en `#0b120e` (tinta oscura
sobre el color, no blanca). **Nada de hex sueltos** en plantillas ni en el CSS de
las secciones: si necesitas un color que no está, añade el token aquí. Las únicas
excepciones son los `rgba()` de velos y separadores del propio rediseño y los
colores de serie de las gráficas (elevación `#f0b070`, velocidad `#3d9be9`, FC
`#e34b4b`, barras `#3f5a49`/`#4e7159`/`#e8863c`), que van en el JS que las pinta.

> **En `templates/` solo hay tres cosas**: `base.html` (el chrome: cabecera, modal
> de Ajustes, CSS global), `shell.html` (el shell de la SPA) y `sec/` con las 6
> secciones. Nada más. La app multipágina anterior (`app.html`, `sendero.html`,
> `editor.html`, `rutas.html`, `overview.html`, `planificacion.html`,
> `plan_detalle.html`) se borró tras la v0.7.1; si necesitas ver cómo era algo
> antes de la SPA: `git show v0.7.1:templates/app.html`.

**Si añades una sección nueva** hacen falta cinco cosas, y olvidar cualquiera la
rompe de una forma distinta: (1) el archivo en `templates/sec/`, incluido en
`shell.html`; (2) su ruta en `ROUTES` de `router.js`; (3) su `.js` y `.css` en
`PRECACHE_URLS` de `static/sw.js` (si no, no se puede montar sin conexión); (4) su
URL en `SHELL_PATHS` del mismo archivo (si no, sin conexión da la página de aviso
en vez del shell); (5) la ruta Flask que sirva `shell.html`.

**Sin build step (regla 1), pero el JS ya no va todo inline.** Reparto:

```
static/vendor/     maplibre-gl-4.7.1.js|css, chart-4.4.1.umd.min.js, pmtiles-3.0.6.js
                   (antes unpkg/cdnjs; nombre con versión = cacheables como inmutables)
static/fonts/      Oswald + IBM Plex Sans + IBM Plex Mono en .woff2 + fonts.css
                   (autoalojadas: el contenedor no pide nada a internet). Oswald e
                   IBM Plex Sans son VARIABLES: un archivo por subconjunto cubre
                   los pesos 400-600; IBM Plex Mono es estático, uno por peso. Solo
                   los subconjuntos latin y latin-ext. La cabecera de fonts.css
                   explica cómo regenerarlas
static/sw.js       Service Worker (lo sirve /sw.js, no /static/sw.js — ver api/pwa.py)
static/icons/      icon-192.png, icon-512.png, icon-maskable-512.png, generados de
                   static/icon.svg con cairosvg (el maskable al 80% sobre el fondo)
static/shared.js   ACTIVITIES/activityOf/iconSvg/_loadActImages, BASEMAP_TILES,
                   buildStyle/basemapNames/defaultBasemap/applyBasemap, MAP_CFG
static/js/core/    chrome.js  helpers globales ($, toast, fmtKm/fmtDur/fmtDate, esc)
                              + TODO el modal de Ajustes + registro del Service
                              Worker + badge de conexión + Ajustes → Sin conexión.
                              Se carga en base.html (sin IIFE a propósito: lo
                              llaman los onclick=)
                   loader.js  loadOnce()/loadCssOnce(): inyecta el <script>/<link>
                              de una sección una sola vez
                   router.js  Router de las 6 vistas + window.go()
                   store.js   IndexedDB + sincronización delta + outbox (§4/§7)
                   tiles.js   mapa sin conexión de UNA ruta: corredor de teselas
                              del track, caché `sendero-tiles-v1` y su UI (§6.2)
static/js/sec/     un archivo por sección, en IIFE, publicando
                   window.SEC.<sec> = {mount(params,opts), unmount()}
static/css/        el CSS de cada sección migrada, escopado bajo #sec-<sec>
templates/sec/     el markup de cada sección migrada
```

**Son `<script>` clásicos, no módulos ES**: hay 121 atributos `onclick=` en las
plantillas y un módulo ES no expone nada al ámbito global, así que se romperían
todos. Por eso cada sección va en su IIFE y publica lo que la plantilla necesita en
`window.SEC.<sec>` (los `onclick=` llaman `SEC.plan.saveNotes()` etc.).

**`unmount()` DEBE destruir el mapa MapLibre y los `Chart` de la sección.** Sin eso,
navegar entre secciones deja instancias vivas con sus listeners y el navegador se
degrada poco a poco (no falla de golpe: es la fuga nº 1 de esta conversión).
Los listeners de `document` de una sección se registran **una vez** al cargar el
archivo, nunca en `mount()`.

| Archivo | Ruta Flask | Contenido |
|---------|-----------|-----------|
| `templates/base.html` | — | CSS global, header (con el badge `#net-badge` de estado de conexión), toast, modal de Ajustes, `<link rel="manifest">` y `theme-color`. Carga `static/vendor/*`, `static/fonts/fonts.css`, `static/shared.js` y `static/js/core/chrome.js` (que registra el Service Worker). No redeclares en una plantilla nada que ya esté en `shared.js`/`chrome.js` (dos `const` globales con el mismo nombre en scripts distintos = SyntaxError) |
| `templates/shell.html` | **todas** las vistas (`/dashboard`, `/rutas`, `/planificacion`, `/Sendero/<id>`, `/Sendero/<id>/editor`, `/Plan/<id>`, `/app-shell`) | Shell de la SPA: incluye los 6 `templates/sec/*.html`, la tab bar, las acciones de cabecera por sección (`data-sec-actions`), carga `core/loader.js`+`store.js`+`router.js` y llama a `Router.start()`. Cero datos inyectados salvo el `bootstrap_json` opcional de la primera carga (`/app-shell` lo sirve **sin** él: es el que precachea el SW) |
| `templates/sec/detalle.html` | (sección `detalle` del shell) | Detalle de ruta con el rediseño 2a/2d: **mapa cabecera** (`.d-hero`, 360 px, con el título y el chip de actividad encima del velo), banda de 7 métricas (`#d-stats`), y cuerpo a dos columnas (perfil + velocidad + FC + fotos ‖ datos técnicos + calidad del track + resumen). En móvil el cuerpo son pestañas: `data-tab` en la sección y `data-dtab` en cada bloque (ver «Pestañas del detalle en móvil»). Los ids genéricos llevan prefijo `d-` (`#d-map`, `#d-stats`, `#d-elev`, `#d-notes`…) para no chocar con otras secciones del mismo documento |
| `templates/sec/plan.html` | (sección `plan` del shell) | Detalle de ruta planificada. Lógica en `static/js/sec/plan.js`, estilos en `static/css/plan.css` |
| `templates/sec/dashboard.html` | (sección `dashboard`) | "Analítica global": selector de año, 5 KPIs, desnivel por mes, zonas más visitadas, almacenamiento, mapa de todas las rutas, "Por actividad", "Rutas por año" y récords. Lógica en `static/js/sec/dashboard.js` |
| `templates/sec/rutas.html` | (sección `rutas`) | Listado con filtros (actividad, fechas y **buscador**), mapa de visión general, tres vistas (⊞ Cuadrícula · ☰ Tabla · ▤ Panel), modo edición y subida de GPX/FIT. Lógica en `static/js/sec/rutas.js` |
| `templates/sec/planes.html` | (sección `planes`) | Tarjetas de rutas planificadas, mapa y alta por GPX. Lógica en `static/js/sec/planes.js` |
| `templates/sec/editor.html` | (sección `editor`) | Editor de rutas. Lógica en `static/js/sec/editor.js`; sus metadatos de arranque los da `GET /api/routes/<id>/editor` |

### Navegación
- **La URL canónica de todo es el `public_id`**, en rutas y en planes: `/Sendero/<pid>`,
  `/Sendero/<pid>/editor`, `/Plan/<pid>`. Por nombre el servidor redirige 302 (enlaces y
  marcadores viejos siguen funcionando), pero no lo generes: el nombre es ambiguo con
  rutas repetidas y cambia al renombrar. Única excepción viva: las tarjetas de récords
  del dashboard, porque el caché de stats en `settings` solo guarda el nombre.
- Tarjeta en "Mis Rutas" → `openRoute(r.public_id)` (guarda el encuadre del mapa en
  memoria del módulo y navega con `go()`; al volver, `initMap()` lo restaura)
- Tarjeta en "Mis Planes" → `location.href = '/Plan/' + p.public_id`
- Cambio de sección (Dashboard ↔ Mis Rutas ↔ Mis Planes) → SPA con `_showSec(name)`
- Dentro del shell nuevo: `Router.go(url)` / `window.go(url)`, o un `data-nav="/url"`
  en cualquier elemento (el router delega el click); si la vista destino no está en
  el documento, cae a `location.href` sola
- Botón "← Volver" en detalle → `data-nav="/rutas"` (el router cae a `location.href`
  porque el documento actual no aloja esa sección)
- Renombrar ruta **ya no toca la URL**: al ir por `public_id` la URL no depende del
  nombre (antes hacía falta `history.replaceState`)
- El botón Atrás del navegador funciona vía `window.addEventListener('popstate', ...)`

### Rutas Flask completas

| Método | URL | Handler |
|--------|-----|---------|
| GET | `/` | redirect → `/dashboard` |
| GET | `/dashboard` · `/rutas` · `/planificacion` | `shell.html` (secciones `dashboard`/`rutas`/`planes`); sin datos inyectados, los pide el Store |
| GET | `/Sendero/<public_id>` | `shell.html` (sección `detalle`) con la ruta como `bootstrap_json` en su variante **ligera** (`?lite=1`, la misma que pide la sección: si no coincidieran, el Store guardaría en IndexedDB algo distinto de lo que sirve la red y pediría el detalle otra vez). Por nombre redirige 302 al `public_id` |
| GET | `/Plan/<public_id>` | `shell.html` (sección `plan`) con el plan como `bootstrap_json`; por nombre redirige 302 al `public_id` |
| GET | `/app-shell` | `shell.html` **sin** `bootstrap_json`. Lo precachea el Service Worker y es lo que se sirve al navegar sin conexión a una vista que el shell aloja |
| GET | `/sw.js` | `static/sw.js` con `self.APP_VERSION = "X.Y.Z"` inyectada delante (`Cache-Control: no-cache`, `Service-Worker-Allowed: /`) |
| GET | `/manifest.webmanifest` | manifiesto de la PWA (`application/manifest+json`). El `<link>` de `base.html` lo pide con `crossorigin="use-credentials"` (ver Quirks: proxy con autenticación) |
| GET | `/actualizar` | página de reparación: desregistra el Service Worker, borra sus cachés, la IndexedDB del Store y las preferencias de sesión, y ofrece volver a la app. `Cache-Control: no-store`, el SW **no la intercepta** y su JS va inline (un `<script src>` podría venir de la caché vieja, que es el problema que arregla). Enlazada desde Ajustes → Sin conexión |
| GET | `/api/routes` | lista paginada (incluye `thumb_file`); sin `limit` devuelve todas (es barata, ~130 KB/500 rutas) |
| GET | `/api/routes/geojson` | FeatureCollection de líneas decimadas (props: id, name, activity, year, km). Acepta `?bbox=minLon,minLat,maxLon,maxLat`; sin él devuelve todas (no lo usa el dashboard salvo fallback) |
| POST | `/api/routes` | crea ruta desde GPX o FIT; genera thumb. Dedup (ver sección): 409 exacta (hash) o blanda (firma); `?auto=1` importa la blanda marcada (`dup_suspect_of`) en vez de bloquear; `?force=1` la importa limpia (el usuario ya la aceptó en la web) |
| GET | `/api/routes/<id>` | dict completo de la ruta. Lleva `rev` y `ETag` (= rev de `sync_log`): con `If-None-Match` responde **304** si no ha cambiado. `?lite=1` = track decimado y series remuestreadas a ~500 puntos (~20-30 KB en vez de ~350 KB; el editor necesita el completo) |
| PATCH | `/api/routes/<id>` | actualiza name/notes/activity_type/immich_checked/device; `dup_suspect_of=null` descarta el aviso de posible duplicada |
| DELETE | `/api/routes/<id>` | borra ruta + fotos + GPX + thumb + versiones |
| POST | `/api/routes/<id>/rescan` | re-parsea GPX/FIT; regenera thumb |
| GET | `/api/routes/<id>/thumb` | sirve el PNG del track (image/png) |
| GET | `/api/routes/<id>/gpx` | descarga el archivo GPX/FIT original |
| GET | `/Sendero/<public_id>/editor` | `shell.html` (sección `editor`); por nombre redirige 302 al `public_id` |
| GET | `/api/routes/<public_id>/editor` | metadatos de arranque del editor (nombre, versión, `gps_thresholds` con los TRES umbrales de la actividad, `gps_max_speed`, `gps_issues`, `dem_enabled`). Antes iban inyectados en la plantilla |
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
| GET | `/api/stats` | estadísticas globales (desde caché en settings). Del dashboard solo alimenta los RÉCORDS: el resto de la analítica se calcula en el cliente |
| GET | `/api/storage` | tamaño en disco de `/data`: `{db,gpx,photos,thumbs,tiles,total,immich_refs}`. Lo pinta el panel «Almacenamiento» del dashboard |
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
| GET | `/api/sync/state` | ¿ha cambiado algo? `{epoch,cursor,min_rev,counts}` + ETag `"<epoch>:<cursor>"`; con `If-None-Match` → **304 sin cuerpo** (la respuesta normal) |
| GET | `/api/sync/changes` | diferencias desde `?since=<rev>` (`&epoch=`, `&limit=`): `{cursor, complete, reset, routes:{upserted,deleted}, planned:{…}}`. `since=0` = carga inicial; `reset:true` ⇒ el cliente vacía su copia |
| GET | `/api/sync/manifest` | `[public_id, rev]` de todo (~30 B/ruta) para corroborar la copia local y descargar solo lo divergente |
| GET | `/api/maps` | estado de los mapas base: `.pmtiles` disponibles, capa por defecto, zoom máx, atribución |
| GET | `/tiles/<archivo.pmtiles>` | sirve el mapa base offline con soporte de `Range` (206). Solo nombres presentes en `data/tiles/` (sin travesía de rutas) |
| GET/POST | `/api/mifit/settings` | ajustes Mi Fit/Zepp (GET enmascara el token) |
| POST | `/api/mifit/sync` | encola sincronización manual (flag en settings); body `{reset:true}` reinicia la marca (reimportar desde fecha) |
| GET | `/api/mifit/status` | estado de la última sincronización Mi Fit/Zepp |

### Helper `_build_route_dict(rid)` en `api/routes.py`
Construye el dict completo de una ruta (geojson, elevation, heart_rate, speed, photos,
auto_summary, thumb_file, `version`, `n_points`…). Lo usan `get_route()` (API JSON) y
`sendero_page()` (inyección en template). **Si añades campos al objeto ruta,
añádelos aquí.** `n_points` se calcula aquí y no en `_route_payload()` a propósito:
tiene que ser el número de puntos del track COMPLETO, antes de que `?lite=1` decime
el `geojson` (si no, "Puntos GPS" del detalle mentiría por un factor de 20). El campo `version` se deriva de `MAX(version_n)` en
`route_versions` (0 = nunca editada); no hay columna `version` en `routes` a propósito.

### Editor de rutas (`api/editor.py` + `core/editing.py` + `static/js/sec/editor.js`)
Lo que sabe hacer, todo con versionado:

- **Dos modos de edición**: "Seleccionar" (tramos A–B) y "Editar puntos" (arrastrar
  vértice = `move_point`, Alt+click = `delete_points`, click en la línea =
  `insert_point`, Shift+click = waypoint).
- **Recortes y estructura**: recortar inicio/fin, eliminar tramo intermedio, invertir
  ruta, dividir en dos (`POST /split`, server-side sobre el estado guardado) y unir
  rutas (`POST /api/routes/merge`, que crea una ruta NUEVA).
- **Correcciones**: simplificación Douglas-Peucker con preview (compila a
  `delete_points`), picos de elevación (`set_ele`), velocidad excesiva (saltos de GPS:
  los puntos que exigirían superar el umbral de la actividad — Ajustes → "GPS
  incorrecto", `gps_max_speed` de `/api/routes/<id>/editor` — **no se eliminan: se
  recolocan** con `move_points`, ver abajo) y recálculo de elevación contra un DEM (`POST /elevation-dem`, requiere `DEM_URL` en
  Ajustes → Editor; servicio OpenTopoData comentado en docker-compose.yml).
- **Tiempos y waypoints**: `shift_time` (desplaza todos los timestamps y reactiva el
  cruce con Immich) y `wpt_add`/`wpt_move`/`wpt_rename`/`wpt_del` sobre
  `gpx.waypoints` (el popup del marker ⚑ renombra y borra).
- **Integración con `gps_issues`**: la página inyecta los avisos, el panel "⚠ Avisos
  GPS" los lista con bandas rojas en las gráficas y tramos rojos en el mapa (solo si no
  hay cambios pendientes: los km son del estado guardado), y "Corregir" hace zoom al
  tramo y abre la herramienta según `type` (speed → velocidad excesiva con el umbral del
  aviso; elevation → picos). "✔ Corregir todo" lo resuelve en 2 ops deshacibles (3 si
  además hay que eliminar un salto al final del track, ver abajo) y **converge a la
  primera** — ver la sección siguiente.

**«✔ Corregir todo» tiene que converger EN UNA PASADA, y lo comprueba** (v0.9.7). No es
un detalle de comodidad: si al guardar reaparecen avisos, el usuario no sabe si la
herramienta funciona. Las piezas, todas en `sec/editor.js` y todas puras:

- **`detectGpsIssues(pos, ele, t, th)`** es un **puerto exacto** de
  `core/gps_analysis.py::detect_gps_anomalies`: mismos tres tipos (`speed`, `elevation`
  = tasa vertical en m/s, `altitude` = cota absoluta) y mismo criterio **entre puntos
  consecutivos**. Si los dos criterios divergen, el cliente cantará "0 avisos" y el
  servidor los volverá a marcar al guardar. **`node tests/gps_parity_smoke.js` compara
  las dos implementaciones punto a punto sobre 12 escenarios**: si tocas una, toca la otra.
- **`planGpsFix(pos, ele, t, th)`** devuelve el estado ya corregido y **los avisos que
  quedan**. Converge en una pasada porque la velocidad depende solo de posición y tiempo,
  y la tasa vertical y la altitud solo de elevación y tiempo: son independientes, así que
  basta arreglar posiciones y **después** elevaciones. El segundo paso no puede romper el
  primero.
  - Velocidad: reparto **proporcional al tiempo** sobre el segmento A→B ⇒ la velocidad de
    cualquier par consecutivo resultante es exactamente `|AB|/(tB−tA)`, que es la que
    `detectSpeedErr` ya validó al aceptar B. No puede pasarse. El reparto se fuerza
    monótono, o un timestamp desordenado fabricaría una velocidad nueva.
  - Elevación y altitud: los **anclas se abren hacia fuera** hasta cumplir las dos
    condiciones (`|eB−eA|/(tB−tA) ≤ tasa máx.` y ambas `≤ altitud máx.`), y se interpola
    **por TIEMPO**. Interpolar por distancia —que es lo que se hacía— no acota una tasa
    en m/s: ese era el fallo.
- **Lo irreparable se reporta.** Si la "altitud máx." de la actividad está por debajo de
  la cota real de la ruta no hay ancla válida: sale en `plan.issues` y el toast lo dice,
  en vez de fingir que está arreglado. Se corrige en Ajustes, no tocando el track.
- Los **tres umbrales** llegan en `gps_thresholds` de `/api/routes/<id>/editor`. Sin la
  tasa vertical y la altitud máxima el cliente no puede verificarse: si añades un umbral
  nuevo al detector, mándalo también ahí.
- El plan se calcula entero sobre copias y las ops se emiten **al final**, para que siga
  costando 2 pasos de deshacer y no uno por iteración.

**Corrección de velocidad excesiva: se arregla el punto, no se borra** (`planSpeedFix()`
en `sec/editor.js`, probado con `node tests/speedfix_smoke.js`). Hasta la 0.7.1 los puntos
marcados se eliminaban (`delete_points`), así que un salto de GPS se llevaba por delante
puntos reales. Ahora cada tira contigua de puntos marcados se recoloca entre el último
punto válido anterior (A) y el primero válido posterior (B):
- Un punto suelto a mitad de camino en el tiempo queda en la **media exacta** de A y B;
  una tira de varios se reparte proporcional a `(t−tA)/(tB−tA)`, y cae a espaciado
  uniforme si a algún punto le falta el `<time>`.
- **La altitud se promedia igual** cuando A y B la tienen: un salto de GPS suele traer
  también una altitud falsa, y el punto recolocado debe ser coherente con su posición.
- **El resultado no puede volver a pasarse del umbral**: `detectSpeedErr()` solo acepta B
  como válido si la velocidad A→B ya cumplía, y los puntos interpolados caen sobre ese
  mismo tramo con reparto temporal. Si tocas el reparto, mantén esa propiedad (el smoke
  test la comprueba re-detectando sobre el track corregido).
- **Único caso en que se elimina**: una tira que llega al final del track (o arranca en el
  primer punto), porque sin un punto válido al otro lado no hay nada con lo que promediar.
  El panel lo cuenta aparte y se aplica en un `delete_points` propio, **después** del
  `move_points` (al revés reindexaría los movimientos).

**Smoke test end-to-end del editor** (`PID` = `public_id` de una ruta de prueba; los
endpoints del editor resuelven `public_id`, no el id entero):

```bash
curl -s localhost:8090/api/routes/$PID/points | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['version'],d['n'],d['segments'])"  # 0, n, segmentos

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"base_version":0,"summary":"Recorte de prueba","ops":[{"op":"delete_range","start":0,"end":9}]}' \
  localhost:8090/api/routes/$PID/edit | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['version'],d['distance_m'])"       # 2, distancia menor

# repetir ese mismo POST con base_version:0  → HTTP 409 (version_conflict)
curl -s localhost:8090/api/routes/$PID/versions            # v1 "Archivo original" + v2
curl -s localhost:8090/api/routes/$PID/versions/2/gpx | python3 -c \
  "import gpxpy,sys;gpxpy.parse(sys.stdin);print('GPX válido')"
curl -s -X POST localhost:8090/api/routes/$PID/versions/1/restore | python3 -c \
  "import json,sys;print(json.load(sys.stdin)['version'])"  # 3, y stats como las originales
curl -sI localhost:8090/api/routes/$PID/thumb               # 200 image/png, MISMO nombre de archivo
# caso .fit: el primer guardado materializa <stem>.gpx y el .fit queda como v1
# DELETE /api/routes/$PID → versions/<id>/ desaparece y route_versions queda limpia
```

En el navegador: click en la línea coloca A y B; arrastrar A hace snap y mueve la banda
del perfil (y al revés); recortar/eliminar/invertir actualizan las stats en vivo (invertir
avisa de que se pierden los timestamps); Ctrl+Z / Ctrl+Y; Guardar con resumen editable →
toast "v2" y el historial se refresca; Restaurar v1; salir con cambios pendientes pide
confirmación; y "Mis Rutas" refleja la distancia nueva.

Hubo además un **planificador interno** (dibujo por anclas con routing BRouter,
`/planificacion/crear`, `POST /api/planned/draw`, `BROUTER_URL`): se implementó y se
revirtió el mismo día. Hoy "Dibujar ruta nueva" abre una web externa configurable
(`PLANNER_URL`). Desde la v0.9.6 no queda ningún resto en el código: la columna
`draw_anchors` de `planned_routes` se eliminó. Si vuelve a plantearse, es un
rediseño, no un revert.

**Paridad cliente/servidor**: el cliente mantiene el estado con `idxMap`
(orden/supervivencia) + `posOverride`/`eleOverride` (valores editados por índice
original; los insertados se añaden al final de los arrays de `P`). Cliente y
servidor deben aplicar cada op EXACTAMENTE igual — si añades una op nueva,
impleméntala en `doOp()` (`sec/editor.js`) y en `apply_ops()` (`core/editing.py`) y
verifica que la misma secuencia produce las mismas coordenadas en ambos.
`delete_points` (puntos sueltos) NO parte el segmento; `delete_range` sí.
`move_points` es el lote de `move_point` (items `[i,lon,lat]` o `[i,lon,lat,ele]`): existe
para que una corrección de cientos de puntos sea **una** op — un solo paso de deshacer y
una sola línea en el resumen. En el cliente escribe `posOverride` y, si el item trae el 4º
elemento, también `eleOverride`.

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
lo revisa una persona (badge en `makeCard`, banner `#dup-banner` en la sección `detalle`
con "descartar aviso"/ir a la parecida → borrar o `POST /api/routes/merge`; el enlace usa
`dup_suspect_public`, así que navega por el router de un detalle a otro).

**Filtrarlas y borrarlas (frontend):** la fila de ORDEN de "Mis Rutas" tiene el filtro
"⚠ Duplicadas (N)" (solo visible si hay marcadas, ver "Listado de rutas"), y el modo
edición un botón "⚠ Borrar duplicados (N)" (`deleteDuplicates()` en `sec/rutas.js`, visible solo si hay
`dup_suspect_of` en `allRoutes`). NO es un endpoint nuevo: selecciona las rutas marcadas
y reusa `deleteSelected()` (mismo confirm con recuento + barra de progreso + `DELETE
/api/routes/<id>`). Se borra la ruta MARCADA (la sospechosa), no la original a la que se
parece.

`content_hash`/`signature` se fijan **al importar y no se recalculan** al editar/
reescanear: la pregunta que responden es "¿ya vi este archivo/entreno?", referida al
original. Backfill único de las rutas previas en `init_db()` (firma desde la BD,
hash leyendo el archivo; solo filas con `content_hash IS NULL`). Al añadir la columna
`dup_suspect_of` al listado se creó `idx_routes_list_cov2` (regla 12); al añadir después
`locality` se sustituyó por `idx_routes_list_cov3`, y al añadir `public_id` por
`idx_routes_list_cov5`, que además guarda ya calculado el resumen de `gps_issues` (se descartan todos los anteriores).

### Thumbnails de track (`core/thumbs.py`)
`generate_thumb(coords, gpx_file)` genera un PNG:
- **Fondo TRANSPARENTE** (RGBA), línea blanca de 6 px con vértices redondeados,
  400 px de alto, ancho proporcional al bounding-box del track (ratio corregido por
  latitud, acotado 1:4 – 4:1), 40 px de padding interior. Sin fondo a propósito: el
  PNG se pinta ENCIMA de la tarjeta de "Mis Rutas", así que un fondo opaco se ve
  como un recuadro (y al pasar el ratón, cuando la tarjeta cambia de color, canta).
  Los 6 px también son a propósito: en la tarjeta la miniatura se ve a ~1/3 de su
  tamaño, y una línea de 2 px quedaba en sub-píxel e invisible al 22 % de opacidad.
  Las miniaturas generadas antes de esto conservan su fondo hasta que se reescanee
  la ruta (en masa: "Mis Rutas" → ✎ Editar → Seleccionar todos → ↻ Re-escanear).
- Se llama automáticamente en `create_route` y `rescan_route`; también en el script
  de backfill manual.
- El archivo se llama igual que el GPX con extensión .png (`<stem>.png`), se guarda
  en `data/thumbs/` y se referencia en `thumb_file`.
- Al borrar una ruta, se borra también el thumb.
- En `makeCard` de `sec/rutas.js`: elemento absoluto pegado al borde derecho y de arriba
  abajo de la tarjeta (52 % de ancho, `object-fit:contain`), al 22 % y con `z-index:0`
  para que el texto se lea encima. El desvanecido hacia la izquierda va como
  `mask-image`, no como un degradado de color: así funciona con la tarjeta normal, en
  hover y seleccionada, que tienen fondos distintos.

### Auto-importación Mi Fit / Zepp (`core/mifit/` + `mifit_sync.py` + `api/mifit.py`)
Descarga los entrenamientos del reloj Amazfit/Zepp/Mi Fit (API de Huami) y los
importa como rutas. Funciona con el **token pegado a mano**, y así se queda: capturarlo
con un clic (un servicio-navegador `mifit-auth` con Firefox/noVNC) se llegó a plantear y
está **descartado** — un navegador entero en un contenedor para copiar una cadena que
caduca de vez en cuando no compensa. No lo reabras sin motivo nuevo.
- **`core/mifit/`** — vendorizado de MiFitDataExport (solo GPX-por-token).
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

### Contrato de una sección (`static/js/sec/*.js`)
Todas siguen el mismo patrón, y conviene leerlo una vez antes de tocar cualquiera:

```js
(() => { 'use strict';
  let _tok = 0;                    // token de montaje: invalida cargas en vuelo
  const q = sel => document.querySelector('#sec-<sec> ' + sel);   // consultas escopadas
  const visible = () => { … };     // ¿está esta sección a la vista?
  async function mount(params, opts) { const tok = ++_tok; … }
  function unmount() { _tok++; /* destruir mapa, Charts, marcadores, timers */ }
  document.addEventListener(…);    // listeners de documento: UNA vez, aquí abajo
  window.SEC.<sec> = {mount, unmount, …lo que llamen los onclick= del markup};
})();
```

Tres cosas que no son opcionales: **(a)** `unmount()` destruye mapas y `Chart`s (sin eso
cada visita deja un contexto WebGL vivo y el navegador se degrada poco a poco: es la fuga
nº 1 de esta conversión); **(b)** los listeners de `document` se registran al cargar el
archivo, nunca en `mount()`, porque `loadOnce()` ejecuta el script una sola vez pero
`mount()` puede correr decenas de veces; **(c)** el token `_tok` se compara después de cada
`await`, o una respuesta vieja pintará encima de otra sección.

### Estado JS relevante en `static/js/sec/detalle.js`
Todo vive dentro del IIFE de la sección (nada de esto es global). Se reinicia en
`resetView()`, que llaman **`mount()` y `unmount()`**: `mount()` también, porque se puede
ir de un detalle a OTRO detalle (el enlace del aviso de duplicada) y el router no
desmonta cuando la sección no cambia.

| Variable | Contenido |
|----------|-----------|
| `current` | objeto de la ruta (geojson, elevation, heart_rate, photos…) que devuelve `Store.route(pid, {lite:true})`: red, `bootstrap` de la primera carga o copia local, lo decide el Store |
| `pid` / `_lite` | `public_id` de la ruta montada y si lo cargado es la variante ligera (se lo pasa a `Store.putDetail` para no guardar una copia con la etiqueta equivocada) |
| `_tok` | token de montaje: `++_tok` invalida las cargas en vuelo, para que un fetch viejo no pinte encima de otra ruta |
| `photoMarkers` | `{id: marker}` — marcadores MapLibre de fotos con GPS |
| `lbIdx` | índice en `current.photos` de la foto visible en el lightbox |
| `immichCands` / `immichSel` | candidatos de Immich y Set de índices seleccionados |
| `IMMICH` | booleano; activado tras `/api/config`, controla el botón Immich |
| `hoverD` | distancia (km) resaltada ahora mismo en el hover sincronizado mapa↔gráficos, o `null` |
| `trackCumKm` | distancia acumulada (km) por punto de `current.geojson`, recalculada en cada `renderMap()` |

### Qué pinta cada `render*()` del detalle (rediseño 2a)
`renderAll()` los llama en orden; todos leen de `current` y ninguno pide red:

| Función | Dónde escribe | Notas |
|---|---|---|
| `renderActivity()` | `#d-activity-badge-sm` (chip sobre el mapa) | fondo translúcido oscuro a propósito: el color solo no se lee sobre una capa satélite. Abre el selector de actividad al pulsarlo — es la ÚNICA forma de cambiarla (ya no hay tarjeta de actividad en la banda) |
| `renderStats()` | `#d-stats` | 7 tarjetas `.stat` (8 con FC máx). La primera lleva `.acc` + `border-left-color` de la actividad y la cifra en ámbar. `tests/e2e_spa.py` exige ≥7 |
| `renderTech()` | `#d-tech` | filas `.kv-row` solo con lo que la ruta tiene. Cadencia y temperatura NO se inventan: el modelo no las guarda |
| `renderQuality()` | `#d-quality-badge` / `#d-quality-body` | los `gps_issues`; `severity:'high'` → `.warn.crit` (ámbar), el resto `.warn.info`. Sin avisos: «Sin errores detectados» |
| `renderElev()` | `#d-elev` + `#d-elev-sub` | área con degradado del color de la actividad (`_areaGradient`), línea `#f0b070`, y el subtítulo «X m salida · Y m cima · pendiente máx. N %» (`_elevSub`, tramos ≥30 m para que el ruido del GPS no dé porcentajes absurdos) |
| `renderSpeed()` / `renderHR()` | `#speed-section` / `#hr-section` + sus pies | ocultan su panel entero si la serie está vacía (lo comprueba la suite e2e) |
| `renderGallery()` + `renderPhotosHead()` | `#d-gallery`, `#d-photos-count`, `#d-photos-all` | el pie de cada miniatura es la hora de la foto; la cabecera dice cuántas son y si vienen de Immich |

Los tres `Chart` comparten `_scales()` (rejilla `rgba(236,229,216,.07)`, ejes en mono
y sin títulos: la unidad la dice el título del panel) y `fmtNum` en las marcas del
eje Y (1 950, no 1,950).

### Pestañas del detalle en móvil (<768 px)
El cuerpo del detalle pasa de dos columnas a cuatro pestañas (Perfil / Fotos /
Datos / Notas) **solo con CSS**: la sección lleva `data-tab="<activa>"` y cada
bloque `data-dtab="<pestaña>"`; por debajo de 768 px se oculta todo `[data-dtab]`
salvo el que coincide. `SEC.detalle.setTab(name)` cambia el atributo, marca la
pestaña y **redimensiona los Charts** (mientras su panel estuvo en `display:none`
su canvas medía 0). `resetView()` vuelve siempre a «Perfil».

Las acciones del mapa cabecera viven en `.d-hero-actions`, que está FUERA de
`.d-hero` (que recorta con `overflow:hidden`) y dentro de `.d-hero-wrap`: así en
pantalla estrecha pueden caer debajo del mapa en flujo normal. Sobre el mapa solo
están «✎ Editar track» y «↓ Exportar GPX»; el resto va tras el `⋯`
(`#d-actions-more`), **también en escritorio** — si automatizas un click en
«Renombrar», «Reescanear» o «Eliminar», abre antes el menú.

### Mapa base offline autoalojado (PMTiles)
La 5ª capa del selector, «Offline (local)», es la única que no depende de terceros: la
sirve Sendero desde un archivo **PMTiles** en `data/tiles/`. Un PMTiles es un único
archivo con todas las teselas dentro, que se lee por *range requests*, así que no hace
falta un servidor de teselas: `GET /tiles/<archivo>.pmtiles` (`api/maps.py`) responde
206 y `pmtiles.js` pide los bytes que necesite. **Necesita el servidor encendido** — para
el monte con el servidor apagado es el corredor por ruta de la sección siguiente.

- **Es RASTER, no vectorial** (`buildStyle()` en `static/shared.js`: `type:'raster'`,
  `pmtiles://<url>/{z}/{x}/{y}`). Es deliberado: un basemap vectorial necesitaría además
  `style.json`, `glyphs` (fuentes en PBF) y `sprite` locales, y si los `glyphs` siguen
  apuntando a un CDN los nombres de los pueblos desaparecen sin internet aunque las
  teselas sí estén. Con raster no hace falta ninguna de esas piezas.
- **Cómo se genera**: cualquier tileset raster convertido a PMTiles (la ruta habitual es
  MBTiles → `pmtiles convert` de `go-pmtiles`). Ojo con la licencia del tileset de
  partida: por eso no vale con volcarse OpenTopoMap. Un extracto regional son decenas de
  MB; un país entero, del orden de GB.
- **Configuración** en Ajustes → Mapas (claves de `settings`, en `_SETTINGS_KEYS`):
  `MAP_OFFLINE_FILE` (nombre del archivo dentro de `data/tiles/`; vacío o inexistente ⇒
  la capa no se ofrece siquiera en el selector), `MAP_OFFLINE_MAXZOOM` (14 por defecto;
  tiene que coincidir con el del archivo o MapLibre pedirá teselas que no existen),
  `MAP_OFFLINE_ATTRIBUTION` y `MAP_DEFAULT_LAYER`.
- **No hay ningún `.pmtiles` en esta instalación** (`data/tiles/` está vacío), así que
  este camino está implementado pero **no probado con un archivo real**. Si añades uno,
  compruébalo antes de fiarte.

### Mapa sin conexión de una ruta (`static/js/core/tiles.js`)
El botón «⬇ Mapa sin conexión» (detalle de ruta y de plan) guarda en el navegador la franja
de teselas por la que pasa el track. Es lo único que hace visible el mapa **sin servidor**:
la capa «Offline (local)» de §6.1 la sirve Sendero desde su `.pmtiles`, así que necesita el
servidor encendido; esto no.

- **Corredor, no bbox**: `forTrack(coords)` toma las teselas que pisa el track más un anillo
  de vecinas, en los zooms 10-15. Para 40 km son 250-380 teselas (6-9 MB) según lo recta
  que vaya el track — `tests/tiles_smoke.js` mide 381 con una recta, que es el peor caso,
  y una ruta real que serpentea en un valle repite teselas y baja de 300; el bbox completo de
  esa misma ruta serían miles. Van **ordenadas por zoom ascendente**: si la descarga se
  corta, queda al menos la vista general.
- **Caché aparte y que sobrevive a las versiones**: `sendero-tiles-v1` no lleva
  `APP_VERSION` en el nombre y `activate` no la borra (está en `KEEP` de `static/sw.js`).
  Son megas que el usuario pidió a mano: tirarlas al publicar le quitaría el mapa que se
  llevó al monte. Se gestionan en Ajustes → Sin conexión.
- **El SW las sirve con red primero** (`tileFirstNetwork`): con conexión gana la tesela
  real, porque la guardada puede ser de hace meses. Sin conexión y sin tesela, devuelve un
  **504 vacío** a propósito: MapLibre lo trata como hueco y sigue pintando el track.
  Solo se mira la caché para URLs con forma `/{z}/{x}/{y}` (`ES_TESELA`), para no meter un
  `caches.match()` en cada petición externa.
- **Se descarga con `mode:'cors'`**, no `no-cors`: una respuesta opaca no la puede
  decodificar MapLibre después. Las 4 capas ya envían CORS (si no, no se verían hoy).
- **Términos de uso**: las capas son de terceros y piden no descargar en masa. Por eso esto
  es siempre una acción explícita sobre una ruta concreta, con tope duro (`MAX_TILES`),
  3 descargas en paralelo y pausa entre teselas. Si añades una capa nueva a `BASEMAP_TILES`,
  mira su licencia antes de dejar que se pre-descargue.

### Escrituras en el detalle (`static/js/sec/detalle.js`)
Dos categorías, y la diferencia importa:
- **Por `Store.patch`** (nombre, notas, actividad, `immich_checked`, descartar aviso de
  duplicada): sin conexión se **encolan** en el outbox y se envían al volver. Después hay
  que llamar a `saveLocal()` (= `markCacheDirty()` + `Store.putDetail`), o el cambio hecho
  sin conexión se vería revertido al volver a la vista: el PATCH está en la cola, pero la
  copia local del detalle seguiría siendo la del servidor.
- **Con conexión obligatoria** (`needOnline()`): reescanear, subir fotos, Immich, borrar
  ruta o foto. El servidor decide cosas que el cliente no puede simular (dedup por hash,
  409 por `base_version`, EXIF), y un borrado no debe encolarse porque no se puede deshacer.
  Tras ellas, `reload()` (= `Store.route(..., {refresh:true})` + `syncNow`): el `rev` del
  listado aún no ha llegado por la sincronización, así que sin `refresh` se serviría la
  copia vieja.

### Hover sincronizado mapa↔gráficos en el detalle (`static/js/sec/detalle.js`)
Pasar el ratón por la línea del track en el mapa, o por el perfil de elevación/velocidad/FC,
resalta la misma posición en los otros 3 elementos y muestra un cuadro flotante en el mapa
con altitud/velocidad/FC en ese punto. Punto de entrada único: `setHoverD(d)` (d en km o `null`).
- **`elevation`/`speed`/`heart_rate` son series independientes**, cada una con su propio muestreo
  de `d` (no todos los puntos del track tienen elevación/velocidad/FC). `_nearestByD(arr,d)` busca
  el punto más cercano por distancia (binary search, arrays ya vienen ordenados por `d`); no asumas
  mismo índice entre series.
- **Mapa → gráficos**: capa `ruta-linea-hit` (línea ancha invisible sobre `ruta-linea`, mismo
  patrón que `dash-lines-hit` en `sec/dashboard.js`) recibe `mousemove`/`mouseleave`; busca el vértice de
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

### Mapa de visión general en `static/js/sec/rutas.js`
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
  se filtra por los filtros activos de la lista**: `applyLineFilter()` recalcula qué
  subconjunto de `ovLineFeaturesAll` mostrar cada vez que cambia `ovRoutes` (filtro de
  actividad/fecha/búsqueda), sin volver a pedir red — el endpoint `/api/routes/geojson` solo
  filtra por bbox, así que el filtrado por actividad/fecha es 100% cliente.
- **Invalidación**: `invalidateLines()` vacía `lineIds`/`lineFeaturesAll` y limpia la
  fuente `ov-lines`; la llama `reload()`, así que cualquier mutación que acabe en un
  `Store.syncNow()` + `reload()` queda cubierta sin inventar otra invalidación. Si la
  caché queda vacía pero hay rutas que mostrar, `applyLineFilter()` relanza
  `loadLinesForView()` sola.
- **Encuadre inicial instantáneo**: `fitMap(true)` en la creación del mapa usa
  `duration:0` — el centro/zoom del constructor (`[-84,10]`, un placeholder en Costa Rica)
  nunca se ve, salta directo a la posición real de las rutas. Sin el `true`, MapLibre anima
  el vuelo desde ese placeholder cada vez que se (re)crea el mapa, aunque tus rutas estén al
  otro lado del mundo. El resto de llamadas a `fitMap()` (botón "centrar", cambios de filtro)
  sí animan, ahí tiene sentido.

### Mapa del dashboard en `static/js/sec/dashboard.js`
Segundo mapa MapLibre. Dibuja las rutas con **dos representaciones según el zoom** en vez
de cargar siempre todas las líneas completas:
- **Bolitas/clusters (`dash-points`/`dash-clusters`/`dash-unclustered`)**: se pintan casi
  al instante a partir del listado de `Store.routes()` — clustering nativo de MapLibre,
  mismo patrón que el mapa de "Mis Rutas". Las etiquetas con el número de rutas de cada
  cluster son marcadores DOM (`syncClusterLabels`), no símbolos de MapLibre: pintar texto
  necesitaría un servidor de glyphs, que no hay (ni tendría sentido sin conexión).
- **Líneas reales (`dash-lines`)**: solo desde `LINES_MINZOOM` (9). Se piden a
  `GET /api/routes/geojson?bbox=...` **solo para la zona visible** (+50% de margen) en
  `map.on('moveend', scheduleLineLoad)` (debounce 350 ms), y solo si el zoom ya pasó
  `LINES_PREFETCH_ZOOM` (`LINES_MINZOOM - 2`, para que estén listas antes de volverse
  visibles). `lineIds` evita volver a pedir rutas ya cargadas.
- **El mapa no tiene filtros propios** (los tiene el de "Mis Rutas", que sí filtra
  `ov-lines` por la lista). El selector de año de la analítica NO lo afecta: el mapa
  muestra siempre todas las rutas con GPS.
- **Se crea DESPUÉS de que `renderAnalytics()` quite el `.hidden` de `#ov-content`.**
  Creándolo con el panel en `display:none`, MapLibre mide un contenedor de 0 px y luego
  solo repinta teselas en una esquina, aunque después se llame a `resize()`.

### Analítica del dashboard (`static/js/sec/dashboard.js`)
Desde el rediseño, **casi todo se calcula en el cliente** con el listado que ya tiene el
Store (`allRows`, que incluye `distance_m`, `ascent_m`, `moving_s`, `started_at` y
`locality`). Dos consecuencias: el dashboard funciona sin conexión y el selector de año
no gasta ni una petición.

- `year` ('todo' por defecto) lo cambian las píldoras de año y las barras de "Rutas por
  año"; `renderAnalytics()` repinta KPIs, meses, zonas, "Por actividad" y el año.
- **KPIs**: Salidas (`#ov-total-routes`), Distancia, Desnivel +, Horas y Zonas, cada uno
  con su línea de contexto (delta vs el año anterior, media por salida, "N × Everest",
  media de horas, zona más visitada).
- **Desnivel por mes**: 12 barras del año elegido (con 'todo', la suma de todos los años,
  que es lo que enseña la estacionalidad). El color va por ranking: el mes más fuerte en
  ámbar, los tres siguientes en naranja, el resto en verdes apagados.
- **Zonas más visitadas**: recuento de `locality`. Si ninguna ruta la tiene, lo dice y
  apunta a Ajustes → Editor (la geocodificación puede estar desactivada).
- **Almacenamiento**: `GET /api/storage`. La barra es la COMPOSICIÓN del total (base,
  tracks, fotos, miniaturas, teselas), no un porcentaje de cuota: aquí no hay cuota.
- **Lo ÚNICO que sigue viniendo del servidor son los récords** (`GET /api/stats`):
  necesitan `avg_speed`, que no está en `ROUTE_LIST_COLS`. Se guardan en el Store con
  `Store.setMeta('stats', …)`; sin conexión se pintan los últimos conocidos y aparece el
  aviso `#ov-stale`. Si el servidor los marca como sucios, `regenInBackground()` los
  recalcula por detrás sin ocultar lo que ya se ve.
- **`reloadRoutes()`** repinta mapa y analítica desde el Store; se llama al montar y
  cuando `Store.onChange` avisa de una sincronización con cambios.
- Si añades una representación nueva por zoom (p.ej. una capa intermedia), sigue el mismo
  patrón: dato ligero primero (instantáneo), dato pesado filtrado por bbox después, en
  segundo plano, sin loader que bloquee.

### Listado de rutas en `static/js/sec/rutas.js` — scroll infinito
Cada tarjeta (`makeCard`) muestra nombre (Oswald 19 px), fecha larga en versalitas
(`fmtDateLong`), **distancia** (`fmtKm(r.distance_m)`, en ámbar), **localidad**
(`r.locality`, con icono de pin `pinSvg()`) y el **nº de fotos** (`r.n_photos`, con
icono de cámara `camSvg()`, y **nada si es 0** — un «0» es ruido) en una línea
`.card-meta`; debajo, un `.card-badges` con las chapas de **posible duplicada** y de
**avisos GPS** (`⚠ N avisos GPS`, ámbar fuerte si `gps_issues_high`, apagada si no).
Más el borde izquierdo del color de la actividad y la miniatura del track al 22 %
anclada abajo a la derecha. `distance_m`, `locality`, `n_photos`, `gps_issues_n` y
`gps_issues_high` vienen ya en el listado.

**Tres vistas** (`viewMode`, botones en la cabecera y estado en `sessionStorage`):
- `'a'` ⊞ Cuadrícula — tarjetas en rejilla de 3.
- `'t'` ☰ Tabla — la variante densa del rediseño: `makeRow()` en vez de `makeCard()`,
  con el mismo agrupado por mes (cada mes es su propia `<table class="rtable">`, con
  `table-layout:fixed` y `<colgroup>` para que las columnas de meses distintos cuadren).
  El "Estado" dice OK, posible duplicada y avisos GPS (`⚠ N GPS`), las dos chapas
  apiladas si se dan a la vez. Desde la v0.9.5 el resumen de `gps_issues` viaja en el
  listado; lo que sigue sin poder decir es cualquier cosa que no esté en
  `ROUTE_LIST_COLS`.
- `'b'` ▤ Panel — lista estrecha + mapa grande (se fuerza a `'a'` en móvil).
Cambiar de vista repinta la lista (`renderList()`), porque es otro markup.

**Buscador** (`#route-search` → `setSearch`, debounce 180 ms): filtra en cliente por
nombre y localidad, que es lo que hay en el listado (el nombre del archivo no está).
Se guarda con el resto de filtros y `clearFilters()` lo vacía también.

**Filtro de posibles duplicadas** (`#dup-filter` → `toggleDupOnly`): deja solo las
rutas con `dup_suspect_of`. `updateDupFilter()` (lo llama `reload()`, junto a
`updateDedupBtn()`) lo **muestra solo si hay alguna marcada**, y si deja de haberlas
lo esconde y lo apaga — si no, la lista se quedaría vacía sin explicación. Vive en la
fila de ORDEN y no en el panel de filtros a propósito: aparece y desaparece según los
datos, y ahí empujaba el buscador a una segunda línea (el panel cambiaba de altura
solo). Se guarda en el estado de filtros como el resto.

`reload()` pide el listado completo a **`Store.routes()`** (IndexedDB; si está vacío
espera la primera sincronización, y si no devuelve lo local al instante y sincroniza por
detrás). Lo que se pagina es el **renderizado de tarjetas**, no la petición:
- `renderList()` filtra/ordena/agrupa por mes el array completo, pero solo manda a
  `appendBatchToDOM()` las primeras `PAGE_SIZE` (30) vía `loadNextListPage()`.
- Un `<div id="list-sentinel">` al final de `#routes`, observado con
  `IntersectionObserver` (`rootMargin:"800px"`), llama a `loadNextListPage(PAGE_SIZE)`
  cuando entra en viewport — así se van añadiendo tarjetas al hacer scroll.
- En modo edición (`editMode`) se renderiza todo de golpe (`pendingRoutes.length`),
  porque "Selec. mes"/"Seleccionar visibles" necesitan que la tarjeta ya exista en el DOM.
- `visibleRoutes` solo contiene lo que ya está renderizado (no todo lo cargado); úsalo
  con eso en mente si tocas selección.
- El mapa de overview (`renderMap`) sigue recibiendo el array **completo** filtrado de
  una vez (es barato, son solo puntos), independientemente de cuántas tarjetas estén ya
  en el DOM.
- Una sincronización posterior (otro dispositivo, `watch.py`, `mifit_sync.py`) repinta
  la lista sola: `mount()` se suscribe con `Store.onChange` y llama a `reload()` cuando
  llega un `synced` con cambios. La suscripción se cancela en `unmount()`.

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

- **Estado de módulo inicializado a partir de `ACTIVITIES` fuera de orden** — en su día,
  declarar `new Set(ACTIVITIES.map(...))` en los `let` de cabecera de la SPA vieja lanzaba
  `ReferenceError`, porque `ACTIVITIES` se definía más abajo en el mismo archivo. Hoy
  `ACTIVITIES` vive en `static/shared.js` (cargado antes), pero la lección vale igual para
  los módulos de sección: inicializa ese estado **dentro de `mount()`**, no en la
  declaración (ver `activeActs` en `sec/rutas.js`).

- **`window.Router`/`window.Store` no existen** — `Router` y `Store` se declaran con
  `const` en el ámbito superior de un script clásico, y eso crea un binding léxico global
  que **no** es propiedad de `window`. `chrome.js` comprobaba `window.Router` para
  apartarse cuando el router podía navegar; al ser siempre `undefined`, hacía un
  `location.href` 100 ms después de que la SPA ya hubiera cambiado de sección: cada click
  del nav recargaba la página entera. Lo mismo dejaba muerto el contador de cambios
  pendientes del badge. Se comprueba con `typeof X !== 'undefined'`.



- **La vista 3D se quedaba NEGRA por mover la cámara en el mismo tick que activar
  el terreno** — `toggle3D()` hacía `map.setTerrain({...}); map.easeTo({pitch:60})`
  seguidos, y el mapa se quedaba en un rectángulo negro del que no se recuperaba.
  Vivió desde que se añadió el 3D (junio) hasta 0.7.0. Tres cosas que aprendimos
  depurándolo, porque despistan:
  (a) **No era el DEM**: `s3.amazonaws.com/elevation-tiles-prod/terrarium` responde
      200, con CORS, y las teselas decodifican bien (2019 m donde toca).
  (b) **No era la animación**: con `duration:0` pasaba igual. Lo que importa es que
      el terreno no tiene su primera tesela cuando la cámara se reproyecta.
  (c) **Solo se reproduce en alta montaña Y con zoom alto** (~1500 m+ y zoom ≈14):
      con exageración 1.5 la superficie sube por encima de la cámara. Con una ruta
      de valle, o con el encuadre alejado, no se ve el fallo — por eso un test con
      rutas sintéticas normales pasaba con el código roto.
  Arreglo: inclinar primero y activar el terreno en el `moveend`. Además así, si el
  DEM no llega (sin internet), queda la vista inclinada en 2D en vez de negro.
  Lo cubre `tests/e2e_spa.py` con una ruta de alta montaña sembrada a propósito
  (comprobado que el test FALLA si se revierte el arreglo).

- **Un índice de cobertura RECIÉN creado puede ser ignorado por el planificador si la
  BD tiene `sqlite_stat1`** — es la trampa de la regla 12 en su segunda vuelta. Si
  alguien corrió `ANALYZE` alguna vez, SQLite tiene estadísticas de los índices
  *antiguos* y ninguna del nuevo, así que lo descarta a favor de uno con datos
  (`idx_routes_date`) y vuelve a leer la fila completa — o sea, a atravesar los blobs
  `geojson`/`elevation`/`heart_rate`. Medido al añadir `idx_routes_list_cov5`: **25 ms
  en vez de 1,4 ms** con 500 rutas, y con la caché fría es el mismo bug de 7-9 s de más
  abajo. Ninguna instalación de Sendero corre `ANALYZE` por su cuenta (sin
  `sqlite_stat1` todos los índices parten iguales y el de cobertura gana solo), pero el
  fallo sería mudo. Por eso `init_db()` re-analiza **una sola vez**, solo si hay
  `sqlite_stat1` y le falta el índice nuevo. Si añades otro índice de cobertura,
  añádelo también a esa comprobación.

- **`init_db()` a nivel de módulo** — Gunicorn importa `app:app` sin ejecutar el
  bloque `__main__`; sin `init_db()` al importar falla en el primer request.

- **Especificidad CSS del modal Immich** (hoy `static/css/detalle.css`): la regla
  `#sec-detalle .overlay.hidden{display:none}` (especificidad doble) debe estar
  inmediatamente después de `#sec-detalle .overlay{display:flex}`. Sin ella el modal
  Immich aparece al cargar.

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

- **`fitMap()` sin `duration:0` en el primer encuadre del mapa de "Mis Rutas"** (hoy
  `sec/rutas.js`)
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

9. **Identidad visual** — los tokens del rediseño están en `:root` de
   `templates/base.html` y son la única fuente de verdad (ver "Tokens de diseño"):
   `--bg` #0b120e, `--panel` #101a14, `--ink` #ece5d8, `--pr-yellow` #e3b23c,
   `--gr-red` #e2492c, `--sage` #8fb69f, más las curvas de nivel del header.
   **Nada de hex sueltos** en plantillas ni en el CSS de las secciones, y no metas
   framework de UI ni cambies la paleta sin pedirlo.

10. **`{{ bootstrap_json | safe }}` en shell.html** (y `{{ route_json | safe }}` en
    el editor pide los suyos a `/api/routes/<id>/editor`) — intencional. El JSON viene de
    `json.dumps()` sobre datos de la BD, no
    de input de usuario. No lo escapes dos veces. En el shell va dentro de un
    `<script type="application/json">`, que el navegador no ejecuta, y lo lee `JSON.parse`.

11. **Caché de rutas en el cliente** — si cambias los campos que devuelve `/api/routes`,
    sube `DB_VERSION` en `static/js/core/store.js`: su `onupgradeneeded` vacía los
    almacenes de IndexedDB y los clientes se rehacen la copia. Es la ÚNICA caché de datos
    que queda (el `sessionStorage` con TTL de 10 min, `sendero_routes_v4`, murió con la
    migración de "Mis Rutas" al Store; en `sessionStorage` solo quedan los filtros de la
    lista, que son preferencias). Añadir `thumb_file` sin invalidar causó en su día que se
    vieran tarjetas sin miniatura hasta que la caché expirara.
    Recuerda que `/api/routes` y los `upserted` de `/api/sync/changes` comparten
    columnas (`ROUTE_LIST_COLS`/`PLANNED_LIST_COLS`): la lista se toca en un solo sitio.

12. **Toda columna nueva que se vaya a leer en un listado o agregado frecuente necesita
    su índice de cobertura en `init_db()`**, no solo el `ALTER TABLE`. Ver "Bugs
    corregidos" — sin esto, leer una columna añadida tarde en el esquema obliga a SQLite
    a atravesar los blobs grandes (`geojson`/`elevation`/`heart_rate`) de cada fila.

13. **Cualquier migración en `init_db()` debe asumir que puede ejecutarse dos veces en
    paralelo** (gunicorn arranca 2 workers, cada uno corre `init_db()` por su cuenta).
    `PRAGMA busy_timeout` ya está puesto; para `ALTER TABLE ADD COLUMN` que puedan
    chocar, envuélvelos en `try/except sqlite3.OperationalError` tolerando
    `"duplicate column"`.

14. **Toda tabla nueva que el cliente deba sincronizar necesita sus 3 triggers**
    (`AFTER INSERT`/`UPDATE`/`DELETE`) en `_sync_triggers_sql()` y su entrada en
    `_ENTITIES` de `api/sync.py`. Sin los triggers la tabla no aparece en
    `/api/sync/changes` y los clientes no se enteran nunca de sus cambios; sin la
    entrada en `_ENTITIES` las filas de `sync_log` se ignoran. Y si la tabla cuelga de
    otra (como `photos` de `routes`), decide si es entidad propia o si solo sube el
    `rev` de su padre. **No** actives `PRAGMA foreign_keys`/`recursive_triggers` sin
    revisar esto (hoy el borrado de fotos es explícito, ver `api/routes.py`).

15. **Un mapa nuevo se crea con `buildStyle(defaultBasemap(<fallback>))`**, nunca con las
    teselas a mano: si no, ese mapa será el único que ignore la capa configurada en
    Ajustes → Mapas (la offline incluida). Y para cambiar de capa, `applyBasemap(map, capa)`:
    entre capas raster hace `setTiles()` (barato), pero al entrar o salir de
    `OFFLINE_LAYER` (`pmtiles://`, otro maxzoom) **reconstruye el estilo y eso borra todas
    tus fuentes y capas de datos** — repinta escuchando `map.on('sendero:basemap')` o
    recreando el mapa (ver `plan.js` y `sec/detalle.js`/`sec/rutas.js` respectivamente).

16. **El Service Worker NO cachea documentos que lleven datos inyectados dentro.**
    `/Sendero/<pid>` trae la ruta en `bootstrap_json`, así que su HTML es una copia de
    los datos: guardarlo haría que al recargar sin conexión ese bootstrap viejo pisara
    en IndexedDB una edición hecha sin conexión (`Store.route` confía en el bootstrap
    sin preguntar). Para esas vistas se sirve `/app-shell` (sin datos) y los pone el
    Store. Si migras una vista al shell, mira si su ruta debe entrar en `SHELL_PATHS`
    de `static/sw.js` — y si inyecta datos, que NO entre en la caché de documentos.
    Tampoco se cachean `/api/*` (de eso vive el Store) ni las peticiones con `Range`
    (los `.pmtiles` se piden por rangos y una respuesta parcial cacheada rompe el mapa).
    Y **caché primero solo para lo que lleva versión en el nombre** (`static/vendor/**`)
    o no cambia (fuentes, iconos): `static/js/**`, `static/css/**` y `shared.js` van con
    revalidación por detrás, porque su nombre no lleva versión y si no, editar
    `detalle.js` sin subir `APP_VERSION` no llegaría nunca al navegador.

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
| gps_issues | TEXT JSON | tramos GPS anómalos (`core/gps_analysis.py::detect_gps_anomalies`, umbrales por actividad de Ajustes → "GPS incorrecto"); lista `[{type: speed\|elevation\|altitude, d_from, d_to, value_max, threshold, severity}, …]` o NULL. `altitude` (puntos por encima de `max_ele_m`) se detecta incluso sin timestamps. Lo calculan `create_route` y `_reanalyse_and_update` (rescan + guardados del editor); el editor lo premarca. El **listado no lleva este JSON** (pesa y en la tarjeta no se usa): lleva su resumen en dos enteros derivados, `gps_issues_n` y `gps_issues_high`, calculados con las expresiones `GPS_ISSUES_N_SQL`/`GPS_ISSUES_HIGH_SQL` de `core/database.py` y guardados **ya calculados dentro de `idx_routes_list_cov5`**, que es un índice sobre expresiones — por eso la fila nunca se toca. Query e índice importan las mismas constantes a propósito: si los dos textos SQL dejan de coincidir, el índice deja de aplicarse y vuelve el problema de la regla 12 (`tests/test_list_cols.py` lo vigila con un `EXPLAIN QUERY PLAN`). OJO: `app.py` hace `refresh_config()` en `before_request` porque con 2 workers un POST de ajustes solo refrescaba el worker que lo atendía |
| created_at | TEXT | |
| activity_type | TEXT | senderismo/bicicleta/caminata/correr/esqui/otros |
| device | TEXT | fabricante/modelo del dispositivo |
| immich_checked | INTEGER | 0/1 |
| start_lat, start_lon | REAL | primer punto del track |
| thumb_file | TEXT | nombre en `data/thumbs/` (PNG) |
| bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat | REAL | bounding box del track completo; lo calcula `_route_bbox()` en `create_route`/`rescan_route`. Usado por `/api/routes/geojson?bbox=` (mapa del dashboard) para no cargar rutas fuera de la zona visible |
| content_hash | TEXT | SHA-256 de los bytes crudos del archivo importado (`core/dedup.py`). Dedup DURA: reimportar los mismos bytes (aunque con otro nombre) → 409. Índice propio `idx_routes_content_hash`. Solo se fija al importar; NO se recalcula al editar/reescanear (la pregunta es "¿ya vi este archivo?", referida al original) |
| signature | TEXT | Huella SEMÁNTICA del entreno (`route_signature`): `started_at` al minuto + primer/último punto a 4 decimales (~11 m). Sin timestamps cae a distancia(100 m)+nº puntos. Dedup BLANDA. Índice propio `idx_routes_signature`. Deliberadamente NO incluye distancia cuando hay hora (el hash por igualdad daría falsos negativos en las fronteras de cubo). Solo al importar, no se recalcula |
| dup_suspect_of | INTEGER | id de la ruta a la que se parece, cuando la ingesta AUTOMÁTICA (`?auto=1`) la importó pese al aviso semántico. NULL = limpia. Se lee en el listado → va en `idx_routes_list_cov5` (regla 12). Se limpia al editar la ruta o con `PATCH {dup_suspect_of:null}` ("descartar aviso") |
| locality | TEXT | Sitio donde se hizo la ruta ("Localidad, Región"), por geocoding inverso del punto de inicio (`core/geocode.py`, `GEOCODE_URL` en Ajustes → Editor). Se rellena best-effort al importar (`create_route`) y al reescanear una ruta que aún no la tenga (`_reanalyse_and_update`, backfill vía "Re-escanear"); NULL = servicio desactivado o geocoding fallido. Se lee en el listado y se muestra en la tarjeta de "Mis Rutas" y en el detalle → va en `idx_routes_list_cov5` (regla 12) |
| public_id | TEXT | Identificador **opaco no secuencial** (`secrets.token_urlsafe(8)`, ~11 chars) expuesto en TODAS las URLs `/api/routes/<public_id>/...`; la PK entera `id` queda solo interna (FKs, `versions/<route_id>/`, prefijo de nombre de foto). Evita que CrowdSec vea enumeración al pedir las miniaturas del listado. Índice UNIQUE `idx_routes_public_id`; se lee en el listado → va en `idx_routes_list_cov5` (regla 12). Se fija al importar (con reintento por colisión) y por backfill en `init_db()`; NO se recalcula. Los endpoints resuelven `public_id`→`id` con `rid_from_public()` en su 1ª línea (thumb/gpx/foto consultan `WHERE public_id=?` directo). Al añadirlo se invalidó la caché del cliente (regla 11) |

### Tabla `route_versions`
Historial del editor de rutas (append-only, ver sección "Editor de rutas").
`route_id`, `version_n` (UNIQUE juntos), `file` (nombre en
`data/gpx/versions/<route_id>/`), `summary` (en español), `distance_m`,
`ascent_m`, `n_points`, `created_at`. Sin filas = ruta nunca editada (versión 0).
El archivo activo de la ruta es siempre idéntico a la versión más alta.

### Tabla `photos`
`route_id`, `file` XOR `immich_id`, `original`, `lat`, `lon`, `taken_at`,
`public_id` (opaco no secuencial, como en `routes`: `/api/photos/<public_id>/file`
y DELETE; índice UNIQUE `idx_photos_public_id`; se fija al insertar con
`set_public_id()` y por backfill en `init_db()`). La PK entera `id` queda interna.
`idx_photos_route ON photos(route_id)` (v0.9.5) es lo que hace barato el subselect
`n_photos` del listado de rutas: sin él SQLite se fabrica un índice automático en
cada petición, y con volumen pasa a `SCAN photos` (34 ms vs 1,4 ms con 500 rutas).

### Tabla `planned_routes`
`name`, `source` (`gpx` | `dibujada`), `source_url`, `activity_type`,
`distance_m`, `ascent_m`, `descent_m`, `ele_min`, `ele_max`, `start_lat`,
`start_lon`, `geojson`, `elevation`, `notes`, `gpx_data` (BLOB), `created_at`,
`public_id` (opaco no secuencial, igual que en `routes`/`photos`: es la URL
canónica `/Plan/<public_id>`, la clave de `/api/planned/<public_id>` y la clave
estable de la sincronización; índice UNIQUE `idx_planned_public_id` + índice de
cobertura del listado `idx_planned_list_cov`, regla 12 — estas columnas pequeñas
vienen físicamente DESPUÉS del BLOB `gpx_data`).

La v0.9.6 eliminó `draw_anchors` (resto del planificador interno revertido). El
`DROP COLUMN` de una tabla con BLOB e índices de cobertura sale limpio **si la
columna no está en ningún índice ni la nombra ningún trigger**; compruébalo antes
de repetir la jugada con otra.

Las columnas que devuelve el listado están en **una sola constante**,
`PLANNED_LIST_COLS` (`api/planned.py`), porque las leen `list_planned()` **y**
`api/sync.py` para los `upserted` del delta. Lo mismo con `ROUTE_LIST_COLS` en
`api/routes.py`: si las dos listas se separaran, el cliente recibiría tarjetas con
campos distintos según si la ruta llegó por la carga inicial o por una sync.

### Tablas `sync_seq` y `sync_log` (sincronización delta)
`sync_seq` es un contador monotónico global
(una sola fila); `sync_log` tiene **una fila por entidad viva o borrada**
(`entity` `'route'|'planned'`, `entity_id` = PK interna, `public_id`, `rev`, `op`
`'up'|'del'`), y esas filas **no se borran nunca**: `op='del'` es la tombstone que
permite que un cliente apagado semanas sepa qué desapareció (~40 B por entidad).

Lo mantienen **9 TRIGGERS**, no el código Python (`_sync_triggers_sql()` en
`core/database.py`): las mutaciones están repartidas en 13 sitios de 5 blueprints y
cualquier esquema que dependa de "acuérdate de subir el contador aquí" se rompe en
el primero que se olvide. Las fotos **no** son entidad propia: al añadirlas o
borrarlas suben el `rev` de SU RUTA, que es lo que invalida el detalle cacheado en
el cliente (las fotos van dentro de ese detalle).

**`rev` es un cursor opaco**: no es una fecha, no ordena por antigüedad y no se
muestra en la UI. Solo dice "esto ya no es lo que tenías".

`settings['sync_epoch']` es la red de seguridad: si se restaura un backup o se
reconstruye la BD, el epoch cambia y todos los clientes recargan de cero en vez de
quedarse con datos fantasma. `settings['sync_min_rev']` es la escotilla por si algún
día se purgan tombstones (hoy 0: no se purgan).

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

Mapas (Ajustes → Mapas, en `_SETTINGS_KEYS`): `MAP_OFFLINE_FILE` (nombre de un
`.pmtiles` dentro de `data/tiles/`; vacío o inexistente = la capa "Offline (local)"
no se ofrece), `MAP_DEFAULT_LAYER` (capa base con la que arrancan los mapas),
`MAP_OFFLINE_MAXZOOM`, `MAP_OFFLINE_ATTRIBUTION`. De solo lectura para el cliente
vía `/api/maps` y `<body data-map-cfg>` (lo lee `MAP_CFG` en `static/shared.js`).
`sync_epoch` y `sync_min_rev` también viven aquí, pero los escribe `init_db()`.

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
- Las plantillas de la app multipágina **ya no existen** (ver "Frontend"). Para ver
  cómo era algo antes de la SPA: `git show v0.7.1:templates/<archivo>`.
- **Código viejo pegado en el navegador tras publicar una versión.** Es el peor fallo de
  esta arquitectura: el documento llega de red (nuevo) pero `static/js/**` se sirve con
  revalidación por detrás, así que la primera carga tras actualizar puede ejecutar el JS
  anterior; y con una PWA instalada el Service Worker no se releva mientras quede una
  ventana viva. Síntoma: "no cargan las opciones", botones que no responden, secciones a
  medias — sin ningún error claro en el servidor. Salida: **`/actualizar`** (enlazado en
  Ajustes → **Mantenimiento**), que borra SW, cachés, IndexedDB y sesión; o cerrar del todo
  la PWA. Esa sección del modal muestra además la versión que sirve el servidor frente a la
  que tiene guardada el navegador (`mantEstado()` en `chrome.js`, que la deduce del nombre
  de la caché `sendero-shell-<versión>`): si no coinciden, es esto. Antes de sospechar del código, comprueba la misma URL en una ventana de incógnito:
  si ahí funciona, es esto.
- **Detrás de un proxy con autenticación** (Pangolin, Authelia, oauth2-proxy…), el
  `<link rel="manifest">` de `base.html` NECESITA `crossorigin="use-credentials"`. Es el
  único subrecurso que el navegador pide sin cookies, así que sin ese atributo el proxy lo
  ve sin sesión, redirige al SSO (otro dominio) y el navegador bloquea la redirección con
  `blocked by CORS policy: No 'Access-Control-Allow-Origin' header`. Si aun así falla, es
  que el SSO no deja cookie en el dominio del recurso: entonces hay que excluir
  `/manifest.webmanifest` de la autenticación en el proxy. El Service Worker (`/sw.js`) no
  sufre esto: se registra con credenciales `same-origin`.
- **`python app.py` no recarga las plantillas**: sin `debug=True`, Jinja compila cada
  plantilla una vez y la guarda en memoria mientras viva el proceso. Editar
  `templates/*.html` y recargar el navegador NO enseña el cambio (el CSS y el JS sí,
  que son estáticos) — hay que reiniciar el servidor. Cuesta un rato de depuración
  creer que una regla CSS "no aplica" cuando lo que falta es el markup nuevo.
- **Las capturas de página completa de un mapa o una gráfica salen a medias**: el
  contenido WebGL (MapLibre) y los `<canvas>` de Chart.js no se repintan para el
  viewport ampliado que usa `full_page=True`, así que se ven cortados o comprimidos
  aunque en pantalla estén bien. Para juzgar el aspecto, captura del viewport.
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
- Si tocaste el CSS del modal Immich (`static/css/detalle.css`): comprueba que
  `#sec-detalle .overlay.hidden` sigue ocultando el modal al cargar la ruta.
- Con Playwright disponible, la comprobación de verdad es `python tests/e2e_spa.py`
  (~115 asserts en un navegador real: mapas, gráficas, fugas de `unmount()`, Service
  Worker, modo sin conexión y cola de escrituras). Necesita un servidor con
  `SENDERO_DATA` **de pruebas** y `python tests/e2e_seed.py` para sembrarlo.
- Si tocaste `/actualizar` o el Service Worker: comprueba que la página sigue llegando de
  red (el SW no debe interceptarla) y que deja SW, cachés, IndexedDB y sessionStorage a
  cero; y que al volver a la app se rehacen los cuatro.
- Si tocaste la PWA (`static/sw.js`, `api/pwa.py`, el precache): `node tests/sw_smoke.js`,
  y comprueba que **todas** las URLs de `PRECACHE_URLS` devuelven 200 (un 404 se salta sin
  romper la instalación, pero deja esa pieza sin cachear y la app no arranca sin conexión).
  En el navegador: DevTools → Application → Service Workers → "Offline" y recargar.
- Si añadiste un archivo a `static/js/sec/` o `static/css/`: añádelo a `PRECACHE_URLS`
  de `static/sw.js`, o esa sección no se podrá montar sin conexión.
- Si tocaste el mapa sin conexión por ruta (`static/js/core/tiles.js`, `tileFirstNetwork`
  en el SW): `node tests/tiles_smoke.js`, y recuerda que la caché `sendero-tiles-v1` debe
  seguir en `KEEP` del Service Worker (si sale, se borrará al publicar cada versión).
- Si tocaste `_build_route_dict()`: verifica que `/api/routes/<id>` y
  `/Sendero/<nombre>` devuelven los mismos campos.
- Si añadiste columnas a `/api/routes` (lista): tócalas en `ROUTE_LIST_COLS`
  (`api/routes.py`, la comparten el listado y `/api/sync/changes`), añade su índice de
  cobertura y sube `DB_VERSION` en `static/js/core/store.js` para invalidar la copia
  local de los clientes (regla 11).
- Si tocaste la sincronización: `curl -si localhost:8090/api/sync/state` dos veces (la
  segunda con `If-None-Match` debe dar **304**), y comprueba que crear/editar/borrar una
  ruta mueve el `cursor` y aparece en `/api/sync/changes?since=<anterior>` (los triggers
  se disparan en el esquema, no en la conexión, pero verifícalo, no lo asumas).
- Si tocaste una sección de la SPA: ¿`unmount()` destruye el mapa y los `Chart`?
  `node tests/sec_smoke.js` y la suite e2e lo comprueban montando y desmontando 20 veces
  y contando `<canvas>`. ¿Los listeners de `document` se registran una sola vez al cargar
  el archivo, y no en cada `mount()`?
- Si añadiste un archivo a `static/js/sec/` o `static/css/`: ¿está en `PRECACHE_URLS` y su
  URL en `SHELL_PATHS` (`static/sw.js`)? Sin lo primero la sección no se monta sin
  conexión; sin lo segundo su URL da la página de aviso en vez del shell.
- Si tocaste algo del editor: además de la paridad `doOp()`↔`apply_ops()`, comprueba que
  salir con cambios sin guardar sigue preguntando. Ya no basta `beforeunload`: salir del
  editor puede ser un simple cambio de sección, y de eso se encarga un listener en fase de
  captura dentro de `sec/editor.js`.
- Si tocaste la corrección de velocidad excesiva o los avisos GPS del editor:
  `node tests/speedfix_smoke.js` **y `node tests/gps_parity_smoke.js`** (y recuerda que la
  herramienta **recoloca** los puntos, no los borra: si vuelve a aparecer un
  `delete_points` con todos los marcados, es una regresión). El nombre de las funciones
  importa: los tests las extraen por nombre del archivo.
- Si tocaste `core/gps_analysis.py::detect_gps_anomalies` o `detectGpsIssues()` de
  `sec/editor.js`: **son la misma lógica en dos idiomas y tienen que seguir coincidiendo**
  (`node tests/gps_parity_smoke.js`). Y si añades un umbral, mándalo también en
  `gps_thresholds` de `/api/routes/<id>/editor`, o «✔ Corregir todo» no podrá verificarse
  y volverá a hacer falta pasarlo varias veces.
- Si tocaste `chrome.js`, `router.js` o `store.js`: recuerda que `Router` y `Store` son
  `const` de un script clásico y **no** están en `window` (ver "Bugs corregidos"). Para
  saber si están cargados: `typeof X !== 'undefined'`.
- Si creaste un mapa nuevo o tocaste el selector de capas: ¿pasa por
  `buildStyle(defaultBasemap(...))` y por `applyBasemap()`, y repinta sus capas de datos
  al entrar/salir de la capa offline? (regla 15).
- Si tocaste `makeCard` o el CSS de `.card`: están en `sec/rutas.*`, y el CSS va escopado
  bajo `#sec-rutas` (sin el prefijo pisaría a `.plan-card` y a las tarjetas del detalle).
- Si tocaste el mapa del dashboard: verifica que `paintRoutes()` limpia las fuentes antes
  de repoblar (si no, tras borrar rutas quedan puntos y líneas fantasma) y que
  `initMap()` no crea dos mapas (guarda `if (map) return`).
- Si añades assets estáticos a `static/`: el `COPY static ./static` ya está en el Dockerfile.
- Si añadiste una columna a `routes` que se lee en un listado/agregado frecuente:
  ¿le añadiste también su índice de cobertura en `init_db()`? (ver regla 12).
- Si tocaste algo en `init_db()`: ¿sobrevive a ejecutarse dos veces en paralelo
  (2 workers de gunicorn)? (ver regla 13).
- Si tocaste el editor (`core/editing.py`/`api/editor.py`): ¿el orden de aplanado
  sigue siendo idéntico al de `analyse_gpx()`? ¿El activo sigue siendo igual a la
  versión más alta tras guardar y tras restaurar? ¿Los `<time>`/HR sobreviven a un
  recorte? (smoke test al final de "Editor de rutas").
- Si tras `docker compose up -d --build` los cambios no se reflejan en `localhost:8090`
  pese a que el build no falla: revisa el quirk de procesos huérfanos de Docker
  Desktop/WSL2 antes de sospechar del código.
- Si tocaste el mapa de "Mis Rutas" (`sec/rutas.js`): ¿las líneas (`ov-lines`) siguen
  respetando los filtros de actividad/fecha vía `applyLineFilter()`, o se te ha colado un
  caso que las muestra sin filtrar? ¿sigue usando `fitMap(true)` en el primer encuadre
  (sin animación de vuelo)?
- Si tocaste `renderElev/renderSpeed/renderHR` o el mapa en `sec/detalle.js`: ¿el hover
  sincronizado sigue funcionando en las 4 direcciones (mapa→gráficos y cada gráfico→resto)?
  Si añades un `Chart` nuevo, usa `ctx.onmouseleave=...` (asignación directa, no
  `addEventListener`) para no acumular listeners en cada `renderAll()`.
- Si tocaste el color o la tipografía: ¿sale de un token de `base.html` (regla 9)? Un hex
  suelto en una sección es lo que hace que la próxima vez la paleta quede a medias.
  Comprobación: `grep -rn "#[0-9a-f]\{6\}" static/css/ templates/sec/`. Lo que sí puede
  aparecer ahí son los colores de las **series de gráficas** (`#3f5a49`, `#4e7159`,
  `#e8863c`…), el degradado del mapa cabecera, las sombras `#000000xx` y los badges de
  fuente de los planes; cualquier otro hex nuevo es que falta un token.
- Si tocaste el detalle en móvil: ¿las cuatro pestañas siguen mostrando su bloque
  (`data-tab`/`data-dtab`) y `setTab()` redimensiona los Charts? ¿Las acciones del mapa
  cabecera caen debajo del mapa por debajo de 1200 px (están en `.d-hero-wrap`, fuera de
  `.d-hero`, que recorta)?
- Si tocaste la analítica del dashboard: ¿sigue saliendo del listado del Store (o sea,
  sigue funcionando sin conexión) y el selector de año sin pedir nada al servidor?
