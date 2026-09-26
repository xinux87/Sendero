# CLAUDE.md

Contexto para trabajar en **Sendero** (bitácora autoalojada de rutas de montaña).
El README explica *qué hace* y cómo desplegarlo; este archivo cubre lo que necesitas
para tocar el código sin romperlo. Si algo de aquí contradice al README, este manda.

## Qué es, en una frase
Monolito Flask + SQLite que sube/visualiza GPX y FIT, les asocia fotos (locales o de
Immich por referencia), genera thumbnails PNG de cada track y guarda un resumen por ruta.

## Qué forma tiene hoy
**Una SPA**: las 7 vistas (dashboard, rutas, planes, detalle de ruta, detalle de plan,
editor, unir) son secciones de un único documento (`templates/shell.html`), y todo el JS
de vista vive en `static/js/sec/` (ver "Frontend"). Cambiar de sección no pide ningún
documento nuevo: solo el JSON que haga falta, y a menudo ni eso.

Son 7 vistas y **9 URLs**: dos secciones sirven para dos entidades cada una, una ruta y
un plan. El `editor` (`/Sendero/<pid>/editor` y `/Plan/<pid>/editor`, desde la v0.10.0)
y `unir` (`/Sendero/<pid>/unir` y `/Plan/<pid>/unir`, desde la v0.11.7). Cada una es el
mismo archivo con el mismo markup; lo que cambia va en su objeto `K`
(`sec/editor.js`, `sec/unir.js`) y, en el servidor, en el `RouteTarget`/`PlanTarget`.

**Y una PWA que funciona sin conexión**, apoyada en un Service Worker que precachea el
shell y el código, y en un almacén local (IndexedDB) que se pone al día con
sincronización delta. Lo que eso significa en la práctica:

- **Funciona sin conexión**: abrir la app en cualquier vista (shell y código
  precacheados), los listados de rutas y planes, el dashboard (con las últimas
  estadísticas guardadas, avisando), el detalle de rutas y planes ya sincronizados, el
  mapa de «Mis Planes» con las trazas de cada plan (guardadas en el Store), el
  mapa base si hay un `.pmtiles` en `data/tiles/`, el botón «Mi ubicación» de cualquier
  mapa (la ubicación la da el dispositivo, no el servidor), y editar nombre/notas/actividad y
  **marcar un plan como realizado** (se encolan y se envían al volver la red).
- **NO funciona sin conexión, a propósito**: el **editor** —el de una ruta y el de un
  plan, que son el mismo— (opera sobre el estado guardado en el servidor y cada guardado
  lleva `base_version`; encolar eso sería inventarse decisiones del servidor), **unir**
  (la decisión la toma el servidor mirando la geometría de los tracks enteros, que el
  cliente no tiene: la vista se abre y lo explica, pero no previsualiza ni crea nada),
  subir rutas
  o fotos, Immich, reescanear (rutas y planes), calcular el índice IBP y borrar. Todas
  avisan en vez de fallar en silencio: «✎ Editar track» de la ficha de un plan ni siquiera
  navega, avisa y se queda donde está.
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
python -m pytest                   # 204 tests unitarios (tests/): editing, parsers, FIT, gps_analysis,
                                   #   actividades (el catálogo y su cableado), la edición de PLANES
                                   #   (test_plan_editing.py: targets, versiones, unir, dividir, IBP),
                                   #   la UNIÓN inteligente (test_merge.py: geometría, propuestas,
                                   #   rendimiento y los dos endpoints, con preview),
                                   #   dedup, geocode, ibp, sync y las columnas de los dos listados

# OJO: en esta máquina NO hay `node` instalado, así que los seis smokes de
# JavaScript de abajo NO se pueden lanzar aquí (se verificaron en un navegador
# real con Playwright, canal `msedge`). Sigue siendo obligatorio pasarlos donde
# sí lo haya: son la única red que cubre ese código.
node tests/sw_smoke.js             # Service Worker: install/activate + estrategias (solo Node)
node tests/sec_smoke.js            # sec/detalle.js, sec/plan.js, sec/editor.js y sec/unir.js
                                   #   (los dos últimos, como ruta Y como plan) cargan contra
                                   #   los ids reales del markup
node tests/tiles_smoke.js          # geometría del corredor de teselas (§6.2)
node tests/slope_smoke.js          # escala de pendiente (color verde→rojo de traza y perfil)
node tests/speedfix_smoke.js       # velocidad excesiva y convergencia de «Corregir todo»
node tests/gps_parity_smoke.js     # el detector de avisos GPS del cliente == el del servidor

# end-to-end en un navegador real (Playwright; NO va en requirements-dev.txt)
python -m venv /tmp/pw && /tmp/pw/bin/pip install playwright
/tmp/pw/bin/playwright install chromium
SENDERO_DATA=/tmp/sendero-e2e python app.py &        # ¡datos de PRUEBA, no los reales!
python tests/e2e_seed.py http://localhost:8080       # siembra 4 rutas + 2 planes (los planes, sin <time>)
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
  activities.py — CATÁLOGO DE DEPORTES: la única fuente de verdad de qué actividades
                  existen. Un deporte entero (id, etiqueta, color, icono, umbrales
                  GPS, palabras de detección y modalidad IBP) se define AQUÍ y en
                  ningún otro sitio; ver "Catálogo de actividades"
  config.py     — paths (GPX_DIR, PHOTO_DIR, THUMB_DIR, VERSIONS_DIR, TILES_DIR, DB_PATH),
                  variables Immich y de mapas (MAP_OFFLINE_FILE/MAP_DEFAULT_LAYER…)
  database.py   — init_db(), close_db(), helper db() (conexión por request vía g.db),
                  public_id (set_public_id/rid_from_public/plan_id_from_public) y el
                  esquema de sincronización: sync_seq/sync_log + los 9 triggers,
                  sync_cursor()/sync_epoch()/entity_rev()
  sync.py       — lógica PURA de la sincronización: diff_manifest(local, remoto) →
                  {missing, stale, extra}, decimate() y resample() para ?lite=1,
                  más decimate_indices()/remap_indices()/decimate_with_segments()
                  para que los cortes de `seg_starts` sobrevivan al decimado
                  (tests en tests/test_sync.py)
  parsers.py    — analyse_gpx() y analyse_fit() → devuelven (stats, coords, elev, name, creator).
                  FIT con garmin-fit-sdk (SDK oficial); _fit_dt() normaliza datetimes a naive-UTC
                  como hacía fitparse — no devolver datetimes aware (rompe merge_gpx e Immich)
  thumbs.py     — generate_thumb(coords, gpx_file) → PNG 400px en data/thumbs/
  editing.py    — lógica pura del editor: extract_points(), apply_ops(), fit_to_gpx()
                  y smart_merge() — la UNIÓN inteligente de dos o más GPX, ver
                  «Unir rutas y planes» (merge_gpx() queda como envoltorio)
  summaries.py  — auto_summary() y auto_summary_planned()
  exif.py       — extrae lat/lon/taken_at de fotos subidas
  geocode.py    — reverse_geocode(lat,lon) → 'Localidad, Región' o None. Best-effort
                  (nunca rompe import/rescan, como thumbs/gps_issues). Endpoint
                  compatible Nominatim configurable (GEOCODE_URL, Ajustes → Editor;
                  vacío = desactivado). _format_locality() es pura (tests/test_geocode.py)
  immich.py     — cliente HTTP para Immich (immich_get, immich_search, min_dist_to_track)
  ibp.py        — índice IBP (ibpindex.com) de las rutas PLANIFICADAS. Su algoritmo es
                  cerrado: analyse() sube el GPX a su API (clave en Ajustes → IBP Index,
                  vacía = desactivado) y parse_response() —pura, tests/test_ibp.py— elige
                  la modalidad que toca de las tres que devuelve. Lanza IbpError con
                  mensaje en español; el importador lo captura y sigue
  mifit/        — cliente Huami (Mi Fit/Zepp) vendorizado de MiFitDataExport:
                  api.py (HTTP+modelos), points.py (decodifica el detalle crudo),
                  gpx.py (build_gpx/workout_filename), sync.py (iter_new_workouts).
                  Solo el camino GPX-por-token; añade únicamente 'pydantic' a deps.

api/
  routes.py     — CRUD de rutas + rescan + thumb + stats; y las páginas
                  /Sendero/<pid> y /Sendero/<pid>/unir (shell.html)
  editor.py     — EDITOR: la página, /points, el guardado por ops, el DEM y las
                  versiones. La E/S vive en un TARGET (`RouteTarget` aquí,
                  `PlanTarget` en planned_editor.py) y el flujo de cada operación
                  (run_points/run_edit/run_elevation_dem/run_list_versions/
                  run_restore/commit_new_version) es común a rutas y planes.
                  También la UNIÓN, que no depende del target (opera sobre
                  objetos gpxpy en memoria): merge_options/run_merge/
                  merge_report_lean/merge_preview_response
  photos.py     — subida y borrado de fotos locales; proxy de fotos Immich
  planned_editor.py — EDITOR DE PLANES: `PlanTarget` (la E/S del editor sobre
                  planned_routes.gpx_data + la tabla plan_versions) y los endpoints
                  espejo de los de ruta. El FLUJO no está aquí: lo pone api/editor.py
  planned.py    — CRUD de rutas planificadas y sus páginas (/Plan/<pid> y
                  /Plan/<pid>/unir), /api/planned/geojson (las trazas para
                  el mapa de la sección), el estado de "realizada" del PATCH
                  (completed_at + completed_route → completed_route_id) y el índice
                  IBP: /api/planned/<id>/ibp lo calcula, create_planned lo intenta
                  best-effort al importar, y el PATCH de actividad reelige la
                  modalidad desde ibp_all sin tocar la red
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
Además hay seis pruebas de humo de JavaScript que se lanzan con **Node a pelo** (sin npm
ni dependencias, regla 1; pytest ignora los `.js`): `node tests/sw_smoke.js` ejecuta
`static/sw.js` con `caches`/`fetch` simulados y comprueba install/activate y qué
estrategia le toca a cada URL; `node tests/sec_smoke.js` carga `static/js/sec/detalle.js`,
`plan.js`, `editor.js` y `unir.js` contra los ids reales de su markup **más el de
`shell.html`** (el documento real es la suma de los dos: las acciones de cabecera viven en
el shell), los monta con el Store devolviendo `null` y así pilla un selector que ya no
existe — `editor` y `unir` se montan **dos veces**, como ruta y como plan. Si añades
una sección al array `SECCIONES`, hereda la comprobación;
`node tests/tiles_smoke.js` mide el corredor de teselas; `node tests/slope_smoke.js`
comprueba la escala de pendiente (que sea absoluta, que la ventana aplane el ruido del
GPS y que las paradas del degradado de MapLibre vayan crecientes); y `node tests/speedfix_smoke.js`
extrae del propio `sec/editor.js` la geometría de la corrección de velocidad excesiva
(`planSpeedFix`/`detectSpeedErr`) y la ejecuta contra tracks sintéticos con saltos de GPS.

Rendimiento transversal: la BD corre en WAL (`init_db()`), las respuestas de texto van
con gzip/brotli (flask-compress en `app.py`, mínimo 500 bytes), y los binarios llevan
caché: thumbs con ETag/304 (revalidación: se regeneran con el mismo nombre), fotos
locales inmutables con max-age 1 año, proxys Immich con caché privada de 7 días.

### Frontend — una SPA, un documento, 7 secciones

**Todas las vistas viven en `templates/shell.html`**, que no lleva datos dentro y
aloja las 7 secciones. Cada una son tres archivos con el mismo nombre:

| Sección | URL | Markup | Lógica | Estilos |
|---|---|---|---|---|
| `dashboard` | `/dashboard` | `templates/sec/dashboard.html` | `static/js/sec/dashboard.js` | `static/css/dashboard.css` |
| `rutas` | `/rutas` | `sec/rutas.html` | `js/sec/rutas.js` | `css/rutas.css` |
| `planes` | `/planificacion` | `sec/planes.html` | `js/sec/planes.js` | `css/planes.css` |
| `detalle` | `/Sendero/<public_id>` | `sec/detalle.html` | `js/sec/detalle.js` | `css/detalle.css` |
| `plan` | `/Plan/<public_id>` | `sec/plan.html` | `js/sec/plan.js` | `css/plan.css` |
| `editor` | `/Sendero/<public_id>/editor` **y** `/Plan/<public_id>/editor` | `sec/editor.html` | `js/sec/editor.js` | `css/editor.css` |
| `unir` | `/Sendero/<public_id>/unir` **y** `/Plan/<public_id>/unir` | `sec/unir.html` | `js/sec/unir.js` | `css/unir.css` |

El router (`static/js/core/router.js`) monta la sección según `location.pathname`,
así que **navegar entre vistas no pide ningún documento**: solo el JSON que haga
falta, y a menudo ni eso (lo tiene el Store).

**Las siete vistas siguen el rediseño**, con la opción **2a** en pantalla grande y
la **2d** en móvil: `detalle`, `rutas` y `dashboard` desde la v0.9.0, `planes` +
`plan` desde la v0.9.3, `editor` desde la v0.9.4 y `unir` desde la v0.11.7 (nació
ya con él). El patrón, si añades una
octava: panel `--panel` + borde `--line` + radio 12, título de panel en
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
| `--panel` / `--panel-2` / `--panel-3` | `#101a14` / `#16241c` / `#22332a` | tarjetas y paneles / inputs y filas realzadas / brillo del shimmer de carga |
| `--line` / `--line-strong` | `rgba(236,229,216,.09)` / `.16` | borde de tarjeta / de control |
| `--ink` | `#ece5d8` | texto principal (crema) |
| `--muted` / `--muted-dim` / `--muted-faint` | `#8b9a8f` / `#7f9184` / `#68786d` | texto secundario / etiquetas / ejes y fechas |
| `--sage` | `#8fb69f` | títulos de panel y curvas de nivel |
| `--pr-yellow` | `#e3b23c` | ámbar: cifras clave, estado activo, avisos |
| `--gr-red` | `#e2492c` | rojo: acción primaria (`--gr-red-hover` al pasar) |
| `--display` / `--mono` | Oswald / IBM Plex Mono | títulos y cifras / datos y etiquetas |

Los colores de la **escala de pendiente** (verde→rojo de la traza y el perfil) también
viven en `static/shared.js`, en `SLOPE_SCALE`, y de ahí sale hasta la leyenda: ver
«Color por pendiente en los dos detalles».

Los colores de actividad viven en el catálogo de `core/activities.py` (no en CSS
ni en `shared.js`, que solo lo recibe inyectado — ver «Catálogo de actividades»):
`senderismo #e8863c` · `bicicleta #3d9be9` · `caminata #43b97f` · `correr #e34b4b` ·
`esquí #a86ee0` · `kayak #23bfc4` · `otros #e055c0`, con el glifo del icono en `#0b120e` (tinta oscura
sobre el color, no blanca). **Nada de hex sueltos** en plantillas ni en el CSS de
las secciones: si necesitas un color que no está, añade el token aquí. Las únicas
excepciones son los `rgba()` de velos y separadores del propio rediseño, los
colores de serie de las gráficas (elevación `#f0b070`, velocidad `#3d9be9`, FC
`#e34b4b`, barras `#3f5a49`/`#4e7159`/`#e8863c`), que van en el JS que las pinta
—`sec/unir.js` reusa los dos primeros para los tracks A y B de su previsualización,
y su `css/unir.css` no lleva ni un hex—,
y los iconos del botón «Mi ubicación» en `base.html`: van dentro de un `data:URI`
porque una `url()` no puede leer una variable CSS, y **repiten el valor** de
`--pr-yellow` y `--gr-red` (si cambias esos tokens, cámbialos también ahí).

> **En `templates/` solo hay tres cosas**: `base.html` (el chrome: cabecera, modal
> de Ajustes, CSS global), `shell.html` (el shell de la SPA) y `sec/` con las 7
> secciones. Nada más. La app multipágina anterior (`app.html`, `sendero.html`,
> `editor.html`, `rutas.html`, `overview.html`, `planificacion.html`,
> `plan_detalle.html`) se borró tras la v0.7.1; si necesitas ver cómo era algo
> antes de la SPA: `git show v0.7.1:templates/app.html`.

**Si añades una sección nueva** hacen falta cinco cosas, y olvidar cualquiera la
rompe de una forma distinta: (1) el archivo en `templates/sec/`, incluido en
`shell.html`; (2) su ruta en `ROUTES` de `router.js`; (3) su `.js` y `.css` en
`PRECACHE_URLS` de `static/sw.js` (si no, no se puede montar sin conexión); (4) su
URL en `SHELL_PATHS` del mismo archivo (si no, sin conexión da la página de aviso
en vez del shell); (5) la ruta Flask que sirva `shell.html`. La sección `unir`
(v0.11.7) es el ejemplo reciente de las cinco, y añadió una sexta que conviene no
olvidar: su nombre en `SECCIONES` de `tests/sec_smoke.js`.

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
static/shared.js   ACTIVITIES (lo INYECTA base.html desde core/activities.py, no
                   se escribe aquí)/activityOf/iconSvg/_loadActImages, BASEMAP_TILES,
                   gapFeatures/addGapLayers/GAP_MIN_M (los huecos entre
                   segmentos del track, ver «Huecos entre segmentos»),
                   SLOPE_SCALE/slopeColor/slopeProfile/slopeBuckets/
                   slopeGradientExpr/slopeChartGradient/slopeLegendHtml
                   (color por pendiente de los dos detalles),
                   buildStyle/basemapNames/defaultBasemap/applyBasemap, MAP_CFG,
                   addGeolocate/geoTracking (botón «Mi ubicación», ver §6.3)
static/js/core/    chrome.js  helpers globales ($, toast, fmtKm/fmtDur/fmtDate, esc)
                              + TODO el modal de Ajustes + registro del Service
                              Worker + badge de conexión + Ajustes → Sin conexión.
                              Se carga en base.html (sin IIFE a propósito: lo
                              llaman los onclick=)
                   loader.js  loadOnce()/loadCssOnce(): inyecta el <script>/<link>
                              de una sección una sola vez
                   router.js  Router de las 7 vistas en 9 URLs (el editor y unir
                              tienen una por entidad, con `kind`) + window.go()
                   store.js   IndexedDB + sincronización delta + outbox (§4/§7)
                   tiles.js   mapa sin conexión de UNA ruta: corredor de teselas
                              del track, caché `sendero-tiles-v1` y su UI (§6.2)
static/js/sec/     un archivo por sección, en IIFE, publicando
                   window.SEC.<sec> = {mount(params,opts), unmount()}
static/css/        el CSS de cada sección migrada, escopado bajo #sec-<sec>
templates/sec/     el markup de cada sección migrada
```

**Son `<script>` clásicos, no módulos ES**: hay 123 atributos `onclick=` en las
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
| `templates/shell.html` | **todas** las vistas (`/dashboard`, `/rutas`, `/planificacion`, `/Sendero/<id>`, `/Sendero/<id>/editor`, `/Sendero/<id>/unir`, `/Plan/<id>`, `/Plan/<id>/editor`, `/Plan/<id>/unir`, `/app-shell`) | Shell de la SPA: incluye los 7 `templates/sec/*.html`, la tab bar, las acciones de cabecera por sección (`data-sec-actions`), carga `core/loader.js`+`store.js`+`router.js` y llama a `Router.start()`. Cero datos inyectados salvo el `bootstrap_json` opcional de la primera carga (`/app-shell` lo sirve **sin** él: es el que precachea el SW) |
| `templates/sec/detalle.html` | (sección `detalle` del shell) | Detalle de ruta con el rediseño 2a/2d: **mapa cabecera** (`.d-hero`, 360 px, con el título y el chip de actividad encima del velo), banda de 7 métricas (`#d-stats`), y cuerpo a dos columnas (perfil + velocidad + FC + fotos ‖ datos técnicos + calidad del track + resumen). En móvil el cuerpo son pestañas: `data-tab` en la sección y `data-dtab` en cada bloque (ver «Pestañas del detalle en móvil»). Los ids genéricos llevan prefijo `d-` (`#d-map`, `#d-stats`, `#d-elev`, `#d-notes`…) para no chocar con otras secciones del mismo documento |
| `templates/sec/plan.html` | (sección `plan` del shell) | Ficha de una ruta planificada: mapa cabecera con el chip de actividad y la chapa **✔ Realizada** (`#pl-done-badge`), banda de métricas, perfil, **dificultad IBP** (`#pl-ibp-panel`), datos técnicos y notas. En la fila de acciones, en este orden: `✎ Editar track`, `⛓ Unir…` (`#pl-unir-btn`), `Vista 3D` (`#pl-btn3d`) y `⬇ Mapa sin conexión` (`#pl-offline-btn`); tras el `⋯` (`#pl-actions-more`): descargar GPX (`#pl-download-btn`), marcar/desmarcar realizada (`#pl-done-btn` + el modal `#pl-done-modal`), `↺ Reanalizar` (`#pl-rescan-btn`), renombrar y eliminar. En móvil, tres pestañas (`data-tab`/`data-dtab`). Lógica en `static/js/sec/plan.js`, estilos en `static/css/plan.css` |
| `templates/sec/dashboard.html` | (sección `dashboard`) | "Analítica global": selector de año, 5 KPIs, desnivel por mes, zonas más visitadas, almacenamiento, mapa de todas las rutas, "Por actividad", "Rutas por año" y récords. Lógica en `static/js/sec/dashboard.js` |
| `templates/sec/rutas.html` | (sección `rutas`) | Listado con filtros (píldoras de actividad a la vista; fecha y **buscador** tras el botón `⋯`, ver «Cabecera de filtros»), mapa de visión general, tres vistas (⊞ Cuadrícula · ☰ Tabla · ▤ Panel), modo edición y subida de GPX/FIT. Lógica en `static/js/sec/rutas.js` |
| `templates/sec/planes.html` | (sección `planes`) | Tarjetas de rutas planificadas, mapa (marcadores de salida **y** la traza de cada plan, ver abajo), alta por GPX, **marcar un plan como realizado** (botón por tarjeta + selector `#done-modal` de la ruta que lo cumplió), la chapa del **índice IBP** y el filtro de estado `#pg-filters` (Pendientes · Realizadas · Todas, que filtra también el mapa). Lógica en `static/js/sec/planes.js` |
| `templates/sec/editor.html` | (sección `editor`) | Editor de tracks, el MISMO para una ruta y para un plan (los textos con género los pone `sec/editor.js` desde `K`). Lógica en `static/js/sec/editor.js`; sus metadatos de arranque los da `GET /api/routes/<id>/editor` o `GET /api/planned/<id>/editor`. **Unir NO está aquí** desde la v0.11.7: es la sección `unir` |
| `templates/sec/unir.html` | (sección `unir`) | Unir dos o más tracks (hasta 6) en uno nuevo, a pantalla completa y el MISMO markup para una ruta y para un plan (los textos con género los pone `sec/unir.js` desde `K`). Mapa `#un-map` + panel lateral de 380 px con los pasos «Propuestas» (`#un-props-panel`), «Inicio y fin» (`#un-ends`), «Ajustes» (`#un-tune`) y «Resultado» (`#un-result-panel`); «Con qué unir» es el popup de selección múltiple `#un-pick-modal`. Ver «Unir rutas y planes» |

### Navegación
- **La URL canónica de todo es el `public_id`**, en rutas y en planes: `/Sendero/<pid>`,
  `/Sendero/<pid>/editor`, `/Sendero/<pid>/unir`, `/Plan/<pid>`, `/Plan/<pid>/editor`,
  `/Plan/<pid>/unir`. Por nombre el servidor redirige 302 (enlaces y
  marcadores viejos siguen funcionando), pero no lo generes: el nombre es ambiguo con
  rutas repetidas y cambia al renombrar. Única excepción viva: las tarjetas de récords
  del dashboard, porque el caché de stats en `settings` solo guarda el nombre.
- Tarjeta en "Mis Rutas" → `openRoute(r.public_id)` (guarda el encuadre del mapa en
  memoria del módulo y navega con `go()`; al volver, `initMap()` lo restaura)
- Tarjeta en "Mis Planes" → `go('/Plan/' + p.public_id)`; y lo mismo el click en la traza
  del mapa de la sección (capa `pl-lines-hit`)
- Cambio de sección (Dashboard ↔ Mis Rutas ↔ Mis Planes) → SPA por el router
  (`Router.go()`, o el `data-nav` de la tab bar). El `_showSec()` de la app multipágina
  ya no existe: solo se le cita en un comentario de `router.js` como origen del patrón
- Dentro del shell nuevo: `Router.go(url)` / `window.go(url)`, o un `data-nav="/url"`
  en cualquier elemento (el router delega el click); si la vista destino no está en
  el documento, cae a `location.href` sola
- Botón "← Volver" en detalle → `data-nav="/rutas"` (el router cae a `location.href`
  porque el documento actual no aloja esa sección)
- Ficha de un plan → editor: `SEC.plan.openEditor()` → `go('/Plan/<pid>/editor')`, pero
  **solo con conexión** (si no, avisa y no navega: el editor no puede cargar sin servidor).
  El "← Volver" del editor usa `K.detailUrl(pid)`, así que vuelve a `/Sendero/<pid>` o a
  `/Plan/<pid>` según lo que se estuviera editando
- Ficha de un plan → unir: `SEC.plan.openUnir()` → `go('/Plan/<pid>/unir')`; detalle de una
  ruta → `SEC.detalle.openUnir()` → `go('/Sendero/<pid>/unir')` (este cierra antes el menú
  `⋯`). Las dos **exigen conexión**, como `openEditor()`: sin ella avisan y no navegan
- **El router tiene 9 entradas para 7 secciones** (`ROUTES` en `router.js`): las del editor
  y las de `unir` están dos veces, una por entidad, y pasan `params.kind`
  (`'route'` | `'plan'`). Cada editor y cada `unir` van ANTES que su detalle, porque
  `/Sendero/<id>/editor` y `/Sendero/<id>/unir` también encajan en el patrón de
  `/Sendero/<id>`. Lo mismo en `SHELL_PATHS` de `static/sw.js`: sin `/Plan/<id>/unir` ahí,
  esa URL daría sin conexión la página de aviso en vez del shell
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
| GET | `/actualizar` | página de reparación: desregistra el Service Worker, borra sus cachés, la IndexedDB del Store y las preferencias de sesión, y ofrece volver a la app. Antes de borrar la copia local pide a las demás ventanas que la suelten (`BroadcastChannel('sendero-db')`, lo escucha `store.js`) y **acota cada paso en el tiempo**: si otra ventana la retiene, lo dice y ofrece reintentar en vez de quedarse colgada (ver "Bugs corregidos"). `Cache-Control: no-store`, el SW **no la intercepta** y su JS va inline (un `<script src>` podría venir de la caché vieja, que es el problema que arregla). Enlazada desde Ajustes → Sin conexión |
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
| GET | `/Sendero/<public_id>/unir` | `shell.html` (sección `unir` con `kind:'route'`); por nombre redirige 302 al `public_id`. **Sin `bootstrap_json`**: la unión la calcula el servidor a partir de los archivos guardados y la sección pide al Store lo que necesita |
| GET | `/api/routes/<public_id>/editor` | metadatos de arranque del editor (nombre, versión, `gps_thresholds` con los TRES umbrales de la actividad, `gps_max_speed`, `gps_issues`, `dem_enabled`). Antes iban inyectados en la plantilla |
| GET | `/api/routes/<id>/points` | puntos completos para el editor: arrays paralelos lonlat/ele/time/hr 1:1 con los trkpt + `segments` + `version` |
| POST | `/api/routes/<id>/edit` | guarda edición: `{base_version, summary, ops}`; 409 si base_version ≠ actual |
| POST | `/api/routes/<id>/split` | divide en el punto `index`: la original se recorta (versión nueva) y la 2ª mitad pasa a ruta nueva; las fotos se quedan en la original |
| POST | `/api/routes/merge` | Unión inteligente → RUTA NUEVA (las originales intactas). Body `{ids, name, preview?, options?{reverse, trim, join_gap, tol_m, proposal, start, end, pieces}}` (`pieces` = montaje manual, ver «Unir rutas y planes»). Con **`preview:true`** no crea nada: 200 `{preview, report, stats, elevation}` (el perfil del resultado, ≤501 puntos). Sin él: 201 `{id, public_id, name, times_kept, report}` con el informe **sin geometrías** (`merge_report_lean`). Opciones mal formadas o `proposal` fuera de rango → 400. Ver «Unir rutas y planes» |
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
| GET | `/api/planned/geojson` | FeatureCollection de líneas decimadas de TODOS los planes (props: id=`public_id`, name, activity, km), para el mapa de «Mis Planes». Sin `?bbox=` a propósito: `planned_routes` no tiene columnas de bounding box y los planes son unas decenas |
| POST | `/api/planned` | crea ruta planificada desde GPX |
| GET | `/api/planned/<id>` | dict completo del plan. Lleva `version` (= `MAX(version_n)` de `plan_versions`; 0 = nunca editado), como el dict de una ruta |
| PATCH | `/api/planned/<id>` | actualiza nombre/notas/actividad del plan y su estado de **realizada**: `{completed_at, completed_route}` (fecha ISO que pone el CLIENTE y `public_id` de la ruta que lo cumplió, opcional; `{completed_at:null, completed_route:null}` desmarca y limpia la ruta). 400 si el `completed_route` no existe |
| DELETE | `/api/planned/<id>` | borra plan |
| GET | `/api/planned/<id>/gpx` | descarga GPX del plan |
| POST | `/api/planned/<id>/ibp` | calcula (o recalcula) el índice IBP del plan subiendo su GPX a ibpindex.com. 400 sin clave o sin GPX, 502 si el servicio falla (con SU mensaje), 200 `{ibp_index, ibp_modality, ibp_all}`. NO se encola sin conexión: el número lo decide un tercero |
| GET | `/Plan/<public_id>/editor` | `shell.html` (sección `editor` con `kind:'plan'`); por nombre redirige 302 al `public_id`. Sin `bootstrap_json`, como el de una ruta |
| GET | `/Plan/<public_id>/unir` | `shell.html` (sección `unir` con `kind:'plan'`); por nombre redirige 302 al `public_id`. Sin `bootstrap_json`, como el de una ruta |
| GET | `/api/planned/<id>/editor` | metadatos de arranque del editor de un plan: `kind:'plan'`, nombre, `version`, `gps_thresholds`, `gps_max_speed`, `dem_enabled`, `has_times` (parseando el GPX) y `gps_issues` **siempre vacío** (un plan no es un track grabado: no tiene saltos de receptor que avisar) |
| GET | `/api/planned/<id>/points` | puntos completos del plan para el editor (mismo formato que el de una ruta: lonlat/ele/time/hr + `segments` + `version`) |
| POST | `/api/planned/<id>/edit` | guarda edición: `{base_version, summary, ops}`; 409 si `base_version` ≠ actual. Crea versión nueva y **vacía el índice IBP** |
| POST | `/api/planned/<id>/split` | divide el plan en el punto `index`: el original se recorta (versión nueva) y la 2ª mitad pasa a plan nuevo, que hereda la actividad y nace SIN índice IBP |
| POST | `/api/planned/merge` | Espejo exacto del de rutas (mismo body, mismo `preview`, mismas respuestas; el flujo es el mismo `run_merge`) → PLAN NUEVO, los originales intactos. Solo plan + plan, ver «Unir rutas y planes» |
| POST | `/api/planned/<id>/elevation-dem` | recalcula la elevación del plan contra el DEM de Ajustes (versión nueva); 400 sin `DEM_URL`, 409 por `base_version`, 502 si el DEM falla |
| GET | `/api/planned/<id>/versions` | historial de versiones del plan (desc) |
| POST | `/api/planned/<id>/versions/<vn>/restore` | restaura la versión vn como versión nueva |
| GET | `/api/planned/<id>/versions/<vn>/gpx` | descarga el GPX de esa versión |
| POST | `/api/planned/<id>/rescan` | re-parsea el GPX guardado y rehace las métricas del plan. NO crea versión y NO toca el IBP: el track es el mismo |
| GET | `/api/config` | estado Immich (enabled, margin, dist) y si el IBP tiene clave (`ibp`) |
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
auto_summary, thumb_file, `version`, `n_points`, `seg_starts`…). Lo usan `get_route()` (API JSON) y
`sendero_page()` (inyección en template). **Si añades campos al objeto ruta,
añádelos aquí.** `n_points` se calcula aquí y no en `_route_payload()` a propósito:
tiene que ser el número de puntos del track COMPLETO, antes de que `?lite=1` decime
el `geojson` (si no, "Puntos GPS" del detalle mentiría por un factor de 20). El campo `version` se deriva de `MAX(version_n)` en
`route_versions` (0 = nunca editada); no hay columna `version` en `routes` a propósito.

### Editor de tracks (`api/editor.py` + `api/planned_editor.py` + `core/editing.py` + `static/js/sec/editor.js`)
**Un solo editor para dos entidades**: desde la v0.10.0 la misma sección edita una RUTA
(`/Sendero/<pid>/editor`) y un PLAN (`/Plan/<pid>/editor`). Lo que sabe hacer, todo con
versionado:

- **Dos modos de edición**: "Seleccionar" (tramos A–B) y "Editar puntos" (arrastrar
  vértice = `move_point`, Alt+click = `delete_points`, click en la línea =
  `insert_point`, Shift+click = waypoint).
- **Recortes y estructura**: recortar inicio/fin, eliminar tramo intermedio, invertir
  ruta y dividir en dos (`POST /split`, server-side sobre el estado guardado). **Unir
  ya no está aquí**: desde la v0.11.7 es su propia sección (ver «Unir rutas y planes»).
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

**Cómo se reparte entre ruta y plan: el TARGET es la E/S, el flujo es común.**
`api/editor.py` no sabe si detrás hay un archivo en `data/gpx/` o un BLOB en la base: eso lo
sabe el target (`RouteTarget` en `api/editor.py`, `PlanTarget` en `api/planned_editor.py`),
que implementa `read_active` / `write_active` / `current_version` / `archive_v1_if_needed` /
`archive` / `list_versions` / `version_meta` / `read_version` / `restore_active` /
`reanalyse` / `metrics` / `build_dict` / `after_new_version`. Encima van las funciones de
flujo —`run_points`, `run_edit`, `run_elevation_dem`, `run_list_versions`, `run_restore`,
`download_version_response` y, debajo de todas, `commit_new_version()`— y esas son **las
mismas** para las dos. Los errores de E/S con mensaje para el usuario viajan como
`TargetError(mensaje, status)`, que el endpoint traduce con `.response()`.

- **Regla: una operación o un endpoint nuevo del editor va SOBRE EL TARGET**, no en un
  `if kind == 'plan'`. La semántica de versionado (archivar el original antes de tocar el
  activo, insertar la fila después del reanálisis, el 409 por `base_version`) es justo lo que
  no puede divergir entre las dos entidades; duplicarla es cuestión de tiempo que se separe.
- **`after_new_version(reason)`** es el único gancho con comportamiento propio de cada una:
  en una ruta, solo `reason == 'edit'` limpia `dup_suspect_of` (dividir, DEM o restaurar no lo
  tocaban y siguen sin tocarlo); en un plan, **cualquier** versión nueva vacía el índice IBP.
- **En el cliente pasa lo mismo con `K`** (objeto `KINDS` de `sec/editor.js`): la base de la
  API (`api(pid)`), `detailUrl`, `listUrl`, `device` y todos los textos con género
  (`el`, `dividida`, `nombreB`, `invertir`, `conflicto`…). **En ese archivo no se escribe
  `/api/routes` ni `/Sendero/` a mano**: todo cuelga del helper `api()`, y el router es
  quien dice de qué se trata con `params.kind`. `mergeApi`/`list()` y los textos de unir
  se fueron con la sección `unir`, y con ellos `applyKindUI()`: los textos del editor que
  dependían del género ya no están en el markup.
- **`has_times`** llega en los metadatos de arranque de las dos (en una ruta se deduce de
  `started_at`; en un plan hay que parsear el GPX, que son unas decenas). Si es falso, el
  editor **esconde** `#speedfix-btn` («⚡ Corregir velocidad excesiva») y `#shift-btn`
  («🕐 Desplazar tiempos»), que sin Δt no pueden hacer nada, y la gráfica de velocidad ya se
  ocultaba sola. Vale para los dos: una ruta invertida también pierde sus `<time>`. Antes
  seguían a la vista para soltar un aviso al pulsarlas.
- Lo que **no** tiene un plan: dispositivo (su campo se esconde entero, y el PATCH de planes
  no lo acepta), thumbnails, avisos GPS guardados y re-detección de actividad al reparsear.

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
- **En un PLAN el archivo va DENTRO de la base**: su GPX ya vivía en
  `planned_routes.gpx_data`, así que sus versiones son filas de `plan_versions` con el
  BLOB dentro (sacarlas a `data/gpx/versions/` partiría el modelo en dos). El resto
  —numeración, v1 = original, restaurar como v(n+1), 409 por `base_version`— es idéntico,
  porque es el mismo código. Invariante equivalente: `planned_routes.gpx_data` == la
  versión más alta, y `DELETE /api/planned/<id>` borra también sus `plan_versions`.
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
- **El índice IBP de un plan se VACÍA en cada versión nueva** del track (guardar, dividir,
  DEM y restaurar) y no se recalcula solo: es un número de un tercero al que hay que subir
  el GPX entero. El plan que nace de un split o de un merge tampoco lo calcula. `rescan`
  **no** lo toca: ahí el track es el mismo. Ver «Índice IBP de un plan».

### Unir rutas y planes (`core/editing.py::smart_merge` + `sec/unir.*`)
Desde la v0.11.7 unir dos tracks **no es una herramienta del editor**: es una sección
propia a pantalla completa (`/Sendero/<pid>/unir` y `/Plan/<pid>/unir`) y, por debajo,
una función que mira la GEOMETRÍA en vez de concatenar a ciegas. El caso real que lo
obligó: dos planes de Wikiloc, «PARTE A» (un bucle P→Q→P) y «PARTE B» (Q→desvío→P,
volviendo pegado al tramo P→Q). Pegar A y B a lo bruto daba B al revés con una recta de
3 km por el medio, el tramo P→Q duplicado y el final montado sobre el inicio. Hoy la
propuesta 0 es «A (2ª mitad, invertida) + B»: 16,5 km, circular y sin repetir nada.

**El servidor: `smart_merge(gpxs, names, *, reverse=None, trim=True, join_gap=None,
tol_m=30, gap_join_m=50, out_and_back_frac=0.5, proposal=0) -> (xml, report)`.**
`merge_gpx()` sigue existiendo como envoltorio (devuelve `(xml, times_kept)`). Lo que
hace, y lo que NO se puede tocar sin rehacerlo:

- **Nunca reconstruye puntos**: reordena los `GPXTrackPoint` originales, así que `<time>`,
  HR y extensiones sobreviven intactos. Misma disciplina que las ops del editor.
- **Con tiempos REALES en todas las entradas no se invierte nada**: manda el reloj.
  «Tiempos reales» = `_real_times()`, o sea span > 0 **y** monótonos: un track dibujado a
  mano en Wikiloc pone el MISMO `<time>` en sus 422 puntos, y **eso no son tiempos** — si
  se cuentan como tales, el track no se puede orientar y sale al revés. Si los rangos se
  solapan, se descartan todos los `<time>` (`times_kept:false`), como siempre.
- **Recorte del solape** contiguo a cada costura, solo si tiene cuerpo (≥3 puntos y
  ≥2·`tol_m`): un cruce suelto no es una costura. Se busca solo contra la parte ANTERIOR,
  no contra todo lo acumulado.
- **Cierre de circular**: si la cola se monta sobre el inicio se recorta, pero con tope
  (`_LOOP_MAX_FRAC`, ¼ del recorrido) — una **ida y vuelta** también acaba donde empezó y
  sin tope se comería medio track. Ida y vuelta (solape > 50 % del corto, `out_and_back_frac`)
  y cierre que se pasa del tope **se avisan y no se recortan**. `_closes()` usa
  `max(tol_m, gap_join_m)`: con solo `tol` un bucle que cerraba a 30,4 m salía «sin cerrar»,
  y eso decide qué propuesta gana.
- **El hueco** que queda se une en recta si es ≤ `gap_join_m` (50 m); si no, se deja como
  corte de segmento (que es lo que luego el detalle pinta como hueco, ver la sección
  siguiente). `join_gap=True/False` lo fuerza en las dos direcciones.
- **Costuras INTERIORES y propuestas.** Hay **dos clases de junta** (`_split_units`): por
  **extremo** —un extremo de una entrada cae (≤ `tol_m`) sobre un punto interior de otra, a
  más de 3·`tol_m` de sus extremos medido A LO LARGO del track— y, desde la v0.11.7, por
  **tramo común** (`_overlap_runs`): el principio y el fin de cada tramo contiguo en que las
  dos van pegadas, anotados en las dos entradas. La segunda es la que permite partir un track
  por donde REENCUENTRA al otro, que no es extremo de nada: sin ella, «bucle + desvío que
  vuelve a la junta» (PARTE A + PARTE B → Ruta Pichones) se llevaba la copia duplicada del
  sendero común (16,5 km en vez de 15,5). Tres constantes que no son cosméticas:
  `_DETOUR_MIN_M` (500 m) es **histéresis** —dos dibujos del mismo sendero se despegan
  decenas de metros continuamente (medido: huecos de 37-310 m dentro de 5 km compartidos) y
  sin fundir esos tramos salían juntas falsas que multiplicaban la enumeración—;
  `_JUNCTION_MERGE_M` (250 m) fusiona juntas que describen el mismo sitio (la de extremo y la
  de tramo salían a 107 m en los GPX reales) y es el margen de extremo de las juntas por tramo
  (con solo 3·tol, el solape de una costura normal partía el track a 100 m del final);
  `_MAX_JUNCTIONS` (4 por track, ≤5 piezas) es el freno de la enumeración junto con
  `_MAX_CHAINS` (medido: 96 cadenas en el caso real). Con las piezas se enumeran los
  ensamblajes posibles (`_chains` + `_whole_chains`). Se devuelven **≤5** en `report["proposals"]`, la 0 es la
  mejor, y `proposal` elige cuál se ensambla. El orden es el que define qué es un buen
  recorrido: **cierra circuito > repite menos metros (`repeated_m`) > deja menos hueco
  (los que se unen en recta NO cuentan, o una propuesta que se deja medio track fuera
  ganaría por 30 m) > usa más piezas > invierte menos**. Una propuesta válida tiene que
  **tocar todas las entradas** y llevar **alguna entera** (si no, «unir» acabaría
  devolviendo solo A, o dos trozos sueltos). La unión de toda la vida —entradas enteras,
  en el orden dado— se cuela siempre en la lista aunque puntúe mal: puede ser justo lo que
  se pedía. **El ranking no premia la longitud**: entre dos recorridos que cierran y no
  repiten decide `n_rev`, así que la propuesta que lleva el trozo duplicado del otro track
  no gana por ser más larga. **Etiquetas**: «1ª/2ª mitad» solo con dos mitades y una sola
  aparición; si una entrada sale más de una vez o va partida en más de dos, los trozos van
  por kilómetros («A (km 0→4,1) + B (km 0→6,1) + A (km 4,1→9,5)», que es la etiqueta real
  de Pichones, con `order [0,1,0]`: aquí es donde más se nota que `order`/`reversed` van por
  PIEZA).
- **Con `reverse` explícito, o con tiempos reales en TODAS las entradas, no se parte nada**
  y hay una sola propuesta (`proposal` debe ser 0): invertir «la entrada i entera» solo
  significa algo sobre entradas sin partir.
- **Inicio y fin a elegir** (`start`/`end`, cadenas `"<i><s|e>"`: `"0s"` = inicio del
  track que se une, `"1e"` = fin del elegido; `None` = automático): el recorrido tiene que
  empezar y acabar cerca de esos puntos. Tres reglas: (1) **se pide por PUNTO, no por
  extremo** — en un bucle `0s` y `0e` valen los dos y decide el ranking; (2) la holgura es
  `close_tol = max(tol_m, gap_join_m)` (50 m), por el mismo motivo que `_closes()`: el fin de
  PARTE B cae a 30,0 m clavados del de PARTE A y con `tol` a secas salía «imposible»; (3)
  **pedir extremos nunca falla**: si ninguna propuesta cumple, salen todas,
  `endpoints_applied:false` y un aviso; si alguna cumple, `proposals` trae SOLO esas (única
  excepción a «la unión clásica siempre está en la lista»). Pedirlos enumera propuestas
  aunque no haya juntas interiores (hace falta poder reordenar), con tiempos reales puede
  obligar a invertir (se pierden los `<time>`, con aviso) y con `reverse` explícito solo se
  reordena (si no cuadra, manda `reverse` y se avisa). `start == end` → 400.
- **Montaje manual (`pieces`, «unirV2»)**: el usuario dicta los trozos y el servidor solo
  arregla las costuras. `options.pieces = [{track, from_m, to_m}, …]` (≥1; `track` = índice en
  `ids`; **`from_m > to_m` = trozo invertido**; corte al vértice más cercano, nunca se
  interpolan puntos). Con `pieces` se **ignoran** `reverse`/`proposal`/`start`/`end` (aviso,
  no error) y aplican `trim`/`join_gap`/`tol_m`. Dos trozos seguidos del mismo track,
  contiguos y en el mismo sentido se encadenan **sin costura** (ni junta, ni hueco, ni
  recorte: montar dos mitades devuelve el track entero); el resto pasa por `_seam` + cierre
  de circular + política de tiempos de siempre, y un hueco que queda como corte avisa «Hueco
  de X entre el trozo N y el N+1: quedará un corte de segmento». Trozo de <2 puntos o <2·tol
  → 400. **Todas las distancias de un track —`from_m`/`to_m`, `track_lengths_m` y las
  `pieces` de las propuestas— van en la MISMA escala, la de `_Poly.cum`** (planar 2D, con el
  salto entre segmentos), que NO es la de `analyse_gpx` (~1-3 % de diferencia) a propósito:
  así una pieza de una propuesta se puede devolver tal cual como pieza manual. Si cambias
  `_Poly.cum`, cambias el contrato del cliente. El informe añade `manual` y
  `track_lengths_m` (los dos **siempre**) y, en manual, una única propuesta «Montaje manual»
  cuyas `pieces` son las **reales tras el recorte** (`trimmed_head_m`, `trimmed_tail_m`,
  `requested`). OJO: `gaps`/`junctions` **se saltan las uniones sin costura**, así que no
  están alineadas con las piezas; el cliente reproduce la regla en `seamGaps()`.
- **El índice de rejilla (`_Poly`, celda 2·`tol_m`, distancia punto→tramo) no es una
  optimización, es un requisito**: la distancia punto↔traza en bruto es O(n·m) y con
  2×20 000 puntos serían 4·10⁸ comparaciones en Python. `tests/test_merge.py` exige la
  unión de esos dos tracks en **menos de 2 s** (va sobre 1,2 s).

**Claves de `report`**: `order`, `reversed`, `trimmed_m`, `gap_m`, `gap_joined`, `gaps[]`,
`closed_loop`, `closed_trim_m`, `times_kept`, `warnings[]`, `junctions`, `n_points`,
`tracks[]`, `segments[]`, `proposal`, `repeated_m`, `had_times[]`,
`endpoints_applied` (`null` si no se pidió nada, `true`/`false` si sí), `start_point`,
`end_point` (primer y último punto del resultado ensamblado), `endpoints[{track, name, s, e}]`
(los extremos ORIGINALES de cada entrada, sin orientar) y
`proposals[{k, label, distance_m, closed_loop, repeated_m, gap_m, n_pieces,
pieces[{track, name, reversed, from_m, to_m, len_m}], reversed_inputs[], segments_lite}]`.
**TRAMPA: `order`/`reversed`/`trimmed_m`/`tracks` van por PIEZA ensamblada, no por
entrada** — en cuanto hay una junta interior, `order` puede repetir un índice o dejarse
alguno fuera. Lo que va por ENTRADA es `had_times` y el `reversed_inputs` de cada
propuesta (`null` ahí = esa entrada se usa por trozos).

**Los endpoints** son `POST /api/routes/merge` y `POST /api/planned/merge`, y el flujo es
**común** (`api/editor.py`: `merge_options` → `run_merge` → `merge_report_lean` /
`merge_preview_response`; `api/planned_editor.py` los importa). Unir no pasa por el TARGET
del editor a propósito: opera sobre objetos gpxpy en memoria y no toca la E/S de ninguna
entidad. Body `{ids, name, preview?, options?{reverse, trim, join_gap, tol_m, proposal, start, end, pieces}}`;
con `preview:true` **no se crea nada** (200 `{preview, report, stats, elevation}` — `elevation`
es la serie `[{d,e}]` del resultado pasada por `core.sync.resample`, hasta **501** puntos, y solo
va en la preview), sin él se crea
(201, con el informe ya sin geometrías). Opciones mal formadas o `proposal` fuera de rango
→ 400. Lo cubre `tests/test_merge.py` (64 tests: geometría, 3+ entradas desordenadas, propuestas con el fixture
sintético «bucle + ramal desde un punto interior», rendimiento y los dos endpoints).

**Tres o más tracks** (v0.11.8): la vista deja unir hasta **6** (`MAX_INPUTS` de `unir.js`;
el servidor admite 8, `_MAX_INPUTS`, 400 por encima). Lo que eso cambió en el servidor, y no
se puede quitar sin que la selección múltiple vuelva a dar basura: **el orden en que llegan
los `ids` es el de SELECCIÓN**, no el del recorrido, y con dos entradas no importaba. Por eso
(1) con 3+ entradas sin tiempos se enumeran propuestas aunque no haya juntas interiores; (2)
con 4+, además de «entradas enteras en el orden dado», `_greedy_orders()` añade los
encadenados «al extremo más cercano» desde cada entrada y orientación (probar todas las
permutaciones son 24·16 con cuatro); (3) con `reverse` forzado y 3+ entradas,
`_order_min_gap()` elige el orden que menos hueco deja; y (4) en el ranking **cerrar circuito
solo cuenta si no deja huecos cortados** — con tres tramos desordenados ganaba un «circuito»
que se saltaba 5 km en recta. Lo cubren los tests de «3+ entradas» de `tests/test_merge.py`.

**El cliente (`sec/unir.js` + `sec/unir.html` + `css/unir.css`)** solo pinta lo que dice el
informe: **toda la decisión la toma el servidor**. Como el editor, sirve para las dos
entidades con un objeto `K` (`params.kind`), y **en ese archivo no se escribe `/api/routes`
ni `/Sendero/` a mano**. Pantalla completa: a la izquierda `.un-left`, con el mapa `#un-map` y **debajo el perfil de
elevación del resultado** (`#un-elev-panel`, el mapa cede altura); a la derecha un panel de
380 px con cuatro pasos —«Propuestas»
(tarjetas; **oculto si hay ≤1**; el hover pinta esa propuesta en gris punteado con las
capas `mg-hover-*`, sin elegirla), «Inicio y fin» (`#un-ends`: dos `<select>` `#un-start`/`#un-end`
con «Automático» + dos extremos por entrada), «Ajustes» (`<details>` plegable) y «Resultado» (cuatro
cifras, avisos, nombre y `#un-create`)—. Lo que hay que saber si lo tocas:

- **Las entradas son N, no A y B** (v0.11.8): la 0 (A) es siempre la que se está uniendo
  (`pid`) y las elegidas son B, C, D… en el orden en que se marcaron (`sels`); `nIn()` =
  cuántas hay, `mgLabel(i)` su letra (la misma que `_letter` del servidor) y
  `srcColor(i)` su color de serie (`SRC_COLOR`, seis). Todo lo que era por entrada va en
  arrays de longitud `nIn()`: `srcs`, `srcCharts`, `selRange`, `partial`, `opts.reverse`.
- **Capas del mapa**: `un-s<i>*` (una fuente con casing/line/hit por entrada, las
  `MAX_INPUTS` creadas de una vez y vacías) para las trazas de entrada y `mg-*` para la
  previsualización (lo que se conserva, lo que se descarta en punteado, el hueco, las
  flechas de sentido `mg-arrow-<i>` y los círculos de junta). Se reponen en `map.on('sendero:basemap')`
  (regla 15), y **ese repintado NO se puede guardar con `map.isStyleLoaded()`**: en ese
  evento todavía devuelve `false`, así que salir de la capa offline dejaba el mapa sin
  capas y sin forma de recuperarlas. La única guarda es la de idempotencia
  (`if (map.getSource('un-s0')) return`).
- **Cada cambio relanza la previsualización con debounce de 250 ms Y token**: sin el token,
  una respuesta lenta de la opción anterior pinta encima de la nueva y el mapa deja de
  describir lo que dicen los controles.
- **Los toggles «Invertir X» salen de `reversed_inputs`**, no de `reversed`, y los pinta
  `renderToggles()` en `#un-revs` (uno por entrada; con más de 3, «↔ C» a secas). Un `null`
  ahí se pinta «parcial» y **deshabilitado**: la propuesta elegida usa esa entrada por
  trozos e invertirla entera no significa nada. Pulsar uno pone `reverse` explícito, con lo
  que el servidor deja de enumerar: las tarjetas desaparecen y sale «↩ Volver a las
  propuestas» (`#un-back-props`). Cambiar la **tolerancia** (`#un-tol`) resetea `proposal` a
  0, porque con otra tolerancia las piezas ya no son las mismas.
- **`MG_GAP_JOIN_M` (50) en `unir.js` es copia de `gap_join_m` del servidor** — no viaja en
  el informe y solo se usa para decidir si la chapa «hueco X» de una propuesta merece
  salir. Si cambias uno, cambia el otro.
- **«Con qué unir» es un POPUP, no un panel** (v0.11.7), y **de selección múltiple**
  (v0.11.8): `#un-pick-modal` (overlay con el buscador `#un-search` y la lista `#un-list`,
  candidatos de `K.list()` —el **Store**— ordenados por cercanía a los extremos del track,
  grupo «Cercanos» a <3 km) más el chip `#un-pick-chip` de la cabecera («Con: PARTE B ·
  11,4 km · a 2,98 km», o «Con: B + C (2) · 23,4 km» con varias) con `#un-change`
  («Cambiar» / «Elegir con qué unir» en ámbar sin candidato). Se trabaja sobre un BORRADOR
  (`pickDraft`, copia de `sels` al abrir): click en una fila la marca con la letra que tendrá
  (`.un-row-ck`), «Unir con N» (`#un-pick-ok`, `applyPick()`) lo aplica, doble click = unir
  solo con esa, y cerrar de cualquier otra forma lo descarta. `setSelection()` **conserva lo
  que puede**: las fuentes ya cargadas y los trozos del montaje de las entradas que siguen
  (remapeando su índice: quitar B convierte la C en B) y la tolerancia/recorte/hueco; vuelve a
  cero lo que depende del conjunto (informe, propuestas, `reverse`, extremos). `selGen`
  invalida las cargas de fuentes en vuelo de la selección anterior. Se abre solo al montar sin
  candidato y con conexión (sin conexión no se abre y el botón queda deshabilitado; sin
  candidatos dice `K.sinOtras` y ofrece «← Volver»). Cierra por ✕, «Cancelar», velo y Escape
  — ese listener de `document` se registra **una vez al cargar el archivo** y comprueba
  `pickOpen` y que la sección no esté `hidden`. Y la trampa del modal Immich:
  `#sec-unir .un-overlay.hidden{display:none}` va justo detrás de
  `#sec-unir .un-overlay{display:flex}`. `resetState()` lo cierra (es `position:fixed`).
- **El perfil** se pinta con las funciones de `shared.js`, igual que la ficha de un plan
  (`slopeProfile`/`slopeGradientPlugin`/`slopeLegendHtml`), y valen las mismas trampas:
  degradado como VALOR (nunca opción scriptable), `chart.render()` para el crosshair, cerrojo
  `_syncing`, `onHover` que descarta el `mouseout`, `ctx.onmouseleave` por asignación. El hover
  va en las dos direcciones con la capa `mg-keep-hit` y el punto `mg-hover-point`. Para pasar de
  `d` a coordenada, `buildResult()` acumula km sobre `report.segments` **sin sumar el salto entre
  segmentos** (como `analyse_gpx`) y **escala el total al último `d` de `elevation`**: los
  segmentos del informe vienen decimados y sin esa escala el crosshair se desplaza hacia el final.
- **Inicio y fin**: `#un-start`/`#un-end` mandan `options.start`/`end` (`null` = automático);
  cambiar cualquiera resetea `proposal` a 0, cambiar la selección los devuelve a «Automático», y
  **el mismo extremo en los dos no se manda** (es un 400 seguro): se marca en ámbar y se espera.
  Si `report.endpoints_applied === false` los dos selects van en ámbar y el aviso del servidor
  sale en `#un-warns`. Los marcadores de inicio/fin (sobre `start_point`/`end_point`) son
  **PUNTOS** del tamaño de la traza —verde `--sage` el inicio, rojo `--gr-red` el fin, y uno solo
  a dos colores si `closed_loop` o están a <30 m (el caso real cierra a 30,4 m)—, no chapas con
  texto: la chapa «INICIO» tapaba justo el tramo que se quería mirar (v0.11.7); el nombre va en
  el `title`. Ellos y los puntitos de `endpoints[]` (dos por entrada) son **marcadores DOM**: sobreviven a `sendero:basemap` y se quitan en
  `clearMap()`/`unmount()`, junto con el `Chart` del perfil y el `.hover-infobox`.
- **Modo «Montaje» (unirV2)**: la sección tiene dos modos, conmutador `#un-mode` en la
  cabecera (Automático · Montaje), preferencia en `sessionStorage` (`sendero_unir_modo_v1`);
  cambiar de modo **no pierde** candidato ni trozos. En Montaje la columna izquierda pasa a
  ser mapa → **un perfil fuente por entrada** (dentro de `#un-srcs`) → **línea de tiempo**
  (`#un-timeline`) → perfil del resultado. Los paneles fuente **no están en el markup**: los
  crea `srcEl(i)` la primera vez y se reutilizan (su `<canvas>` se engancha una sola vez, con
  listeners en `window`), y sus elementos se buscan dentro del panel (`data-r`), nunca por id.
  Con más de dos, `.un-srcs.many` los baja a 96 px (el mapa mide lo que la pila); y a la derecha «Propuestas» e «Inicio y fin» se
  esconden y aparece «Montaje» (`#un-pieces-panel`, la lista de clips en texto con las piezas
  REALES tras el recorte). Se selecciona un tramo **arrastrando** sobre un perfil fuente (el
  sentido del arrastre cuenta: de derecha a izquierda = invertido; «＋ Añadir invertido» le da la
  vuelta a lo que diga la selección; doble click/«Todo» = el track entero), y el tramo se
  ilumina en el mapa (`un-sel-line`). Cada clip tiene ◀ ▶ ↔ ✕ y el separador entre clips dice el
  estado de la costura (✓ cosida · ⚠ hueco · ✂ solape recortado). El cliente manda
  `options.pieces` y **no manda** `proposal`/`start`/`end`/`reverse`. **`track_lengths_m` manda
  sobre el último `d` de la serie ligera**: al llegar se reescalan `cum`, la serie de elevación,
  los trozos y la selección con el mismo factor (`applyTrackLens`, una vez por entrada); sin
  reescalar la elevación, el eje del perfil y la selección hablan de escalas distintas. Los
  perfiles fuente van sin degradado (cada uno del color de su entrada) y con `events: []` (el
  gesto es un arrastre sobre el propio canvas). Las entradas se pintan enteras y atenuadas en
  `un-s<i>*`. Los `Chart` fuente se destruyen en `unmount()`, al volver a Automático y al
  cambiar la selección (se rehacen con las fuentes que sigan) — `clearMap()` **no** los
  destruye: son el material del montaje. La línea de tiempo
  es lo único de la vista con `overflow-x` propio.
  - **La rejilla de Montaje es OTRA** (v0.11.7): bajo `#sec-unir.is-montaje`, `.un-left` y
    `.un-side` pasan a `display:contents` y cada panel se coloca por `grid-area`
    (`map/srcs/tl/pieces/tune/result/elev`), sin mover nodos del DOM. ≥1000 px:
    `map map srcs srcs / tl tl tl tl / pieces tune result result / elev elev elev elev` (la
    línea de tiempo bajo el mapa a todo el ancho desde la v0.11.7; el mapa ≈55 % de ancho y
    **mide lo que la pila de perfiles fuente**: `align-self:stretch`, sin alto propio,
    `min-height` solo como suelo); 768-999: dos columnas y los perfiles de dos en dos;
    <768: una. Los paneles que el JS esconde con `display:none` no ocupan celda.
    Automático no cambia (medido: misma rejilla y mismos bounds).
  - **Cambiar de modo cambia el tamaño del mapa: el encuadre va DESPUÉS del resize.**
    `afterResize()` (doble `requestAnimationFrame` con `map.resize()`) + `fitCurrent()`
    (informe → `fitReport`; Montaje con alguna elegida cargada → `fitAll`, bounds de todas;
    si no → `fitA`).
    Encuadrar en el mismo tick calcula la cámara para el lienzo viejo: el síntoma era entrar
    en Montaje y ver media ruta. `refitNext` es de un solo uso al volver a Automático (el
    informe se rehace); fuera de eso, cambiar una opción **no** le mueve la cámara al usuario.
  - **«Ajustar» en cada separador con costura** (`.un-seam-fit`, en la línea de tiempo Y en la
    lista de `#un-pieces-panel`; `fitSeam(k)`, v0.11.7): recorta los dos trozos hasta el par de
    vértices más cercano entre sus dos tracks. Solo sale donde hay costura de verdad (regla de
    `seamGaps()`). El final efectivo de un trozo es siempre `to_m` y el inicio `from_m`,
    invertido o no; lo que cambia con `from_m > to_m` es la dirección de la ventana
    (`fitWindow`), y el ajuste **solo recorta**. **Una pulsada ITERA** (`FIT_MAX_PASSES`) con
    ventanas de 3 km que llegan siempre hasta el borde ORIGINAL del trozo: con una sola pasada
    un punto de encuentro a 5,4 km del final se quedaba a medio camino, y sin el borde original
    el descenso caía en un mínimo local (264 m en vez de 5). Dos umbrales a propósito:
    `FIT_MIN_GAIN_M` (5 m) deshabilita el botón, `FIT_STEP_GAIN_M` (0,5 m) para la iteración.
    Si dejara un trozo por debajo de 2·tol, no se aplica y avisa con toast. 37 ms con los GPX
    reales.
  - **Barra de scroll de `#un-timeline`**: fina y en `--sage`. Trampa: en Chromium poner
    `scrollbar-width` hace que se ignoren los `::-webkit-scrollbar`, así que los estándar van
    tras `@supports not selector(::-webkit-scrollbar)` (solo Firefox). Y en Chromium headless no
    se pinta ninguna barra: para verlas, `headless=False` y
    `--disable-features=OverlayScrollbar,FluentOverlayScrollbar`.
  - **Hover de las fuentes (solo Montaje)**: `srcHover = {i, d}` es el hermano de `hoverD`;
    si los dos están vivos manda el del resultado (el `.hover-infobox` es uno solo). Perfil →
    mapa va por listeners del propio `<canvas>` (enganchados una vez; los perfiles fuente
    siguen con `events: []`, así que ahí no aplican las trampas de `onHover`, pero sí
    `_syncing` y `render()`), y no actúa mientras `dragI !== null`. Mapa → perfil va por
    `un-s<i>-hit` (debajo de `mg-keep-hit`) con **UN solo handler para todas**: las entradas
    se solapan por diseño, los eventos se disparan a la vez y gana el vértice más cercano. Los `map.on(...)` se registran en `initMap()`, no en `addDataLayers()` (que se
    reejecuta tras `sendero:basemap`). Punto propio `un-src-hover-point`.
- **Requiere conexión**: la sección se monta igual sin ella (está en `SHELL_PATHS`) pero
  avisa con `K.offline` y no previsualiza ni crea nada.
- `window.SEC.unir = {mount, unmount, retry, searchChanged, openPick, closePick, changePick
  (alias de openPick), veilClick, backFromPick, applyPick, backToProposals, toggleRev, optsChanged, setGap,
  endsChanged, setMode, srcAll, srcAdd, clearPieces, fitSeam, doMerge}`.

### Huecos entre segmentos (`seg_starts`)
Un GPX con varios `<trkseg>` —se perdió la señal, o son dos tracks unidos y la unión dejó
el corte a propósito para no fabricar distancia— se dibuja como **un solo LineString**, así
que MapLibre une los extremos y el corte parece un camino recto que nadie anduvo. Las
stats siempre estuvieron bien (`analyse_gpx()` reinicia la distancia en cada segmento):
esto es solo la representación, y desde la v0.11.7 se pinta.

- **Servidor**: columna `seg_starts TEXT JSON` en `routes` **y** en `planned_routes` (los
  índices de `geojson` donde empieza cada segmento; `[0]` = uno solo; NULL = desconocido ⇒
  el cliente pinta como antes). La calculan `analyse_gpx()` y `analyse_fit()` dentro de
  `stats` (un FIT no tiene `<trkseg>`: `[0]` si hay puntos) y la escriben importar,
  reescanear y **cada reanálisis del editor**. Las rutas ya importadas la ganan al
  reescanearlas o al guardar una edición: **no hay backfill masivo** al arrancar (sería
  reparsear cientos de GPX).
- **No va en ningún índice de cobertura** (regla 12) y **no hizo falta subir `DB_VERSION`**
  (regla 11): no se lee en ningún listado, solo en `_build_route_dict`/`_build_plan_dict`
  y en el editor, siempre por id, que ya leen la fila entera.
- **En `?lite=1` los índices hay que REMAPEARLOS**, porque apuntan al `geojson` sin decimar:
  lo hace `decimate_with_segments()` (`core/sync.py`), que conserva el punto del corte **y
  el anterior** —si no, el decimado se comería justo la marca, o el hueco dibujado se
  tragaría hasta `step-1` puntos de track de verdad— y traduce las marcas con
  `decimate_indices()` + `remap_indices()`. El `bootstrap_json` de `/Sendero/<pid>` es la
  misma variante ligera, así que coincide. El dict de un plan **no** tiene variante ligera:
  ahí los índices no se remapean nunca.
- **Cliente**: `gapFeatures()` / `addGapLayers()` / `GAP_MIN_M` (20 m: por debajo de eso es
  una pausa, no un hueco) en `static/shared.js`, compartidas por las dos fichas para que no
  puedan divergir. Cada corte son DOS capas —`d-gaps-mask`/`d-gaps-dash` en el detalle de
  una ruta y `pl-gaps-mask`/`pl-gaps-dash` en el de un plan—: una ancha del color del
  lienzo (`--bg-deep`) que **tapa** la recta de debajo, y otra fina punteada en `--muted`.
  Los dos colores se leen con `getComputedStyle` del `:root` de `base.html` (MapLibre
  necesita un color literal), así que siguen siendo tokens y no hex sueltos (regla 9).
- **Se añaden DESPUÉS de la traza** (MapLibre dibuja en el orden en que se añaden) y
  **ANTES de la capa de hover**, que debe quedar arriba. En el detalle de una ruta el mapa
  se recrea entero al cambiar de capa base, así que no hay que reponerlas; en la ficha de
  un plan van dentro de `drawTrack()`, que ya se re-ejecuta tras `sendero:basemap`
  (regla 15).
- **No tocan `lineMetrics` ni el degradado por pendiente**: son capas aparte encima, no
  cambian la fuente de la traza.

### Catálogo de actividades (`core/activities.py`) — un deporte, un archivo
**Añadir un deporte es editar `core/activities.py` y subir `APP_VERSION`. Nada más.**
Antes eran cinco sitios y olvidarse de uno no daba ningún error: el deporte
simplemente no salía en una pantalla (el caso real: la actividad nueva no aparecía
en el selector del detalle ni en las píldoras de filtro).

Cada entrada lleva **todo** lo que define la actividad: `id` (el que se guarda en
`routes.activity_type`; ASCII, sin acentos), `label`, `color`, `symbol` (el interior
del `<svg viewBox="0 0 26 26">`, glifo siempre en `#0b120e`), `thresholds` (los de
Ajustes → «GPS incorrecto»), `gpx_types`/`fit_sports`/`keywords` (las tres vías de
detección al importar) e `ibp` (modalidad del índice, o `None`). De ahí salen las
vistas derivadas `IDS`/`THRESHOLDS`/`GPX_TYPES`/`FIT_SPORTS`/`KEYWORDS`/`IBP_MODALITY`,
que es lo que importan `core/config.py`, `core/parsers.py` y `core/ibp.py` — **ninguno
tiene ya su propia tabla**.

- **El cliente lo recibe inyectado**, no por `fetch`: `app.py` (context processor)
  pone `client_json()` en `<script type="application/json" id="activities-json">` de
  `base.html`, y `shared.js` lo convierte en `ACTIVITIES`. Dos motivos: las secciones
  lo leen **síncronamente** al montar (`ACTIVITIES.forEach`, sin `await`) y así
  funciona **sin conexión** con solo el shell precacheado. El `<script>` va
  obligatoriamente **antes** de `shared.js`.
- **Los umbrales NO viajan al cliente**: los sirve `/api/settings/gps-thresholds`, que
  ya devuelve los efectivos (los personalizados del usuario, con estos de respaldo).
- **El orden de `KEYWORDS` importa**: gana la primera que casa y las de `senderismo`
  son muy golosas (`via`, `travesia`, `gr` —que va dentro de «Segre»—), así que una
  actividad de palabras específicas se adelanta con `keyword_prio` negativo (lo hace
  `kayak`). Y nada de palabras que vivan dentro de otras: `remo` está en «extremo».
- **`tests/test_activities.py` vigila el cableado**, que es lo que se rompe callado:
  que nadie vuelva a escribir la lista a mano en `shared.js` o en `chrome.js`, que
  `base.html` siga inyectando el catálogo antes de `shared.js`, que no haya palabras
  ni tipos compartidos entre dos actividades y que las modalidades IBP sean válidas.
- **Al añadir un deporte hay que subir `APP_VERSION`** aunque no toques JS: el
  catálogo viaja dentro del shell, y sin eso los clientes con el shell precacheado
  seguirían sin verlo.
- El filtro de «Mis Rutas» guarda en `sessionStorage` las actividades **desmarcadas**
  (`off`), no las marcadas: si guardara las marcadas, un deporte nuevo saldría
  filtrado para quien ya tuviera estado guardado, y una lista vacía por el filtro no
  se distingue de «no tengo rutas de ese tipo».

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
| `renderElev()` | `#d-elev` + `#d-elev-sub` + `#d-slope-legend` | línea y relleno con el degradado **por pendiente** (`slopeChartGradient`, ver «Color por pendiente»), el subtítulo «X m salida · Y m cima · pendiente máx. N %» (`_elevSub`, tramos ≥30 m para que el ruido del GPS no dé porcentajes absurdos) y la leyenda de la escala |
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
pantalla estrecha pueden caer debajo del mapa en flujo normal. En la fila están
«✎ Editar track», «↓ Exportar GPX», «Vista 3D» (`#d-btn3d`) y el `⋯`
(`#d-more-btn`); tras ese menú (`#d-actions-more`) van **cinco** entradas, en
este orden: «↺ Reescanear» (`#rescan-btn`), «⬇ Mapa sin conexión», «⛓ Unir…»
(`#d-unir-btn`), «Renombrar» y «Eliminar». El menú es así **también en
escritorio** — si automatizas un click en cualquiera de esas cinco, ábrelo antes
(`SEC.detalle.openUnir()` además lo cierra él mismo al navegar).

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

### Botón «Mi ubicación» (`addGeolocate()` en `static/shared.js`)
Los **siete** mapas lo llevan (el de `unir` desde la v0.11.7): centra el mapa en el usuario
y lo sigue mientras no arrastre.
Es el `GeolocateControl` de MapLibre, no un control propio, y se añade siempre con
`addGeolocate(map, esquina)` justo después del `NavigationControl` — así los textos, los
avisos de error y el estilo se tocan en un solo sitio. La ubicación la da el dispositivo,
así que **funciona sin conexión** si el mapa base está descargado.

- **No necesita repintarse al cambiar de capa base** (regla 15): el punto y el círculo de
  precisión son marcadores **DOM**, no capas del estilo, así que sobreviven al `setStyle()`
  de `applyBasemap`. Un control propio con una capa GeoJSON sí habría que repintarlo.
- **`geoTracking(map)` es el freno de los re-encuadres automáticos.** Mientras se sigue la
  ubicación, la cámara es del usuario: `fitToPoints()` (dashboard), `fitPlans()` (planes),
  el auto-encuadre de `renderMap()` (rutas) y el `fitRoute()` del `load` del editor lo
  consultan y se apartan. Sin eso, un cambio de filtro o una sincronización de fondo le
  devolvía el mapa a la colección **y** tumbaba el seguimiento a «segundo plano» (MapLibre
  entiende cualquier movimiento ajeno como que el usuario se fue a mirar otra cosa). Los
  encuadres que el usuario PIDE («centrar en la ruta») no miran esto.
- **Los textos van a mano** porque MapLibre solo los traduce con la opción `locale` de cada
  mapa, y son seis: `_geoLabels()` reescribe el título del botón cuando MapLibre lo pone en
  inglés, que es **asíncrono** (al volver de `addControl` el botón todavía no existe: lo
  crea `_setupUI` tras comprobar el soporte del navegador). De ahí el `MutationObserver`.
- **La geolocalización solo existe en contexto seguro** (https o localhost). En LAN por http
  el navegador la deniega con el mismo código que un permiso denegado, y no dice nada
  visible en la página: por eso el aviso mira `window.isSecureContext` **antes** que el
  código de error. Cuatro mensajes distintos (http, denegado, sin señal, tiempo agotado).
- **El estado activo se pinta en `base.html`**, con el resto de reglas de MapLibre: el icono
  de serie es azul cian, y el filtro que pone en blanco los iconos de los controles lo
  dejaba idéntico al de reposo. Se sustituye por el mismo dibujo en ámbar (y en rojo si
  falla la ubicación con el seguimiento puesto), con `!important` porque el vendor trae una
  variante del selector con un `button` de más que gana por especificidad, y porque
  `#sec-detalle`/`#sec-plan` reponen el filtro con un selector de ID. Los hex están dentro
  del `data:URI` (una `url()` no puede leer una variable CSS): son `--pr-yellow` y
  `--gr-red`, y hay que cambiarlos ahí si cambian los tokens.
- **El `unmount()` de la sección ya lo apaga**, sin código extra: `map.remove()` llama al
  `onRemove` del control, que hace `clearWatch` del GPS. Si algún día un mapa se destruye sin
  `map.remove()`, el watch se queda abierto — es la fuga nº 1 de esta conversión, pero
  gastando batería.
- Lo cubre el bloque 16 de `tests/e2e_spa.py`, que da permiso y ubicación falsa a Chromium y
  comprueba en los seis mapas que cubre (el de `unir` todavía no está en su lista) que el
  punto acaba **en el centro** del contenedor, que sin permiso avisa en español, y que al
  cambiar de sección el watch del GPS se cierra.

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

### Color por pendiente en los dos detalles (`SLOPE_*` en `static/shared.js`)
Desde la v0.9.13, la traza del mapa y el perfil de elevación del detalle de una RUTA y del
de un PLAN van coloreados de **verde (llano) a rojo (pared)** según lo empinado del
terreno, con la leyenda de la escala en la cabecera del perfil. La escala vive en
`static/shared.js` porque la comparten las dos vistas; la lógica es pura y la mide
`node tests/slope_smoke.js`.

- **Todo se mide por DISTANCIA, nunca por índice de la serie**, y esto es EL fallo de esta
  función (costó una versión, aunque no salió publicado). La serie de elevación **no es
  uniforme en distancia**: el GPX muestrea por tiempo, así que una subida lenta acumula
  puntos y una bajada rápida casi ninguno, y `resample()` del modo ligero toma un paso
  constante en índice, que conserva el sesgo. Medido en una ruta real de 7,6 km, el punto
  nº 50 % de la serie estaba en el km 37 %: pintar «el color del punto k/n en la fracción
  k/n del eje» ponía un **28,6 % (rojo) donde el terreno iba al 2,3 % (llano)**, con casi
  800 m de desfase. Por eso existe `slopeBuckets(elev, B)` —media de |pendiente| en cubos
  de igual LONGITUD— y por eso lo usan las dos, la traza y el perfil. Si añades otra cosa
  que coloree por pendiente, sácala de ahí.
- **La pendiente es ABSOLUTA**: bajar al 25 % pinta igual que subirlo. Describe lo duro del
  terreno, no el esfuerzo de ascenso, y así «verde = llano, rojo = empinado» se lee sin
  traducir. Si algún día se quiere distinguir la bajada, es otra escala (azul), no un
  parche a esta.
- **Se mide con una ventana centrada de `SLOPE_WINDOW_M` (50 m)**, no entre puntos
  seguidos: la pendiente punto a punto de un GPS es ruido puro (±60 % en llano) y el color
  parpadearía en vez de describir nada. Mismo motivo por el que `_elevSub()` mide la
  pendiente máxima sobre tramos de ≥30 m. En los extremos la ventana se estira hacia
  dentro, o el primer y el último kilómetro saldrían con el doble de ruido.
- **En una cima o una vaguada la ventana da ~0 % y sale un punto verde.** No es un fallo:
  ahí el terreno pasa de subir a bajar y localmente es llano. Cualquier estimador que lo
  «arregle» (media de |pendiente|, medias ventanas) devuelve el ruido a las zonas llanas,
  que es mucho más visible. No lo reabras sin medir las dos cosas.
- **Mapa**: `line-gradient` con `['line-progress']`, que exige **`lineMetrics: true` en la
  fuente** — sin eso MapLibre ignora el degradado y la traza sale sin color. La fracción de
  cada parada es `d/dTotal` de la serie de elevación (la misma magnitud que `line-progress`
  salvo por la deformación de Mercator, milésimas en un track de kilómetros). Las paradas se
  agrupan en `SLOPE_BUCKETS` (200) cubos y las de igual color se funden: sin eso saldría una
  parada por punto y la expresión sería impagable. **Tienen que ir estrictamente crecientes**
  o MapLibre descarta el degradado entero. Los dos desfases que esto podría tener están
  medidos en rutas reales y son despreciables: Mercator↔suelo **0,00 %**, y el track decimado
  del modo ligero (que es más corto que la serie de elevación) desplaza las paradas **0,2 %,
  unos 12-15 m** — por debajo de la propia ventana de 50 m. No hace falta corregirlos.
- **Debajo de la traza va un ribete oscuro** (`ruta-linea-casing` / `pl-ruta-casing`): el
  verde de la escala se pierde sobre el mapa topográfico, que ya es verde y claro. Con los
  colores de actividad, todos saturados, no hacía falta.
- **Perfil**: `slopeChartGradient(chart, elev, alfa, cubos)` (también en `shared.js`, para
  que las dos vistas no puedan divergir), un degradado de canvas horizontal: opaco para la
  línea y al 34 % para el relleno. **Se asigna al dataset como VALOR, desde
  `slopeGradientPlugin` (hook `afterLayout`), NUNCA como opción scriptable** — ver
  «Rendimiento del hover» justo abajo, que es donde esto se paga. Se sitúa con la **escala X** del gráfico, no con el `chartArea`,
  para que cada color caiga sobre su kilómetro. **NO se usa `segment.borderColor`**: con
  estilos por tramo, Chart.js parte también el relleno y deja una costura vertical en cada
  punto (~80 rayas en un perfil normal). El punto del hover sí va por índice de dato —ahí
  el índice es el correcto—, que para eso `_crosshairPlugin(colorAt)` acepta un color.
- **Sin elevación no hay pendiente**: `slopeGradientExpr()` devuelve `null` y la traza se
  queda del color de la actividad, como siempre. Una pendiente constante SÍ se pinta (dos
  paradas del mismo color): devolver `null` ahí dejaría gris una rampa perfectamente
  descriptible.
- **La actividad sigue viéndose** en el chip sobre el mapa y en el borde de la primera
  métrica; lo que ya no la lleva es la traza. Por eso el PATCH de actividad de `plan.js`
  solo repinta `line-color` cuando NO hay degradado.
- Los colores salen de la paleta del proyecto (verde de `caminata`, ámbar `--pr-yellow`,
  naranja de `senderismo`, rojo `--gr-red`) más una lima. Van en el JS que pinta, como el
  resto de colores de serie, y la leyenda se genera de la misma tabla (`slopeLegendHtml()`),
  así que **no puede desfasarse**: si cambias los cortes, la leyenda cambia sola.

### Estado de carga de los dos detalles (shimmer, tope de tiempo y reintentar)
Hasta la v0.9.14, mientras el detalle estaba en vuelo se veían **los paneles vacíos**, y si
el servidor aceptaba la conexión y no contestaba la vista se quedaba así **para siempre**:
`fetch` no trae tope propio (el del navegador son minutos) y no había ninguno, así que
`mount()` no terminaba nunca. Sin error, sin aviso y sin nada que pulsar — el síntoma era
«se queda con el esqueleto sin hacer nada», y se confundía con código viejo pegado.

Tres piezas, y las tres hacen falta:
- **Tope de tiempo en el Store**: `DETAIL_TIMEOUT_MS` (15 s) en `store.js`, aplicado con un
  `AbortController` **solo a `route()` y `plan()`**. No es general a propósito: subir fotos,
  calcular el IBP o recalcular contra un DEM tardan legítimamente más. Agotar el tiempo
  **no** marca la app como sin conexión (si lo hiciera, una red lenta se anunciaría como
  caída y el resto de la app entraría en modo offline sin motivo): el error lleva
  `timeout:true` en vez de `offline:true`.
- **Shimmer** mientras carga: `skeletonOn()/Off()/Soon()` en cada sección pintan tarjetas y
  filas de esqueleto y marcan la sección con `.is-loading`, que es lo que hace brillar las
  cajas de las gráficas (un `<canvas>` no se rellena con HTML: el shimmer va en su caja y
  el lienzo, transparente hasta que Chart.js pinte, lo deja ver). Se retrasa
  `SKEL_DELAY_MS` (140 ms) porque un detalle que ya está en IndexedDB se pinta en menos que
  eso y un parpadeo gris se ve peor que nada. `resetView()`/`unmount()` lo apagan: si se
  escapara, la sección se quedaría con las gráficas brillando debajo de los datos.
- **Salida**: `#d-load-error` / `#pl-load-error` con el motivo y «↻ Reintentar»
  (`SEC.detalle.retry()`, que repite el `mount()` con los mismos params guardados en
  `_lastParams`). Los mensajes distinguen los tres casos —sin red, el servidor no contesta,
  y otra ventana retiene la copia local— porque se arreglan de formas distintas.

Lo cubre el bloque 19 de `tests/e2e_spa.py`. Para simular el cuelgue **hay que envolver
`window.fetch` en la página**, no usar `page.route`: el Service Worker atiende los fetch y
`route` no los ve, y si su handler no responde Playwright continúa la petición él solo. La
envoltura tiene que **respetar el `AbortSignal`**, que es lo que hace la red de verdad y lo
único que prueba el tope. Y para que el detalle se pida de verdad hay que **vaciar el
almacén `detail` de IndexedDB** antes: si hay copia local, `route()` la devuelve y no hay
carga que ver.

### Rendimiento del hover: qué NO hacer en un `Chart` que se repinta en cada mousemove
El hover sincronizado repinta las gráficas en **cada movimiento del ratón**, así que
cualquier cosa que Chart.js resuelva por punto se multiplica por 500 y sesenta veces por
segundo. Dos reglas que salieron de medirlo (ruta de 3000 puntos, perfil de 501):

- **Nada de opciones scriptables** (`borderColor: c => …`, `backgroundColor: c => …`) con
  algo que cueste más que leer una variable. Chart.js las resuelve **una vez por punto**:
  con el degradado por pendiente como función salían **1020 llamadas por repintado**, cada
  una recalculando el perfil de pendientes entero → **114 ms por movimiento del ratón (~9
  fps)**. Como valor concreto puesto una vez (`slopeGradientPlugin`, que además solo lo
  rehace si cambia el ancho del gráfico): **0 llamadas**.
- **Para mover el crosshair, `chart.render()`, no `chart.update('none')`**. `render()` solo
  repinta el lienzo (0,26 ms el perfil, 0,56 ms los tres juntos); `update('none')`
  reconstruye escalas y vuelve a resolver las opciones de los 500 puntos (2,08 ms por
  gráfica) **y reenvía el último evento de ratón**, que es el replay que obliga al cerrojo
  `_syncing`.

Lo que sí es barato y no hace falta tocar, medido en el mismo escenario: el `setData()` del
punto de hover (0,10 ms), el repintado del mapa que provoca (**1,0 ms** de mediana) y el
`innerHTML` + `offsetWidth` del cuadro flotante (0,07 ms, el reflow no se nota porque el
mapa es un canvas). Con todo junto el coste por movimiento queda en **~1,8 ms**. Si alguna
vez hay que bajar de ahí, lo siguiente sería el punto de hover como marcador DOM (mueve con
un transform, sin repintar el mapa), no micro-optimizar el JS.

### Hover sincronizado mapa↔gráficos en el detalle (`static/js/sec/detalle.js`)
Pasar el ratón por la línea del track en el mapa, o por el perfil de elevación/velocidad/FC,
resalta la misma posición en los otros 3 elementos y muestra un cuadro flotante en el mapa
con altitud/velocidad/FC en ese punto. Punto de entrada único: `setHoverD(d)` (d en km o `null`).

**Lo mismo hay en el detalle de un PLAN** (`sec/plan.js`, desde la v0.9.13), con las mismas
funciones y el mismo `.hover-infobox`, pero solo con elevación: un plan no tiene velocidad
ni FC porque no se ha hecho todavía. Las capas se llaman `pl-ruta-hit` y `pl-hover-point`, y
las crea `drawTrack()` (así se repintan solas al entrar/salir de la capa offline, regla 15);
los `map.on('mousemove'/'mouseleave', 'pl-ruta-hit')` van en `initMap()`, porque `drawTrack()`
se vuelve a ejecutar tras cada cambio de estilo y acumularía handlers. Si tocas una de las dos
vistas, mira si la otra necesita el mismo cambio.
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
- **Apagar el hover al salir del gráfico son DOS trampas de Chart.js**, las dos corregidas en la
  v0.9.13 y las dos mudas si se revierten (el cuadro se queda pegado en el mapa para siempre, sin
  ningún error):
  1. **`chart.update()` REENVÍA el último `mousemove`** (su `_lastEvent`, un replay interno) y con
     él vuelve a llamar a `onHover`. Como `setHoverD()` actualiza los charts, `setHoverD(null)` se
     deshacía a sí mismo: el replay reponía la distancia anterior. De ahí el cerrojo `_syncing`,
     que ignora la reentrada mientras se está actualizando.
  2. **Chart.js llama a `onHover` también con el `mouseout`**, y encima diferido a la siguiente
     animación, así que llega DESPUÉS del `onmouseleave` del canvas y trae la última posición
     buena. Por eso cada `onHover` empieza con `if (!e || e.type === 'mouseout') { setHoverD(null);
     return; }` — es ahí donde se apaga de verdad, no en el `onmouseleave`.
  Lo cubren el bloque «Hover sincronizado mapa↔gráficos» (salir del GRÁFICO, que es un caso
  distinto de salir del mapa: el test viejo solo probaba lo segundo y por eso no lo vio) y el
  bloque 17 de `tests/e2e_spa.py`. El de la ruta sale del perfil **por la izquierda** a propósito:
  hacia abajo se entra en el gráfico de velocidad y el resultado depende de qué chart procesa
  antes su `mouseout`.
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
- **El auto-encuadre se aparta si se está siguiendo la ubicación**: el `setTimeout(fitMap,
  600)` de `renderMap()` mira `userMoved` **y** `geoTracking(map)`, y `trackuserlocationstart`
  pone `userMoved` (ver «Botón Mi ubicación»). Sin eso, una sincronización de fondo devolvía
  el mapa a las rutas mientras el usuario se miraba a sí mismo.

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
- `fitToPoints()` se aparta mientras se sigue la ubicación (`geoTracking(map)`): lo llama
  `reloadRoutes()`, o sea cada sincronización de fondo.

### Mapa de «Mis Planes» en `static/js/sec/planes.js`
Tercer mapa MapLibre. Pinta dos cosas: los **marcadores DOM** de salida (icono de la
actividad, click → `/Plan/<public_id>`) y, desde la v0.9.8, la **traza de cada plan**
(`pl-lines` + `pl-lines-hit`, misma línea ancha invisible que `ov-lines-hit` para que el
click no exija acertar 2 px; color por `activityLineColor()`).
- Las líneas **no salen del listado**: `PLANNED_LIST_COLS` no trae `geojson` a propósito,
  así que las da `GET /api/planned/geojson`. Se piden **todas de una vez**, sin `?bbox=`
  ni umbral de zoom (a diferencia de `ov-lines`/`dash-lines`): los planes son unas
  decenas, no cientos, y `planned_routes` no tiene columnas de bounding box.
- **Sin conexión siguen viéndose**: se guardan en el Store con
  `Store.setMeta('planned_lines', …)` y se pintan antes de pedir la red, como los récords
  del dashboard. Si la petición falla, quedan las guardadas (o solo los marcadores).
- `lineFC()` filtra por `visiblePlans()`: los `public_id` que el listado tiene ahora mismo
  (para que la traza de un plan borrado no se quede pintada hasta que responda la petición)
  y que pasan el filtro por estado. Los marcadores hacen lo propio en `syncMarkers()` y el
  encuadre en `fitPlans()` — el filtro tiene una sola fuente, ver la sección siguiente.
- Al entrar/salir de la capa offline hay que **volver a añadir las capas** (regla 15):
  `applyBasemap` reconstruye el estilo. Los marcadores se recrean (son DOM) y
  `addLineLayers()` vuelve a crear fuente y capas en `map.once('sendero:basemap', …)`.
- `fitPlans()` encuadra las trazas **más** los puntos de salida, con `duration:0`: el
  centro del constructor es un placeholder y animar desde él es el «vuelo» que se quitó
  del mapa de «Mis Rutas». Y **no encuadra nada mientras se sigue la ubicación**
  (`geoTracking(map)`): aquí todos los encuadres son automáticos (filtro, recarga,
  llegada de las trazas), no hay botón de «centrar», así que basta pararlo ahí.

### Marcar un plan como realizado (`static/js/sec/planes.js`)
Cada tarjeta de «Mis Planes» lleva un botón: `✓ Marcar realizada` abre `#done-modal`
(«¿qué ruta la cumplió?») y `Desmarcar` la devuelve a pendiente. Se guarda en
`planned_routes.completed_at` + `completed_route_id` (ver la tabla más abajo).
- **La ruta asociada es opcional**: el botón «Marcarla sin ruta asociada» del modal
  manda `completed_route:null`. No todo plan hecho tiene un track subido.
- **El selector sale del Store, no de la red**: `loadRoutesIndex()` usa
  `Store.routes()`, así que funciona sin conexión. Las rutas cuyo inicio cae a
  menos de `NEAR_M` (3 km) del inicio del plan van arriba, en «Sugeridas»
  (`haversineM` local al módulo, como en `detalle`/`editor`); el resto, en «Todas»,
  con buscador por nombre y localidad.
- **Sin conexión se encola** (`Store.patch` → outbox) y por eso la fecha la pone el
  cliente con `isoLocal(new Date())` — ISO local sin zona, como los `created_at`
  del servidor; con `toISOString()` un plan marcado a las 00:30 saldría con la
  fecha del día anterior.
- **Tras el PATCH hay que actualizar la copia local**: `Store.patchPlanRow(pid,
  cambios)` (mismo motivo que `putDetail` en el detalle de una ruta). Sin eso, el
  cambio hecho sin conexión desaparece en el siguiente `reload()`, porque la
  sección relee el listado de IndexedDB y ahí seguiría el estado del servidor.
- La tarjeta realizada se **apaga** (`.plan-card.done`, opacidad .62 y título
  tachado) y recupera opacidad al pasar el ratón.

**Filtro por estado** (`#pg-filters`, en la fila de `.pg-list-head`): píldoras
`Pendientes · Realizadas · Todas` con el recuento de cada estado dentro, pintadas
por `renderFilters()`. Arranca en `'pendientes'` (esta vista es la lista de lo que
queda por hacer) y se recuerda en `sessionStorage` bajo `sendero_planes_estado_v1`
— es una preferencia, no un dato, igual que los filtros de «Mis Rutas». Tres cosas
que no son opcionales si lo tocas:
- **Filtra la lista Y el mapa.** `visiblePlans()` es la única fuente: la usan
  `render()`, `syncMarkers()`, `lineFC()` y `fitPlans()`. Un filtro que solo
  escondiera tarjetas dejaría el mapa contando otra historia (mismo criterio que
  `applyLineFilter()` en «Mis Rutas»).
- Los **marcadores se sincronizan** (`syncMarkers()`), no solo se añaden: hay que
  QUITAR el del plan que el filtro deja fuera. Antes solo se añadían, y con un
  filtro eso deja marcadores de planes que no están en la lista.
- **Vacío por el filtro ≠ vacío de verdad**: `#no-plans` explica cuál de los dos es
  y ofrece cambiar de estado. Si no, marcar el último plan pendiente parece haber
  borrado la colección.
- Los KPIs de la cabecera **no** se filtran: describen la colección entera (el
  recuento por estado ya lo dan las píldoras).

### La ficha de un plan (`templates/sec/plan.html` + `sec/plan.js` + `css/plan.css`)
El detalle de una ruta planificada. Desde la v0.10.0 no es una vista de solo lectura:

- **Acciones de cabecera**: en la fila, `✎ Editar track` (→ `/Plan/<pid>/editor`,
  `openEditor()`, que **exige conexión** y si no la hay avisa sin navegar), `⛓ Unir…`
  (`#pl-unir-btn` → `/Plan/<pid>/unir`, `openUnir()`, online-only por el mismo motivo),
  `Vista 3D`
  (`#pl-btn3d`) y `⬇ Mapa sin conexión` (`#pl-offline-btn`). Con la quinta acción la
  rejilla 2×2 de ≤600 px queda impar, así que `#pl-more-btn` ocupa la fila entera
  (`grid-column:1 / -1`). Tras el `⋯`
  (`#pl-actions-more`): `↓ Descargar GPX` (solo si el plan guarda su archivo),
  `✔ Marcar realizada` / `Desmarcar` (`#pl-done-btn`), `↺ Reanalizar` (`#pl-rescan-btn`),
  `Renombrar` y `Eliminar`. **`#pl-offline-btn` tiene que seguir a la vista**: la suite e2e
  lo pulsa directamente, no abre el menú.
- **Realizada**: chapa `#pl-done-badge` sobre el mapa, fila «Realizada» con la fecha en
  «Datos técnicos» y, si hay ruta asociada, otra fila con un `data-nav` a `/Sendero/<pid>`
  (el nombre lo pone el cliente desde su copia de `routes`, así un renombrado se refleja
  solo). El modal `#pl-done-modal` es **propio de esta sección**, no el `#done-modal` de
  «Mis Planes»: aquél vive en la IIFE de `sec/planes.js`, que puede no estar cargada cuando
  se entra directo a `/Plan/<pid>`. Mismas reglas que allí: fecha `isoLocal` del CLIENTE
  (el PATCH se encola sin conexión y al reenviarse llevaría la fecha en que volvió la red),
  rutas del Store (`Store.routes()`, «Sugeridas» las que salen a menos de 3 km) y hay que
  escribir **las dos** copias locales, `Store.putDetail` y `Store.patchPlanRow`.
- **Vista 3D**: misma secuencia que el detalle de una ruta —inclinar primero, encender el
  terreno en el `moveend`— porque mover la cámara en el mismo tick que `setTerrain()` deja
  el mapa NEGRO (ver «Bugs corregidos»). Lo propio de aquí es **`ensureTerrain()`**: la
  fuente `terrain` se añade aparte del track y hay que **reponerla tras
  `sendero:basemap`**, porque entrar o salir de la capa offline reconstruye el estilo y se
  lleva todas las fuentes (regla 15). Si estabas en 3D, se vuelve a encender sola. Y
  `fitRoute()` conserva el `pitch` en 3D: reencuadrar a pitch 0 sería deshacer lo que el
  usuario acaba de pedir.
- **Pestañas en móvil (<768 px)**: son **tres** (Perfil · Datos · Notas), no cuatro como en
  el detalle de una ruta — un plan no tiene fotos. Mismo mecanismo: `data-tab` en la
  sección, `data-dtab` en cada panel, `SEC.plan.setTab()` cambia el atributo y
  **redimensiona el Chart** (con el panel en `display:none` su canvas medía 0).
  `resetView()`/`unmount()` vuelven siempre a «Perfil».
- **TRAMPA: un panel que se esconde por no tener datos usa `style.display`, no `.hidden`.**
  `#pl-elev-panel` (sin elevación) y `#pl-source-section` (sin Wikiloc) llevan `data-dtab`,
  y la regla de la pestaña activa (`#sec-plan[data-tab="x"] [data-dtab="x"]{display:block}`)
  **empata en especificidad** con `#sec-plan .panel.hidden{display:none}`: gana la última, o
  sea que el panel vacío reaparecería en móvil. El estilo inline gana siempre. Es el mismo
  apaño que `#speed-section` en el detalle de una ruta.
- `rescanPlan()` es `POST /api/planned/<pid>/rescan` y necesita conexión (lo hace el
  servidor); tras él, `Store.putDetail` + `render()` + `Store.syncNow`.
- Todo lo demás (hover sincronizado, color por pendiente, IBP, mapa sin conexión) tiene su
  propia sección más arriba: si tocas una de las dos fichas, mira si la otra necesita lo
  mismo.

### Índice IBP de un plan (`core/ibp.py` + `api/planned.py` + `api/planned_editor.py` + `sec/plan.js`)
La puntuación de dificultad de [ibpindex.com](https://www.ibpindex.com) (0 → ∞) de las
rutas **planificadas**. Cuatro cosas que definen el diseño, y ninguna es negociable sin
rehacerlo:

- **El algoritmo es cerrado y no se puede reimplementar.** Ni su web ni su documentación
  publican la fórmula (su calculadora sube el archivo y recibe el número). Se usa su
  **API v2.0**: `POST https://www.ibpindex.com/api/` multipart con `file` + `key`, y
  devuelve **HTTP 200 con `{"error": ...}`** cuando la clave no vale — mirar el código de
  estado no basta, de ahí `parse_response()`. Si alguna vez se plantea "calcularlo
  nosotros": no es el mismo número y deja de ser comparable, que es su única utilidad.
- **Aquí sale el track completo de la LAN**, único sitio de Sendero donde eso pasa (el
  geocoder manda un punto). Por eso la clave se pega a mano en Ajustes → IBP Index,
  **vacía = desactivado de fábrica**, y el aviso está en esa pantalla, no en un hint.
- **Solo planes, no rutas.** No lo añadas a `routes` sin motivo nuevo: son 500 subidas a
  un tercero de recorridos ya hechos, y para eso la ruta ya tiene sus datos reales.
- **El valor se guarda y no se recalcula solo**: si el servicio desaparece, los índices
  obtenidos siguen ahí. Solo se recalcula si lo pides (`↻ Recalcular` o el botón de lote).
- **Al editar el track, el índice se VACÍA** (`ibp_index`/`ibp_modality`/`ibp_all`/`ibp_at`
  a NULL, lo hace `PlanTarget.after_new_version()` en cada versión nueva: guardar, dividir,
  DEM y restaurar). El número describía otro recorrido, y recalcularlo solo significaría
  mandar el track entero a un tercero en cada guardado: la ficha vuelve a ofrecer
  «Calcular». Los planes que nacen de un split o de un merge tampoco lo traen. `rescan`
  no lo toca. Está en «Descartado» de `WHATS_NEXT.md`: no lo reabras sin motivo nuevo.

Cómo se reparte:
- `core/ibp.py` — `analyse()` (red) y `parse_response()` (pura, `tests/test_ibp.py`).
  Lanza `IbpError` con mensaje **en español** en vez de devolver None: sin clave, clave
  inválida, sin red y GPX ilegible se arreglan de formas distintas y el usuario tiene que
  saber cuál es. Quien va best-effort lo captura.
- `create_planned` lo intenta al importar (solo si hay clave) y **nunca rompe la
  importación**: el plan entra igual y se queda con su botón en el detalle.
- **La modalidad importa**: la misma ruta no puntúa igual a pie (`HKG`), en bici (`BYC`) o
  corriendo (`RNG`), así que el número **siempre va con su acrónimo**. La API devuelve las
  tres de una vez ⇒ se guardan las tres en `ibp_all` y **cambiar la actividad del plan
  reelige el índice sin red** (lo hace el PATCH en el servidor y `pickActivity()` en el
  cliente, con `IBP_MOD_BY_ACT`, que es copia de `_MODALITY_BY_ACTIVITY`: si tocas una,
  toca la otra).
- **No se interpreta la cifra en una escala de dificultad**: ibpindex.com no publica los
  cortes, así que inventarlos sería peor que no decir nada.
- UI: chapa `.ibp-badge` en `makeCard()` de `sec/planes.js`, panel `#pl-ibp-panel` en el
  detalle (tres estados: con índice, sin índice pero con clave, y sin configurar — el
  tercero explica cómo activarlo en vez de ofrecer un botón que fallaría), y el botón de
  lote de Ajustes (`ibpBackfill()` en `chrome.js`), que **recorre los planes de uno en uno
  desde el cliente**: no hay endpoint de lote ni proceso de fondo porque los planes son
  unas decenas, no cientos.
- Tras calcular hay que escribir **las dos** copias locales: `Store.putDetail` (el panel) y
  `Store.patchPlanRow` (la chapa de la tarjeta). Con solo la primera, la tarjeta no enseña
  el índice hasta la siguiente sincronización con cambios.

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

**Cabecera de filtros: qué se ve y qué está tras el `⋯`.** En la fila solo quedan las
píldoras de actividad (el filtro del día a día), la `✕` de limpiar —solo el icono, el
nombre va en el `title`— y el botón `⋯` (`#more-btn`), que despliega `#more-pop` con la
**fecha** y el **buscador**. Cuatro cosas que no son opcionales si lo tocas:
- **El botón se enciende en ámbar** (`.on`, lo pone `updateMoreBtn()` desde
  `renderList()`) cuando hay fecha o búsqueda: un filtro activo dentro de un menú
  cerrado deja la lista recortada sin nada a la vista que lo explique — el mismo
  criterio que el «vacío por el filtro ≠ vacío de verdad» de «Mis Planes».
- **El calendario se dibuja DENTRO de `#filter-more`**, así que el cierre por click
  fuera (`!cont.contains(e.target)`) no lo confunde con un click externo. Si algún día
  el `.dp-pop` se mueve al `<body>` (es `position:fixed`, tentador), el menú se cerrará
  al abrir el calendario y habrá que exceptuarlo a mano.
- `#sec-rutas .more-pop.hidden{display:none}` va **justo después** del `display:flex`:
  sin esa regla el `.hidden` global pierde por especificidad y el menú aparece abierto
  al cargar (es el mismo tropiezo que el modal Immich del detalle).
- Los listeners de cierre (click fuera y Escape) se registran **una vez** al cargar el
  archivo, y `unmount()` llama a `closeMore()`.

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

- **Subir `DB_VERSION` colgaba la app y dejaba `/actualizar` a medias** (0.9.8 → 0.9.9).
  IndexedDB no deja migrar una BD mientras otra conexión la tenga abierta con la versión
  anterior, y `store.js` no cubría **ninguno** de los dos lados de eso:
  (a) no escuchaba `versionchange`, así que una ventana con código viejo bloqueaba la
  migración de la nueva para siempre; (b) no escuchaba `onblocked`, así que la promesa de
  `open()` **no se resolvía ni se rechazaba** — cada lectura quedaba pendiente y la app se
  veía a medias, sin error, que es el síntoma clásico de "código viejo pegado" y por eso se
  diagnostica mal. El remate: el `deleteDatabase()` de `/actualizar` se encolaba DETRÁS de
  ese `open()` bloqueado y **tampoco recibía evento alguno** (ni `success` ni `blocked`), de
  modo que la página se quedaba en «Copia local de rutas y planes …» sin terminar; y en el
  caso más benigno (misma versión, app abierta en otra pestaña) resolvía en `onblocked` y
  cantaba «borrada» sin haber borrado nada.
  Hoy: `_db.onversionchange` suelta la conexión, `onblocked` rechaza con `dbBlocked` y
  avisa (`emit({type:'db-blocked'})` → chapa «otra ventana» + toast en `chrome.js`, pegajoso
  vía `Store.dbBlocked()` porque el `pendingCount()` en vuelo pisaba el badge), `/actualizar`
  pide `release` por `BroadcastChannel('sendero-db')` antes de borrar y **acota cada paso en
  el tiempo**. Lo cubre el bloque 17 de `tests/e2e_spa.py` (comprobado que FALLA si se
  revierte). Si vuelves a subir `DB_VERSION`, no toques nada de esto sin volver a pasar ese
  bloque.

- **El detalle se quedaba «cargando» para siempre si el servidor no contestaba** (0.9.14).
  `netFetch` no tenía tope de tiempo, así que un servidor que acepta la conexión y calla
  dejaba el `await` de `mount()` pendiente sin límite: paneles vacíos, ningún error y ni
  siquiera el `go()` del router volvía. Hoy `route()`/`plan()` van con `DETAIL_TIMEOUT_MS` y
  la vista tiene aviso con «Reintentar» (ver «Estado de carga de los dos detalles»). Si
  añades otra vista que cargue de red, dale las tres piezas: tope, shimmer y salida.

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

11. **Caché de rutas en el cliente** — si cambias los campos que devuelve `/api/routes`
    **o `/api/planned`**, sube `DB_VERSION` en `static/js/core/store.js`: su
    `onupgradeneeded` vacía los almacenes de IndexedDB y los clientes se rehacen la copia.
    (Va por 5: el 3 fue el resumen de `gps_issues`/`n_photos` del listado de rutas, el 4,
    `completed_at`/`completed_route_public` en el de planes, y el 5, `ibp_index`/
    `ibp_modality` en el de planes.) **Subirla no es gratis**: una
    ventana abierta con el código anterior retiene la BD y bloquea la migración, así que
    `store.js` tiene que seguir soltando la conexión en `versionchange` y avisando en
    `onblocked` — ver "Bugs corregidos" y el bloque 17 de `tests/e2e_spa.py`.
    El almacén del Store es la ÚNICA caché de datos
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
    Lo que NO hay que repintar son los controles ni los marcadores DOM (el punto de «Mi
    ubicación» es uno de ellos, por eso no aparece en ningún repintado).
    **Y ese repintado no se guarda nunca con `map.isStyleLoaded()`**: `sendero:basemap` se
    dispara en el `styledata` del estilo nuevo, donde todavía devuelve `false`, así que la
    guarda se tragaría el repintado entero y el mapa se quedaría sin capas de datos (pasó
    en `sec/unir.js` al salir de la capa offline). La guarda correcta es la de
    idempotencia: «¿ya existe mi fuente? pues no la vuelvas a añadir».

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
| activity_type | TEXT | senderismo/bicicleta/caminata/correr/esqui/kayak/otros. Los ids salen de `core/activities.py`, ver «Catálogo de actividades» |
| device | TEXT | fabricante/modelo del dispositivo |
| immich_checked | INTEGER | 0/1 |
| start_lat, start_lon | REAL | primer punto del track |
| thumb_file | TEXT | nombre en `data/thumbs/` (PNG) |
| bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat | REAL | bounding box del track completo; lo calcula `_route_bbox()` en `create_route`/`rescan_route`. Usado por `/api/routes/geojson?bbox=` (mapa del dashboard) para no cargar rutas fuera de la zona visible |
| content_hash | TEXT | SHA-256 de los bytes crudos del archivo importado (`core/dedup.py`). Dedup DURA: reimportar los mismos bytes (aunque con otro nombre) → 409. Índice propio `idx_routes_content_hash`. Solo se fija al importar; NO se recalcula al editar/reescanear (la pregunta es "¿ya vi este archivo?", referida al original) |
| signature | TEXT | Huella SEMÁNTICA del entreno (`route_signature`): `started_at` al minuto + primer/último punto a 4 decimales (~11 m). Sin timestamps cae a distancia(100 m)+nº puntos. Dedup BLANDA. Índice propio `idx_routes_signature`. Deliberadamente NO incluye distancia cuando hay hora (el hash por igualdad daría falsos negativos en las fronteras de cubo). Solo al importar, no se recalcula |
| dup_suspect_of | INTEGER | id de la ruta a la que se parece, cuando la ingesta AUTOMÁTICA (`?auto=1`) la importó pese al aviso semántico. NULL = limpia. Se lee en el listado → va en `idx_routes_list_cov5` (regla 12). Se limpia al editar la ruta o con `PATCH {dup_suspect_of:null}` ("descartar aviso") |
| locality | TEXT | Sitio donde se hizo la ruta ("Localidad, Región"), por geocoding inverso del punto de inicio (`core/geocode.py`, `GEOCODE_URL` en Ajustes → Editor). Se rellena best-effort al importar (`create_route`) y al reescanear una ruta que aún no la tenga (`_reanalyse_and_update`, backfill vía "Re-escanear"); NULL = servicio desactivado o geocoding fallido. Se lee en el listado y se muestra en la tarjeta de "Mis Rutas" y en el detalle → va en `idx_routes_list_cov5` (regla 12) |
| seg_starts | TEXT JSON | Índices de `geojson` donde empieza cada `<trkseg>` (`[0]` = un solo segmento; NULL = desconocido, o sea rutas anteriores a la columna hasta que se reescaneen). Lo que hace que el detalle dibuje los cortes como **hueco** en vez de la recta que MapLibre traza entre segmentos (ver «Huecos entre segmentos»). Lo calculan `analyse_gpx`/`analyse_fit` y lo escriben `create_route`, `rescan_route` y cada reanálisis del editor. **NO va en ningún índice de cobertura** (regla 12) y **no obliga a subir `DB_VERSION`** (regla 11): no se lee en el listado, solo en `_build_route_dict` y el editor, siempre por id. En `?lite=1` hay que remapearlo (`decimate_with_segments()`) |
| public_id | TEXT | Identificador **opaco no secuencial** (`secrets.token_urlsafe(8)`, ~11 chars) expuesto en TODAS las URLs `/api/routes/<public_id>/...`; la PK entera `id` queda solo interna (FKs, `versions/<route_id>/`, prefijo de nombre de foto). Evita que CrowdSec vea enumeración al pedir las miniaturas del listado. Índice UNIQUE `idx_routes_public_id`; se lee en el listado → va en `idx_routes_list_cov5` (regla 12). Se fija al importar (con reintento por colisión) y por backfill en `init_db()`; NO se recalcula. Los endpoints resuelven `public_id`→`id` con `rid_from_public()` en su 1ª línea (thumb/gpx/foto consultan `WHERE public_id=?` directo). Al añadirlo se invalidó la caché del cliente (regla 11) |

### Tabla `route_versions`
Historial del editor de rutas (append-only, ver sección "Editor de tracks").
`route_id`, `version_n` (UNIQUE juntos), `file` (nombre en
`data/gpx/versions/<route_id>/`), `summary` (en español), `distance_m`,
`ascent_m`, `n_points`, `created_at`. Sin filas = ruta nunca editada (versión 0).
El archivo activo de la ruta es siempre idéntico a la versión más alta.

### Tabla `plan_versions` (v0.10.0)
Lo mismo para un PLAN, con una diferencia: **el archivo va dentro**. `plan_id`,
`version_n` (UNIQUE juntos), `gpx_data` (BLOB con el GPX de esa versión), `summary`,
`distance_m`, `ascent_m`, `n_points`, `created_at`. El GPX de un plan ya vive en
`planned_routes.gpx_data` y no en disco, así que sacar sus versiones a
`data/gpx/versions/` partiría el modelo en dos.
- Sin filas = plan nunca editado (versión 0). **Invariante: `planned_routes.gpx_data`
  == la versión más alta**, y `DELETE /api/planned/<id>` borra explícitamente sus filas
  (no hay FK: `PRAGMA foreign_keys` está apagado, regla 14).
- **No es entidad sincronizada y no lleva triggers** (como `route_versions`): lo que el
  cliente ve cambiar es el plan, y ese sí los tiene. Tampoco hay columna nueva en
  `planned_routes`: el `version` del dict sale de `MAX(version_n)`, igual que en una ruta.
- Sin índice de cobertura a propósito (regla 12): aquí el BLOB está **al final** del
  registro, así que listar el historial no lo atraviesa. Solo `idx_plan_versions_plan`
  para no escanear la tabla entera.

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
cobertura del listado `idx_planned_list_cov3`, regla 12 — estas columnas pequeñas
vienen físicamente DESPUÉS del BLOB `gpx_data`).

**Plan realizado** (v0.9.8): `completed_at` (ISO, cuándo se marcó; NULL =
pendiente) y `completed_route_id` (id interno de la ruta real que lo cumplió;
NULL = marcada sin ruta). Las dos se leen en el listado → van en
`idx_planned_list_cov3` (regla 12; sustituye a `idx_planned_list_cov2`, que a su
vez sustituyó a `idx_planned_list_cov`: los dos anteriores se descartan). **Sin FK a propósito**: `PRAGMA foreign_keys` está apagado (regla 14) y
si esa ruta se borra el subselect de `PLANNED_LIST_COLS` da NULL solo, así que la
tarjeta queda «realizada, sin ruta» en vez de romperse. El listado NO expone el id
interno: manda `completed_route_public` (subselect del `public_id`), que es lo que
la tarjeta enlaza, y el nombre lo pone el cliente desde su copia de `routes` — así
un renombrado se refleja sin denormalizar nada. La **fecha la manda el cliente**,
no `now()` del servidor: el PATCH se encola en el outbox sin conexión y al
reenviarse llevaría la fecha en que volvió la red.

**Índice IBP** (v0.9.11, ver «Índice IBP de un plan»): `ibp_index` (la puntuación
de la modalidad que toca; NULL = sin calcular), `ibp_modality` (su acrónimo:
`HKG`/`BYC`/`RNG`), `ibp_all` (JSON con las TRES que devuelve la API en la misma
llamada) e `ibp_at` (cuándo se calculó). Las dos primeras se leen en el listado →
van en `idx_planned_list_cov3` (regla 12); `ibp_all` **no**, a propósito: solo lo
miran el PATCH de actividad y el endpoint de cálculo, siempre por id, así que la
fila se lee entera de todas formas.

**Huecos entre segmentos** (v0.11.7): `seg_starts` (TEXT JSON), exactamente igual que en
`routes` —ver allí y «Huecos entre segmentos»—. Tampoco se lee en el listado, así que no
va en `idx_planned_list_cov3` ni obligó a subir `DB_VERSION`; solo lo mira
`_build_plan_dict`, por id. Aquí **no** hay variante ligera, así que sus índices no se
remapean nunca.

**La v0.10.0 no añadió ninguna columna aquí**, aunque el plan ya se edite: el historial
vive en su propia tabla (`plan_versions`) y el `version` del dict sale de `MAX(version_n)`,
igual que en una ruta. Por eso tampoco hizo falta tocar `PLANNED_LIST_COLS`, ni el índice
de cobertura, ni subir `DB_VERSION` (regla 11).

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
`IBP_API_KEY` (clave de la API del índice IBP, Ajustes → IBP Index; vacía =
desactivado, y es el valor de fábrica — sin ella no se sube ningún track),
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
  medias — sin ningún error claro en el servidor. **Desde la v0.9.18 se cura solo**: en
  cuanto el Service Worker de la versión nueva toma el control (`controllerchange` en
  `chrome.js`), la página se recarga UNA vez y todo pasa a venir de la misma versión. No
  recarga en dos casos, a propósito: en la primera visita (no había controlador: no hay
  nada viejo que arreglar) y con cambios sin guardar en el editor
  (`SEC.editor.pendientes()`, que solo existen en memoria) — ahí avisa con un toast.
  Si aun así se queda pegado, la salida sigue siendo **`/actualizar`** (enlazado en
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
- **Eran DOS motores Docker, no «procesos huérfanos».** Hasta la v0.11.7 aquí se
  documentaba que Docker Desktop sobre WSL2 dejaba `gunicorn`/`watch.py` huérfanos tras
  varios `down`/`up --build`. **No era eso**: en esta máquina había un `dockerd` **nativo
  dentro de Ubuntu** (systemd, con autoarranque) que levantaba el stack viejo desde
  `/mnt/c/Users/xinux/Documents/Sendero` y retenía el 8090 con su `docker-proxy`, además
  de Docker Desktop. Los tres síntomas, que engañan por separado:
  (a) `docker ps` **no lista** el contenedor que está atendiendo el 8090 (lo tiene el otro
  motor), así que los cambios no se reflejan aunque el build vaya bien;
  (b) si Desktop levanta su stack a la vez, los dos abren la MISMA `data/sendero.db` y el
  de producción empieza a dar **500 `unable to open database file`**;
  (c) Docker Desktop, al arrancar, **tapa `/var/run/docker.sock` y `/run/docker.sock`**
  del nativo, así que el mismo comando habla con un motor u otro según el momento.
  Diagnóstico: `wsl -d Ubuntu -u root -e ss -ltnp | grep 8090` (quién tiene el puerto) y
  `ps -eo pid,lstart,cmd | grep gunicorn` (desde cuándo lleva vivo).
  Solución aplicada: `systemctl disable --now docker docker.socket containerd` dentro de
  Ubuntu, matar los zombis con `ctr -n moby tasks kill`, y quedarse con **un solo motor**
  (Docker Desktop) con la integración WSL activada para Ubuntu (Settings → Resources →
  WSL integration).
- **En esta máquina no hay `node`.** Los seis smoke tests de JavaScript
  (`sw_smoke.js`, `sec_smoke.js`, `tiles_smoke.js`, `slope_smoke.js`, `speedfix_smoke.js`
  y `gps_parity_smoke.js`) **no se pueden lanzar aquí**; lo que se ha hecho en su lugar
  es verificar en un navegador real con Playwright, canal `msedge`. No los des por
  pasados: si tocas ese código, pásalos donde haya Node (instalarlo está en la lista de
  «Para hacer» de `WHATS_NEXT.md`).

## Antes de dar por buena una tarea
- ¿Sigue arrancando `python app.py` e `init_db()` sin error?
- Si tocaste `create_route` o `rescan_route`: ¿se genera el thumb y se guarda `thumb_file`?
- Si tocaste fotos: ¿probaste los dos caminos (local y `immich_id`)?
- Si tocaste el esquema: ¿añadiste la migración defensiva en `init_db()`?
- ¿La UI sigue en español y sin paso de build?
- Si tocaste el CSS del modal Immich (`static/css/detalle.css`): comprueba que
  `#sec-detalle .overlay.hidden` sigue ocultando el modal al cargar la ruta.
- Con Playwright disponible, la comprobación de verdad es `python tests/e2e_spa.py`
  (228 comprobaciones en un navegador real: mapas, gráficas, fugas de `unmount()`, Service
  Worker, modo sin conexión, cola de escrituras y el bloque «Planificación editable»).
  Necesita un servidor con `SENDERO_DATA` **de pruebas** y `python tests/e2e_seed.py` para
  sembrarlo. **Dos de esas comprobaciones fallan desde la v0.9.18** y están apuntadas en
  `WHATS_NEXT.md`: si te fallan esas dos y solo esas, no las has roto tú.
- Si tocaste `/actualizar` o el Service Worker: comprueba que la página sigue llegando de
  red (el SW no debe interceptarla) y que deja SW, cachés, IndexedDB y sessionStorage a
  cero; y que al volver a la app se rehacen los cuatro. **Y que termina siempre**: con la app
  abierta en otra pestaña debe borrar de verdad (no decir «borrada» sin borrar), y con una
  ventana que retenga una versión anterior del almacén debe decirlo y ofrecer reintentar
  (bloque 17 de `tests/e2e_spa.py`).
- Si subiste `DB_VERSION` en `store.js`: pasa el bloque 17 de `tests/e2e_spa.py`. Migrar con
  otra ventana abierta es lo que colgaba la app en la 0.9.8 (ver "Bugs corregidos").
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
- Si tocaste la **unión** (`core/editing.py::smart_merge`, `merge_options`/`run_merge` de
  `api/editor.py`, los dos endpoints `/merge`): `python -m pytest tests/test_merge.py`, que
  además de la geometría y las propuestas vigila el **rendimiento** (2×20 000 puntos en
  menos de 2 s: si te cargas el índice de rejilla, la unión pasa a O(n·m) y el test lo
  pilla). Y comprueba las tres que se rompen calladas: que un track con todos los `<time>`
  iguales siga **sin contar como que tiene tiempos**; que `order`/`reversed`/`trimmed_m`
  sigan siendo **por pieza** y los toggles del cliente sigan saliendo de
  `reversed_inputs`; que `MG_GAP_JOIN_M` de `sec/unir.js` siga valiendo lo mismo que
  `gap_join_m` del servidor (50); que `start`/`end` mal formados o fuera de rango den 400 en
  **los dos** endpoints y una combinación imposible avise en vez de fallar; y que
  `start_point`/`end_point` sigan siendo el primer/último punto de `segments` (dependen de que
  `decimate` conserve los extremos). Y en el montaje manual: que `pieces` siga sin fallar
  cuando llegan `reverse`/`proposal`/`start` (avisa, no 400), que `from_m > to_m` siga
  significando invertido, y que las distancias sigan en la escala de `_Poly.cum`.
- Si tocaste la sección `unir`: **pruébala con un PLAN y con una RUTA** (es el mismo
  archivo, `params.kind`), y con **conexión y sin ella** (sin red se monta y avisa, no
  falla). ¿Sigue sin aparecer ningún `/api/routes` ni `/Sendero/` a mano en `sec/unir.js`
  (todo por `K`)? ¿`unmount()` destruye el mapa? ¿Entrar y salir de la capa offline
  repinta las capas `un-s<i>*`/`mg-*` —y el repintado sigue **sin** guardarse con
  `map.isStyleLoaded()`, regla 15—? ¿A **420 px** de ancho el panel no saca scroll
  horizontal? ¿El perfil, los marcadores de inicio/fin y el `.hover-infobox` se destruyen en
  `unmount()`/`clearMap()`, y el hover perfil↔mapa se apaga al salir del perfil? ¿Sigue sin
  mandarse `start`/`end` cuando son el mismo extremo? En Montaje: ¿los dos perfiles fuente se
  destruyen al volver a Automático y en `unmount()`, la selección por arrastre sigue
  iluminando el tramo en el mapa, y las selecciones se reescalan con `track_lengths_m`? Y
  `node tests/sec_smoke.js`, que la monta como las dos entidades.
- Si tocaste los **huecos entre segmentos** (`seg_starts`, `gapFeatures`/`addGapLayers`,
  `decimate_with_segments`): míralo en las **dos fichas** (ruta y plan) y comprueba que
  `?lite=1` sigue coherente —los índices remapeados apuntan al mismo sitio del track
  decimado, y el `bootstrap_json` de `/Sendero/<pid>` es esa misma variante—. Las capas van
  encima de la traza y debajo del hover, y no deben tocar `lineMetrics` ni el degradado por
  pendiente. `python -m pytest tests/test_sync.py tests/test_parsers.py`.
- Si tocaste el editor: **pruébalo también con un PLAN** (`/Plan/<pid>/editor`), que es la
  otra mitad. ¿Lo nuevo va sobre el TARGET y no en un `if kind == 'plan'`? ¿Sigue sin
  aparecer ningún `/api/routes` ni `/Sendero/` a mano en `sec/editor.js` (todo por `K`)?
  ¿`node tests/sec_smoke.js` sigue montando la sección como ruta **y** como plan?
  `python -m pytest tests/test_plan_editing.py` cubre el lado servidor.
- Si añadiste un umbral, un endpoint o un campo a los metadatos de arranque del editor:
  mándalo en **los dos**, `/api/routes/<id>/editor` y `/api/planned/<id>/editor`. Si solo
  va en uno, el editor de la otra entidad se queda a medias sin ningún error.
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
  al entrar/salir de la capa offline? (regla 15). ¿Lleva su `addGeolocate(map, esquina)`
  como los otros siete? Y si tiene un re-encuadre **automático**, ¿lo frena
  `geoTracking(map)`? (ver «Botón Mi ubicación»: si no, le roba la cámara al usuario).
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
- Si tocaste el editor (`core/editing.py`/`api/editor.py`/`api/planned_editor.py`): ¿el
  orden de aplanado sigue siendo idéntico al de `analyse_gpx()`? ¿El activo sigue siendo
  igual a la versión más alta tras guardar y tras restaurar —el archivo en una ruta, el
  `gpx_data` en un plan—? ¿Los `<time>`/HR sobreviven a un recorte? (smoke test al final
  de "Editor de tracks").
- Si tocaste la ficha de un plan (`sec/plan.*`): ¿`unmount()` destruye el mapa y el
  `Chart`? ¿Los paneles que se esconden por falta de datos siguen usando `style.display` y
  no `.hidden` (si no, en móvil reaparecen)? ¿`ensureTerrain()` sigue reponiendo la fuente
  del DEM tras `sendero:basemap`, y el 3D sigue encendiendo el terreno en el `moveend` y no
  en el mismo tick? ¿`#pl-offline-btn` sigue FUERA del menú `⋯` (la e2e lo pulsa directo)?
  ¿Marcar realizada sin conexión se encola, avisa y sobrevive a `unmount()`+`mount()`
  (`putDetail` **y** `patchPlanRow`)?
- Si tocaste la política del índice IBP al editar un plan: lo correcto es **vaciarlo**, no
  recalcularlo (está en «Descartado» de `WHATS_NEXT.md`). Y `rescan` no debe tocarlo.
- Si tras `docker compose up -d --build` los cambios no se reflejan en `localhost:8090`
  pese a que el build no falla (o si el de producción da 500 `unable to open database
  file`): revisa el quirk de los **dos motores Docker** antes de sospechar del código —
  `wsl -d Ubuntu -u root -e ss -ltnp | grep 8090` dice quién tiene el puerto.
- Si tocaste el mapa de "Mis Rutas" (`sec/rutas.js`): ¿las líneas (`ov-lines`) siguen
  respetando los filtros de actividad/fecha vía `applyLineFilter()`, o se te ha colado un
  caso que las muestra sin filtrar? ¿sigue usando `fitMap(true)` en el primer encuadre
  (sin animación de vuelo)?
- Si tocaste el índice IBP (`core/ibp.py`, `/api/planned/<id>/ibp`, el panel de
  `sec/plan.js`): `python -m pytest tests/test_ibp.py` y `node tests/sec_smoke.js`. Y
  comprueba las tres cosas que se rompen sin ruido: que **sin clave** no se sube nada y el
  panel explica cómo activarlo (no un botón que falla); que **importar un plan con el
  servicio caído sigue devolviendo 201**; y que cambiar la actividad reelige la modalidad
  **sin pedir red** (viene de `ibp_all`). La modalidad de cada actividad es el campo
  `ibp` del catálogo (`core/activities.py`); servidor y cliente leen de ahí.
- Si añadiste una actividad: ¿está TODO en `core/activities.py` (no hay una lista nueva
  en ningún otro sitio), pasa `python -m pytest tests/test_activities.py` y subiste
  `APP_VERSION`? Sin lo último, los clientes con el shell precacheado no la ven, que es
  exactamente el síntoma de «el deporte nuevo no sale en el selector».
- Si tocaste `sec/planes.js`: ¿el filtro por estado sigue afectando a la lista **y** al mapa
  (una sola fuente, `visiblePlans()`)? ¿`syncMarkers()` sigue QUITANDO el marcador del plan
  que el filtro deja fuera? ¿marcar como realizada sin conexión sigue encolándose, avisando
  y sobreviviendo a un `unmount()`+`mount()` (la copia local la escribe
  `Store.patchPlanRow`)? ¿la lista vacía por el filtro sigue distinguiéndose de la lista
  vacía de verdad?
- Si tocaste el arranque de un detalle (`mount()` de `sec/detalle.js` o `sec/plan.js`) o
  `netFetch`/`route()`/`plan()` del Store: ¿sigue habiendo tope de tiempo, shimmer y aviso
  con «Reintentar»? Sin el tope, un servidor que acepta y no contesta deja la vista muerta
  sin ningún error (bloque 19 de `tests/e2e_spa.py`; ver «Estado de carga de los dos
  detalles»). Y `skeletonOff()` tiene que llamarse en TODAS las salidas: datos, error,
  «no encontrada», `resetView()` y `unmount()`.
- Si tocaste la escala de pendiente (`SLOPE_*` en `static/shared.js`) o el color de la traza
  o del perfil: `node tests/slope_smoke.js`. Y si has tocado cómo se le pasa el color al
  `Chart`, lee «Rendimiento del hover»: una opción scriptable ahí cuesta 1020 recálculos por
  repintado y deja el hover a 9 fps. Y comprueba las tres que se rompen calladas:
  que todo siga saliendo de `slopeBuckets` (**por distancia, no por índice**: la serie de
  elevación no es uniforme y ese fue el fallo original), que la fuente del mapa siga con
  **`lineMetrics: true`** (sin eso el degradado no se pinta),
  que una ruta **sin elevación** siga saliendo del color de la actividad, y que el perfil no
  vuelva a `segment.borderColor` (deja una costura vertical por punto en el relleno).
- Si tocaste `renderElev/renderSpeed/renderHR` o el mapa en `sec/detalle.js`, o
  `drawElevation()`/`drawTrack()` en `sec/plan.js`: ¿el hover sincronizado sigue funcionando en
  las dos direcciones (mapa→gráficos y gráfico→mapa) **y se apaga al salir del gráfico**? Lo
  segundo es lo que se rompe sin ruido (ver las dos trampas de Chart.js en «Hover sincronizado»).
  Si añades un `Chart` nuevo: `ctx.onmouseleave=...` con asignación directa (no
  `addEventListener`, se acumularían en cada `renderAll()`) y el `onHover` que empiece
  descartando el `mouseout`.
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
