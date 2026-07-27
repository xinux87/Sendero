# Qué viene después

Lo que queda por hacer en Sendero, decidido el 26-07-2026 con la 0.9.2 recién cerrada.
Tres listas: lo que **se hace**, lo que está **pendiente de probar** (el código existe, falta
verificarlo con datos reales) y lo que se ha **descartado** — esto último está aquí para que
nadie lo vuelva a proponer sin un motivo nuevo.

Al terminar cualquiera de estos puntos: bórralo de aquí y cuéntalo en `CHANGELOG.md`.

---

## Para hacer

### 1. Rediseñar «Mis Planes» y el detalle de plan
**Por qué ahora**: son las dos vistas que más cantan al lado de Mis Rutas, porque comparten
patrón (tarjetas + mapa) y conservan la maquetación anterior. Hoy heredan la paleta y la
tipografía nuevas —los tokens cambiaron de valor, no de nombre— pero no la estructura.

**Cómo**: el patrón está en las tres vistas ya hechas (`redesign/README.md` tiene medidas y
tokens; `redesign/screenshots/` el resultado esperado). En corto: panel `--panel` + borde
`--line` + radio 12, título de panel con `.panel-title`, cifras en Oswald, datos en mono.
La tarjeta de plan debería acercarse a `.card` de `sec/rutas.css` (borde de color, miniatura
al fondo, distancia en ámbar), y el detalle de plan al `d-hero` del detalle de ruta.

**Ojo**: `plan.js` repinta sus capas escuchando `map.on('sendero:basemap')` (regla 15 de
`CLAUDE.md`); no lo rompas al tocar el mapa. Y `.plan-card` la comprueba `tests/e2e_spa.py`.

---

### 2. Rediseñar el editor de rutas
**Por qué**: es la pantalla más densa de la app y la que más gana con los paneles nuevos. El
propio prototipo lo ofrecía como continuación natural del handoff.

**Cómo**: mismo patrón que arriba. Los bloques ya están separados (Detalles, Estadísticas,
Operaciones, Avisos GPS, Historial), así que es sobre todo re-encajarlos en `.panel` y pasar
las cifras a Oswald y los datos a mono.

**Ojo**: el editor es la vista con más estado y la única que no funciona sin conexión. No
toques la paridad `doOp()` ↔ `apply_ops()` ni el aviso de salir con cambios sin guardar
(listener en fase de captura). `node tests/speedfix_smoke.js` y la parte de editor de
`tests/e2e_spa.py` tienen que seguir pasando.

---

### 3. Más contexto en la tarjeta del listado: avisos de GPS y número de fotos
**Qué**: hoy la tarjeta de «Mis Rutas» solo avisa de posibles duplicadas.
- **Avisos de GPS**: los `gps_issues` solo se ven al abrir la ruta, así que una con un salto
  de GPS no se distingue en el listado.
- **Número de fotos**: un icono pequeño de cámara con la cifra, para ver de un vistazo qué
  salidas tienen fotos y cuáles no. Nada si la ruta no tiene ninguna — un «0» es ruido.

Los dos van juntos porque comparten exactamente el mismo coste: ninguno de los dos datos
viaja hoy en el listado, y arreglarlo pasa por las mismas cuatro piezas. Hacerlos a la vez
significa **una sola** subida de `DB_VERSION` y **una sola** revisión de índices.

**Cómo, y por qué no es de dos líneas**:
- **`gps_issues`** está en `routes` pero no en `ROUTE_LIST_COLS` (`api/routes.py`). Mejor
  llevar un contador o un flag que el JSON entero, que pesa y en la tarjeta no se usa.
- **El número de fotos NO es una columna de `routes`**: sale de la tabla `photos`. O un
  subselect en la query del listado —`(SELECT COUNT(*) FROM photos WHERE route_id=routes.id)
  AS n_photos`— o una columna desnormalizada que hay que mantener al día en cada alta y baja
  de foto. El subselect es más simple y no puede quedar desincronizado; mídelo con las ~500
  rutas reales antes de darlo por bueno, y si hace falta añade **índice en `photos(route_id)`**,
  que hoy no existe (solo está `idx_photos_public_id`).
- **Índice de cobertura** en `init_db()` para la parte que salga de `routes` (regla 12: una
  columna leída en un listado sin índice obliga a SQLite a atravesar los blobs de cada fila;
  ya pasó y costó 7-9 s por petición).
- **Subir `DB_VERSION`** en `static/js/core/store.js` (regla 11), o los clientes seguirán
  sirviendo su copia local sin los campos nuevos.
- **Pintarlo**: en `makeCard()` (el icono de cámara junto a distancia y localidad, en
  `.card-meta`) y en la columna «Estado» de la vista Tabla, que hoy solo dice OK / ⚠ duplicada.

**A favor**: `ROUTE_LIST_COLS` la comparten el listado y los `upserted` de
`/api/sync/changes`, así que tocando un sitio se enteran los dos. Y el `rev` de una ruta ya
sube al añadir o borrar una foto (los triggers de `photos` suben el de su ruta), de modo que
el contador se sincroniza solo sin tocar nada de la sincronización.

---

### 4. `.gitattributes` con `* text=auto eol=lf`
**Por qué**: el 26-07-2026 el árbol de trabajo se reescribió entero con CRLF (64 archivos
«modificados» sin un solo cambio de contenido) y eso bloqueó los `git checkout` con un error
que no dice lo que pasa. Trabajando desde Windows/WSL volverá a ocurrir.

**Cómo**: añadir el archivo y renormalizar una vez (`git add --renormalize .`) en un commit
propio, que tocará muchos archivos y no debe mezclarse con cambios reales.

---

### 5. Quitar la columna muerta `draw_anchors`
**Qué**: resto del planificador interno (dibujo por anclas con BRouter) que se implementó y
se revirtió el mismo día. Hoy `planned_routes.draw_anchors` es siempre NULL, `api/planned.py`
la borra del dict al servir (`d.pop`) y nadie la escribe.

**Cómo**: SQLite admite `ALTER TABLE … DROP COLUMN` desde 3.35, pero la tabla lleva el BLOB
`gpx_data` y varios índices de cobertura; comprueba que siguen bien después. Si sale
regular, la alternativa honesta es dejarla y documentar que no se toca (que es lo que hay
hoy). No es urgente: no molesta a nadie, solo confunde al leer el esquema.

---

## Pendiente de probar (el código está, falta verificarlo)

### Mapa base PMTiles con un archivo real
`data/tiles/` está vacío, así que la quinta capa del selector («Offline (local)») **nunca se
ha probado con un archivo de verdad**: está implementada de punta a punta —`/tiles/<archivo>`
con soporte de `Range`, `buildStyle()` con `pmtiles://`, ajustes en Ajustes → Mapas— pero sin
un `.pmtiles` no sabes si funciona. Es lo que da mapa sin conexión **con el servidor
encendido** (el corredor de teselas por ruta cubre el caso del servidor apagado).

Para probarlo: consigue un tileset raster con licencia que lo permita, conviértelo con
`pmtiles convert`, déjalo en `data/tiles/` y selecciónalo en Ajustes → Mapas. Comprueba que
el `MAP_OFFLINE_MAXZOOM` coincide con el del archivo, o verás teselas en blanco al acercarte.

### Capturas del README
Las de `readme_images/` son de antes del rediseño (dashboard, Mis Rutas y detalle de ruta
cambiaron en la 0.9.0). El README lo advierte, pero es un parche: hay que rehacerlas desde la
instalación real cuando la 0.9.2 esté desplegada y a gusto.

Al capturar mapas o gráficas, **hazlo del viewport, no de la página completa**: el contenido
WebGL de MapLibre y los `<canvas>` de Chart.js no se repintan para el viewport ampliado de una
captura full-page y salen cortados (está en los quirks de `CLAUDE.md`).

---

## Descartado (no volver a proponerlo sin motivo nuevo)

- **Captura del token de Mi Fit/Zepp con un clic** (servicio `mifit-auth` con Firefox y
  noVNC). Montar un navegador entero en un contenedor para copiar una cadena que caduca de
  vez en cuando no compensa. El token se pega a mano en Ajustes → Mi Fit / Zepp, y cuando
  caduca el panel avisa.
- **Backfill de las miniaturas antiguas** (repintarlas desde el `geojson` de la base sin
  reparsear los GPX). Las anteriores a la 0.9.0 conservan su fondo hasta que se reescanee la
  ruta, y para eso ya existe el re-escaneo masivo de «Mis Rutas» → ✎ Editar → Seleccionar
  todos → ↻ Re-escanear. No hace falta código nuevo.
- **Descargar regiones enteras de mapa** para uso sin conexión: las cuatro capas base son de
  terceros y su política de uso no lo admite. Por eso existe el corredor de teselas por ruta.
- **Tocar `WIKILOC_COOKIE`**. La variable sigue documentada en `.env.example` sin que la lea
  nadie, y del importador de Wikiloc solo queda el badge del detalle de plan. Se deja como
  está: ni se implementa el importador ni se quita la variable.
- **Planificador interno de rutas** (dibujo por anclas con routing BRouter). Se implementó y
  se revirtió el mismo día; hoy «Dibujar ruta nueva» abre una web externa configurable
  (`PLANNER_URL`). Si vuelve a plantearse, es un rediseño desde cero, no un revert.
