# Qué viene después

Lo que queda por hacer en Sendero. Revisado el 27-07-2026 con la 0.9.9 recién cerrada.
Tres listas: lo que **se hace**, lo que está **pendiente de probar** (el código existe, falta
verificarlo con datos reales) y lo que se ha **descartado** — esto último está aquí para que
nadie lo vuelva a proponer sin un motivo nuevo.

Al terminar cualquiera de estos puntos: bórralo de aquí y cuéntalo en `CHANGELOG.md`.

---

## Para hacer

### El detalle de un plan no dice si está realizado
La 0.9.8 añadió «marcar como realizada» **solo en el listado** (`Mis Planes`): la ficha de
un plan (`/Plan/<public_id>`, `templates/sec/plan.html` + `static/js/sec/plan.js`) sigue sin
enseñar la chapa «✔ Realizada», sin el enlace a la ruta que lo cumplió y sin forma de
marcarlo o desmarcarlo. Los datos ya llegan: `_build_plan_dict()` devuelve `completed_at`,
`completed_route_id` y `completed_route_public`, y el PATCH que lo guarda es el mismo
(`/api/planned/<id>`). Falta la UI: chapa en la cabecera del mapa, fila en «Datos técnicos»
y la acción en el menú `⋯`, reutilizando el selector de ruta del listado o uno equivalente.

### La suite e2e no cubre «Mis Planes»
`tests/e2e_spa.py` (135 comprobaciones) es la red de seguridad de la SPA, pero de la sección
`planes` solo mira que las tarjetas, el mapa y el modal de alta existan. Lo que la 0.9.8
añadió —traza en el mapa, marcar/desmarcar realizada (incluido sin conexión), el selector de
ruta y el filtro por estado— se verificó a mano con Playwright, y esos guiones **no están en
el repositorio**: hoy nadie se enteraría si una edición de `sec/planes.js` los rompe. Falta
llevarlos a `tests/e2e_spa.py` como un bloque más (marcar → chapa + enlace + recuentos →
desmarcar → sin conexión: cola y repintado), reusando el plan que ya siembra
`tests/e2e_seed.py`.

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
