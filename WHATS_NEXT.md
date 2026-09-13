# Qué viene después

Lo que queda por hacer en Sendero. Revisado el 13-09-2026 con la 0.10.0 recién cerrada.
Tres listas: lo que **se hace**, lo que está **pendiente de probar** (el código existe, falta
verificarlo con datos reales) y lo que se ha **descartado** — esto último está aquí para que
nadie lo vuelva a proponer sin un motivo nuevo.

Al terminar cualquiera de estos puntos: bórralo de aquí y cuéntalo en `CHANGELOG.md`.

---

## Para hacer

### La suite e2e cubre «Mis Planes» solo a medias
`tests/e2e_spa.py` (226 comprobaciones) es la red de seguridad de la SPA. La 0.10.0 añadió
el bloque «Planificación editable», que ya cubre la **ficha** de un plan de punta a punta
(3D, marcar y desmarcar realizada —también sin conexión—, el editor, unir y las versiones),
pero de la sección `planes` sigue mirando solo que las tarjetas, el mapa y el modal de alta
existan. Lo que la 0.9.8 añadió **en el listado** —la traza de cada plan en el mapa, marcar
y desmarcar desde la tarjeta, su selector de ruta y el filtro por estado— se verificó a mano
con Playwright y esos guiones **no están en el repositorio**: hoy nadie se enteraría si una
edición de `sec/planes.js` los rompe.

### Dos comprobaciones de la e2e fallan desde antes de la 0.10.0
Con el árbol limpio en la v0.9.18 fallan estas dos, y no tienen que ver con la edición de
planes (se comprobó en un worktree sin los cambios):

- **«✕ limpia también lo que estaba en el desplegable»** — el botón de limpiar filtros de
  «Mis Rutas» (`sec/rutas.js`, cabecera reorganizada en la 0.9.17) deja algo puesto de lo
  que vive tras el botón `⋯` (fecha o búsqueda).
- **«el badge del header avisa: “”»** — el `#net-badge` se queda vacío en el momento en que
  la prueba lo mira.

Hay que decidir si el fallo está en el código o en la prueba; mientras tanto, un fallo
conocido que no se arregla es exactamente el que deja de mirarse.

### Un `ALTER TABLE` de `init_db()` sin la red de la regla 13
En `core/database.py` (~línea 181) queda un `ALTER TABLE routes ADD COLUMN hr_max` **sin**
el `try/except sqlite3.OperationalError` que llevan los demás. Con dos `init_db()`
simultáneos sobre una base nueva (los dos workers de gunicorn, que es justo el caso de la
regla 13) uno de los dos muere con `duplicate column`. Se vio montando el entorno de la
0.10.0. Es de una migración antigua, así que en una instalación ya arrancada no se
reproduce; en una instalación nueva, sí.

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

### «Mi ubicación» en un móvil de verdad

El botón está probado en Chromium con ubicación simulada (bloque 16 de `tests/e2e_spa.py`:
centra el mapa y sigue al usuario en los seis mapas), pero **no con un GPS real en el monte**.
Lo que falta comprobar es lo que un emulador no dice: cuánto tarda la primera posición con
señal pobre, si el seguimiento gasta batería de forma notable en una salida larga, y que
sobre las teselas descargadas del corredor de una ruta el punto caiga donde debe.

Y una cosa que sí es segura y conviene tener presente: la geolocalización **solo existe en
contexto seguro**. Si accedes por `http://<ip-de-la-lan>:8090` el navegador la bloquea y el
botón te lo dice; para usarla de verdad hace falta HTTPS (un proxy inverso con certificado)
o entrar por `localhost`.

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
- **Unir un plan con una ruta ya hecha.** «Unir» solo mezcla plan + plan (y ruta + ruta):
  un plan es lo que quieres hacer y una ruta es lo que hiciste, y el resultado no cabría en
  ninguna de las dos tablas sin mentir (¿lleva los tiempos y la FC de la mitad grabada? ¿es
  pendiente o realizada?). Si algún día hace falta, es un concepto nuevo, no un `ids` mixto.
- **Recalcular el índice IBP solo, al editar el track de un plan.** Al guardar una versión
  nueva el índice se **vacía** y ya está: el número lo calcula ibpindex.com con el GPX
  subido entero, o sea red, clave y el track completo saliendo de la LAN. Encadenar eso a
  cada guardado del editor convertiría una edición local en una llamada a un tercero. El
  usuario lo vuelve a pedir con «Calcular» cuando ha terminado de editar.
