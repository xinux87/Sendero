# Sendero

Bitácora autoalojada de rutas de montaña. **Una sola app** que cubre lo que pediste:

- **Visualizar rutas** GPX en mapa topográfico (OpenTopoMap) con perfil de elevación.
- **Estadísticas automáticas**: distancia, desnivel +/−, tiempo en movimiento, velocidad media, altitud máx/mín.
- **Fotos por ruta**: súbelas y, si llevan GPS en el EXIF, se sitúan solas sobre el mapa.
- **Resumen** de cada salida: uno automático con las cifras + tus notas libres.
- **Planificación**: sube GPX de rutas que quieres hacer y tenlas en una lista separada.

Sin Immich, sin Wanderer, sin AdventureLog. Backend Flask + SQLite, todo en un contenedor. **Immich es opcional**: si lo activas, al abrir una ruta puedes buscar en tu Immich las fotos tomadas durante esa salida y elegir cuáles asociar (no se copian: se enlazan por referencia, Immich sigue siendo tu fototeca).

## Conectar con Immich (opcional)

1. En Immich: **Cuenta → Configuración de la cuenta → Claves de API** → crea una clave.
   Dale al menos los permisos **`asset.read`** (buscar fotos) y **`asset.view`**
   (ver/descargar las miniaturas), o simplemente marca *todos los permisos*. Sin
   `asset.view` la búsqueda funciona y aparece el grid, pero **las miniaturas no
   cargan** (Immich responde con error de permisos y Sendero lo muestra como
   `502`); ver *Problemas frecuentes* más abajo.
2. En Sendero: botón **Ajustes** (cabecera) → sección Immich → pega la URL y la API key → Guardar.

Con eso, en cada ruta aparece el botón **⛰ Buscar en Immich**. Sendero toma la hora de inicio y fin del GPX, añade el margen configurado, pregunta a Immich qué fotos se tomaron en esa ventana y te las muestra para seleccionar. Las que tienen GPS se marcan automáticamente si están a menos de la distancia configurada del track; las demás se muestran siempre (muchas fotos de montaña no llevan coordenadas). Las miniaturas se sirven a través de Sendero (proxy), así que tu navegador no necesita acceso directo a Immich ni la API key.

Los ajustes se guardan en la base de datos y persisten entre reinicios. Si prefieres configurarlos como variables de entorno (útil para despliegues automatizados), puedes usar `IMMICH_URL`, `IMMICH_API_KEY`, `IMMICH_MARGIN_MIN` e `IMMICH_DIST_M`; la BD tiene prioridad si el valor también está guardado ahí.

> Cómo funciona el cruce: por **tiempo**, usando las marcas del track y el EXIF de las fotos en Immich. Por eso es importante que el reloj y el teléfono/cámara tengan la hora bien sincronizada.

### Problemas frecuentes con Immich

- **La búsqueda encuentra fotos y sale el grid, pero las miniaturas dan `502`
  (y no cargan).** La API key no tiene el permiso **`asset.view`**. Búsqueda y
  miniaturas usan permisos distintos: buscar solo necesita `asset.read`, pero
  servir cada imagen exige `asset.view`. Edita la clave en Immich (o crea una
  nueva) añadiendo `asset.view` — o marca todos los permisos — y vuelve a
  guardarla en Ajustes. No tiene que ver con exponer Sendero a internet ni con el
  reverse proxy: las miniaturas siempre las sirve el backend de Sendero por proxy,
  el navegador nunca habla con Immich.


## Arrancar

```bash
docker compose up -d --build
# abre http://localhost:8090   (el puerto host está en docker-compose.yml)
```

Los datos (GPX, fotos y base de datos) se guardan en `./data`, montado como volumen. Para mover la instalación a otro equipo, copia esa carpeta.

Sin Docker:

```bash
pip install -r requirements.txt
python app.py          # http://localhost:8080
```

## Cómo encaja con tu Amazfit T-Rex 3 Pro

1. En la app Zepp: abre el entrenamiento → menú `···` → **Exportar a GPX**.
2. El GPX queda en el teléfono. Con **Syncthing** sincronizas esa carpeta con el equipo donde corre Sendero (privado, sin nube).
3. En Sendero pulsas **+ Añadir ruta**, eliges el GPX y listo. O lo haces automático (abajo).

> El paso 1 sigue usando la app Zepp porque Gadgetbridge aún no extrae de forma fiable el track del T-Rex 3. Pero los archivos no salen de tu infraestructura.

## Importación automática (carpeta vigilada)

El servicio `watcher` del `docker-compose.yml` vigila la carpeta `./watch`. Apunta ahí tu carpeta sincronizada con Syncthing: cada GPX nuevo se sube solo a Sendero y se mueve a `./watch/imported/` (o a `./watch/failed/` si algo falla). Así, exportas en el reloj y la ruta aparece sola, sin tocar nada.

Variables (en el `docker-compose.yml`): `SENDERO_POLL` es cada cuántos segundos mira la carpeta (30 por defecto). El watcher espera a que el archivo deje de crecer antes de importarlo, para no pillar una copia de Syncthing a medias. Si no quieres importación automática, borra el servicio `watcher` del compose.

## Estructura

```
sendero/
├── app.py              # API REST + parseo GPX (gpxpy) + EXIF (Pillow) + SQLite + Immich
├── watch.py            # importador automático de carpeta (Syncthing)
├── templates/
│   ├── base.html           # cabecera, CSS compartido, modal de Ajustes
│   ├── dashboard.html      # lista de rutas + subida GPX
│   ├── sendero.html        # detalle de ruta: mapa, perfil, fotos, Immich
│   ├── planificacion.html  # lista de rutas planificadas
│   └── plan_detalle.html   # detalle de ruta planificada
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── data/               # volumen: sendero.db, gpx/, photos/
```

## API (por si quieres automatizar)

| Método | Ruta | Acción |
|--------|------|--------|
| `GET`  | `/api/routes` | lista de rutas |
| `POST` | `/api/routes` | sube un GPX (campo `gpx`) |
| `GET`  | `/api/routes/{id}` | detalle: stats, track, perfil, fotos |
| `PATCH`| `/api/routes/{id}` | renombrar / guardar notas |
| `DELETE`| `/api/routes/{id}` | borrar ruta |
| `POST` | `/api/routes/{id}/photos` | subir fotos locales (campo `photos`) |
| `GET`  | `/api/config` | indica si Immich está activo y la distancia de autoselección |
| `GET`  | `/api/settings` | leer ajustes actuales |
| `POST` | `/api/settings` | guardar ajustes (misma función que el modal Ajustes) |
| `GET`  | `/api/routes/{id}/immich/candidates` | fotos de Immich en la ventana del track |
| `POST` | `/api/routes/{id}/immich/select` | asocia los assets de Immich elegidos |
| `GET`  | `/api/planned` | lista de rutas planificadas |
| `POST` | `/api/planned` | añade una ruta planificada (campo `gpx`) |

El endpoint `POST /api/routes` permite automatizar la importación: un script que vigile la carpeta de Syncthing puede hacer `curl -F "gpx=@ruta.gpx"` por cada archivo nuevo.

## Limitaciones honestas (lo que NO es)

- **No es un gestor de fotos.** No hace miniaturas optimizadas, ni álbumes, ni reconocimiento, ni subida automática desde el carrete. Si quieres eso, usa Immich y conserva Sendero solo para las rutas.
- **Sin usuarios ni login.** Pensado para uso personal en tu red. No lo expongas a internet sin poner delante un proxy con autenticación (p. ej. Authelia / Caddy con basic-auth).
- **La correlación de fotos** usa el GPS del EXIF. Si tus fotos no llevan coordenadas, se muestran en la galería pero no en el mapa.
