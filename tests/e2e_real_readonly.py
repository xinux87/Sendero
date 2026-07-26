"""Comprobación de SOLO LECTURA contra la instalación real.  Ejecutar:

    SENDERO_E2E_URL=http://localhost:8090 /tmp/pw/bin/python tests/e2e_real_readonly.py

A diferencia de tests/e2e_spa.py, esta se puede lanzar contra los datos DE VERDAD:
no crea, no edita y no borra nada — solo navega y mide. Es la que dice si la SPA
aguanta el volumen real (cientos de rutas), que es lo que un entorno sembrado con
3 rutas sintéticas no puede contestar.

No crea, no edita, no borra.

Mide lo que el entorno sintético de 3 rutas no puede decir: que el listado, los
mapas y el modo sin conexión aguantan el volumen real de la instalación.
"""
import re, base64, time, sys
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("SENDERO_E2E_URL", "http://localhost:8123")
TESELA_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB/0lEQVR42u3TMQ0AQAjAwOdN"
    "sDDiXyMzGriT0KSRXQ+u+hJgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAM"
    "AAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABg"
    "ADAAGAADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHA"
    "AGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAADAAGAAOA"
    "AcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgA"
    "DAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAANgADAAGAAMAAYAA4ABwABgADAA"
    "GAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4AB"
    "wABgADAAGAAMAAYAA4ABwABgADAAGAAMgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgAD"
    "gAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAY"
    "AAwABgADwDaT1AJXxdDk9AAAAABJRU5ErkJggg==")

fallos = []


def ok(c, m):
    print(("  OK   " if c else "  FALLA ") + m)
    if not c:
        fallos.append(m)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 950})
    ctx.route(re.compile(r"^(?!" + re.escape(BASE) + r")"),
              lambda r, q: r.fulfill(status=200, content_type="image/png", body=TESELA_PNG))
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:160]))
    # Mismo criterio que tests/e2e_spa.py: las teselas de terceros y los fallos de
    # red del tramo sin conexión son ruido esperado, no errores de la app.
    RUIDO = ("ERR_INTERNET_DISCONNECTED", "Failed to load resource", "net::ERR")
    pg.on("console", lambda m: errs.append(m.text[:160])
          if m.type == "error"
          and "maplibre-gl-" not in ((m.location or {}).get("url", "") + m.text)
          and not any(r in m.text for r in RUIDO)
          else None)

    t0 = time.time()
    pg.goto(BASE + "/rutas", wait_until="load")
    pg.wait_for_selector("#sec-rutas:not(.hidden)", timeout=30000)
    pg.wait_for_function("() => document.querySelectorAll('#sec-rutas .card').length > 0", timeout=60000)
    t_primera = time.time() - t0
    total = pg.evaluate("async () => (await Store.routes()).length")
    tarjetas = pg.locator("#sec-rutas .card").count()
    print(f"\n== Datos reales: {total} rutas ==")
    ok(total >= 40, f"el Store carga el listado real ({total} rutas)")
    ok(tarjetas <= 60, f"scroll infinito: solo se pintan las primeras ({tarjetas} de {total})")
    ok(t_primera < 20, f"primera carga hasta ver tarjetas: {t_primera:.1f} s")
    ok(str(total) in pg.text_content("#count"), f"el contador dice «{pg.text_content('#count')}»")

    for _ in range(6):
        pg.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        pg.wait_for_timeout(400)
    mas = pg.locator("#sec-rutas .card").count()
    ok(mas >= tarjetas, f"al hacer scroll se añaden más tarjetas ({tarjetas} -> {mas})")

    pedidas = []
    pg.on("request", lambda r: pedidas.append(r.url)
          if r.url.rstrip("/").endswith("/api/routes") else None)
    t0 = time.time()
    pg.evaluate("window.go('/dashboard')")
    pg.wait_for_selector("#sec-dashboard:not(.hidden)", timeout=30000)
    pg.wait_for_function("() => document.querySelector('#ov-total-routes').textContent !== '-'"
                         " && document.querySelector('#ov-total-routes').textContent.trim() !== ''",
                         timeout=40000)
    t_dash = time.time() - t0
    ok(t_dash < 12, f"cambiar al dashboard: {t_dash:.1f} s")
    ok(len(pedidas) == 0, f"no se vuelve a pedir /api/routes ({len(pedidas)} peticiones)")
    dash_total = pg.text_content("#ov-total-routes").strip().replace(".", "")
    ok(dash_total == str(total), f"el dashboard cuadra con el listado ({dash_total} vs {total})")
    ok(pg.locator("#sec-dashboard .record-card").count() >= 1,
       f"hay récords personales ({pg.locator('#sec-dashboard .record-card').count()})")

    pid = pg.evaluate("async () => (await Store.routes())[0].public_id")
    t0 = time.time()
    pg.evaluate(f"window.go('/Sendero/{pid}')")
    pg.wait_for_selector("#sec-detalle:not(.hidden)", timeout=30000)
    pg.wait_for_function("() => document.querySelectorAll('#d-map .maplibregl-marker').length >= 2",
                         timeout=40000)
    t_det = time.time() - t0
    ok(t_det < 15, f"abrir el detalle de una ruta real: {t_det:.1f} s")
    ok(pg.text_content("#d-name").strip() != "",
       f"pinta «{pg.text_content('#d-name').strip()[:40]}»")
    ok(pg.evaluate("() => !!Chart.getChart(document.querySelector('#d-elev'))"),
       "con su perfil de elevacion")
    fotos = pg.locator("#d-gallery .thumb").count()
    print(f"       (esta ruta tiene {fotos} foto(s) en la galeria)")

    pg.evaluate("window.go('/rutas')")
    pg.wait_for_selector("#sec-rutas:not(.hidden)", timeout=30000)
    pg.wait_for_function("() => document.querySelector('#overview-map canvas') !== null", timeout=30000)
    pg.wait_for_timeout(3500)
    ok(True, "el mapa de Mis Rutas se pinta con el volumen real")

    pg.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=40000)
    ctx.set_offline(True)
    pg.goto(BASE + "/rutas", wait_until="load")
    pg.wait_for_selector("#sec-rutas:not(.hidden)", timeout=30000)
    pg.wait_for_function("() => document.querySelectorAll('#sec-rutas .card').length > 0", timeout=30000)
    ncards = pg.locator("#sec-rutas .card").count()
    ok(ncards > 0, f"SIN CONEXION el listado real se pinta ({ncards} tarjetas)")
    ok("sin conexion" in pg.text_content("#net-badge").lower().replace("ó", "o"),
       f"y el badge lo indica: «{pg.text_content('#net-badge').strip()}»")
    pg.goto(BASE + f"/Sendero/{pid}", wait_until="load")
    pg.wait_for_selector("#sec-detalle:not(.hidden)", timeout=30000)
    pg.wait_for_function("() => document.querySelector('#d-name').textContent.trim().length > 0",
                         timeout=30000)
    ok(True, "SIN CONEXION el detalle ya visitado se pinta")
    ctx.set_offline(False)

    print(f"\nerrores de JS: {errs[:4] if errs else 'ninguno'}")
    if errs:
        fallos.append("errores de JS")
    b.close()

print("\n" + "=" * 60)
print("  TODO OK" if not fallos else f"  {len(fallos)} fallo(s): {fallos}")
sys.exit(1 if fallos else 0)
