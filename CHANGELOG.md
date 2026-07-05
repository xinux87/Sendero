# Changelog

Todas las novedades relevantes de Sendero. El formato sigue de forma laxa
[Keep a Changelog](https://keepachangelog.com/es/) y el versionado es
[SemVer](https://semver.org/lang/es/). La versión activa se muestra al pie del
panel de Ajustes y en `GET /api/config`.

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
