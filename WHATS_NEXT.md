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

### 3. Aviso de GPS en la tarjeta del listado
**Qué**: hoy la tarjeta de «Mis Rutas» solo avisa de posibles duplicadas. Los avisos de GPS
(`gps_issues`) solo se ven al abrir la ruta, así que una ruta con un salto de GPS no se
distingue en el listado.

**Cómo, y por qué no es de dos líneas**: `gps_issues` no viaja en el listado. Hace falta
- añadir el dato a `ROUTE_LIST_COLS` (`api/routes.py`) — mejor un contador o un flag que el
  JSON entero, que es pesado y no se usa en la tarjeta;
- su **índice de cobertura** en `init_db()` (regla 12: una columna leída en un listado sin
  índice obliga a SQLite a atravesar los blobs de cada fila; ya pasó y costó 7-9 s por
  petición);
- subir `DB_VERSION` en `static/js/core/store.js` (regla 11), o los clientes seguirán con la
  copia local sin el campo;
- pintarlo en `makeCard()` y en la columna «Estado» de la vista Tabla, que hoy dice OK/⚠
  duplicada.

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

### 6. Decidir qué pasa con `WIKILOC_COOKIE`
**Qué**: la variable está documentada en `.env.example` con instrucciones para sacar la
cookie del navegador, pero **no la lee nadie**. Del importador de Wikiloc solo queda el badge
«Wikiloc» en el detalle de plan, para planes cuyo `source` sea ese — valor que hoy no produce
ningún código.

**Dos salidas, y hay que elegir una**:
- **Quitarla** de `.env.example` (y el badge, o dejarlo por si hay filas antiguas en la base).
  Es lo barato y deja de prometer algo que no existe.
- **Implementar el importador**: pegar una URL de Wikiloc, bajar el GPX con esa cookie y darlo
  de alta como plan. Ojo con los términos de uso de Wikiloc antes de meterse.

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
- **Planificador interno de rutas** (dibujo por anclas con routing BRouter). Se implementó y
  se revirtió el mismo día; hoy «Dibujar ruta nueva» abre una web externa configurable
  (`PLANNER_URL`). Si vuelve a plantearse, es un rediseño desde cero, no un revert.
