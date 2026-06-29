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
pip install -r requirements.txt
python app.py                      # http://localhost:8080, init_db() automático

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

## Mapa del código

### Backend — blueprints, no monolito
`app.py` es el punto de entrada: registra blueprints y llama a `init_db()` + `refresh_config()`.
La lógica real está repartida en dos paquetes:

```
core/
  config.py     — paths (GPX_DIR, PHOTO_DIR, THUMB_DIR, DB_PATH) y variables Immich
  database.py   — init_db(), close_db(), helper db() (conexión por request vía g.db)
  parsers.py    — analyse_gpx() y analyse_fit() → devuelven (stats, coords, elev, name, creator)
  thumbs.py     — generate_thumb(coords, route_id) → PNG 400px en data/thumbs/
  summaries.py  — auto_summary() y auto_summary_planned()
  exif.py       — extrae lat/lon/taken_at de fotos subidas
  immich.py     — cliente HTTP para Immich (immich_get, immich_search, min_dist_to_track)

api/
  routes.py     — CRUD de rutas + rescan + thumb + stats
  photos.py     — subida y borrado de fotos locales; proxy de fotos Immich
  planned.py    — CRUD de rutas planificadas
  immich_api.py — candidatos Immich, selección, proxy de miniaturas
  settings.py   — lectura/escritura de ajustes (Immich, tipos GPX personalizados)
```

`watch.py` — importador de carpeta. Proceso **independiente**, no parte del server.

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
| `templates/base.html` | — | CSS global, header, toast, helpers JS (`$`, `fmtKm`, `fmtDur`, `fmtDate`, `esc`) |
| `templates/app.html` | `GET /dashboard` · `/rutas` · `/planificacion` | SPA con tres secciones: Dashboard, Mis Rutas, Mis Planes. Usa MapLibre GL para el mapa de visión general. |
| `templates/sendero.html` | `GET /Sendero/<nombre>` | Detalle de ruta: mapa MapLibre GL, stats, perfil de elevación (Chart.js), notas, fotos, modal Immich, lightbox. |
| `templates/plan_detalle.html` | `GET /Plan/<nombre>` | Detalle de ruta planificada: mapa, stats, notas. |
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
| GET | `/api/routes` | lista paginada (incluye `thumb_file`) |
| GET | `/api/routes/geojson` | FeatureCollection de líneas decimadas para el mapa del dashboard (props: id, name, activity, year, km) |
| POST | `/api/routes` | crea ruta desde GPX o FIT; genera thumb |
| GET | `/api/routes/<id>` | dict completo de la ruta |
| PATCH | `/api/routes/<id>` | actualiza name/notes/activity_type/immich_checked |
| DELETE | `/api/routes/<id>` | borra ruta + fotos + GPX + thumb |
| POST | `/api/routes/<id>/rescan` | re-parsea GPX/FIT; regenera thumb |
| GET | `/api/routes/<id>/thumb` | sirve el PNG del track (image/png) |
| GET | `/api/routes/<id>/gpx` | descarga el archivo GPX/FIT original |
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
| GET | `/api/immich/thumb/<asset_id>` | proxy miniatura Immich |

### Helper `_build_route_dict(rid)` en `api/routes.py`
Construye el dict completo de una ruta (geojson, elevation, heart_rate, photos,
auto_summary, thumb_file…). Lo usan `get_route()` (API JSON) y `sendero_page()`
(inyección en template). **Si añades campos al objeto ruta, añádelos aquí.**

### Thumbnails de track (`core/thumbs.py`)
`generate_thumb(coords, route_id)` genera un PNG:
- Fondo `#17241c` (= `--panel`), línea blanca, 400 px de alto, ancho proporcional
  al bounding-box del track (ratio corregido por latitud, acotado 1:4 – 4:1), 40 px
  de padding interior.
- Se llama automáticamente en `create_route` y `rescan_route`; también en el script
  de backfill manual.
- El archivo se guarda en `data/thumbs/thumb_<id>.png` y se referencia en `thumb_file`.
- Al borrar una ruta, se borra también el thumb.
- En `makeCard` de `app.html`: se muestra como elemento absoluto en el lateral derecho
  de la tarjeta con degradado izquierda→transparente para no tapar el texto.

### Estado JS relevante en `sendero.html`
| Variable | Contenido |
|----------|-----------|
| `current` | objeto completo de la ruta (geojson, elevation, heart_rate, photos…) — poblado desde el HTML, sin fetch |
| `photoMarkers` | `{id: marker}` — marcadores MapLibre de fotos con GPS |
| `lbIdx` | índice en `current.photos` de la foto visible en el lightbox |
| `immichCands` / `immichSel` | candidatos de Immich y Set de índices seleccionados |
| `IMMICH` | booleano; activado tras `/api/config`, controla el botón Immich |

### Mapa de visión general en `app.html` (sección Mis Rutas)
Usa **MapLibre GL** (no Leaflet). La fuente GeoJSON se actualiza con `setData()` sin
reconstruir el mapa. Soporta clustering nativo. Los iconos de actividad se cargan
como imágenes PNG en base64 con `map.addImage()`. Al cambiar la capa base se llama a
`getSource('basemap').setTiles(...)`.

### Mapa del dashboard en `app.html` (sección Dashboard)
Segundo mapa MapLibre (`dashMap`) que dibuja **todas las rutas como líneas** (no puntos).
- Fuente: `GET /api/routes/geojson` — FeatureCollection con coordenadas decimadas (1 de cada 4 puntos). Cada feature lleva `activity`, `year` y `km` en `properties`.
- El mapa se inicializa inmediatamente con fuente vacía; las rutas se cargan en paralelo y se añaden con `setData()`. Hay una barra de progreso de 3 px debajo del mapa.
- **Filtros combinados**: `_dashApplyFilters()` aplica un filtro MapLibre `['all', ...]` combinando año (`dashSelectedYear`) y actividades (`dashActiveActs`).
- **Barras de año clicables** (`toggleDashYear(year)`): seleccionar un año atenúa los demás, filtra el mapa y re-renderiza "Por actividad" con datos del año.
- **Filas de actividad clicables** (`toggleDashAct(actId)`): togglean la visibilidad en el mapa.
- **`_refreshActRows()`**: re-renderiza "Por actividad" desde `dashAllFC` (GeoJSON en memoria), respetando el año seleccionado. Se llama tras cargar el GeoJSON y al cambiar el año.
- **`_reloadDashboard()`**: se llama en cada visita al dashboard (no solo la primera) para recargar stats y reintentar el mapa si estaba vacío. Limpia los contenedores dinámicos antes de repoblarlos.
- **TRAMPA**: `dashActiveActs` se inicializa dentro de `initDashMap()` (no en la declaración) porque `ACTIVITIES` se define más abajo en el mismo fichero y causaría ReferenceError.

### Header (`base.html`)
El logo de la cabecera es `static/icon.svg` (La Traza). La carpeta `static/` se copia en el Dockerfile; si añades assets estáticos, asegúrate de que el `COPY static ./static` siga en el Dockerfile.

## Bugs corregidos (no reintroducir)

- **`dashActiveActs` inicializado fuera de orden** — declarar `dashActiveActs=new Set(ACTIVITIES.map(...))` en el `let` del módulo lanza `ReferenceError` porque `ACTIVITIES` se define más abajo. Siempre inicializar dentro de `initDashMap()`.



- **`init_db()` a nivel de módulo** — Gunicorn importa `app:app` sin ejecutar el
  bloque `__main__`; sin `init_db()` al importar falla en el primer request.

- **Especificidad CSS del modal Immich** (`sendero.html`): la regla
  `.overlay.hidden{display:none}` (especificidad doble) debe estar inmediatamente
  después de `.overlay{display:flex}`. Sin ella el modal Immich aparece al cargar.

- **SPA en `app.html`, no en archivos separados** — el antiguo CLAUDE.md decía
  "app multi-página"; ya no es cierto. Editar `rutas.html` no tiene efecto.

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
| created_at | TEXT | |
| activity_type | TEXT | senderismo/bicicleta/caminata/correr/esqui/otros |
| device | TEXT | fabricante/modelo del dispositivo |
| immich_checked | INTEGER | 0/1 |
| start_lat, start_lon | REAL | primer punto del track |
| thumb_file | TEXT | nombre en `data/thumbs/` (PNG) |

### Tabla `photos`
`route_id`, `file` XOR `immich_id`, `original`, `lat`, `lon`, `taken_at`

### Tabla `planned_routes`
`name`, `source`, `source_url`, `activity_type`, `distance_m`, `ascent_m`,
`descent_m`, `ele_min`, `ele_max`, `start_lat`, `start_lon`, `geojson`,
`elevation`, `notes`, `gpx_data` (BLOB), `created_at`

### Tabla `settings`
Clave-valor: `IMMICH_URL`, `IMMICH_API_KEY`, `IMMICH_MARGIN_MIN`, `IMMICH_DIST_M`,
`GPX_TYPE_CUSTOM` (JSON), `stats_cache` (JSON con estadísticas globales).
Los ajustes de settings sobreescriben los de `.env`/variables de entorno.

## Quirks conocidos
- La validación de extensión en `create_route` acepta cualquier nombre que termine en
  `gpx` o `.fit`. No endurezcas sin revisar el watcher.
- No hay autenticación. Intencional para LAN.
- `rutas.html`, `overview.html`, `planificacion.html` — archivos legacy en `templates/`.
  No los borres (pueden servir de referencia) pero no los edites; el app no los usa.

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
