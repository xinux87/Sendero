# CLAUDE.md

Contexto para trabajar en **Sendero** (bitácora autoalojada de rutas de montaña).
El README explica *qué hace* y cómo desplegarlo; este archivo cubre lo que necesitas
para tocar el código sin romperlo. Si algo de aquí contradice al README, este manda.

## Qué es, en una frase
Monolito Flask + SQLite que sube/visualiza GPX, les asocia fotos (locales o de Immich
por referencia) y guarda un resumen por ruta.

## Comandos
```bash
# desarrollo
pip install -r requirements.txt
python app.py                      # http://localhost:8080, init_db() automático

# producción / como se despliega de verdad
docker compose up -d --build       # servicio 'sendero' + servicio 'watcher'
# El puerto host está en docker-compose.yml ("8090:8080" en esta instalación;
# cámbialo si el 8080 está libre: "8080:8080").

# no hay suite de tests formal. Para validar un cambio, smoke test rápido:
#   1) arranca el server
#   2) sube un GPX:  curl -F "gpx=@ruta.gpx" localhost:8090/api/routes
#   3) GET /api/routes y /api/routes/1  y comprueba stats + geojson
# La lógica de Immich se prueba con unittest.mock parcheando app.requests.post
# (no hay instancia real disponible en CI).
```

## Mapa del código

### Backend
- `app.py` — TODO el backend: rutas Flask, parseo GPX (gpxpy), EXIF (Pillow),
  acceso SQLite, e integración Immich. No hay capas ni blueprints; es plano a propósito.
- `watch.py` — importador de carpeta. Proceso **independiente**, no parte del server.
- `.env` — variables de entorno para Immich (`IMMICH_URL`, `IMMICH_API_KEY`,
  `IMMICH_MARGIN_MIN`). Sin este archivo Immich queda desactivado silenciosamente.

### Frontend — tres plantillas Jinja2
La app es **multi-página** (no SPA). Cada pantalla es una plantilla independiente
que hereda de la base. No hay bundler ni paso de compilación.

| Archivo | Ruta Flask | Contenido |
|---------|-----------|-----------|
| `templates/base.html` | — | CSS compartido, header con curvas de nivel, toast, utilidades JS (`$`, `fmtKm`, `fmtDur`, `fmtDate`, `esc`) |
| `templates/dashboard.html` | `GET /` | Lista de rutas, subida de GPX. Sin Leaflet ni Chart.js. |
| `templates/sendero.html` | `GET /Sendero/<nombre>` | Detalle de ruta: mapa, stats, perfil de elevación, notas, fotos, modal Immich, lightbox. Carga Leaflet + Chart.js. |

`templates/index.html` existe como archivo legado; ya no se sirve.

### Navegación entre páginas
- Clic en tarjeta del dashboard → `location.href = '/Sendero/' + encodeURIComponent(name)`
- Botón "← Volver" / borrar ruta → `location.href = '/'`
- Renombrar ruta → `history.replaceState` (actualiza URL sin recargar)
- El botón atrás del navegador funciona de forma nativa (páginas reales, no SPA)

### Rendimiento de carga en sendero.html
`sendero_page()` en `app.py` resuelve el nombre de la ruta en el servidor y serializa
los datos con `_route_dict(rid)`. El JSON se inyecta directamente en el HTML mediante
la variable Jinja `{{ route_json | safe }}`. El JS asigna `current` en el acto y llama
a `renderAll()` sin ningún fetch previo. La llamada a `/api/config` (solo para el botón
Immich) corre después, sin bloquear el render.

### Helper `_route_dict(rid)` en app.py
Construye el dict completo de una ruta (geojson, elevation, photos, auto_summary).
Lo usan tanto `get_route()` (API JSON) como `sendero_page()` (inyección en template).
Si añades campos al objeto de ruta, añádelos aquí.

### Estado JS relevante en `sendero.html`
| Variable | Contenido |
|----------|-----------|
| `current` | objeto completo de la ruta (incluye `.photos[]`, `.geojson`, `.elevation`) — poblado desde el HTML, no desde fetch |
| `photoMarkers` | `{id: L.Marker}` — marcadores Leaflet de fotos con GPS, para quitarlos sin recargar el mapa |
| `lbIdx` | índice en `current.photos` de la foto visible en el lightbox |
| `immichCands` / `immichSel` | candidatos devueltos por `/immich/candidates` y Set de índices seleccionados |
| `IMMICH` | booleano, activado tras `/api/config`; controla visibilidad del botón Immich |

### Componentes UI en sendero.html
- **Lightbox** (`#lb-overlay`) — modal pantalla completa para ver fotos. Navegación con
  botones ‹ › o flechas de teclado; Escape cierra. Botón "Eliminar foto" llama a
  `lbDelete()`, que borra del servidor, del DOM y del mapa sin recargar la ruta.
- **Selector de capas** — control nativo `L.control.layers` con cuatro capas base:
  Topográfico (OpenTopoMap), Callejero (OSM), Satélite (Esri), Oscuro (CartoDB).
- **Botón centrar mapa** — control Leaflet personalizado (clase `FitBtn`) en esquina
  superior izquierda; llama a `map.fitBounds(trackLayer.getBounds())`.
- **Fotos en el perfil de elevación** — plugin `photoIcons` (`afterDatasetsDraw`) dibuja
  el icono SVG de cámara 28 px por encima del punto de datos real. El scatter dataset
  subyacente es transparente pero captura los clics para abrir el lightbox.
  `photoElevPoints()` encuentra la posición km de cada foto por proximidad al track
  usando distancia Euclidea con corrección coseno (rápido para 14 k puntos × N fotos).

## Bugs corregidos (no reintroducir)

- **`init_db()` debe estar a nivel de módulo**, no solo bajo `if __name__ == "__main__"`.
  Gunicorn importa `app:app` directamente y nunca ejecuta el bloque `__main__`; sin
  `init_db()` al importar, el primer request falla con `no such table: routes`.

- **Especificidad CSS del modal Immich** (en `sendero.html`): `.hidden{display:none}` está
  definido antes que `.overlay{display:flex}`. Como ambos tienen la misma especificidad,
  `.overlay` ganaba y el modal era siempre visible. La solución es la regla
  `.overlay.hidden{display:none}` (especificidad doble) definida inmediatamente después
  de `.overlay`. No elimines esa regla ni reordenes sin tenerlo en cuenta.

## Reglas que evitan romper cosas

1. **El frontend NO tiene build step.** Las tres plantillas heredan de `base.html` via
   Jinja2 (renderizado en servidor, no compilación). Todo el JS va inline en cada
   plantilla. No introduzcas npm, bundlers, React ni paso de compilación.

2. **Una foto es local O de Immich.** En la tabla `photos`, las locales tienen `file`
   y las de Immich tienen `immich_id` (con `file = NULL`). Cualquier código que borre o
   abra archivos DEBE comprobar `if p["file"]:` antes de tocar el disco. `photo_file()`
   ya bifurca: si hay `immich_id`, hace proxy a Immich; si no, sirve el archivo local.
   Las fotos de Immich se guardan **por referencia**, nunca se copian.

3. **El watcher corre una sola vez.** Está como servicio aparte en docker-compose
   precisamente para que no se duplique con los workers de gunicorn. NO lo conviertas en
   un hilo de fondo dentro de Flask: con `--workers 2` tendrías dos importadores
   compitiendo. Si necesitas que el server lo arranque, hazlo en un único worker.

4. **El cruce con Immich es por tiempo.** La ventana es `started_at .. (started_at +
   duration_s)` ± `IMMICH_MARGIN_MIN`. Requiere que el GPX tenga marcas de tiempo; si
   `started_at` es NULL, el endpoint devuelve 400 a propósito. No inventes un fallback
   silencioso.

5. **El filtro de cercanía nunca excluye fotos sin GPS.** En `/immich/candidates` se
   calcula `dist_m` solo para las que tienen lat/lon. El toggle del frontend oculta las
   que tienen GPS y están lejos, pero las de `dist_m == null` (sin ubicación) SIEMPRE se
   muestran. Muchas fotos de montaña no llevan GPS; ocultarlas sería un bug, no mejora.

6. **Migraciones de esquema:** sigue el patrón de `init_db()` (ALTER TABLE defensivo
   comprobando `PRAGMA table_info`). No asumas una BD limpia; hay instalaciones vivas.

7. **Persistencia solo en `/data`** (variable `SENDERO_DATA`), que es el volumen Docker:
   `sendero.db`, `gpx/`, `photos/`. No escribas estado en otros directorios.

8. **Idioma:** la interfaz y todos los mensajes al usuario están en **español**.
   Mantenlo. Comentarios y nombres de código pueden ir en inglés/español como ya están.

9. **Identidad visual:** tema topográfico con variables CSS (`--gr-red`, `--pr-yellow`,
   curvas de nivel en la cabecera). No metas un framework de UI ni cambies la paleta sin
   pedirlo; es deliberada (señalética de senderos GR/PR).

10. **`{{ route_json | safe }}` en sendero.html** — el filtro `| safe` es intencional:
    el JSON lo genera `json.dumps()` en Python desde datos de la BD, no desde input
    de usuario. No lo elimines ni lo escapes dos veces.

## Modelo de datos
- `routes`: stats derivadas del GPX (distance_m, ascent_m, descent_m, duration_s,
  moving_s, ele_min/max, avg_speed, started_at), más `geojson` (lista `[lon,lat]`) y
  `elevation` (perfil `[{d_km, e_m}]`) como TEXT JSON, y `notes` (resumen del usuario).
- `photos`: `route_id`, y luego `file` XOR `immich_id`, más `lat/lon/taken_at`.
- SQLite sin WAL, conexión por request vía `g.db`. Concurrencia = last-write-wins; no
  hay bloqueos. Suficiente para uso personal; no lo trates como multiusuario.

## Quirks conocidos (no son bugs urgentes, pero tenlos presentes)
- La validación de extensión en `create_route` es laxa (`endswith(("gpx", ".gpx"))`):
  acepta cualquier nombre que termine en "gpx". Si endureces esto, no rompas el watcher,
  que sube con el nombre original del archivo.
- No hay autenticación. Es intencional para LAN; si añades login, que sea opt-in y no
  rompa el contrato de la API que ya existe.
- `sendero-demo.html` (en la raíz de entregables, fuera de este repo de runtime) es un
  demo estático con datos embebidos; no consume la API y no hay que mantenerlo en sync.

## Antes de dar por buena una tarea
- ¿Sigue arrancando `python app.py` e `init_db()` sin error?
- Si tocaste fotos: ¿probaste los dos caminos (local y `immich_id`)?
- Si tocaste el esquema: ¿añadiste la migración defensiva?
- ¿La UI sigue en español y sin paso de build?
- Si tocaste CSS del modal en `sendero.html`: comprueba que `.overlay.hidden` sigue
  ocultando el modal al cargar una ruta (abre `/Sendero/<nombre>` y verifica que no
  aparece el overlay de Immich sin haberlo abierto).
- Si tocaste `_route_dict()`: verifica que `/api/routes/<id>` y la navegación directa
  a `/Sendero/<nombre>` devuelven los mismos datos.
