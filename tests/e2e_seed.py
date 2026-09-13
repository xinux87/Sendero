"""Siembra un Sendero de pruebas con rutas y planes sintéticos (para tests/e2e_spa.py).

    python tests/e2e_seed.py http://localhost:8124

El servidor debe estar arrancado con un SENDERO_DATA **de pruebas**, no el real:

    SENDERO_DATA=/tmp/sendero-e2e python app.py

Las rutas son deterministas y cubren los caminos que necesita la suite: una con
puntos cada 10 s (dentro de SPEED_WINDOW_S, así que tiene curva de velocidad) y
otra cada 20 s (sin curva: el parser la deja vacía a propósito, ver
tests/test_parsers.py). Todas llevan <time> y FC, para que salgan las 3 gráficas.
Los dos PLANES, en cambio, van sin <time>: un recorrido que no se ha hecho no
tiene horas, y de eso depende que el editor esconda las herramientas del tiempo.
"""
import sys, time, urllib.request, urllib.error, json, datetime as dt

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8124"


def gpx(name, n=120, lat0=42.60, lon0=-1.60, ele0=800.0, ele_step=6.0,
        start="2026-05-01T09:00:00", step_s=30, tipo="hiking", hr=True,
        dlat=0.0006, dlon=0.0004, times=True):
    """GPX sintético. `times=False` lo deja SIN <time>, que es como son casi
    todos los planes (un recorrido que no se ha hecho todavía no tiene horas):
    es lo que hace que el editor esconda «Corregir velocidad excesiva» y
    «Desplazar tiempos», y lo comprueba el bloque «Planificación editable»."""
    t0 = dt.datetime.fromisoformat(start)
    pts = []
    for i in range(n):
        # una "montaña": sube y baja, con una curva en el trazado
        ele = ele0 + (ele_step * i if i < n // 2 else ele_step * (n - i))
        lat = lat0 + i * dlat
        lon = lon0 + i * dlon + (dlon * 2 if n // 3 < i < 2 * n // 3 else 0)
        ts = (t0 + dt.timedelta(seconds=i * step_s)).strftime("%Y-%m-%dT%H:%M:%SZ")
        tag = f'<time>{ts}</time>' if times else ''
        ext = (f'<extensions><gpxtpx:TrackPointExtension>'
               f'<gpxtpx:hr>{110 + i % 40}</gpxtpx:hr>'
               f'</gpxtpx:TrackPointExtension></extensions>') if hr and times else ''
        pts.append(f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}">'
                   f'<ele>{ele:.1f}</ele>{tag}{ext}</trkpt>')
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<gpx version="1.1" creator="pruebas-e2e" xmlns="http://www.topografix.com/GPX/1/1" '
            f'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">'
            f'<trk><name>{name}</name><type>{tipo}</type><trkseg>{"".join(pts)}</trkseg></trk></gpx>')


def post_gpx(name, body, endpoint="/api/routes"):
    boundary = "----senderoE2E"
    field = "gpx"
    payload = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{name}.gpx"\r\n'
        f"Content-Type: application/gpx+xml\r\n\r\n{body}\r\n--{boundary}--\r\n"
    ).encode()
    req = urllib.request.Request(BASE + endpoint, data=payload, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


if __name__ == "__main__":
    rutas = [
        # 10 s entre puntos: dentro de SPEED_WINDOW_S (15 s), así que SÍ hay curva
        # de velocidad. Con pasos mayores el parser la deja vacía a propósito
        # (ver tests/test_parsers.py), y de eso se encarga la 3ª ruta.
        ("Subida al Monte Perdido", dict(n=140, tipo="hiking", step_s=10,
                                        start="2026-05-02T08:00:00")),
        ("Vuelta en bici por el valle", dict(n=200, tipo="cycling", lat0=42.30, lon0=-1.90,
                                             start="2026-04-18T10:30:00", step_s=15, ele_step=2.0)),
        ("Carrera matinal por el río", dict(n=90, tipo="running", lat0=42.81, lon0=-1.64,
                                            start="2026-03-07T07:15:00", step_s=20, ele_step=1.0)),
        # Ruta de ALTA MONTAÑA, y no es decorativa: la vista 3D solo se rompía por
        # encima de ~1500 m, porque con exageración 1.5 la superficie del terreno
        # sube por encima de la cámara. Sin una ruta así, el test del 3D pasaba
        # igual con el código roto. Coordenadas reales (Andorra) para que el DEM
        # de verdad devuelva altitudes de verdad.
        # El span importa tanto como la altitud: fitBounds tiene que dejar el zoom
        # alto (~14), que es donde la cámara queda cerca del terreno. Con una ruta
        # extendida el encuadre se aleja y el fallo no aparece.
        ("Pico de alta montaña", dict(n=200, tipo="hiking", lat0=42.6050, lon0=1.5500,
                                      ele0=1950.0, ele_step=6.0, step_s=10,
                                      dlat=0.000025, dlon=0.00015,
                                      start="2026-07-11T07:00:00")),
    ]
    creadas = []
    for nombre, kw in rutas:
        code, data = post_gpx(nombre, gpx(nombre, **kw))
        print(f"  {code}  {nombre} -> {data.get('public_id') or data}")
        if code == 201:
            creadas.append(data["public_id"])
    # DOS planes, y el orden de creación importa: /api/planned ordena por
    # created_at DESC, así que el último creado es planes[0] —el que usan los
    # bloques que ya existían—. Ninguno lleva <time>, que es lo normal en un plan.
    #
    # El primero es de ALTA MONTAÑA por el mismo motivo que la ruta de Andorra: la
    # vista 3D solo se rompía por encima de ~1500 m. También es el segundo plan que
    # necesita «unir» (POST /api/planned/merge).
    planes = []
    for nombre, kw in [
        ("Ascensión pendiente en Andorra", dict(n=120, lat0=42.5720, lon0=1.4990,
                                                ele0=1900.0, ele_step=6.0,
                                                dlat=0.000030, dlon=0.00016)),
        ("Travesía pendiente de hacer", dict(n=80, lat0=43.0, lon0=-2.0)),
    ]:
        code, data = post_gpx(nombre, gpx(nombre, times=False, **kw), "/api/planned")
        print(f"  {code}  plan -> {data.get('public_id') or data}")
        if code == 201:
            planes.append(data["public_id"])
    print(json.dumps({"rutas": creadas, "plan": planes[-1] if planes else None,
                      "planes": planes}))
