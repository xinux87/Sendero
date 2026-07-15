# Changelog

Todas las novedades relevantes de Sendero. El formato sigue de forma laxa
[Keep a Changelog](https://keepachangelog.com/es/) y el versionado es
[SemVer](https://semver.org/lang/es/). La versión activa se muestra al pie del
panel de Ajustes y en `GET /api/config`.

## [Sin publicar]

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
