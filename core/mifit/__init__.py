"""Cliente mínimo de la API de Huami (Mi Fit / Zepp) para auto-importar rutas.

Vendorizado desde roadmap/mifit exporter (solo el camino GPX-por-token):
- api.py    → cliente HTTP + modelos de historial/detalle de entrenamientos
- points.py → decodifica lat/lon/alt/hr/cadencia de un detalle a puntos
- gpx.py    → serializa esos puntos a un GPX 1.1 (con <time>/<ele>/<hr>)
- sync.py   → itera el historial y produce (trackid, nombre, gpx) de lo nuevo

La autenticación (obtener el apptoken vía navegador) NO se vendoriza aquí: vive
en el servicio aparte mifit-auth. Aquí el token se recibe ya resuelto.
"""
