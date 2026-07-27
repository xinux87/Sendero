# Qué viene después

Lo que queda por hacer en Sendero, decidido el 26-07-2026 con la 0.9.2 recién cerrada.
Tres listas: lo que **se hace**, lo que está **pendiente de probar** (el código existe, falta
verificarlo con datos reales) y lo que se ha **descartado** — esto último está aquí para que
nadie lo vuelva a proponer sin un motivo nuevo.

Al terminar cualquiera de estos puntos: bórralo de aquí y cuéntalo en `CHANGELOG.md`.

---

## Para hacer

### 1. Quitar la columna muerta `draw_anchors`
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
