# Sendero

Bitácora autoalojada de rutas de montaña. **Una sola app** que cubre lo que pediste:

- **Visualizar rutas** GPX en mapa topográfico (OpenTopoMap) con perfil de elevación.
- **Estadísticas automáticas**: distancia, desnivel +/−, tiempo en movimiento, velocidad media, altitud máx/mín.
- **Fotos por ruta**: súbelas y, si llevan GPS en el EXIF, se sitúan solas sobre el mapa.
- **Resumen** de cada salida: uno automático con las cifras + tus notas libres.

Sin Immich, sin Wanderer, sin AdventureLog. Backend Flask + SQLite, todo en un contenedor. **Immich es opcional**: si lo activas, al abrir una ruta puedes buscar en tu Immich las fotos tomadas durante esa salida y elegir cuáles asociar (no se copian: se enlazan por referencia, Immich sigue siendo tu fototeca).

## Conectar con Immich (opcional)

1. En Immich: **Cuenta → Configuración de la cuenta → Claves de API** → crea una clave.
2. Pon estas variables (en un archivo `.env` junto al `docker-compose.yml`, o exportadas):

```
IMMICH_URL=http://IP-DE-TU-IMMICH:2283
IMMICH_API_KEY=la-clave-que-creaste
IMMICH_MARGIN_MIN=180     # margen, en minutos, antes y después del track
```

Con eso, en cada ruta aparece el botón **⛰ Buscar en Immich**. Sendero toma la hora de inicio y fin del GPX, añade el margen, pregunta a Immich qué fotos se tomaron en esa ventana y te las muestra para seleccionar. Las que tienen GPS se marcan y aparecen sobre el mapa. Las miniaturas se sirven a través de Sendero (proxy), así que tu navegador no necesita acceso directo a Immich ni la API key.

> Cómo funciona el cruce: por **tiempo**, usando las marcas del track y el EXIF de las fotos en Immich. Por eso es importante que el reloj y el teléfono/cámara tengan la hora bien sincronizada.


## Arrancar

```bash
docker compose up -d --build
# abre http://localhost:8080
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
│   └── index.html      # interfaz (Leaflet + Chart.js, autocontenida)
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
| `GET`  | `/api/config` | indica si Immich está activo |
| `GET`  | `/api/routes/{id}/immich/candidates` | fotos de Immich en la ventana del track |
| `POST` | `/api/routes/{id}/immich/select` | asocia los assets de Immich elegidos |

El endpoint `POST /api/routes` permite automatizar la importación: un script que vigile la carpeta de Syncthing puede hacer `curl -F "gpx=@ruta.gpx"` por cada archivo nuevo.

## Limitaciones honestas (lo que NO es)

- **No es un gestor de fotos.** No hace miniaturas optimizadas, ni álbumes, ni reconocimiento, ni subida automática desde el carrete. Si quieres eso, usa Immich y conserva Sendero solo para las rutas.
- **Sin usuarios ni login.** Pensado para uso personal en tu red. No lo expongas a internet sin poner delante un proxy con autenticación (p. ej. Authelia / Caddy con basic-auth).
- **La correlación de fotos** usa el GPS del EXIF. Si tus fotos no llevan coordenadas, se muestran en la galería pero no en el mapa.

## Próximos pasos posibles

- Interpolar sobre el mapa la posición de las fotos sin GPS usando su hora contra el track.
- Vista de calendario / estadísticas anuales (km y desnivel acumulados).

Dime cuál te interesa y lo añado.
