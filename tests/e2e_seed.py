"""Siembra un Sendero de pruebas con rutas y un plan sintéticos (para tests/e2e_spa.py).

    python tests/e2e_seed.py http://localhost:8124

El servidor debe estar arrancado con un SENDERO_DATA **de pruebas**, no el real:

    SENDERO_DATA=/tmp/sendero-e2e python app.py

Las rutas son deterministas y cubren los caminos que necesita la suite: una con
puntos cada 10 s (dentro de SPEED_WINDOW_S, así que tiene curva de velocidad) y
otra cada 20 s (sin curva: el parser la deja vacía a propósito, ver
tests/test_parsers.py). Todas llevan <time> y FC, para que salgan las 3 gráficas.
"""
import sys, time, urllib.request, urllib.error, json, datetime as dt

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8124"


def gpx(name, n=120, lat0=42.60, lon0=-1.60, ele0=800.0, ele_step=6.0,
        start="2026-05-01T09:00:00", step_s=30, tipo="hiking", hr=True):
    t0 = dt.datetime.fromisoformat(start)
    pts = []
    for i in range(n):
        # una "montaña": sube y baja, con una curva en el trazado
        ele = ele0 + (ele_step * i if i < n // 2 else ele_step * (n - i))
        lat = lat0 + i * 0.0006
        lon = lon0 + i * 0.0004 + (0.0008 if n // 3 < i < 2 * n // 3 else 0)
        ts = (t0 + dt.timedelta(seconds=i * step_s)).strftime("%Y-%m-%dT%H:%M:%SZ")
        ext = (f'<extensions><gpxtpx:TrackPointExtension>'
               f'<gpxtpx:hr>{110 + i % 40}</gpxtpx:hr>'
               f'</gpxtpx:TrackPointExtension></extensions>') if hr else ''
        pts.append(f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}">'
                   f'<ele>{ele:.1f}</ele><time>{ts}</time>{ext}</trkpt>')
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
    ]
    creadas = []
    for nombre, kw in rutas:
        code, data = post_gpx(nombre, gpx(nombre, **kw))
        print(f"  {code}  {nombre} -> {data.get('public_id') or data}")
        if code == 201:
            creadas.append(data["public_id"])
    # un plan, para probar la sección plan del shell
    code, data = post_gpx("Travesía pendiente de hacer",
                          gpx("Travesía pendiente de hacer", n=80, lat0=43.0, lon0=-2.0),
                          "/api/planned")
    print(f"  {code}  plan -> {data.get('public_id') or data}")
    print(json.dumps({"rutas": creadas, "plan": data.get("public_id")}))
