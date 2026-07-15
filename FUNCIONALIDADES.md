# Inventario de funcionalidades — Sendero

> Bitácora autoalojada de rutas de montaña (Flask + SQLite). Sube y visualiza
> GPX/FIT, asocia fotos (locales o de Immich por referencia), edita tracks con
> versionado y planifica rutas. Versión de referencia: **0.4.0**.

Este documento inventaría **todo lo que el usuario puede hacer desde la web** y
**todos los endpoints de la API**. Se divide en dos partes:

- [Parte 1 — Funcionalidades de la web (frontend)](#parte-1--funcionalidades-de-la-web)
- [Parte 2 — API y rutas Flask](#parte-2--api-y-rutas-flask)

Actividades soportadas en toda la app: **Senderismo, Bicicleta, Caminata,
Correr, Esquí, Otros** (cada una con color e icono propio).

---

# Parte 1 — Funcionalidades de la web

La app es un **SPA** servido desde `templates/app.html` para las tres secciones
principales (Dashboard, Mis Rutas, Mis Planes), más páginas de detalle
independientes para rutas, editor y planes.

## 0. Marco común (header + Ajustes)

Presente en todas las pantallas (`base.html`).

**Header / navegación**
- Logo, título "Sendero" y eslogan "Bitácora de montaña".
- Navegación entre **Dashboard**, **Mis rutas** y **Mis Planes** (transición SPA).
- Botón **Ajustes** (modal a pantalla completa).
- Bloque de acciones contextual según la sección activa.
- Responsive (oculta la nav en pantallas estrechas).

**Modal de Ajustes** (cierra con ✕, clic fuera o Escape; muestra la versión):
1. **Immich** — URL del servidor, API Key (con mostrar/ocultar), margen temporal
   (min), distancia de autoselección (m). Botón **Guardar ajustes**.
2. **Ingesta** — tabla editable de mapeos "keyword del GPX → actividad"; añadir /
   eliminar filas; **Guardar mapeos**.
3. **GPS incorrecto** — umbrales por actividad (velocidad máx km/h, ascenso máx
   m/s, altitud máx m); **Guardar umbrales**.
4. **Editor** — URL del servicio DEM (OpenTopoData) y URL del planificador externo
   ("Dibujar ruta nueva"); **Guardar ajustes**.

**Utilidades globales:** notificaciones toast; formateadores de km, duración y
fecha en español.

## 1. Dashboard

Acción de header: **↻ Actualizar** (recalcula estadísticas y recarga el mapa).

- **Tarjetas de totales**: nº de rutas, distancia total, desnivel acumulado ↑,
  tiempo total en movimiento.
- Regeneración de caché de estadísticas en segundo plano sin ocultar el contenido.
- **Por actividad**: filas con color, barra de proporción, km y nº de rutas.
- **Rutas por año**: gráfico de barras verticales con tooltip.
- **Récords personales**: tarjetas clicables (ruta más larga, mayor desnivel ↑,
  velocidad media más alta) que navegan a la ficha correspondiente.
- **Mapa (MapLibre GL, base oscura CartoDB)**: rutas como bolitas/clusters de
  lejos y líneas reales coloreadas por actividad de cerca; clic en cluster hace
  zoom, clic en punto o línea navega a la ficha; controles de zoom y pantalla
  completa; carga progresiva de líneas por área visible.

## 2. Mis Rutas

Acciones de header: conmutador de vista **⊞ Cuadrícula / ▤ Panel**, contador de
rutas y **+ Añadir ruta** (selector de GPX/FIT múltiple).

- **Filtros**: pills de actividad (multiselección), rango de fecha con
  date-pickers personalizados (Desde/Hasta), **✕ Limpiar**. Se persisten en
  sessionStorage.
- **Ordenación**: ↓ Más reciente / ↑ Más antiguo.
- **Modo edición** (botón **✎ Editar**): seleccionar/deseleccionar visibles,
  selección individual y por mes, **↻ Re-escanear (N)**, **Eliminar (N)** (con
  confirmación y loader concurrente), **Cancelar**.
- **Listado**: tarjetas agrupadas por mes, con color e icono de actividad,
  nombre, fecha y miniatura; scroll infinito por lotes; clic → ficha de detalle.
- **Mapa de la sección (MapLibre GL, base Satélite por defecto)**: bolitas/
  clusters con líneas al acercar; selector de capa (Topográfico/Callejero/
  Satélite/Oscuro); botón **⤢ Centrar**; popup al pasar el ratón; clic → ficha.
- **Subida drag & drop** global (solo en esta sección): overlay al arrastrar,
  acepta GPX y FIT múltiples, con resumen de subidas/duplicadas/errores.

## 3. Mis Planes

Acción de header: **+ Planificar ruta** (modal).

- **Modal "Planificar ruta"**: arrastrar/soltar o elegir GPX, **Añadir ruta
  planificada**, **✏ Dibujar ruta nueva ↗** (abre el planificador externo).
- **Mapa de planes (MapLibre GL, base OpenTopoMap)**: marcador por plan con
  icono de actividad; clic → ficha del plan; encuadre automático.
- **Listado**: tarjetas con color e icono, nombre, fecha, badge de origen (GPX),
  distancia y desnivel; clic → ficha.

## 4. Detalle de ruta (`sendero.html`)

- **Acciones**: ← Volver, **✎ Editar**, **↺ Reescanear**, **↓ GPX**, **Renombrar**,
  **Eliminar**.
- **Mapa (MapLibre GL)**: track coloreado por actividad, marcadores Inicio/Fin,
  selector de capa base, **⤢ Centrar**, **Vista 3D/2D** (relieve), marcadores de
  fotos geolocalizadas (clic → lightbox), hover con infobox (km/altitud/
  velocidad/FC).
- **Estadísticas**: actividad (clicable), distancia, desnivel ±, tiempo en
  movimiento, velocidad media, altitud máx, FC media/máx si existen.
- **Gráficas (Chart.js)**: perfil de elevación (con iconos de foto), velocidad y
  frecuencia cardíaca (si hay datos); **hover sincronizado** entre las tres
  gráficas y el mapa.
- **Resumen/notas**: badge y resumen automático, selector de tipo de actividad
  (se abre solo si la ruta no tiene tipo), notas editables + **Guardar resumen**.
- **Fotos**: **⛰ Buscar en Immich** (si está configurado), subida drag & drop,
  galería con badge GPS y borrado por foto.
- **Modal Immich**: búsqueda automática/manual de candidatas, estado (fotos
  durante la ruta y con GPS), filtro "Solo fotos cerca de la ruta",
  autoselección de cercanas, seleccionar todas y **Añadir seleccionadas**.
- **Lightbox**: visor a pantalla completa, navegación ‹/› (y teclado), contador,
  cerrar y **Eliminar foto**.

## 5. Editor de rutas (`editor.html`)

- **Cabecera**: ← Volver (avisa cambios sin guardar), badge de versión,
  **↶ Deshacer** (Ctrl+Z) / **↷ Rehacer** (Ctrl+Y), **💾 Guardar cambios**
  (resumen editable; maneja conflicto de versión 409).
- **Panel Detalles**: editar Nombre y Dispositivo; **Guardar detalles**.
- **Panel Estadísticas** en vivo con deltas respecto al estado cargado.
- **Mapa**: track, marcadores inicio/fin, selector de capa, **⤢ Centrar**.
- **Gráficas** de elevación y velocidad: selección de tramo arrastrando, zoom con
  rueda, doble clic para reset, Shift+arrastre para panear.
- **Modo Seleccionar (tramos A–B)**: manejadores A/B arrastrables; **✂ Recortar
  antes de A**, **✂ Recortar después de B**, **␡ Eliminar tramo A–B**, **⇆ Invertir
  ruta**, **✄ Dividir ruta en A…**, **✕ Quitar selección**.
- **Modo Editar puntos**: arrastrar vértice (mover), Alt+clic (eliminar), clic en
  la línea (insertar), Shift+clic (añadir **waypoint** ⚑ con renombrar/eliminar).
- **Herramientas de corrección** (con slider y preview): **⌇ Simplificar** (Douglas-
  Peucker), **⛰ Corregir picos de elevación**, **⚡ Corregir velocidad excesiva**,
  **🕐 Desplazar tiempos**, **⛓ Unir con otra ruta**, **🏔 Recalcular elevación
  (DEM)** (si hay servicio configurado).
- **Panel Avisos GPS**: lista de tramos problemáticos (velocidad/altitud/
  elevación) con bandas rojas en gráficas y overlay en el mapa; **Corregir** por
  aviso (zoom + herramienta) y **✔ Corregir todo**.
- **Panel Historial de versiones**: lista con resumen/km/desnivel/fecha, marca la
  actual, **↓** descargar GPX de cada versión, **Restaurar** (crea versión nueva).

## 6. Detalle de plan (`plan_detalle.html`)

- **Acciones**: ← Planificación, badge de origen (GPX/Wikiloc), **⬇ Descargar
  GPX**, **Renombrar**, **Eliminar**.
- **Mapa (Leaflet)**: track con marcadores Inicio/Final, selector de capas,
  **⊡ Centrar**.
- **Estadísticas**: distancia, desnivel ↑/↓, altitud máx/mín.
- **Perfil de elevación (Chart.js)** con tooltip.
- **Resumen/actividad**: badge clicable → selector de tipo, resumen automático,
  notas + **Guardar notas**.
- **Fuente**: enlace a la página original si el plan viene de Wikiloc.

---

# Parte 2 — API y rutas Flask

**44 rutas** en total: **7 páginas HTML** + **37 endpoints API**, repartidas en 6
blueprints. `app.py` registra los blueprints (sin `url_prefix`), fija
`MAX_CONTENT_LENGTH = 200 MB`, inyecta `app_version` en las plantillas y ejecuta
`refresh_config()` en cada `before_request` (consistencia entre workers).

## Páginas HTML

| Método | URL | Handler | Descripción |
|--------|-----|---------|-------------|
| GET | `/` | `routes.index` | Redirige (302) a `/dashboard` |
| GET | `/dashboard` | `routes.stats_page` | SPA sección Dashboard |
| GET | `/rutas` | `routes.dashboard` | SPA sección Mis Rutas |
| GET | `/Sendero/<path:name>` | `routes.sendero_page` | Detalle de ruta (inyecta `route_json`) |
| GET | `/Sendero/<path:name>/editor` | `editor.editor_page` | Editor de ruta |
| GET | `/planificacion` | `planned.planificacion_page` | SPA sección Mis Planes |
| GET | `/Plan/<path:name>` | `planned.plan_detalle_page` | Detalle de plan (inyecta `plan_json`) |

Flask sirve además `static/` de forma implícita (`/static/<path:filename>`).

## `routes_bp` — `api/routes.py` (rutas + estadísticas)

| Método | URL | Descripción / parámetros |
|--------|-----|--------------------------|
| GET | `/api/stats` | Estadísticas globales cacheadas (totales, `by_type`, `by_year`, `records`); `dirty:true` si la caché está sucia |
| POST | `/api/stats/refresh` | Fuerza el recálculo de estadísticas → `{ok:true}` |
| GET | `/api/routes` | Lista paginada. Query: `limit`, `offset`. → `{items, total}` |
| POST | `/api/routes` | Crea ruta desde `gpx` (GPX/FIT, multipart) + `name` opcional; genera thumb y anomalías GPS. 400/409 (`duplicate`). → `{id}` 201 |
| GET | `/api/routes/geojson` | FeatureCollection de líneas decimadas. Query opcional `bbox=minLon,minLat,maxLon,maxLat`. Props: `id,name,activity,year,km` |
| GET | `/api/routes/by-name/<path:name>` | Dict completo de la ruta más reciente con ese nombre. 404 |
| GET | `/api/routes/<int:rid>` | Dict completo (`_build_route_dict`): geojson, elevation, heart_rate, speed, gps_issues, photos, auto_summary, version… 404 |
| PATCH | `/api/routes/<int:rid>` | Actualiza `name`/`notes`/`activity_type`/`immich_checked`/`device`. 400 si nada. → 204 |
| DELETE | `/api/routes/<int:rid>` | Borra ruta + fotos + GPX + thumb + versiones. → 204 |
| POST | `/api/routes/<int:rid>/rescan` | Re-parsea el archivo activo y actualiza toda la fila + thumb. → dict completo |
| GET | `/api/routes/<int:rid>/thumb` | PNG del track (`image/png`). 404 |
| GET | `/api/routes/<int:rid>/gpx` | Archivo GPX/FIT original. Query `download` (≠"0" fuerza adjunto). 404 |

## `editor_bp` — `api/editor.py` (edición + versionado)

| Método | URL | Descripción / parámetros |
|--------|-----|--------------------------|
| GET | `/api/routes/<int:rid>/points` | Puntos completos 1:1 con trkpt + `version` + `source`. 400/404 |
| POST | `/api/routes/<int:rid>/edit` | Guarda edición: body `{ops, base_version, summary}`. 400 / 409 (`version_conflict`) / 404. → dict completo |
| POST | `/api/routes/<int:rid>/split` | Divide en `index` (body `{index, name_b, base_version}`): original recortada + ruta nueva. → dict + `b_id`, `b_name` |
| POST | `/api/routes/merge` | Une rutas en una NUEVA (body `{ids[≥2], name}`); originales intactas. → `{id, name, times_kept}` 201 |
| POST | `/api/routes/<int:rid>/elevation-dem` | Recalcula elevación contra DEM (body `{base_version}`). 400 (sin DEM) / 409 / 404 / 502. → dict completo |
| GET | `/api/routes/<int:rid>/versions` | Historial descendente → `{current, items}` |
| POST | `/api/routes/<int:rid>/versions/<int:vn>/restore` | Restaura `vn` como versión nueva. 400 (ya actual) / 404 |
| GET | `/api/routes/<int:rid>/versions/<int:vn>/gpx` | Descarga el archivo de esa versión (adjunto). 404 |

## `photos_bp` — `api/photos.py` (fotos)

| Método | URL | Descripción / parámetros |
|--------|-----|--------------------------|
| POST | `/api/routes/<int:rid>/photos` | Sube fotos locales (campo `photos`, multipart); lee EXIF. → `{added:[ids]}` 201 |
| GET | `/api/photos/<int:pid>/file` | Sirve foto local o proxy Immich. Query `size` (def. `preview`). 404 / 502 |
| DELETE | `/api/photos/<int:pid>` | Borra la foto (disco si es local) y su fila. → 204 |

## `planned_bp` — `api/planned.py` (rutas planificadas)

| Método | URL | Descripción / parámetros |
|--------|-----|--------------------------|
| GET | `/api/planned` | Lista paginada. Query `limit`, `offset`. → `{items, total}` |
| POST | `/api/planned` | Crea plan desde `gpx` (solo .gpx, multipart) + `name` opcional. 400. → `{id, name}` 201 |
| GET | `/api/planned/<int:pid>` | Dict del plan (geojson, elevation, has_gpx, auto_summary). 404 |
| PATCH | `/api/planned/<int:pid>` | Actualiza `name`/`notes`/`activity_type`. 400 si nada. → 204 |
| DELETE | `/api/planned/<int:pid>` | Borra el plan. → 204 |
| GET | `/api/planned/<int:pid>/gpx` | Descarga el GPX almacenado (adjunto). 404 |

## `immich_bp` — `api/immich_api.py` (Immich + config pública)

| Método | URL | Descripción / parámetros |
|--------|-----|--------------------------|
| GET | `/api/config` | Config pública: `version`, `immich` (bool), `immich_margin_min`, `immich_dist_m` |
| GET | `/api/routes/<int:rid>/immich/candidates` | Fotos Immich en la ventana temporal del track, con `dist_m`. 400 / 404 / 502. → `{window, candidates}` |
| POST | `/api/routes/<int:rid>/immich/select` | Asocia por referencia (body `{items:[{immich_id,lat,lon,taken_at}]}`). 400 / 404. → `{added}` 201 |
| GET | `/api/immich/thumb/<asset_id>` | Proxy de miniatura Immich. Query `size` (def. `thumbnail`). 404 / 502 |

## `settings_bp` — `api/settings.py` (ajustes)

| Método | URL | Descripción / parámetros |
|--------|-----|--------------------------|
| GET | `/api/settings` | Ajustes actuales: `IMMICH_URL`, `IMMICH_API_KEY`, `IMMICH_MARGIN_MIN`, `IMMICH_DIST_M`, `DEM_URL`, `PLANNER_URL` |
| POST | `/api/settings` | Guarda claves de ajustes (JSON) y refresca config. → 204 |
| GET | `/api/settings/gps-thresholds` | Umbrales GPS efectivos por actividad (custom con fallback a defaults) |
| POST | `/api/settings/gps-thresholds` | Guarda umbrales por actividad. 400 si inválido. → 204 |
| GET | `/api/settings/gpx-types` | Mapeo personalizado de tipos GPX → actividad |
| POST | `/api/settings/gpx-types` | Guarda el mapeo de tipos GPX. 400 si no es objeto. → 204 |

---

## Notas transversales

- **Sin autenticación** (intencional para LAN).
- **Persistencia** solo en `/data`: `sendero.db`, `gpx/`, `photos/`, `thumbs/`.
- **Fotos**: una foto es local (`file`) **o** de Immich (`immich_id`, por
  referencia), nunca ambas.
- **Cruce con Immich** por tiempo: requiere `started_at` no NULL (400 si falta).
  El filtro de cercanía nunca excluye fotos sin GPS.
- **Versionado del editor** (append-only): el archivo activo siempre es la versión
  más alta; restaurar crea una versión nueva; concurrencia protegida con
  `base_version` (409).
