# Changelog

Todas las novedades relevantes de Sendero. El formato sigue de forma laxa
[Keep a Changelog](https://keepachangelog.com/es/) y el versionado es
[SemVer](https://semver.org/lang/es/). La versión activa se muestra al pie del
panel de Ajustes y en `GET /api/config`.

## [0.9.1] — 2026-07-26

### Añadido
- **Página de reparación `/actualizar`**, enlazada desde Ajustes → Sin conexión («Actualizar
  la app en este dispositivo»). Desregistra el Service Worker, borra sus cachés, la copia
  local (IndexedDB) y las preferencias de sesión, y ofrece volver a la app, que se descarga
  de cero. Existe porque el peor fallo de esta arquitectura es quedarse con el código de la
  versión anterior pegado en el navegador —el síntoma es "no cargan las opciones", sin
  ningún error en el servidor— y salir de ahí exigía DevTools o dar con dónde se borran los
  datos del sitio, que en un móvil o en una PWA instalada no es evidente. La página llega
  siempre de red (el Service Worker no la intercepta) y su JS va inline, porque un
  `<script src>` podría servirse justo de la caché vieja que se quiere tirar.

### Corregido
- **El manifiesto de la PWA ya no falla detrás de un proxy con autenticación.** Con Sendero
  publicado tras Pangolin (o Authelia, oauth2-proxy y compañía), la consola del navegador
  daba `Access to manifest … has been blocked by CORS policy` y la app no se podía instalar.
  El motivo: el manifiesto es el único subrecurso que el navegador pide **sin cookies**
  (modo anónimo, por especificación), así que el proxy lo veía como una petición sin sesión,
  respondía con un 302 al SSO —que vive en otro dominio— y el navegador bloqueaba la
  redirección cruzada. Ahora el `<link rel="manifest">` lleva
  `crossorigin="use-credentials"`: la petición viaja con las cookies del sitio y el proxy la
  deja pasar. En una LAN sin proxy no cambia nada. El aviso salía desde la 0.7.0, cuando
  llegó la PWA; no lo introdujo el rediseño.

## [0.9.0] — 2026-07-26

Rediseño de las tres vistas principales (dashboard, Mis Rutas y detalle de ruta) según el
handoff de `redesign/`: la opción **2a** en pantalla grande y la **2d** en móvil. No es una
identidad nueva: formaliza la que ya tenía la app (verde muy oscuro, wordmark condensado,
píldoras de actividad de colores, ámbar para las cifras, rojo para la acción principal) y la
aplica a las tres pantallas con tokens en un solo sitio.

### Cambiado
- **Detalle de ruta: el mapa es la cabecera.** Bloque de 360 px con el selector de capa y
  los controles de zoom encima, y sobre el velo inferior el chip de actividad, la zona, el
  título y la línea `fecha · hora | archivo | dispositivo`. Debajo, la banda de **7
  métricas** (la primera con el borde del color de la actividad y la cifra en ámbar) y un
  cuerpo a dos columnas: perfil de elevación + velocidad + FC + fotos a la izquierda, y
  **Datos técnicos**, **Calidad del track** y **Resumen** a la derecha.
  - «Calidad del track» lista los `gps_issues` de la ruta (los mismos que ve el editor) con
    su severidad y un enlace para corregirlos; sin avisos dice «Sin errores detectados».
  - «Datos técnicos» solo muestra lo que la ruta tiene de verdad: tiempo total, pausas,
    ritmo medio, velocidad máxima, altitud mínima, puntos GPS, formato, versión e
    importación. Nada de cadencia ni temperatura: el modelo no las guarda.
  - Sobre el mapa quedan solo «✎ Editar track» y «↓ Exportar GPX»; reescanear, mapa sin
    conexión, renombrar y eliminar pasan al menú **⋯** (también en escritorio).
- **En móvil el cuerpo del detalle son pestañas** (Perfil / Fotos / Datos / Notas), el mapa
  cabecera baja a 236 px a ancho completo, la banda de métricas va a 3 columnas y las cuatro
  acciones del mapa caen debajo en rejilla 2×2. La cabecera de la app muestra una flecha de
  volver en las vistas de detalle.
- **Mis Rutas**: panel de filtros con las seis píldoras de actividad en su color (sólidas al
  estar activas), rango de fechas, **buscador nuevo** por nombre y zona, y fila de ORDEN.
  Los cuatro controles de la fila de filtros comparten línea de base y miden lo mismo (el
  buscador es una píldora más). Las tarjetas llevan el borde izquierdo del color de la
  actividad, la fecha larga en versalitas, la distancia en ámbar y la miniatura del track
  ocupando el alto completo pegada al borde derecho, escalando con la tarjeta y **detrás**
  del texto, así que nombre, fecha, localidad y avisos se leen encima.
- **Vista nueva «☰ Tabla»** en Mis Rutas (la variante densa del rediseño): mismo agrupado
  por mes, con Ruta · Zona · Fecha · Dist. · D+ · Tiempo · Actividad · Estado. Conviven con
  «⊞ Cuadrícula» y «▤ Panel»; la elección se recuerda en la sesión.
- **Dashboard = «Analítica global»**: selector de año, cinco KPIs (salidas, distancia,
  desnivel +, horas y zonas) con su comparativa, barras de **desnivel acumulado por mes**,
  **zonas más visitadas** y **almacenamiento**. Todo eso se calcula en el cliente desde el
  listado que ya tiene el Store, así que el dashboard entero funciona sin conexión y el
  selector de año no gasta ni una petición. Del servidor solo siguen viniendo los récords
  (necesitan `avg_speed`, que no está en el listado). Se conservan el mapa de todas las
  rutas, «Por actividad» y «Rutas por año», restilados.
  - El panel de las barras por mes y la pila de «Zonas más visitadas» + «Almacenamiento»
    **acaban a la misma altura**, con las barras en porcentaje de su carril para que llenen
    el alto que les toque (comprobado con 1, 4 y 8 zonas).
  - El subtítulo dice solo el periodo («Todas las temporadas» / «Temporada 2026»): lo demás
    era texto del prototipo sin ninguna función.
- **Tipografía**: Oswald (títulos, wordmark y cifras), IBM Plex Sans (interfaz) e IBM Plex
  Mono (datos y etiquetas), autoalojadas en `static/fonts/` como las anteriores. Se van
  Saira Condensed, Inter y Space Mono. Oswald e IBM Plex Sans son variables: un archivo por
  subconjunto cubre los pesos 400-600, así que el precache pesa menos que antes (192 KB).
- **Paleta**: los tokens del rediseño sustituyen los valores de las variables CSS de siempre
  (`--bg`, `--panel`, `--line`, `--ink`, `--pr-yellow`, `--gr-red`…) y se añaden
  `--bg-deep`, `--panel-2`, `--line-strong`, `--muted-dim`, `--muted-faint`, `--sage`,
  `--display`. Al cambiar el valor y no el nombre, las vistas que no se han rediseñado a
  mano (Mis Planes, detalle de plan, editor) heredan la paleta nueva. Los colores de
  actividad también se actualizan, con el glifo del icono en oscuro sobre el color.
- El logo, los iconos de la PWA, el `theme-color` y la página de «sin conexión» del Service
  Worker adoptan la paleta nueva.
- **Las miniaturas de track se generan sin fondo** (PNG con transparencia) y con la línea
  algo más gruesa. Con fondo opaco se veían como un recuadro sobre la tarjeta, y al pasar
  el ratón —cuando la tarjeta cambia de color— cantaba; y a 2 px la traza quedaba en
  sub-píxel al verse a un tercio de tamaño. En la tarjeta, la miniatura ocupa ahora todo
  el alto pegada al borde derecho, escala sola y va detrás del texto, con el desvanecido
  hacia la izquierda hecho con `mask-image` en vez de un degradado de color. Las
  miniaturas anteriores conservan su fondo hasta que se reescanee la ruta (en masa:
  "Mis Rutas" → ✎ Editar → Seleccionar todos → ↻ Re-escanear).

### Añadido
- **Filtro de posibles duplicadas en Mis Rutas**: deja a la vista solo las rutas que la
  importación automática marcó como parecidas a otra. Aparece únicamente si hay alguna
  marcada, y se apaga solo cuando deja de haberlas (borradas o con el aviso descartado).
- `GET /api/storage`: tamaño en disco de la base, los tracks, las fotos, las miniaturas y
  las teselas (más el número de fotos que son solo referencia a Immich). Lo consume el panel
  «Almacenamiento» del dashboard.
- El objeto ruta lleva `n_points` (puntos del track completo). Se calcula antes de que
  `?lite=1` decime el `geojson`, así que «Puntos GPS» no cuenta los de la versión ligera.

### Interno
- `DB_VERSION` del Store sube a 2: sin eso, un detalle ya guardado en IndexedDB no recibiría
  nunca `n_points` (su `rev` no cambia, así que el Store seguiría sirviendo su copia).
- Formatos nuevos en `chrome.js` y compartidos por las tres vistas: `fmtNum` (millares con
  espacio fino), `fmtHM`, `fmtHMS`, `fmtPace`, `fmtDateLong`, `fmtDateTime`.
- El mapa del dashboard se crea **después** de mostrar el contenido: creándolo con el panel
  en `display:none`, MapLibre mide 0 px y luego solo repinta teselas en una esquina.
- `tests/e2e_spa.py` abre el menú ⋯ antes de renombrar; `tests/sec_smoke.js` gana
  `querySelectorAll` y los formatos nuevos en su DOM de mentira. Las 127 comprobaciones de
  la suite e2e siguen pasando.

## [0.8.0] — 2026-07-26

El editor deja de perder puntos al corregir saltos de GPS, y se va el rastro de la app
multipágina que quedaba muerto en el repositorio.

### Cambiado
- **El editor ya no borra los puntos con velocidad imposible: los arregla.** «⚡ Corregir
  velocidad excesiva» (y el «✔ Corregir todo» de los avisos GPS) recolocaba los puntos que
  exigirían superar el umbral de la actividad eliminándolos, así que un salto de GPS se
  llevaba por delante puntos reales del track. Ahora cada punto marcado se **recoloca entre
  el último punto válido anterior y el primero válido posterior** — para un salto suelto, la
  media exacta de los dos — repartiendo una tira de varios en proporción a su hora
  (espaciado uniforme si a algún punto le falta el `<time>`). La altitud se promedia igual,
  porque un salto de GPS suele traer también una altitud falsa y el punto recolocado debe
  ser coherente con su nueva posición. El track conserva el mismo número de puntos, y el
  resultado no puede volver a pasarse del umbral (el punto queda sobre el tramo A–B, que la
  detección ya validó). Único caso en que se sigue eliminando: una tira que llega al final
  del track, porque sin un punto válido al otro lado no hay nada con lo que promediar; el
  panel lo dice y lo cuenta aparte.
- El panel de la herramienta muestra ahora en blanco discontinuo el track tal como quedaría,
  además de los puntos marcados en rojo.

### Interno
- Op nueva del editor `move_points{items:[[i,lon,lat[,ele]],…]}` (`core/editing.py` +
  `doOp()`), el lote de `move_point` que emite la corrección de velocidad: cientos de puntos
  corregidos son **una** op, o sea un solo paso de deshacer y una sola línea en el resumen.
- Prueba de humo nueva: `node tests/speedfix_smoke.js` (geometría de la corrección: la media
  exacta, el reparto por tiempo, que no se pierde ningún punto y que tras corregir no queda
  ninguna velocidad por encima del umbral).
- **Fuera las siete plantillas de la app multipágina** (`app.html`, `sendero.html`,
  `editor.html`, `rutas.html`, `overview.html`, `planificacion.html`,
  `plan_detalle.html`): 6.410 líneas que no servía ninguna ruta desde la 0.7.0. Se
  conservaron durante la migración para poder comparar, y ya solo servían para que
  alguien editara el archivo equivocado. Siguen en git (`git show v0.7.1:templates/...`).
  En `templates/` quedan `base.html`, `shell.html` y `sec/` con las 6 secciones.
- Eliminado el endpoint `GET /api/routes/by-name/<nombre>`, al que no llamaba nadie.
- **Fuera la carpeta `roadmap/`** (4 planes, 1.925 líneas). Estaban todos cerrados: el
  editor (fases 1-3, más una fase 4 implementada y revertida el mismo día), la SPA con
  funcionamiento sin conexión, el responsive de móvil y la sincronización con Mi Fit
  (queda pendiente solo capturar el token con un clic, que ya se dice en el README).
  Describían un código que en varios puntos había dejado de ser el real. Lo que sí tenían
  de útil se ha quedado en `CLAUDE.md`: el smoke test end-to-end del editor y cómo
  funciona el mapa base en PMTiles. Siguen en git (`git show d762a4f:roadmap/...`).
- **Fuera `FUNCIONALIDADES.md`**: iba por la versión 0.4.0, inventariaba plantillas
  borradas y le faltaban enteros los endpoints de sincronización, mapas, PWA y Mi Fit.
  Lo que hacía lo cubren ya el README (qué hace la app) y `CLAUDE.md` (la tabla completa
  de rutas Flask).
- El README se pone al día: la versión, la estructura real del proyecto, la tabla de API
  con los identificadores públicos y los endpoints que faltaban, y una sección nueva
  sobre el uso sin conexión y la instalación como app, que no estaba documentado.
- Los comentarios del código ya no apuntan a `roadmap/…` (eran ~40 referencias que se
  habrían quedado señalando a la nada).

## [0.7.1] — 2026-07-26

Arreglo de la vista 3D. **La 0.7.0 no llegó a publicarse como imagen**, así que si vienes
de la 0.6.0 esta versión te trae además todo lo que hay en su entrada de abajo (la SPA
completa, la PWA y el funcionamiento sin conexión).

### Corregido
- **La vista 3D del mapa ya funciona.** Se quedaba en negro desde que se añadió (junio), y
  no era culpa del servicio de relieve: responde bien y sus datos son correctos. El código
  activaba el relieve y movía la cámara en el mismo instante, y con rutas de alta montaña
  eso dejaba la superficie del terreno por encima de la cámara. Ahora el mapa se inclina
  primero y el relieve aparece al terminar el movimiento. De paso, si el relieve no se
  puede descargar (sin internet), te queda la vista inclinada en 2D en lugar de un
  rectángulo negro.
  Solo se notaba con dos condiciones a la vez —altitud por encima de unos 1500 m y el mapa
  bastante acercado—, que es la razón de que aguantara tantos meses sin que se viera el
  patrón.

### Interno
- La prueba de la vista 3D compara el peso del PNG del mapa (en negro comprime a ~9 KB;
  con relieve, a cientos) usando teselas reales, y `tests/e2e_seed.py` siembra una ruta de
  alta montaña con recorrido corto: sin esas dos condiciones el fallo no se reproduce y la
  prueba pasaba con el código roto.
- Dos comprobaciones del panel «Sin conexión» dejan de depender de un texto de progreso
  exacto y del instante en que el servidor recalcula sus estadísticas.

## [0.7.0] — 2026-07-26

Segundo y último tramo del plan de **SPA completa + funcionamiento sin conexión**
(`roadmap/spa-offline-sync.md`). Toda la aplicación es ya una sola página: cambiar de
pantalla no recarga nada, y lo esencial funciona sin conexión. El almacenamiento no cambia:
mismos GPX, mismas fotos, misma base de datos.

### Añadido
- **Sendero se puede instalar como aplicación (PWA) y arranca sin conexión.** Hay
  manifiesto, iconos y un Service Worker que guarda el código de la app en el dispositivo.
  Con el servidor apagado o sin red se abren **todas** las pantallas: el listado de rutas,
  el dashboard, los planes y el detalle de lo que ya se había sincronizado — con su mapa
  (si hay un `.pmtiles` configurado), su perfil de elevación y sus fotos.
- **Indicador de conexión en la cabecera**: aparece solo cuando hay algo que contar —
  «sin conexión», «sincronizando» o «N sin enviar».
- **Editar sin conexión**: nombre, notas y tipo de actividad se guardan sin red y se envían
  solos al recuperarla. Las acciones que decide el servidor (subir rutas o fotos,
  reescanear, Immich, borrar, y todo el editor) avisan de que necesitan conexión en vez de
  fallar en silencio.
- **Ajustes → Sin conexión**, nueva sección: cuánto hay guardado en este dispositivo y de
  cuándo, **descargar todas las rutas** de golpe para llevarlas al monte sin haberlas
  abierto, **comprobar la sincronización** contra el servidor (y reparar solo lo que
  divergía), ver y reenviar los **cambios pendientes**, y vaciar la copia local.
- **El mapa de una ruta, guardado en el móvil.** Botón «⬇ Mapa sin conexión» en el detalle
  de una ruta y en el de un plan: descarga solo la franja de mapa por la que pasa el
  track, no una región. Una ruta de 40 km son unas 380 teselas (~9 MB) y una caminata de
  14 km unas 170. Es lo que permite salir al monte con el mapa de fondo aunque el servidor
  se quede apagado en casa — la capa PMTiles, en cambio, necesita el servidor encendido.
  Al volver a abrir la ruta te dice si ya lo tienes, y en Ajustes → Sin conexión se ve
  cuánto ocupa y se puede borrar.

### Cambiado
- **Ninguna pantalla recarga la página.** Dashboard, Mis Rutas, Mis Planes, el detalle de
  una ruta, el de un plan y el editor son secciones de un único documento. Antes eran
  cuatro páginas distintas y cada salto costaba una carga completa (mapa incluido).
- **El listado ya no caduca a los 10 minutos.** Se guarda en el dispositivo y se actualiza
  por diferencias: lo que cambie en otro dispositivo, en el importador de carpeta o en la
  sincronización con el reloj aparece en el siguiente sondeo, sin esperar a que expire nada.
- **Las URLs de una ruta van por identificador opaco**, como ya iban los planes:
  `/Sendero/<id>` y `/Sendero/<id>/editor`. Los enlaces y marcadores por nombre siguen
  funcionando (redirección). Renombrar una ruta ya no cambia su URL.
- El detalle de ruta carga su **variante ligera** (track y series remuestreados), así que
  gasta bastante menos datos sin que se note en el mapa ni en las gráficas.
- El mapa de **Mis Planes** ya respeta Ajustes → Mapas y tiene selector de capas: era el
  único que llevaba las teselas escritas a mano, y por eso ignoraba la capa offline.

### Corregido
- El botón ✕ de borrar una foto en el detalle no funcionaba desde 0.5.2: el manejador se
  generaba con el identificador opaco sin comillas y el navegador lo leía como una variable
  inexistente.
- Cada click en la navegación de la cabecera provocaba una recarga completa **además** del
  cambio de sección: la comprobación que debía evitarlo miraba `window.Router`, y las
  constantes de un script clásico no son propiedades de `window`. El mismo fallo dejaba sin
  funcionar el contador de cambios pendientes del indicador de conexión.

### Interno
- `templates/shell.html` aloja las 6 secciones (`templates/sec/*.html` +
  `static/js/sec/*.js` + `static/css/*.css`); `templates/app.html`, `sendero.html` y
  `editor.html` quedan como legacy, ya no los sirve ninguna ruta.
- `GET /api/routes/<id>/editor`: metadatos de arranque del editor, que antes inyectaba la
  plantilla.
- El Service Worker no cachea documentos con datos inyectados dentro, y sirve
  `static/js/**` y `static/css/**` con revalidación por detrás (su nombre no lleva versión):
  reglas 16 y siguientes de CLAUDE.md.
- Pruebas nuevas: `python tests/e2e_spa.py` (~115 comprobaciones en un navegador real con
  Playwright: mapas, gráficas, fugas de `unmount()`, Service Worker, modo sin conexión, cola
  de escrituras y un guardado real del editor), más `node tests/sw_smoke.js` y
  `node tests/sec_smoke.js`. Playwright NO entra en `requirements-dev.txt`.

### Pendiente
- Descargar **regiones** enteras de mapa (el §6.2 original del plan) sigue descartado: las
  capas son de terceros y su política de uso no admite descargas masivas. El caso real
  —tener el mapa de la ruta que vas a hacer— se resuelve con el botón por ruta descrito
  arriba, que baja cientos de teselas en vez de cientos de miles.

## [0.6.0] — 2026-07-25

Primer tramo del plan de **SPA completa + funcionamiento sin conexión + sincronización
delta** (`roadmap/spa-offline-sync.md`). Las fases 1 (vendorizar), 4 (sync delta) y 6.1
(mapa base offline) están terminadas; la conversión del frontend a secciones va por la
primera vista. Nada de esto cambia el almacenamiento: mismos GPX, mismas fotos, misma BD.

### Añadido
- **Sincronización delta**: tres endpoints nuevos que sustituyen al caché con TTL de
  10 minutos del listado.
  - `GET /api/sync/state` responde con `ETag` y, con `If-None-Match`, **304 sin cuerpo**:
    "no ha cambiado nada" cuesta unos cientos de bytes de cabeceras. Es lo que permite
    preguntar a menudo.
  - `GET /api/sync/changes?since=<rev>` devuelve **solo la diferencia** (altas/cambios y
    bajas, paginado por `rev`), y `GET /api/sync/manifest` los pares `[public_id, rev]` de
    todo (~30 B por ruta) para **corroborar** la copia local y descargar únicamente lo que
    divergía, sin recargarlo todo.
  - Un cambio hecho desde otro dispositivo, o por `watch.py`/`mifit_sync.py`, se ve en el
    siguiente sondeo en vez de esperar a que expire un TTL.
- **Mapa base sin conexión (PMTiles)**: copia un `.pmtiles` en `data/tiles/` y aparece la
  capa **«Offline (local)»** en el selector de capas. La sirve Sendero con soporte de
  `Range` (`GET /tiles/<archivo>`), sin servidor de teselas aparte. Nueva sección
  **Ajustes → Mapas**: capa base por defecto, archivo, zoom máximo y atribución.
  Las 4 capas de siempre son de terceros y **siguen necesitando internet** (cachearlas en
  masa va contra su política de uso); esta es la única que funciona en modo avión.
- **Detalle de ruta revalidable y en versión ligera**: `GET /api/routes/<id>` lleva `ETag`
  (= `rev`) y responde **304** si no ha cambiado, y con `?lite=1` devuelve el track
  decimado y las series remuestreadas a ~500 puntos (~20-30 KB en vez de ~350 KB),
  suficiente para mapa, perfil y stats.
- **`public_id` en las rutas planificadas**, como ya lo tenían rutas y fotos: la URL
  canónica es `/Plan/<public_id>` y la API es `/api/planned/<public_id>`. Los enlaces
  antiguos por nombre siguen funcionando (redirección 302).

### Cambiado
- **Sin dependencias de CDN**: MapLibre, Chart.js, PMTiles y las tres familias de fuentes
  se sirven desde `static/vendor/` y `static/fonts/`. Antes la app no cargaba entera en
  una LAN sin internet (fuentes de Google, scripts de unpkg/cdnjs).
- **Un solo motor de mapas**: el detalle de ruta planificada pasa de Leaflet a MapLibre,
  como el resto de la app.
- **Todos los mapas respetan la capa configurada**: el del dashboard llevaba las teselas
  a mano e ignoraba cualquier ajuste. Además, cada capa muestra ya su atribución (antes
  faltaba en el detalle y en el editor).
- **El detalle de un plan es la primera vista de la SPA nueva**: se sirve desde un shell
  único (`templates/shell.html`) con su lógica en `static/js/sec/plan.js`, en vez de una
  plantilla con los datos incrustados. Sus notas, nombre y actividad se pueden editar
  **sin conexión**: el cambio se encola y se envía al recuperarla.

### Interno
- `sync_seq` + `sync_log` mantenidos por **9 triggers de SQLite**, no por el código: las
  mutaciones están repartidas en 13 sitios y cualquier esquema del tipo "acuérdate de
  subir el contador aquí" se rompe en el primero que se olvide. Las tombstones no se
  purgan (~40 B por entidad) y un `sync_epoch` fuerza recarga completa si se restaura un
  backup. Migración y backfill idempotentes, re-ejecutables por los 2 workers.
- Frontend repartido en `static/js/core/` (`chrome.js`, `loader.js`, `router.js`,
  `store.js` con IndexedDB + cola de escrituras) y `static/js/sec/` (una sección por
  archivo). Siguen siendo scripts clásicos: **no hay paso de build**.
- Índices nuevos: `idx_planned_public_id`, `idx_planned_list_cov`, `idx_sync_log_rev`.
- `tests/test_sync.py` para la lógica pura de comparación de manifiestos y remuestreo.

### Pendiente (siguiente versión)
Migrar a secciones el detalle de ruta, dashboard, «Mis Rutas», «Mis Planes» y el editor;
solo entonces el listado deja de usar `sessionStorage` y pasa a leer del almacén local.
Después: PWA/Service Worker (arrancar sin servidor) y caché de teselas por zona.

## [0.5.2] — 2026-07-24

### Seguridad
- **Identificador público opaco para rutas y fotos**: las URLs de la API ya no exponen
  el id entero incremental (`/api/routes/1/thumb`, `/api/routes/2/thumb`…). Al ver la
  lista de rutas, el navegador pedía una miniatura por tarjeta con ids secuenciales y
  CrowdSec lo bloqueaba como intento de enumeración. Ahora cada ruta y cada foto llevan
  un `public_id` opaco no adivinable (`secrets.token_urlsafe(8)`, ~11 chars) y **todas**
  las URLs `/api/routes/<public_id>/...` y `/api/photos/<public_id>/...` lo usan. La PK
  entera queda **solo interna** (FKs, `versions/<route_id>/`, nombres de foto): no cambia
  nada del almacenamiento ni del versionado.
  - Migración automática en `init_db()`: columnas `public_id` (índices UNIQUE
    `idx_routes_public_id`/`idx_photos_public_id`) con backfill idempotente de las filas
    existentes; nuevo índice de cobertura `idx_routes_list_cov4`.
  - La caché del listado sube a `sendero_routes_v4` (se refresca sola en los clientes).
  - `planned_routes` queda igual (no es vector de enumeración: su lista va en una sola
    petición y navega por nombre).

## [0.5.1] — 2026-07-20

### Añadido
- **Localidad de cada ruta**: se muestra el sitio donde se hizo («Localidad, Región»)
  en la tarjeta de «Mis Rutas» y en el detalle. Se obtiene por geocoding inverso del
  punto de inicio (`core/geocode.py`) contra un servicio compatible con Nominatim,
  configurable en **Ajustes → Editor** (`GEOCODE_URL`; por defecto el Nominatim público
  de OSM, vacío = desactivado). Best-effort: si falla, la ruta se queda sin localidad
  sin romper la importación. Se rellena al importar y al **reescanear** una ruta que aún
  no la tenga (el «Re-escanear» masivo sirve de backfill para las rutas antiguas).
- **Distancia en el listado**: cada tarjeta de «Mis Rutas» muestra ya los km de la ruta.
- **Borrado masivo de duplicadas**: botón **«⚠ Borrar duplicados (N)»** en el modo edición
  de «Mis Rutas» (visible solo si hay rutas marcadas como posibles duplicadas). Selecciona
  las marcadas y las borra con el mismo confirmación + progreso que el borrado normal.

### Cambiado
- Tarjeta de ruta más compacta: los nombres de una sola línea ya no reservan altura de dos.

## [0.5.0] — 2026-07-17

### Añadido
- **Auto-importación desde Mi Fit / Zepp (Huami)**: descarga los entrenamientos del
  reloj (Amazfit/Zepp/Mi Fit) como GPX y los importa como rutas, sin exportar a mano.
  - Nuevo servicio `mifit-sync` en `docker-compose.yml` (proceso aparte, como el
    watcher): sincroniza por intervalo o bajo demanda y sube cada GPX por
    `POST /api/routes` (con miniatura y detección de actividad automáticas).
  - Sección **«Mi Fit / Zepp»** en Ajustes: apptoken de Huami, región/endpoint,
    intervalo (Manual/1 h/6 h/12 h/24 h), activar auto-sync, campo **«Importar
    desde»** (suelo de fecha, evita traerse todo el historial), **fecha y hora de la
    última sincronización**, botón **«↻ Sincronizar ahora»** (incremental) y
    **«⟳ Reimportar desde la fecha»** (reinicia la marca).
  - Cliente Huami vendorizado en `core/mifit/` (solo el camino GPX-por-token; añade
    `pydantic` a las dependencias). Los tipos indoor sin GPS se saltan solos.
  - Endpoints nuevos: `GET/POST /api/mifit/settings`, `POST /api/mifit/sync`
    (`{reset:true}` para reimportar), `GET /api/mifit/status`.
- **Deduplicación de importaciones** (subida manual, watcher y Mi Fit):
  - Dura por **SHA-256 de los bytes** (`content_hash`): reimportar el mismo archivo
    da 409 aunque cambie el nombre.
  - Blanda por **huella semántica** (`signature`: fecha al minuto + distancia + puntos
    extremos): pilla el mismo track reexportado en otro formato. En la web pide
    confirmación; en la ingesta automática lo importa **marcado como «posible
    duplicada»** (`dup_suspect_of`) para revisión humana, nunca borra en silencio.
  - Aviso visual: badge **«⚠ posible duplicada»** en la tarjeta y banda en el detalle
    con **«Descartar aviso»**; editar la ruta también limpia el aviso.

### Cambiado
- El campo de fecha «Importar desde» respeta el tema oscuro (`appearance:none` +
  `color-scheme:dark`) con icono de calendario verde propio (funciona en Chromium y
  Firefox; el resaltado del día en el popup de Firefox no es recoloreable por CSS).
- La marca incremental de Mi Fit se persiste cada 10 rutas durante un backfill, para
  que una interrupción no obligue a re-descargar todo el historial.

## [0.4.0] — 2026-07-15

### Añadido
- **Interfaz móvil** (pantallas ≤600 px y dispositivos táctiles):
  - **Tab bar inferior** en la SPA (Dashboard · Rutas · Planes · Ajustes) con
    soporte de *safe areas* (notch/gestos); sustituye a la navegación del header,
    que en móvil quedaba oculta sin alternativa.
  - **Botón flotante (＋)** para añadir rutas y planificar (en móvil no existe el
    arrastrar-y-soltar de archivos).
  - **Filtros de «Mis Rutas» colapsables** tras un botón «☰ Filtros»; la Vista B
    «Panel» se fuerza a Cuadrícula en móvil.
  - **Lightbox táctil**: swipe para cambiar de foto, cierre con tap en el fondo y
    foto a pantalla completa.
  - **Modal Immich a pantalla completa** en móvil, con cierre por fondo y Escape
    (también el selector de actividad).
  - **Menú «⋯»** en el detalle de ruta que agrupa las acciones secundarias
    (reescanear, GPX, renombrar, eliminar).
  - **Editor en móvil (subconjunto)**: botones ＋/−/⤢ de zoom en las gráficas
    (sustituto táctil de la rueda) y manejadores A/B más grandes. El modo
    «Editar puntos» se oculta en táctil (requiere ratón: arrastre fino,
    Alt+click, Shift+click).
  - Modal de **Ajustes a pantalla completa** con pestañas horizontales y tablas
    con scroll lateral.

### Cambiado
- Breakpoints unificados del proyecto: 900 px (tablet) y 600 px (móvil).
- Targets táctiles ≥40-44 px y barra de edición fija sobre la tab bar en móvil
  (vía `@media (hover:none) and (pointer:coarse)`).
- Las gráficas (detalle, plan y editor) pasan a `maintainAspectRatio:false` con
  contenedor de altura fija: en pantallas estrechas ya no quedan diminutas.
- Alturas de mapa relativas al viewport (`dvh` con fallback `vh`) en todas las
  páginas; inputs a 16 px en móvil para evitar el auto-zoom de iOS Safari.
- El botón de borrar miniaturas de fotos es siempre visible en táctil (antes
  solo aparecía con *hover* y era inaccesible).
- El cuadro flotante del hover del mapa del detalle ya no desborda por la
  derecha en pantallas estrechas; el crosshair de las gráficas también se limpia
  al terminar el toque.
- El datepicker de filtros se ajusta al viewport y agranda sus celdas en táctil.

## [0.3.0] — 2026-07-05

### Añadido
- **Editor de rutas** con versionado append-only (fases 1-3): recortar inicio/fin,
  eliminar tramos, invertir, editar vértices (mover / insertar / borrar),
  simplificar (Douglas-Peucker con preview), corregir picos de elevación y saltos
  de GPS, dividir ruta en dos y unir rutas. Historial de versiones restaurable;
  el archivo activo es siempre idéntico a la versión más alta.
- **Avisos GPS**: detección de tramos con velocidad, desnivel o altitud imposibles
  según umbrales por actividad (Ajustes → «GPS incorrecto»), con bandas en las
  gráficas, tramos rojos en el mapa y botones «Corregir» / «Corregir todo». Panel
  del editor con estados (activo / corregido) y aviso al haber cambios sin guardar.
- **Panel «Detalles» en el editor**: renombrar la ruta y editar el dispositivo que
  la grabó sin salir del editor.
- **Elevación desde DEM**: recalcular la altimetría contra un OpenTopoData
  configurable (Ajustes → Editor).
- **Waypoints** editables sobre el track (añadir, mover, renombrar, borrar).
- **Planificador externo configurable** (por defecto brouter-web) para «Dibujar
  ruta nueva».
- **Umbrales GPS por actividad** personalizables desde Ajustes.
- Versión de la aplicación visible en Ajustes y en `/api/config`.

### Cambiado
- La re-detección de actividad y de dispositivo ahora **conserva** el valor ya
  guardado cuando el re-parseo no lo recupera (evita perder lo elegido a mano).
- `refresh_config()` se ejecuta por request para que los dos workers de gunicorn
  no queden con ajustes desincronizados.
- `docker-compose.prod.yml` apunta a la imagen publicada `xinux87/sendero`.

### Corregido
- Documentado que la API key de Immich necesita el permiso **`asset.view`** además
  de `asset.read`: sin él la búsqueda funciona pero las miniaturas dan `502`.

## [0.2.0] — 2026-07

### Añadido
- **SPA** con cabecera persistente entre Dashboard, Mis Rutas y Mis Planes, con
  animación de transición.
- **Dashboard** con analíticas globales (totales por actividad y por año) y caché
  de estadísticas.
- **Mapas MapLibre GL** con clustering, iconos por actividad y capas base
  seleccionables; mapa de rutas en el dashboard con filtros por año/actividad.
- **Miniaturas de track** (PNG) por ruta.
- **Panel de ajustes** persistente accesible desde la cabecera; tipos de GPX
  personalizados.
- Drag & drop global de GPX/FIT; botones Descargar/Ver GPX en el detalle.

### Cambiado
- Rendimiento: índices de cobertura en SQLite, carga del mapa por bbox y scroll
  infinito en el listado de rutas.
- Se eliminó la importación de rutas desde URL de Wikiloc.

## [0.1.0] — 2026-06-27

### Añadido
- Primera versión de Sendero: subida y visualización de **GPX y FIT**, parseo de
  estadísticas y perfil de elevación, asociación de **fotos locales** y de
  **Immich** (por referencia), detalle de ruta con mapa y notas, y despliegue con
  Docker (servicios `sendero` + `watcher`).
