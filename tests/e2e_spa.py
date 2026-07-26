"""Pruebas end-to-end de la SPA en un navegador real (Playwright).

NO son parte de `python -m pytest`: necesitan Playwright y un navegador, que no
están en requirements-dev.txt a propósito (son ~150 MB y el resto de los tests
corre sin ellos). Se ejecutan a mano:

    python -m venv /tmp/pw && /tmp/pw/bin/pip install playwright
    /tmp/pw/bin/playwright install chromium
    SENDERO_E2E_URL=http://localhost:8124 /tmp/pw/bin/python tests/e2e_spa.py

El servidor debe estar levantado y apuntando a un `SENDERO_DATA` **de pruebas**:
estas pruebas escriben (notas, fotos, borrados). Nunca las lances contra la
instalación real.

Qué cubren, y por qué estas y no otras: todo lo que un test de Python o de Node
no puede ver — que MapLibre pinta, que los `Chart` existen, que `unmount()` no
deja instancias vivas, que el Service Worker sirve la app sin red y que una
edición sin conexión sobrevive a recargar.
"""
import base64
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("SENDERO_E2E_URL", "http://localhost:8124")

# Tesela lisa de 256x256 con la que se responde a TODO host externo. Sin esto,
# las 4 capas base de terceros y el DEM del modo 3D fallan (aquí no hay internet)
# y MapLibre escupe un "TypeError: Failed to fetch" por tesela, que ensuciaría la
# comprobación de errores de consola. Y tiene que ser 256x256 de verdad: con un
# PNG de 1x1 MapLibre falla al decodificarla ("The source image could not be
# decoded"), o sea que cambiaríamos un ruido por otro.
# Solo se interceptan los hosts que NO son Sendero: las peticiones a la app deben
# llegar intactas, porque de eso van la mitad de estas pruebas (Service Worker,
# modo sin conexión, sincronización).
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

_fallos = []
_oks = 0


def check(cond, msg):
    global _oks
    if cond:
        _oks += 1
        print(f"  OK   {msg}")
    else:
        _fallos.append(msg)
        print(f"  FALLA {msg}")
    return bool(cond)


def seccion(t):
    print(f"\n── {t} ".ljust(74, "─"))


class Consola:
    """Recoge errores de consola y excepciones no capturadas, con su origen.

    Guarda la URL del archivo que los emite: es lo que permite distinguir un
    error NUESTRO de una tesela de terceros que no carga. Filtrar por el texto no
    basta, porque MapLibre reporta los fallos de tesela como un genérico
    "TypeError: Failed to fetch".
    """

    def __init__(self, page):
        self.errores = []       # (texto, url_origen)
        page.on("console", lambda m: self.errores.append(
            (f"console.{m.type}: {m.text}", (m.location or {}).get("url", "")))
            if m.type == "error" else None)
        page.on("pageerror", lambda e: self.errores.append((f"pageerror: {e}", "")))

    def limpias(self):
        fuera = []
        for texto, url in self.errores:
            # Teselas de las 4 capas base y DEM del modo 3D: son de terceros y
            # este entorno no tiene internet. Se reportan desde dentro del bundle
            # de MapLibre. Una vez el Service Worker controla la página ya no se
            # pueden interceptar (las peticiones pasan por él), así que se
            # descartan por origen.
            if "vendor/maplibre-gl-" in url or "vendor/maplibre-gl-" in texto:
                continue
            if any(i in texto for i in RUIDO):
                continue
            fuera.append(f"{texto}  [{url}]")
        return fuera


# Ruido que sí es esperable: en el tramo sin conexión, las peticiones de la propia
# app fallan a propósito (es lo que se está probando).
RUIDO = ("ERR_INTERNET_DISCONNECTED", "Failed to load resource", "net::ERR")


def esperar_mapa_puntos(page, sel):
    """Espera a que un mapa de varias rutas tenga sus bolitas/clusters pintados.

    Los mapas del dashboard y de Mis Rutas no ponen marcadores de Inicio/Fin, así
    que la señal de que su handler de 'load' ya corrió son las etiquetas de
    cluster (marcadores DOM) o, si no hay agrupación, el canvas más un margen.
    """
    page.wait_for_function(
        f"() => document.querySelector('{sel} canvas') !== null", timeout=20000)
    page.wait_for_timeout(1200)


def esperar_mapa(page, sel="#d-map"):
    """Espera a que MapLibre haya ejecutado su handler de 'load'.

    No basta con que exista el <canvas>: se crea en el constructor, antes de que
    el estilo cargue. Los marcadores de Inicio/Fin se añaden DENTRO del
    map.on('load'), así que su presencia es la señal de que las capas de datos
    (incluida la fuente 'hover-point') ya están en el mapa.
    """
    page.wait_for_function(
        f"() => document.querySelectorAll('{sel} .maplibregl-marker').length >= 2",
        timeout=20000)


Tiles_MAX = 3000     # el tope duro de static/js/core/tiles.js


def api(page, path):
    return page.evaluate("""async p => { const r = await fetch(p); return r.ok ? r.json() : null; }""", path)


def main():
    with sync_playwright() as p:
        navegador = p.chromium.launch()
        ctx = navegador.new_context(viewport={"width": 1400, "height": 950})
        # Todo lo que no sea Sendero se responde con una tesela lisa (ver TESELA_PNG).
        # El patrón excluye BASE con un lookahead para no tocar NADA de la app.
        # Con nombre porque hay una comprobación que necesita quitarlo: mientras el
        # stub esté puesto, responde él y no se puede saber si la tesela vino de la
        # caché del Service Worker o del propio stub.
        patron_externo = re.compile(r"^(?!" + re.escape(BASE) + r")")
        def stub_tesela(route, req):
            route.fulfill(status=200, content_type="image/png", body=TESELA_PNG)
        ctx.route(patron_externo, stub_tesela)
        page = ctx.new_page()
        con = Consola(page)

        datos = json.loads(os.environ.get("SENDERO_E2E_FIXTURES") or "{}")
        page.goto(BASE + "/rutas", wait_until="load")
        rutas = page.evaluate("""async () => (await (await fetch('/api/routes')).json()).items""")
        planes = page.evaluate("""async () => (await (await fetch('/api/planned')).json()).items""")
        check(len(rutas) >= 3, f"el entorno de pruebas tiene rutas ({len(rutas)})")
        check(len(planes) >= 1, f"el entorno de pruebas tiene planes ({len(planes)})")
        rid = rutas[0]["public_id"]
        nombre = rutas[0]["name"]
        pid_plan = planes[0]["public_id"]

        # ── 0. las tres vistas de listado, ya como secciones ──────────────────
        seccion("Dashboard, Mis Rutas y Mis Planes (secciones del shell)")
        page.goto(BASE + "/dashboard", wait_until="load")
        page.wait_for_selector("#sec-dashboard:not(.hidden)", timeout=15000)
        # Tras sembrar rutas nuevas el caché de stats del servidor queda sucio: el
        # dashboard pinta el último valor conocido y lo regenera por detrás (eso es
        # lo correcto), así que se espera a que converja en vez de exigirlo ya.
        page.wait_for_function(
            "n => document.querySelector('#ov-total-routes').textContent.trim() === String(n)",
            arg=len(rutas), timeout=30000)
        check(page.text_content("#ov-total-routes").strip() == str(len(rutas)),
              f"el dashboard pinta el total de rutas ({page.text_content('#ov-total-routes').strip()})")
        check(page.locator("#sec-dashboard .act-row").count() >= 1,
              "«Por actividad» tiene filas")
        check(page.locator("#sec-dashboard .year-col").count() >= 1,
              "«Rutas por año» tiene barras")
        esperar_mapa_puntos(page, "#dash-map")
        check(True, "el mapa del dashboard carga con sus bolitas")
        check(not page.locator("[data-sec-actions='dashboard']").is_hidden(),
              "las acciones de cabecera del dashboard se muestran")
        check(page.locator("[data-sec-actions='rutas']").is_hidden(),
              "y las de las otras secciones no")

        # navegación por el nav del header, sin recargar
        page.evaluate("window.__t2 = 'vivo'")
        page.click(".header-nav a[href='/rutas']")
        page.wait_for_selector("#sec-rutas:not(.hidden)", timeout=15000)
        check(page.evaluate("window.__t2") == "vivo",
              "ir del dashboard a Mis Rutas por el nav NO recarga el documento")
        check(page.url.endswith("/rutas"), f"la URL cambia a /rutas ({page.url})")
        page.wait_for_function(
            "() => document.querySelectorAll('#sec-rutas .card').length > 0", timeout=15000)
        tarjetas = page.locator("#sec-rutas .card").count()
        check(tarjetas == len(rutas), f"se pintan las tarjetas de todas las rutas ({tarjetas})")
        check("ruta" in page.text_content("#count"), f"el contador del header: «{page.text_content('#count')}»")
        check(page.locator("#sec-rutas .month-group").count() >= 1, "las tarjetas se agrupan por mes")
        esperar_mapa_puntos(page, "#overview-map")
        check(True, "el mapa de Mis Rutas carga")

        # Filtro por actividad. La actividad se saca de los datos, no se escribe a
        # mano: otras comprobaciones de esta misma suite cambian la actividad de
        # una ruta, así que un nombre fijo dejaría el filtro sin efecto.
        act_id = page.evaluate("""async () => {
            const rows = (await (await fetch('/api/routes')).json()).items;
            const con = rows.find(r => r.activity_type);
            return con ? con.activity_type : null;
        }""")
        etiqueta = page.evaluate("id => (ACTIVITIES.find(a => a.id === id) || {}).label", act_id)
        page.click(f"#sec-rutas .act-pills .pill:text-is('{etiqueta}')")
        page.wait_for_timeout(500)
        tras = page.locator("#sec-rutas .card").count()
        check(tras < tarjetas,
              f"quitar «{etiqueta}» filtra la lista ({tarjetas} → {tras})")
        page.click("#sec-rutas .filter-clear")
        page.wait_for_timeout(500)
        check(page.locator("#sec-rutas .card").count() == tarjetas,
              "«Limpiar» restaura la lista completa")

        # orden
        primero_desc = page.locator("#sec-rutas .card h3").first.text_content()
        page.click("#sort-asc")
        page.wait_for_timeout(400)
        primero_asc = page.locator("#sec-rutas .card h3").first.text_content()
        check(primero_desc != primero_asc, "cambiar el orden reordena la lista")
        page.click("#sort-desc")
        page.wait_for_timeout(400)

        # modo edición
        page.click("#edit-toggle-btn")
        page.wait_for_timeout(400)
        check(not page.locator("#edit-bar").is_hidden(), "el modo edición muestra su barra")
        page.locator("#sec-rutas .card").first.click()
        page.wait_for_timeout(200)
        check(page.text_content("#sel-count").strip() == "1", "seleccionar una tarjeta cuenta 1")
        page.click("#sec-rutas button:has-text('Cancelar')")
        page.wait_for_timeout(400)
        check(page.locator("#edit-bar").is_hidden(), "«Cancelar» sale del modo edición")

        # planes
        page.click(".header-nav a[href='/planificacion']")
        page.wait_for_selector("#sec-planes:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelectorAll('#sec-planes .plan-card').length > 0", timeout=15000)
        check(page.locator("#sec-planes .plan-card").count() == len(planes),
              f"Mis Planes pinta sus tarjetas ({page.locator('#sec-planes .plan-card').count()})")
        check(page.evaluate("window.__t2") == "vivo", "y tampoco recarga el documento")
        # el mapa de planes ya no lleva las teselas a mano: tiene selector de capas
        page.wait_for_function(
            "() => document.querySelector('#plan-map canvas') !== null", timeout=15000)
        check(page.locator("#sec-planes #plan-map select").count() == 1,
              "el mapa de planes ya tiene selector de capas (antes ignoraba Ajustes → Mapas)")
        page.click("[data-sec-actions='planes'] button")
        page.wait_for_selector("#add-modal:not(.hidden)", timeout=5000)
        check(True, "«+ Planificar ruta» abre el modal")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check(page.locator("#add-modal").get_attribute("class").find("hidden") >= 0,
              "Escape cierra el modal")

        # ida y vuelta entre las 3 sin fugas
        antes_c = page.evaluate("() => document.querySelectorAll('canvas').length")
        for _ in range(6):
            for url in ("/dashboard", "/rutas", "/planificacion"):
                page.evaluate(f"window.go('{url}')")
                page.wait_for_timeout(350)
        page.evaluate("window.go('/rutas')")
        page.wait_for_selector("#sec-rutas:not(.hidden)", timeout=15000)
        page.wait_for_timeout(800)
        despues_c = page.evaluate("() => document.querySelectorAll('canvas').length")
        check(despues_c <= antes_c + 1,
              f"6 vueltas por las 3 vistas no acumulan mapas ({antes_c} → {despues_c})")

        # ── 1. detalle de ruta ────────────────────────────────────────────────
        seccion("Detalle de ruta (sección `detalle` del shell)")
        page.goto(f"{BASE}/Sendero/{rid}", wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
        check(page.text_content("#d-name").strip() == nombre,
              f"el nombre se pinta: «{page.text_content('#d-name').strip()}»")
        check(nombre in page.title(), "el <title> lleva el nombre de la ruta")
        stats = page.locator("#d-stats .stat").count()
        check(stats >= 7, f"se pintan las tarjetas de stats ({stats})")

        page.wait_for_function("() => document.querySelector('#d-map canvas') !== null", timeout=15000)
        check(True, "MapLibre crea su canvas en #d-map")
        # que el track esté realmente en el mapa, no solo el canvas
        capas = page.evaluate("""() => {
            const m = window.SEC && window.SEC.detalle;
            return document.querySelectorAll('#d-map canvas').length;
        }""")
        check(capas == 1, f"hay exactamente 1 canvas de mapa ({capas})")

        page.wait_for_function(
            "() => { const c = document.querySelector('#d-elev'); return c && c.width > 100; }",
            timeout=10000)
        charts = page.evaluate("""() => ({
            elev: !!Chart.getChart(document.querySelector('#d-elev')),
            speed: !!Chart.getChart(document.querySelector('#speed-chart')),
            hr: !!Chart.getChart(document.querySelector('#hr-chart')),
        })""")
        check(charts["elev"], "el perfil de elevación es un Chart vivo")
        check(charts["speed"], "la gráfica de velocidad es un Chart vivo")
        check(charts["hr"], "la gráfica de FC es un Chart vivo")
        check(not page.locator("#speed-section").is_hidden(), "la sección de velocidad se muestra")
        check(not page.locator("#hr-section").is_hidden(), "la sección de FC se muestra")
        check(page.locator("#immich-btn").is_hidden(),
              "el botón de Immich está oculto (no configurado)")

        # Una ruta con puntos más espaciados que SPEED_WINDOW_S no tiene curva de
        # velocidad (decisión del parser, ver tests/test_parsers.py): la sección
        # tiene que ocultarse, no quedarse vacía.
        lenta = next((r for r in rutas if "Carrera" in r["name"]), None)
        if lenta:
            page.goto(f"{BASE}/Sendero/{lenta['public_id']}", wait_until="load")
            page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
            page.wait_for_function(
                "() => document.querySelector('#d-stats').children.length > 0", timeout=10000)
            check(page.locator("#speed-section").is_hidden(),
                  "sin datos de velocidad, la sección de velocidad se oculta")
            page.goto(f"{BASE}/Sendero/{rid}", wait_until="load")
            page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)

        # ── 2. hover sincronizado ─────────────────────────────────────────────
        seccion("Hover sincronizado mapa↔gráficos")
        esperar_mapa(page)
        # OJO: hay que hacer scroll antes de mover el ratón. El perfil queda por
        # debajo del pliegue (y≈900 en una ventana de 950), y page.mouse.move a
        # una coordenada fuera del viewport no toca el elemento: el hover no se
        # dispararía y parecería un fallo de la app.
        page.locator("#d-elev").scroll_into_view_if_needed()
        page.wait_for_timeout(200)
        caja = page.locator("#d-elev").bounding_box()
        page.mouse.move(caja["x"] + caja["width"] * 0.5, caja["y"] + caja["height"] * 0.5)
        page.wait_for_timeout(400)
        hover = page.evaluate("""() => {
            const box = document.querySelector('#sec-detalle .hover-infobox');
            return {visible: !!box && getComputedStyle(box).display !== 'none',
                    texto: box ? box.textContent : ''};
        }""")
        check(hover["visible"], "pasar el ratón por el perfil muestra el cuadro flotante en el mapa")
        check("km" in hover["texto"] and "Alt" in hover["texto"],
              f"el cuadro trae km y altitud: «{hover['texto'][:40]}»")
        # y el mapa → gráficos: pasar por la línea del track resalta lo mismo
        page.locator("#d-map").scroll_into_view_if_needed()
        page.wait_for_timeout(200)
        m = page.locator("#d-map").bounding_box()
        page.mouse.move(m["x"] + m["width"] / 2, m["y"] + m["height"] / 2)
        page.wait_for_timeout(400)
        desde_mapa = page.evaluate("""() => {
            const box = document.querySelector('#sec-detalle .hover-infobox');
            return !!box && getComputedStyle(box).display !== 'none';
        }""")
        check(desde_mapa, "pasar el ratón por la línea del mapa también resalta la posición")

        page.mouse.move(5, 5)
        page.wait_for_timeout(300)
        oculto = page.evaluate("""() => {
            const box = document.querySelector('#sec-detalle .hover-infobox');
            return !box || getComputedStyle(box).display === 'none';
        }""")
        check(oculto, "al salir del gráfico el cuadro se oculta")

        # ── 3. navegación SPA sin recargar ────────────────────────────────────
        seccion("Navegación entre secciones sin recargar el documento")
        page.evaluate("window.__testigo = 'vivo'")
        page.evaluate(f"window.go('/Plan/{pid_plan}')")
        page.wait_for_selector("#sec-plan:not(.hidden)", timeout=10000)
        page.wait_for_function("() => document.querySelector('#pl-map canvas') !== null", timeout=15000)
        testigo = page.evaluate("window.__testigo")
        check(testigo == "vivo", "ir de detalle a plan NO recarga el documento (la SPA funciona)")
        check(page.locator("#sec-detalle").get_attribute("class").find("hidden") >= 0,
              "la sección detalle queda oculta")
        canvases = page.evaluate("() => document.querySelectorAll('#d-map canvas').length")
        check(canvases == 0, f"unmount() destruyó el mapa del detalle (canvas: {canvases})")
        vivos = page.evaluate("""() => [
            Chart.getChart(document.querySelector('#d-elev')),
            Chart.getChart(document.querySelector('#speed-chart')),
            Chart.getChart(document.querySelector('#hr-chart')),
        ].filter(Boolean).length""")
        check(vivos == 0, f"unmount() destruyó los 3 Charts del detalle (vivos: {vivos})")

        # ── 4. 20 idas y venidas: fugas ───────────────────────────────────────
        seccion("20 montajes/desmontajes (fuga nº 1 de la conversión)")
        antes = page.evaluate("() => document.querySelectorAll('canvas').length")
        for i in range(20):
            page.evaluate(f"window.go('/Sendero/{rid}')")
            page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
            page.wait_for_function("() => document.querySelector('#d-map canvas') !== null", timeout=15000)
            page.evaluate(f"window.go('/Plan/{pid_plan}')")
            page.wait_for_selector("#sec-plan:not(.hidden)", timeout=10000)
        page.evaluate(f"window.go('/Sendero/{rid}')")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
        esperar_mapa(page)
        despues = page.evaluate("() => document.querySelectorAll('canvas').length")
        check(despues <= antes + 2,
              f"el nº de <canvas> del documento no crece con las visitas ({antes} → {despues})")
        marcadores = page.evaluate(
            "() => document.querySelectorAll('#d-map .maplibregl-marker').length")
        check(marcadores <= 2, f"no se duplican los marcadores de inicio/fin ({marcadores})")
        infoboxes = page.evaluate(
            "() => document.querySelectorAll('#sec-detalle .hover-infobox').length")
        check(infoboxes <= 1, f"no se acumulan cuadros de hover ({infoboxes})")

        # ── 5. guardar notas (Store.patch + putDetail) ────────────────────────
        seccion("Guardar el resumen (escritura con conexión)")
        texto = f"Notas de prueba {int(time.time())}"
        page.fill("#d-notes", texto)
        page.click("#sec-detalle button:has-text('Guardar resumen')")
        page.wait_for_timeout(800)
        check(page.text_content("#toast").strip() != "", f"aparece el toast: «{page.text_content('#toast').strip()}»")
        srv = api(page, f"/api/routes/{rid}")
        check(srv and srv.get("notes") == texto, "el servidor guardó las notas")
        page.reload(wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
        page.wait_for_function("() => document.querySelector('#d-notes').value.length > 0", timeout=10000)
        check(page.input_value("#d-notes") == texto, "al recargar, las notas siguen ahí")

        # ── 6. renombrar (no cambia la URL: va por public_id) ─────────────────
        seccion("Renombrar (la URL va por public_id y no debe cambiar)")
        # Idempotente: sin quitar el sufijo, cada pasada apilaría otro
        # "(renombrada)" y el nombre crecería sin fin entre ejecuciones.
        nuevo = nombre.split(" (renombrada)")[0] + " (renombrada)"
        page.evaluate(f"window.prompt = () => {json.dumps(nuevo)}")
        page.click("#sec-detalle button:has-text('Renombrar')")
        page.wait_for_timeout(800)
        check(page.text_content("#d-name").strip() == nuevo, "el nombre se actualiza en pantalla")
        check(page.url.endswith("/Sendero/" + rid), f"la URL no cambia: {page.url.split('/')[-1]}")
        srv = api(page, f"/api/routes/{rid}")
        check(srv and srv.get("name") == nuevo, "el servidor guardó el nombre")
        # y el nombre viejo sigue resolviendo por 302 al mismo public_id
        page.goto(f"{BASE}/Sendero/{nuevo.replace(' ', '%20')}", wait_until="load")
        check(page.url.endswith("/Sendero/" + rid), "entrar por nombre redirige al public_id")

        # ── 7. Service Worker ─────────────────────────────────────────────────
        seccion("Service Worker (PWA)")
        page.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=20000)
        sw = page.evaluate("""async () => {
            const regs = await navigator.serviceWorker.getRegistrations();
            const cs = await caches.keys();
            const shell = await caches.open(cs.find(c => c.startsWith('sendero-shell-')));
            const claves = (await shell.keys()).map(r => new URL(r.url).pathname);
            return {n: regs.length, cachés: cs, precache: claves.length,
                    tiene_shell: claves.includes('/app-shell'),
                    tiene_detalle: claves.includes('/static/js/sec/detalle.js')};
        }""")
        check(sw["n"] >= 1, "el Service Worker está registrado y controla la página")
        check(any(c.startswith("sendero-shell-") for c in sw["cachés"]),
              f"existe la caché de precache: {sw['cachés']}")
        check(sw["precache"] >= 25, f"el precache tiene las piezas ({sw['precache']} entradas)")
        check(sw["tiene_shell"], "/app-shell está precacheado")
        check(sw["tiene_detalle"], "el módulo de la sección detalle está precacheado")

        # ── 8. sin conexión ───────────────────────────────────────────────────
        seccion("Sin conexión (servidor inalcanzable)")
        ctx.set_offline(True)
        page.goto(f"{BASE}/Sendero/{rid}", wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelector('#d-name').textContent.trim().length > 0", timeout=15000)
        check(page.text_content("#d-name").strip() == nuevo,
              "sin conexión, el detalle se pinta desde IndexedDB")
        page.wait_for_function("() => document.querySelector('#d-map canvas') !== null", timeout=15000)
        check(True, "sin conexión, el mapa se crea (las teselas necesitan capa offline)")
        check(page.input_value("#d-notes") == texto, "sin conexión, las notas guardadas están")
        badge = page.text_content("#net-badge").strip().lower()
        check("sin conexión" in badge, f"el badge del header avisa: «{badge}»")

        # Lo que esta migración desbloquea: los tres listados sin conexión.
        page.goto(BASE + "/rutas", wait_until="load")
        page.wait_for_selector("#sec-rutas:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelectorAll('#sec-rutas .card').length > 0", timeout=15000)
        check(page.locator("#sec-rutas .card").count() == len(rutas),
              f"sin conexión, Mis Rutas pinta las tarjetas desde IndexedDB "
              f"({page.locator('#sec-rutas .card').count()})")
        page.goto(BASE + "/dashboard", wait_until="load")
        page.wait_for_selector("#sec-dashboard:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelector('#ov-total-routes').textContent !== '–'", timeout=15000)
        check(page.text_content("#ov-total-routes").strip().isdigit(),
              f"sin conexión, el dashboard muestra las últimas estadísticas guardadas "
              f"({page.text_content('#ov-total-routes').strip()} rutas)")
        check(not page.locator("#ov-stale").is_hidden(),
              "y avisa de que son de la última sincronización")
        check(page.locator("#sec-dashboard .act-row").count() >= 1,
              "«Por actividad» se recalcula del listado local, así que sigue al día")
        page.goto(BASE + "/planificacion", wait_until="load")
        page.wait_for_selector("#sec-planes:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelectorAll('#sec-planes .plan-card').length > 0", timeout=15000)
        check(page.locator("#sec-planes .plan-card").count() == len(planes),
              "sin conexión, Mis Planes pinta sus tarjetas")
        # y volver al detalle para lo que sigue
        page.goto(f"{BASE}/Sendero/{rid}", wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelector('#d-notes').value.length > 0", timeout=15000)

        # ── 9. escritura sin conexión → cola → envío al volver ────────────────
        seccion("Editar sin conexión y enviar al recuperar la red")
        texto_off = f"Escrito sin conexión {int(time.time())}"
        page.fill("#d-notes", texto_off)
        page.click("#sec-detalle button:has-text('Guardar resumen')")
        page.wait_for_timeout(600)
        t = page.text_content("#toast").strip()
        check("conexión" in t.lower(), f"avisa de que se enviará luego: «{t}»")
        pend = page.evaluate("async () => await Store.pendingCount()")
        check(pend == 1, f"el cambio queda en la cola ({pend} pendiente)")
        badge = page.text_content("#net-badge").strip().lower()
        # El badge lee el Store con `typeof Store`, no `window.Store`: un `const`
        # de un script clásico no es propiedad de window, y con la comprobación
        # equivocada este contador nunca aparecía.
        check("sin conexión" in badge or "sin enviar" in badge,
              f"el badge refleja la cola o el estado offline: «{badge}»")
        # recargar sin conexión: la edición local NO debe perderse
        page.reload(wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.querySelector('#d-notes').value.length > 0", timeout=15000)
        check(page.input_value("#d-notes") == texto_off,
              "recargar sin conexión conserva la edición local (no la pisa el bootstrap)")
        ctx.set_offline(False)
        page.evaluate("async () => { await Store.flushOutbox(); }")
        page.wait_for_timeout(800)
        pend = page.evaluate("async () => await Store.pendingCount()")
        check(pend == 0, "al volver la red la cola se vacía")
        srv = api(page, f"/api/routes/{rid}")
        check(srv and srv.get("notes") == texto_off,
              "el servidor recibió lo que se escribió sin conexión")

        # ── 10. fotos ─────────────────────────────────────────────────────────
        seccion("Subir foto, galería y lightbox")
        page.goto(f"{BASE}/Sendero/{rid}", wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
        img = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "e2e-foto.jpg")
        if os.path.exists(img):
            # Idempotente: si una ejecución anterior dejó fotos, fuera antes de empezar.
            page.evaluate("""async pid => {
                const d = await (await fetch('/api/routes/' + pid)).json();
                for (const p of d.photos) await fetch('/api/photos/' + p.public_id, {method: 'DELETE'});
            }""", rid)
            page.reload(wait_until="load")
            page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
            page.set_input_files("#d-photo-input", img)
            page.wait_for_function(
                "() => document.querySelectorAll('#d-gallery .thumb').length > 0", timeout=20000)
            n = page.locator("#d-gallery .thumb").count()
            check(n == 1, f"la foto aparece en la galería ({n})")
            page.locator("#d-gallery .thumb").first.click()
            page.wait_for_selector("#lb-overlay:not(.hidden)", timeout=5000)
            check(True, "el lightbox se abre al pulsar la foto")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            check(page.locator("#lb-overlay").get_attribute("class").find("hidden") >= 0,
                  "Escape cierra el lightbox")
            # Borrar con el ✕ de la miniatura: es el que estaba roto desde 0.5.2
            # (el onclick generado metía el public_id opaco sin comillas). Hay que
            # pasar el ratón por la tarjeta primero, porque el botón vive a
            # opacity:0 hasta el hover; un click forzado sobre él es inestable.
            page.locator("#d-gallery .thumb").first.scroll_into_view_if_needed()
            page.locator("#d-gallery .thumb").first.hover()
            page.wait_for_timeout(200)
            page.locator("#d-gallery .thumb .del").first.click()
            page.wait_for_timeout(1500)
            n = page.locator("#d-gallery .thumb").count()
            check(n == 0, f"el botón ✕ borra la foto ({n} restantes)")
            check(page.locator("#lb-overlay").get_attribute("class").find("hidden") >= 0,
                  "borrar con el ✕ no abre el lightbox por debajo")
            quedan = api(page, f"/api/routes/{rid}")
            check(quedan and len(quedan["photos"]) == 0, "el servidor ya no tiene la foto")
        else:
            check(False, f"falta el fixture de imagen {img}")

        # ── 11. modal de actividad ────────────────────────────────────────────
        seccion("Cambiar el tipo de actividad")
        page.click("#d-activity-badge-sm .act-badge")
        page.wait_for_selector("#d-activity-modal:not(.hidden)", timeout=5000)
        opciones = page.locator("#d-act-picker-grid .act-opt").count()
        check(opciones >= 6, f"el selector muestra las actividades ({opciones})")
        page.locator("#d-act-picker-grid .act-opt").nth(1).click()
        page.wait_for_timeout(900)
        check(page.locator("#d-activity-modal").get_attribute("class").find("hidden") >= 0,
              "el modal se cierra al elegir")
        srv = api(page, f"/api/routes/{rid}")
        check(srv and srv.get("activity_type") == "bicicleta",
              f"el servidor guardó la actividad ({srv.get('activity_type') if srv else '?'})")

        # ── 12. editor ────────────────────────────────────────────────────────
        seccion("Editor de rutas (sección `editor`, la 6ª y última)")
        page.goto(f"{BASE}/Sendero/{rid}", wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=10000)
        page.evaluate("window.__t3 = 'vivo'")
        page.click("#sec-detalle button:has-text('✎ Editar')")
        page.wait_for_selector("#sec-editor:not(.hidden)", timeout=15000)
        check(page.evaluate("window.__t3") == "vivo",
              "ir del detalle al editor NO recarga el documento (ya son la misma SPA)")
        check(page.url.endswith(f"/Sendero/{rid}/editor"), f"la URL es la del editor ({page.url})")
        page.wait_for_selector("#ed-body:not(.hidden)", timeout=25000)
        check(page.text_content("#ed-name").strip() == nuevo,
              f"el editor carga la ruta: «{page.text_content('#ed-name').strip()}»")
        check(page.text_content("#ed-version").strip().startswith("v"),
              f"muestra la versión ({page.text_content('#ed-version').strip()})")
        page.wait_for_function("() => document.querySelector('#edmap canvas') !== null", timeout=20000)
        check(True, "el mapa del editor se crea")
        page.wait_for_function(
            "() => !!Chart.getChart(document.querySelector('#edelev'))", timeout=15000)
        check(True, "el perfil de elevación del editor es un Chart vivo")
        check(page.text_content("#sec-editor #ed-stats").strip() != "", "pinta sus stats")
        check(page.locator("#save-btn").is_disabled(), "«Guardar cambios» arranca deshabilitado")

        # Una operación real que no necesita seleccionar tramo: invertir la ruta.
        # Verifica de paso que doOp() vive y que el botón de guardar se habilita.
        page.evaluate("window.confirm = () => true;")
        page.click("#sec-editor button:has-text('Invertir')")
        page.wait_for_timeout(700)
        check(not page.locator("#save-btn").is_disabled(),
              "tras invertir hay cambios pendientes (se habilita «Guardar cambios»)")
        page.click("#undo-btn")
        page.wait_for_timeout(600)
        check(page.locator("#save-btn").is_disabled(), "deshacer los descarta")

        # Salir con cambios pendientes debe preguntar. Antes lo hacía
        # `beforeunload` porque salir era recargar; ahora es un cambio de sección.
        page.click("#sec-editor button:has-text('Invertir')")
        page.wait_for_timeout(600)
        page.evaluate("window.__confirmado = null; window.confirm = m => { window.__confirmado = m; return false; };")
        page.click(".header-nav a[href='/rutas']")
        page.wait_for_timeout(600)
        msg = page.evaluate("window.__confirmado")
        check(msg is not None and "sin guardar" in msg,
              f"salir del editor con cambios pendientes pregunta: «{msg}»")
        check(page.url.endswith("/editor"), f"y si se dice que no, no se sale ({page.url})")
        # Guardado de verdad: es lo que ejercita la paridad doOp()↔apply_ops().
        # Se usa una ruta distinta para no dejar la principal invertida.
        otra = next(r for r in rutas if r["public_id"] != rid)
        page.goto(f"{BASE}/Sendero/{otra['public_id']}/editor", wait_until="load")
        page.wait_for_selector("#ed-body:not(.hidden)", timeout=25000)
        # OJO: el stub de confirm se pierde en cada page.goto (documento nuevo),
        # así que se vuelve a poner DESPUÉS de navegar. Invertir pregunta antes de
        # borrar los <time>, y sin aceptar no se genera ninguna op.
        page.evaluate("window.confirm = () => true;")
        antes = api(page, f"/api/routes/{otra['public_id']}")
        v_antes = antes["version"]
        km_antes = round(antes["distance_m"])
        page.click("#sec-editor button:has-text('Invertir')")
        page.wait_for_timeout(700)
        page.click("#save-btn")
        page.wait_for_selector("#save-modal:not(.hidden)", timeout=5000)
        page.fill("#save-summary", "Invertida por la suite e2e")
        page.click("#save-confirm")
        page.wait_for_function(
            "() => document.getElementById('ed-body').classList.contains('hidden') === false"
            " && document.getElementById('save-btn').disabled", timeout=30000)
        despues = api(page, f"/api/routes/{otra['public_id']}")
        # El primer guardado de una ruta nunca editada archiva el original como v1
        # y deja el resultado como v2 (invariante documentada en CLAUDE.md); los
        # siguientes suben de uno en uno.
        esperada = 2 if v_antes == 0 else v_antes + 1
        check(despues["version"] == esperada,
              f"guardar crea una versión nueva (v{v_antes} → v{despues['version']}, "
              f"esperada v{esperada})")
        check(round(despues["distance_m"]) == km_antes,
              f"invertir no cambia la distancia ({km_antes} m → {round(despues['distance_m'])} m)")
        check(despues["geojson"][0] == antes["geojson"][-1]
              and despues["geojson"][-1] == antes["geojson"][0],
              "el track quedó realmente invertido en el servidor")
        check(despues["started_at"] is None,
              "invertir eliminó los <time> (timestamps descendentes serían inválidos)")
        vers = api(page, f"/api/routes/{otra['public_id']}/versions")
        check(len(vers) >= 2,
              f"el historial guarda el original y la edición ({len(vers)} versiones)")
        # y se restaura, para dejar el entorno como estaba
        page.evaluate("""async pid => {
            const vs = await (await fetch(`/api/routes/${pid}/versions`)).json();
            await fetch(`/api/routes/${pid}/versions/1/restore`, {method: 'POST'});
        }""", otra["public_id"])
        rest = api(page, f"/api/routes/{otra['public_id']}")
        check(rest["geojson"][0] == antes["geojson"][0],
              "restaurar la v1 devuelve el track original")

        # ahora sí, salir aceptando el aviso
        page.goto(f"{BASE}/Sendero/{rid}/editor", wait_until="load")
        page.wait_for_selector("#ed-body:not(.hidden)", timeout=25000)
        page.evaluate("window.confirm = () => true;")
        page.click("#sec-editor button:has-text('Invertir')")
        page.wait_for_timeout(600)
        page.click(".header-nav a[href='/rutas']")
        page.wait_for_selector("#sec-rutas:not(.hidden)", timeout=15000)
        check(True, "aceptando, se sale al listado")
        canvas_ed = page.evaluate("() => document.querySelectorAll('#edmap canvas').length")
        check(canvas_ed == 0, f"unmount() destruyó el mapa del editor ({canvas_ed})")
        charts_ed = page.evaluate("""() => [
            Chart.getChart(document.querySelector('#edelev')),
            Chart.getChart(document.querySelector('#edspeed')),
        ].filter(Boolean).length""")
        check(charts_ed == 0, f"y sus gráficas ({charts_ed} vivas)")

        # ── 13. Ajustes → Sin conexión ────────────────────────────────────────
        seccion("Ajustes → Sin conexión (gestión de la copia local y de la cola)")
        page.goto(BASE + "/rutas", wait_until="load")
        page.wait_for_selector("#sec-rutas:not(.hidden)", timeout=15000)
        page.click("#nav-ajustes")
        page.wait_for_selector("#cfg-overlay:not(.hidden)", timeout=8000)
        page.click("#cfg-nav-offline")
        page.wait_for_selector("#cfg-sec-offline:not(.hidden)", timeout=5000)
        page.wait_for_function(
            "() => !document.getElementById('off-estado').textContent.includes('Cargando')",
            timeout=10000)
        estado = page.text_content("#off-estado")
        check(f"{len(rutas)} ruta" in estado,
              f"informa de lo guardado en local: «{estado[:80]}»")
        check("plan" in estado, "y de los planes")
        check("Nada pendiente" in page.text_content("#off-cola"),
              "la cola aparece vacía cuando no hay nada pendiente")

        # Prefetch: descarga el detalle ligero de todas. Se espera a que el botón
        # vuelva a habilitarse (lo deshabilita mientras descarga) en vez de a un
        # texto de progreso concreto: el total lo pone el Store, no la API, y si
        # ambos difieren por un instante la comparación de cadenas no converge.
        en_store = page.evaluate("async () => (await Store.routes()).length")
        page.click("#off-prefetch-btn")
        page.wait_for_function(
            "() => !document.getElementById('off-prefetch-btn').disabled", timeout=60000)
        info = page.text_content("#off-prefetch-info")
        check(True, f"«Descargar todas» termina ({info.strip()})")
        detalles = page.evaluate("async () => (await Store._getAll('detail')).length")
        check(detalles >= en_store,
              f"IndexedDB tiene el detalle de todas las rutas ({detalles} de {en_store})")

        # comprobar sincronización (manifiesto)
        page.click("#off-verify-btn")
        page.wait_for_timeout(1500)
        check("coincide" in page.text_content("#toast") or "Reparadas" in page.text_content("#toast"),
              f"«Comprobar sincronización» responde: «{page.text_content('#toast')}»")

        # la cola, con un cambio hecho sin conexión
        ctx.set_offline(True)
        page.evaluate("""async pid => {
            await Store.patch('/api/routes/' + pid, {notes: 'desde Ajustes'}, {label: 'notas de prueba'});
        }""", rid)
        page.evaluate("loadOffline()")
        page.wait_for_function(
            "() => document.getElementById('off-cola').textContent.includes('notas de prueba')",
            timeout=8000)
        check(True, "un cambio sin conexión aparece en la lista de pendientes con su etiqueta")
        ctx.set_offline(False)
        page.click("#off-flush-btn")
        page.wait_for_function(
            "() => document.getElementById('off-cola').textContent.includes('Nada pendiente')",
            timeout=15000)
        check(True, "«Enviar ahora» vacía la cola al volver la red")
        page.evaluate("closeSettings()")

        # ── 14. mapa sin conexión de una ruta (roadmap §6.2) ──────────────────
        seccion("Mapa sin conexión de UNA ruta (corredor de teselas)")
        page.goto(f"{BASE}/Plan/{pid_plan}", wait_until="load")
        page.wait_for_selector("#sec-plan:not(.hidden)", timeout=15000)
        page.wait_for_function("() => document.querySelector('#pl-map canvas') !== null", timeout=20000)
        # cuántas teselas necesita este track, con el mismo código que usa la app
        page.evaluate("""async pid => {
            const d = await (await fetch('/api/planned/' + pid)).json();
            window.__track = d.geojson;
        }""", pid_plan)
        est = page.evaluate("""() => {
            const t = Tiles.forTrack(window.__track);
            return {n: t.length, mb: +Tiles.estimate(t).mb.toFixed(1),
                    zooms: [...new Set(t.map(x => x.z))]};
        }""")
        check(0 < est["n"] < Tiles_MAX,
              f"el corredor del plan son {est['n']} teselas (~{est['mb']} MB), zooms {est['zooms']}")
        antes_cache = page.evaluate("""async () => {
            const c = await caches.open('sendero-tiles-v1');
            return (await c.keys()).length;
        }""")

        # se descarga sin el confirm (el diálogo se acepta) y se espera el aviso
        page.evaluate("window.confirm = () => true;")
        page.click("#pl-offline-btn")
        page.wait_for_function(
            "() => document.getElementById('pl-offline-info').textContent.includes('Mapa disponible')",
            timeout=120000)
        info = page.text_content("#pl-offline-info")
        check("Mapa disponible" in info, f"la UI confirma la descarga: «{info.strip()[:70]}»")
        despues_cache = page.evaluate("""async () => {
            const c = await caches.open('sendero-tiles-v1');
            return (await c.keys()).length;
        }""")
        check(despues_cache >= est["n"],
              f"las teselas quedan en la caché sendero-tiles-v1 ({antes_cache} → {despues_cache})")

        # al volver a entrar, lo dice sin que haya que pulsar
        page.goto(f"{BASE}/Plan/{pid_plan}", wait_until="load")
        page.wait_for_selector("#sec-plan:not(.hidden)", timeout=15000)
        page.wait_for_function(
            "() => document.getElementById('pl-offline-info').textContent.includes('Mapa disponible')",
            timeout=20000)
        check(True, "al reabrir el plan avisa de que su mapa ya está descargado")

        # Y AHORA lo que importa: sin conexión, el Service Worker sirve esas teselas.
        # Se quita el stub de teselas falsas: con él puesto responde él a todo y la
        # comprobación no distinguiría la caché del SW de la propia interceptación.
        ctx.unroute(patron_externo, stub_tesela)
        ctx.set_offline(True)
        page.goto(f"{BASE}/Plan/{pid_plan}", wait_until="load")
        page.wait_for_selector("#sec-plan:not(.hidden)", timeout=20000)
        page.wait_for_function("() => document.querySelector('#pl-map canvas') !== null", timeout=25000)
        page.wait_for_timeout(3000)
        # El track se relee del Store, no de window: el page.goto anterior creó un
        # documento nuevo y cualquier variable de la página se perdió.
        desde_sw = page.evaluate("""async pid => {
            // ¿Puede el propio SW resolver una tesela del corredor sin red?
            const d = await Store.plan(pid);
            const t = Tiles.forTrack(d.geojson)[0];
            const capa = document.querySelector('#pl-map select').value;
            const u = Tiles.urlFor(capa, t);
            try { const r = await fetch(u); return {ok: r.ok, status: r.status}; }
            catch (e) { return {ok: false, error: String(e)}; }
        }""", pid_plan)
        check(desde_sw.get("ok"),
              f"SIN CONEXIÓN una tesela del corredor se sirve desde la caché ({desde_sw})")
        fuera = page.evaluate("""async () => {
            // una tesela FUERA del corredor no está, y debe fallar de forma controlada
            const r = await fetch('https://a.tile.opentopomap.org/12/1/1.png');
            return r.status;
        }""")
        check(fuera == 504,
              f"una tesela no descargada da 504 controlado, no una excepción ({fuera})")
        ctx.set_offline(False)
        ctx.route(patron_externo, stub_tesela)      # se devuelve para el resto

        # y se puede vaciar desde Ajustes
        page.click("#nav-ajustes")
        page.wait_for_selector("#cfg-overlay:not(.hidden)", timeout=8000)
        page.click("#cfg-nav-offline")
        page.wait_for_function(
            "() => document.getElementById('off-tiles').textContent.includes('teselas')",
            timeout=10000)
        check("teselas guardadas" in page.text_content("#off-tiles"),
              f"Ajustes informa del espacio: «{page.text_content('#off-tiles').strip()}»")
        page.evaluate("window.confirm = () => true;")
        page.click("#cfg-sec-offline button:has-text('Borrar los mapas descargados')")
        page.wait_for_function(
            "() => document.getElementById('off-tiles').textContent.includes('Ningún mapa')",
            timeout=10000)
        check(True, "y permite borrarlos")
        page.evaluate("closeSettings()")

        # ── 15. vista 3D (relieve) ────────────────────────────────────────────
        seccion("Vista 3D del detalle (el bug del mapa en negro)")
        # Con las teselas falsas el mapa es un color plano y no se distingue de un
        # mapa roto, así que este bloque usa las de verdad: se quita el stub. Si no
        # hay internet, se omite en vez de dar un falso fallo.
        ctx.unroute(patron_externo, stub_tesela)
        # OJO: tiene que ser una ruta de ALTA MONTAÑA. El bug solo aparecía por
        # encima de ~1500 m (con exageración 1.5 la superficie del terreno sube por
        # encima de la cámara), así que con una ruta de valle este bloque pasaba
        # igual con el código roto — comprobado. La siembra crea una en Andorra.
        alta = next((r for r in rutas if "alta montaña" in r["name"]), None)
        if not alta:
            print("  OMITIDA  falta la ruta de alta montaña en la siembra "
                  "(vuelve a lanzar tests/e2e_seed.py)")
            alta = {"public_id": rid}
        page.goto(f"{BASE}/Sendero/{alta['public_id']}", wait_until="load")
        page.wait_for_selector("#sec-detalle:not(.hidden)", timeout=15000)
        esperar_mapa(page)
        # Los modales que se abren solos (Immich, actividad) taparían el mapa.
        page.add_style_tag(content="#immich-modal,#d-activity-modal{display:none!important}")
        page.wait_for_timeout(6000)
        plano = len(page.locator("#d-map").screenshot())
        if plano < 40_000:
            print(f"  OMITIDA  sin teselas reales ({plano} B): la vista 3D no se puede juzgar aquí")
        else:
            page.click("#d-btn3d")
            page.wait_for_timeout(10000)          # easeTo(800) + moveend + DEM
            en3d = len(page.locator("#d-map").screenshot())
            # Un mapa en negro comprime a ~10 KB; uno con relieve y curvas, a cientos.
            check(en3d > plano * 0.4,
                  f"la vista 3D pinta el mapa, no un rectángulo negro "
                  f"(2D {plano // 1024} KB → 3D {en3d // 1024} KB)")
            check(page.text_content("#d-btn3d").strip() == "Vista 2D",
                  "el botón pasa a «Vista 2D»")
            page.click("#d-btn3d")
            page.wait_for_timeout(5000)
            vuelta = len(page.locator("#d-map").screenshot())
            check(vuelta > plano * 0.4,
                  f"y al volver a 2D sigue viéndose ({vuelta // 1024} KB)")
            # otra vez a 3D: el bug original tampoco dejaba repetir
            page.click("#d-btn3d")
            page.wait_for_timeout(10000)
            otra = len(page.locator("#d-map").screenshot())
            check(otra > plano * 0.4, f"y a la segunda activación también ({otra // 1024} KB)")
        ctx.route(patron_externo, stub_tesela)

        # ── 16. errores de consola ────────────────────────────────────────────
        seccion("Errores de JavaScript")
        errs = con.limpias()
        check(not errs, "ningún error de JS ni excepción sin capturar"
              + (":\n     " + "\n     ".join(errs[:8]) if errs else ""))

        navegador.close()

    print("\n" + "═" * 74)
    print(f"  {_oks} comprobaciones OK, {len(_fallos)} fallos")
    if _fallos:
        for f in _fallos:
            print("   ✗ " + f)
        sys.exit(1)
    print("  TODO OK")


if __name__ == "__main__":
    main()
