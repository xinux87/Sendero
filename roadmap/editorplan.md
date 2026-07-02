# Plan de implementación: Editor de rutas GPX para Sendero

> **Estado: Fases 1 y 2 IMPLEMENTADAS** (F1: 2026-07-01 · F2: 2026-07-02).
> F1: backend (`core/editing.py`, `api/editor.py`, tabla `route_versions`) +
> frontend (`templates/editor.html`) + smoke test §8 pasado. Además: perfil de
> velocidad en el editor, zoom/paneo en las gráficas, deselección al hacer click
> fuera de la línea.
> F2: ops `move_point`/`insert_point`/`delete_points`/`set_ele` (paridad
> cliente/servidor verificada), modo "Editar puntos" (arrastrar/insertar/borrar
> vértices), simplificación Douglas-Peucker con ghost preview, corrección de
> picos de elevación con preview en el perfil, `POST /api/routes/<id>/split`
> (dividir ruta en dos), y corrección de velocidad excesiva (saltos de GPS →
> `delete_points`, umbral inicial de Ajustes → "GPS incorrecto" por actividad).
> **Fase 3 IMPLEMENTADA** (2026-07-02): ops `shift_time` + waypoints
> (`wpt_add/move/rename/del`, Shift+click añade, popup ⚑ edita), unir rutas
> (`POST /api/routes/merge`, cronológico, tiempos descartados si solapan),
> elevación DEM (`POST /elevation-dem` + `DEM_URL` en Ajustes → Editor +
> servicio OpenTopoData comentado en docker-compose), y la integración
> `gps_issues`: se calculan en create/rescan/guardado, el editor los premarca
> (panel "⚠ Avisos GPS", bandas rojas en gráficas, tramos rojos en mapa) y
> "Corregir" abre la herramienta adecuada con zoom al tramo. Ampliaciones
> posteriores: botón "✔ Corregir todo" (interpola regiones de elevación/altitud
> fusionadas y elimina saltos de velocidad en 2 ops deshacibles), umbral de
> altitud máxima (`max_ele_m`, tipo de aviso `altitude`, funciona sin
> timestamps), y panel Ajustes → "GPS incorrecto" para editar los umbrales por
> actividad (`GET/POST /api/settings/gps-thresholds`). Fixes: conservar la
> actividad asignada cuando la re-detección no da nada (los umbrales dependen
> de ella) y `refresh_config()` por request (consistencia entre workers).
> Fase 4 pendiente.

> Documento autocontenido para implementar el editor. **Lee primero `CLAUDE.md` en la raíz
> del repo**: contiene las reglas duras del proyecto (sin build step, migraciones
> defensivas, UI en español, persistencia solo en `/data`, etc.). Si algo de aquí
> contradice a CLAUDE.md, CLAUDE.md manda en lo relativo a reglas del proyecto;
> este documento manda en lo relativo al diseño del editor.

## 0. Contexto y objetivo

Sendero es un monolito Flask + SQLite que visualiza rutas GPX/FIT, pero no permite
modificarlas: ruido GPS al inicio/fin, tramos grabados por error o rutas invertidas
obligan a editar el archivo fuera de la app. Se añade un **editor de rutas profesional**,
accesible con un botón "✎ Editar" desde el detalle de ruta (`/Sendero/<nombre>`,
`templates/sendero.html`), implementado **por fases**. La **Fase 1 es la que hay que
implementar**; las fases 2–4 son roadmap y NO deben implementarse todavía, pero el
diseño de la F1 (pipeline de operaciones) debe dejarlas posibles.

**Decisiones ya tomadas (no reabrir):**
- **Versionado completo**: cada guardado crea una versión navegable (v1, v2, …);
  historial visible, cualquier versión restaurable y descargable.
- **Página dedicada**: el editor vive en `templates/editor.html`, no como modo dentro
  de `sendero.html`.

## 1. Principio central de arquitectura

**El cliente NUNCA envía coordenadas al guardar: envía una lista ordenada de
OPERACIONES sobre índices de punto.** Motivo: el parser actual (`core/parsers.py`,
`analyse_gpx()` L117-200) no extrae timestamps por punto — solo `started_at` y
duraciones — y el HR va en extensiones XML por punto. Si el cliente reconstruyera el
GPX desde su `geojson`, se destruirían timestamps, pulsaciones y cualquier extensión.

En su lugar, el servidor:
1. Re-parsea el GPX original con `gpxpy` (ya en `requirements.txt`, v1.6.2).
2. Aplica las operaciones sobre los objetos `GPXTrackPoint` reales (que conservan
   `time`, `extensions` y atributos desconocidos).
3. Serializa con `gpx.to_xml()` y reescribe el archivo activo de forma atómica.

El mapeo índice-cliente ↔ trkpt-servidor es determinista porque ambos aplanan con el
mismo triple bucle `gpx.tracks → track.segments → seg.points` (el mismo orden que usa
`analyse_gpx` para construir `coords`, que es la lista COMPLETA 1:1 con los trkpt, sin
decimar — y es lo que se guarda en la columna `geojson`).

Un token de concurrencia `base_version` en el POST de guardado detecta que el archivo
cambió entre abrir el editor y guardar (→ 409).

## 2. Modelo de versionado

### Almacenamiento
**Archivos en `data/gpx/versions/<route_id>/v<N>.<ext>`** + tabla de metadatos.
NO usar BLOBs: un historial acumulativo de GPX de 100-500 KB engordaría `sendero.db`
(el proyecto ya sufrió la patología de blobs grandes en SQLite, ver CLAUDE.md regla 12),
y los archivos inmutables funcionan mejor con backups incrementales del volumen `/data`.
Subdirectorio por `route_id` (no por nombre): sobrevive a renombrados y queda fuera del
alcance de la validación de colisión de nombres de `create_route` (que solo mira
`data/gpx/<nombre>` plano).

### Migración (en `core/database.py::init_db()`)
```sql
CREATE TABLE IF NOT EXISTS route_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id   INTEGER NOT NULL,
    version_n  INTEGER NOT NULL,
    file       TEXT NOT NULL,      -- 'v1.gpx' o 'v1.fit', relativo a data/gpx/versions/<route_id>/
    summary    TEXT DEFAULT '',    -- en español: "Recortados 234 puntos del inicio"
    distance_m REAL, ascent_m REAL, n_points INTEGER,
    created_at TEXT,
    UNIQUE(route_id, version_n)
);
CREATE INDEX IF NOT EXISTS idx_route_versions_route
    ON route_versions(route_id, version_n DESC, summary, distance_m, ascent_m,
                      n_points, created_at, file);
```
Solo `CREATE ... IF NOT EXISTS` → inherentemente re-ejecutable por los 2 workers de
gunicorn en paralelo (regla 13 de CLAUDE.md, no necesita try/except). El índice cubre
exactamente lo que lee el panel de historial (regla 12).

**NO añadir columna `version` a `routes`**: se deriva con
`SELECT MAX(version_n) FROM route_versions WHERE route_id=?` (indexado) y se añade como
campo `version` en `_build_route_dict()` (`api/routes.py`). Recuerda: `/api/routes/<id>`
y `/Sendero/<nombre>` deben devolver los mismos campos (checklist de CLAUDE.md).

En `core/config.py`: añadir `VERSIONS_DIR = GPX_DIR / "versions"` al bloque de paths
(y crearlo con `mkdir(parents=True, exist_ok=True)` donde se crean los demás).

### Semántica (append-only, estilo git)

**Invariante: el archivo activo en `data/gpx/` es SIEMPRE idéntico a la versión más alta.**

- Ruta nunca editada → **0 filas** en `route_versions` (versión efectiva 0). Cero
  migración de datos para las rutas existentes.
- **Primer guardado**: antes de tocar nada, se archiva el archivo activo byte a byte
  como **v1** con summary `"Archivo original"`. Después se escribe el resultado editado
  como activo y se archiva como **v2** con el resumen del usuario.
- **Guardados siguientes**: el nuevo estado se archiva como v(n+1).
- **Restaurar la versión k** NO borra versiones posteriores: copia vk sobre el activo y
  crea **v(n+1)** con summary `"Restaurada la versión k"`. Historial lineal, sin ramas.
- **Caso FIT**: los .fit no se reescriben. En el primer guardado de una ruta `.fit`,
  materializar un GPX con gpxpy: trkpt con `time`, `elevation` y HR en extensión
  `gpxtpx:TrackPointExtension` (formato Garmin — es el que ya lee
  `_hr_from_extensions()` en `core/parsers.py` L85-97, garantizando round-trip).
  El FIT original se archiva como **v1** (`v1.fit`); el GPX editado se escribe como
  `data/gpx/<stem>.gpx` (MISMO stem → el thumbnail `<stem>.png` no cambia de nombre);
  se actualiza `routes.gpx_file`; el `.fit` viejo se borra de `data/gpx/` (está a salvo
  como v1). Si `<stem>.gpx` ya existiera, usar `<stem>_editado.gpx`. Restaurar v1
  devuelve el `.fit` como activo y repone `gpx_file`.
- El GPX activo **conserva su nombre** entre versiones → no se rompen ni los thumbnails
  (`core/thumbs.py` los nombra `<stem_del_gpx>.png`) ni la validación 409 de duplicados.

### Interacciones
- `delete_route()` (`api/routes.py`): añadir `DELETE FROM route_versions WHERE route_id=?`
  y `shutil.rmtree(cfg.VERSIONS_DIR / str(rid), ignore_errors=True)`.
- `rescan_route()`: sin cambios de semántica — re-lee el activo, que por invariante es
  la última versión.
- El watcher (`watch.py`) solo crea rutas nuevas → sin interacción.

## 3. Backend Fase 1

### Nuevos archivos
- `core/editing.py` — lógica pura de edición (sin Flask).
- `api/editor.py` — blueprint `editor_bp` con página + API; registrarlo en `app.py`
  junto a los demás blueprints.

### Refactor previo en `api/routes.py`
Extraer el cuerpo de `rescan_route()` a un helper reutilizable:
```python
def _reanalyse_and_update(con, rid, row):
    """Re-parsea el archivo activo y actualiza la fila completa
    (stats, geojson, elevation, heart_rate, speed, bbox, thumb, stats_dirty).
    row necesita name y gpx_file. Devuelve None o (respuesta_error, status)."""
```
`rescan_route()` queda como envoltorio fino. El editor lo importa junto a
`_build_route_dict`. OJO: la fila de `routes` incluye ahora también el perfil `speed`
(columna reciente) — el helper debe cubrir todo lo que hoy actualiza `rescan_route`,
no una lista congelada; copia el UPDATE tal cual esté en el código actual.

### `core/editing.py`
- `extract_points(raw, is_fit)` → dict con arrays paralelos 1:1 con los trkpt aplanados:
  `lonlat` (lista `[lon,lat]`), `ele`, `time` (ISO o null), `hr`, `segments` (lista de
  rangos inclusivos `[ini, fin]` de índices por segmento), `n`. Iterar EXACTAMENTE en el
  orden de `analyse_gpx`. Si un array está vacío para TODOS los puntos, devolverlo como
  `None` (para no serializar 50k nulls).
- `apply_ops(gpx, ops)` → aplica la secuencia de ops y devuelve el XML:
  1. Construir `flat = [(ti, si, pi), ...]` con referencias a los trkpt en orden de aplanado.
  2. Aplicar cada op sobre esa lista (borrar slice / invertir), validando en cada paso:
     índices en rango, `start <= end`, y ≥2 puntos supervivientes al final
     (si no → `ValueError` con mensaje en español, el endpoint lo convierte en 400).
  3. Reconstruir los tracks del objeto gpxpy REUTILIZANDO los objetos `GPXTrackPoint`
     originales, respetando los cortes de segmento originales MÁS los nuevos cortes:
     un `delete_range` interior a un segmento lo **parte en dos** (no se fabrica
     distancia en línea recta sobre el hueco; `get_moving_data()` lo trata como pausa,
     y el perfil de `analyse_gpx` ya reinicia distancia por segmento).
  4. Para `reverse`: invertir orden de segmentos y de puntos dentro de cada uno, y poner
     `p.time = None` en TODOS los puntos (timestamps descendentes serían inválidos;
     conservar `ele` y extensiones HR). `started_at` pasará a NULL al re-analizar.
  5. `return gpx.to_xml()`.
- `fit_to_gpx(raw)` — materialización FIT→GPX descrita en §2.
- `generate_summary(ops)` — resumen autogenerado en español a partir de las ops
  (p. ej. `"Recortados 234 puntos del inicio · Invertida la ruta"`).

### Operaciones de la Fase 1 (2 primitivas)

| op | params | semántica |
|---|---|---|
| `delete_range` | `start`, `end` (índices aplanados inclusivos **del estado en ese momento de la secuencia**) | elimina los puntos; parte el segmento si el rango es interior |
| `reverse` | — | invierte la ruta; **elimina todos los `<time>`** (el frontend avisa antes con confirm) |

Las ops se aplican **secuencialmente**: los índices de cada op se refieren al estado
resultante de las anteriores, exactamente como las registró el cliente. Cliente y
servidor ejecutan literalmente el mismo programa.

La toolbar del cliente ofrece 4 acciones, pero 3 compilan a `delete_range`
(recortar-antes-de-A / recortar-después-de-B / eliminar-tramo-A–B).

### Endpoints (`api/editor.py`)

| Método | URL | Descripción |
|---|---|---|
| GET | `/Sendero/<path:name>/editor` | Página. Mismo lookup por nombre que `sendero_page()`. Inyecta `route_json` **ligero** (id, name, gpx_file, distance_m, ascent_m, descent_m, started_at, activity_type, version) — los puntos van por API. Ruta inexistente → redirect `/rutas`. |
| GET | `/api/routes/<int:rid>/points` | Re-parsea el activo con `extract_points`. Respuesta: `{version, source: "gpx"\|"fit", n, segments, lonlat, ele, time, hr}`. Errores: 404 ruta/archivo; 400 `"Archivo ilegible: …"`; 400 `"Este archivo no contiene tracks editables"` si solo hay `<rte>`/`<wpt>`. |
| POST | `/api/routes/<int:rid>/edit` | Guardar. Body: `{base_version, summary, ops: [...]}`. Flujo abajo. |
| GET | `/api/routes/<int:rid>/versions` | `{current, items: [{version_n, summary, distance_m, ascent_m, n_points, created_at, file_ext}]}` orden desc. 200 con `items: []` si nunca editada. |
| POST | `/api/routes/<int:rid>/versions/<int:vn>/restore` | 404 si no existe; 400 `"Ya es la versión actual"` si `vn == MAX`. Copia atómica sobre el activo (maneja cambio de extensión si vn es el `.fit` v1), crea v(n+1) `"Restaurada la versión <vn>"`, re-analiza, devuelve `_build_route_dict(rid)`. |
| GET | `/api/routes/<int:rid>/versions/<int:vn>/gpx` | Descarga `Content-Disposition: attachment; filename="<nombre_saneado>_v<vn>.<ext>"` (mismo saneo regex que `download_route_gpx`). |

**Flujo de `POST /edit`** (una sola transacción para lo SQL):
1. `SELECT` fila → 404. Leer archivo activo → 404 `"Archivo original no encontrado"`.
2. Validar payload (ops lista no vacía, formato conocido) → 400.
3. Concurrencia: `cur_v = MAX(version_n) or 0`; si `base_version != cur_v` →
   **409** `{"error": "La ruta ha cambiado desde que abriste el editor. Recarga para continuar.", "code": "version_conflict"}`.
4. Parsear: `.fit` → `fit_to_gpx(raw)`; `.gpx` → `gpxpy.parse(...)`.
5. Si `cur_v == 0`: archivar los bytes originales como `versions/<rid>/v1.<ext>` +
   INSERT v1 `"Archivo original"` (stats ligeras copiadas de la fila actual).
6. `xml = apply_ops(gpx, ops)` → 400 si la validación falla.
7. **Escritura atómica** del activo: escribir a `data/gpx/<activo>.tmp` y `os.replace()`
   (mismo directorio ⇒ rename atómico). Caso FIT: escribir `<stem>.gpx` igual,
   `UPDATE routes SET gpx_file=?`, borrar el `.fit` viejo.
8. `_reanalyse_and_update(con, rid, row)` (actualiza stats/geojson/thumb/stats_dirty).
9. Copiar el nuevo activo a `versions/<rid>/v<sig>.gpx` + INSERT con `summary`
   (si viene vacío, `generate_summary(ops)`) y stats ligeras del re-análisis.
10. `return jsonify(_build_route_dict(rid))` — incluye el `version` nuevo.

El orden garantiza que **jamás se pierde el original** (v1 se archiva antes de la
primera escritura). Peor caso ante crash a mitad: un archivo de versión huérfano en
disco, inofensivo. Todos los errores con `{"error": "…en español"}`.

## 4. Frontend Fase 1 — `templates/editor.html`

`{% extends "base.html" %}`, MapLibre GL 4.7.1 + Chart.js 4.4.1 por CDN en el bloque
`head_libs` (mismas versiones que `sendero.html`). **Todo el JS inline, sin build step,
sin frameworks.** UI íntegra en español. Paleta existente (`var(--panel)`, `var(--line)`,
`--pr-yellow`, `--gr-red`); paneles como los `.section` de `sendero.html`.

### Acceso
En `templates/sendero.html`, barra de acciones (junto a "↺ Reescanear"):
```html
<button class="btn ghost sm" onclick="location.href='/Sendero/'+encodeURIComponent(current.name)+'/editor'">✎ Editar</button>
```

### Layout (grid `1fr 300px`, columna única en `@media(max-width:900px)`)
```
┌──────────────────────────────────────────────────────────────┐
│ ← Volver · NOMBRE · [v3]        ↶ Deshacer ↷ Rehacer  [💾 Guardar] │
├───────────────────────────────────┬──────────────────────────┤
│  #edmap (mapa, ~55vh)             │ ESTADÍSTICAS (aprox.)    │
│                                   │  12,40 km · +820 m ·     │
│                                   │  14 832 pts (y deltas)   │
│                                   ├──────────────────────────┤
│                                   │ OPERACIONES              │
│                                   │ ✂ Recortar antes de A    │
│                                   │ ✂ Recortar después de B  │
│                                   │ ␡ Eliminar tramo A–B     │
│                                   │ ⇆ Invertir ruta          │
│                                   │ ✕ Quitar selección       │
├───────────────────────────────────┼──────────────────────────┤
│  #edelev (perfil arrastrable)     │ HISTORIAL DE VERSIONES   │
│                                   │ v3 · hoy · «resumen»     │
│                                   │    [↓] [Restaurar]       │
└───────────────────────────────────┴──────────────────────────┘
```

### Estado JS
```js
let P = null;              // respuesta de /points {lonlat, ele, time, hr, segments, version, n}
let idxMap;                // Int32Array: índices ORIGINALES vivos, en orden actual
let undoStack=[], redoStack=[];  // snapshots {idxMap, reversed}
let opsList = [];          // ops acumuladas desde el último guardado (lo que se envía)
let selA=null, selB=null;  // índices del ESTADO ACTUAL (posiciones en idxMap)
let handleA, handleB;      // maplibregl.Marker draggables
let cumKm;                 // Float64Array de distancias acumuladas del estado actual
```
**Undo/redo por snapshots de `idxMap`** (Int32Array, ~200 KB por op con 50k puntos —
despreciable), NO por replay de ops (O(ops×n) y propenso a off-by-one). `opsList` se
mantiene en paralelo: push al operar, pop al deshacer, re-push al rehacer. Cada op se
registra con los índices del estado en que se ejecutó — la misma semántica secuencial
que reproduce el servidor.

`applyState()` tras cada cambio: recomputar el array de coords actual, `cumKm`
(haversine, copiar la función de `sendero.html`), stats preview, datos del chart,
marcadores Inicio/Fin, y limpiar selección.

### Mapa
- source `ruta` / layer `ruta-linea`: línea del estado actual, color de la actividad,
  opacidad 0.9 (bajar a 0.45 cuando hay selección activa para que el tramo resalte).
- source `sel` / layer `sel-linea`: el tramo seleccionado, `#e8c44a`, width 6.
- Marcadores Inicio/Fin no draggables (como en `sendero.html`), fondo topográfico y
  controles reutilizados de `renderMap()` de `sendero.html`.
- **Manejadores A y B**: `new maplibregl.Marker({draggable:true})`, A amarillo
  (`--pr-yellow`) y B rojo. Nacen ocultos; **click en la línea** coloca A y luego B en
  el punto del track más cercano al click. Snap durante `drag` (throttled con
  `requestAnimationFrame`) y en `dragend`:
```js
function nearestIdx(lon, lat){   // escaneo lineal con aprox. equirectangular; <1 ms con 50k pts
  const cos0 = Math.cos(lat*Math.PI/180);
  let bi=0, bd=Infinity;
  for(let i=0;i<cur.length;i++){
    const dx=(cur[i][0]-lon)*cos0, dy=cur[i][1]-lat, d=dx*dx+dy*dy;
    if(d<bd){bd=d;bi=i;}
  }
  return bi;
}
```
  El marker se re-ancla con `setLngLat(cur[idx])` (snap visual continuo) y se actualiza
  `sel-linea` + la banda del perfil en vivo.

### Perfil de elevación interactivo (`#edelev`, Chart.js)
- Dataset línea `{x: cumKm[i]/1000, y: ele[idxMap[i]]}` con la estética de
  `renderElev()` de `sendero.html`. Si el estado tiene >3000 puntos, **decimar solo
  para pintar** manteniendo un `chartIdx[]` que mapea punto-pintado → índice real.
- **Selección por arrastre** sobre el canvas (`mousedown/mousemove/mouseup` +
  `touchstart/...`): píxel→km con `chart.scales.x.getValueForPixel(px)`, km→índice con
  búsqueda binaria en `cumKm`. Plugin `afterDraw` pinta la banda seleccionada
  (`fillRect` `rgba(232,196,74,.18)` + bordes verticales amarillos).
- **Sincronía bidireccional**: arrastrar en el perfil mueve A/B en el mapa; arrastrar
  A/B repinta la banda. Única fuente de verdad: `selA/selB`.

### Operaciones y controles
| Botón | habilitado si | compila a |
|---|---|---|
| ✂ Recortar antes de A | `selA != null && selA > 0` | `{op:'delete_range', start:0, end:selA-1}` |
| ✂ Recortar después de B | `selB != null && selB < n-1` | `{op:'delete_range', start:selB+1, end:n-1}` |
| ␡ Eliminar tramo A–B | ambos != null | `{op:'delete_range', start:min, end:max}` |
| ⇆ Invertir ruta | siempre | `{op:'reverse'}` — si `P.time` existe, `confirm("Invertir la ruta eliminará las marcas de tiempo de los puntos. ¿Continuar?")` |

`doOp(op)`: push snapshot a `undoStack`, vaciar `redoStack`, mutar `idxMap`, push a
`opsList`, `applyState()`. Atajos: `Ctrl+Z` / `Ctrl+Y`, `Escape` limpia la selección.

Stats preview en cliente: distancia haversine 2D (etiquetada "aprox." — el servidor
recalcula el valor exacto al guardar), desnivel ± con umbral de ruido ±2 m, nº de
puntos, y deltas respecto al original (p. ej. `−3,2 km`).

### Guardar
Botón primario (deshabilitado si `opsList.length === 0`). Modal con input de resumen
prellenado con el autogenerado. **OJO al bug documentado en CLAUDE.md**: la regla CSS
`.overlay.hidden{display:none}` debe ir inmediatamente después de `.overlay{display:flex}`.
POST a `/edit` con `base_version: P.version`:
- **200**: `toast("Guardado como versión v"+d.version)`, refetch de `/points`, reset de
  pilas y `opsList`, recargar panel de versiones, y marcar la caché de listado como
  sucia (mismo mecanismo que usa `sendero.html` tras renombrar/re-escanear: revisa cómo
  invalida `sessionStorage` y replica) — las tarjetas de "Mis Rutas" cambian de stats.
- **409**: toast del error + botón "Recargar editor".
- Otros: toast del `error`, estado local intacto.

### Panel de versiones
`GET /versions` al cargar y tras cada guardado. Fila:
`v3 · 12,40 km · +820 m · 01/07/2026 · «resumen»` + botones `↓` (descarga) y
`Restaurar` (oculto en la versión actual; con `confirm`, y si hay cambios locales sin
guardar avisa que se descartan). Tras restaurar: refetch `/points`, reset, toast.

### Salir sin guardar
`beforeunload` con `preventDefault` si `opsList.length`, y el botón "← Volver" pide
`confirm("Hay cambios sin guardar. ¿Salir de todas formas?")`.

## 5. Orden de implementación de la Fase 1

1. `core/config.py`: `VERSIONS_DIR`.
2. `core/database.py`: tabla + índice en `init_db()`.
3. `core/editing.py`: `extract_points`, `apply_ops`, `fit_to_gpx`, `generate_summary`.
4. `api/routes.py`: refactor `_reanalyse_and_update()`, limpieza de versiones en
   `delete_route()`, campo `version` en `_build_route_dict()`.
5. `api/editor.py`: los 6 endpoints; registrar `editor_bp` en `app.py`.
6. Smoke test por curl (§8) — ANTES de tocar frontend.
7. `templates/editor.html` + botón "✎ Editar" en `sendero.html`.
8. Actualizar `CLAUDE.md`: rutas nuevas, tabla `route_versions`, invariante
   "activo == última versión", campo `version` en `_build_route_dict`.

## 6. Roadmap fases 2–4 (NO implementar ahora)

### Fase 2 — Edición fina de geometría (~1,5× esfuerzo F1)
Extiende el pipeline de ops con `move_point{i,lon,lat[,ele]}`, `insert_point{after,lon,lat}`
(sin time o interpolado), `delete_points{indices}`, `set_ele{items:[[i,e],…]}`.
- Vértices arrastrables: capa `circle` visible a zoom ≥15, drag con feature-state;
  insertar punto con click en la línea; borrar con Alt+click.
- Simplificación Douglas-Peucker en JS (~40 líneas) con slider de tolerancia (m),
  capa fantasma comparativa y contador antes/después; al aplicar compila a `delete_points`.
- Corrección de picos de elevación: detección de deltas anómalos, preview en el perfil,
  corrección por interpolación → `set_ele`.
- Dividir ruta en dos: `POST /api/routes/<id>/split {index, name_b}` server-side —
  crea ruta nueva con la segunda mitad y recorta la original como versión nueva.
  Las fotos asociadas se quedan en la original (decisión F2).

### Fase 3 — Operaciones entre rutas y datos externos (~2× F1)
- Unir rutas: `POST /api/routes/merge {ids, keep_times}` → ruta NUEVA, originales
  intactas. Si los rangos de tiempo se solapan o van en orden inverso, descartar times.
- Desplazar timestamps: op `shift_time{seconds}` (reactiva el cruce con Immich para
  relojes mal configurados).
- Recálculo de elevación contra DEM: **OpenTopoData self-hosted** como servicio opcional
  en docker-compose (la API pública limita 1 req/s y 100 pts/req — inviable). URL
  configurable en Ajustes (mismo patrón que Immich); sin configurar, el botón no aparece.
- Waypoints: conservar/editar `<wpt>` del GPX (hoy se ignoran) + markers editables.
- Integración con `gps_issues`: `rescan`/`create` ya calculan los tramos GPS
  anómalos con `detect_gps_anomalies` (`core/gps_analysis.py`) y los guardan en
  `routes.gps_issues`. El editor debería abrir con esos tramos **premarcados**
  (banda roja en el perfil + resaltado en el mapa) y ofrecer un atajo "corregir
  este tramo" que preconfigure la herramienta adecuada según el `type` del issue:
  `speed` → "Corregir velocidad excesiva" con el umbral del aviso; `elevation` →
  "Corregir picos de elevación". Así el flujo detección automática → corrección
  interactiva queda cerrado sin que el usuario tenga que buscar los tramos a mano.

### Fase 4 — Creación de rutas con routing (~2,5× F1)
- **BRouter self-hosted** (servicio docker con segmentos de la región) como motor;
  modo creación: clicks de waypoint → tramo ruteado según perfil de actividad
  (senderismo/MTB/carretera), fallback línea recta si BRouter no responde.
- Integración con `planned_routes` (ya guarda `gpx_data BLOB`): guardar genera el plan
  con GPX sintético + elevación DEM (F3). Convertir plan → editor para retocar.

## 7. Riesgos y decisiones cerradas

1. **Multi-segmento**: preservar segmentos, no colapsarlos. Un `delete_range` interior
   parte el segmento en dos. El aplanado determinista + `base_version` (409) cierran
   cualquier desfase cliente/servidor. GPX solo-`<rte>` → 400 explícito en `/points`.
2. **GPX sin timestamps**: `time: null`; `reverse` sin aviso; `started_at` sigue NULL
   tras guardar (la regla 4 de CLAUDE.md — Immich exige `started_at` — se mantiene);
   `duration_s/moving_s/avg_speed` quedan NULL. No inventar datos.
3. **50k+ puntos**: snap lineal con rAF (<1 ms), chart decimado a ≤3000 pts solo para
   pintar, snapshots Int32Array, el POST pesa bytes (solo ops). `/points` puede rondar
   3-5 MB — aceptable en LAN.
4. **Caché del listado** (`ROUTE_CACHE` en `app.html`): NO cambia de clave — la lista
   `/api/routes` no cambia de campos. Las stats editadas llegan invalidando la caché
   (dirty) tras guardar.
5. **Reglas del proyecto**: sin build step; migración idempotente y paralela-segura;
   persistencia solo en `/data`; UI en español; `.overlay.hidden` tras `.overlay`;
   thumbs/duplicados intactos porque el activo no cambia de nombre.

## 8. Verificación (smoke test end-to-end)

```bash
# tras docker compose up -d --build (puerto 8090; ver quirk de procesos huérfanos
# de WSL2 en CLAUDE.md si los cambios no se reflejan). N = id de una ruta de prueba.

curl -s localhost:8090/api/routes/N/points | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['version'],d['n'],d['segments'])"   # 0, n, segmentos

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"base_version":0,"summary":"Recorte de prueba","ops":[{"op":"delete_range","start":0,"end":9}]}' \
  localhost:8090/api/routes/N/edit | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['version'],d['distance_m'])"        # 2, distancia menor

# repetir el mismo POST con base_version:0  → HTTP 409
curl -s localhost:8090/api/routes/N/versions                                          # v1 "Archivo original" + v2
curl -s localhost:8090/api/routes/N/versions/2/gpx | python3 -c \
  "import gpxpy,sys;gpxpy.parse(sys.stdin);print('GPX válido')"
curl -s -X POST localhost:8090/api/routes/N/versions/1/restore | python3 -c \
  "import json,sys;print(json.load(sys.stdin)['version'])"                            # 3, stats originales
curl -sI localhost:8090/api/routes/N/thumb                                            # 200 image/png, mismo nombre
# caso .fit: el primer guardado materializa .gpx; v1 descargable es el .fit
# DELETE /api/routes/N → data/gpx/versions/N/ desaparece y route_versions queda limpia
```

Navegador: `/Sendero/<nombre>` muestra "✎ Editar" → el editor carga mapa+perfil; click
en la línea coloca A y B; drag de A con snap y banda amarilla sincronizada en el perfil;
arrastre en el perfil mueve los markers; recortar/eliminar/invertir (con aviso de
timestamps) actualizan stats en vivo; Ctrl+Z/Ctrl+Y; Guardar con resumen editable →
toast "v2" y el historial se actualiza; Restaurar v1; "← Volver" con cambios pendientes
pide confirmación; tras guardar, "Mis Rutas" refleja la nueva distancia.

Checklist final de CLAUDE.md: `python app.py` arranca; `init_db()` sobrevive a
ejecutarse 2 veces en paralelo; UI en español y sin build; `_build_route_dict` devuelve
lo mismo en `/api/routes/<id>` y `/Sendero/<nombre>`.
