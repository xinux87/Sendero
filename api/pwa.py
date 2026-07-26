"""PWA: manifiesto, Service Worker y el shell sin datos.

Las tres rutas viven en la RAÍZ, no bajo /static, y eso es intencional:

- `/sw.js`: el ámbito de un Service Worker es la carpeta desde la que se sirve.
  Servido como /static/sw.js solo podría controlar /static/**, es decir, nada de
  lo que importa. Además aquí se le inyecta `APP_VERSION`, que es lo que hace que
  el archivo cambie (y el navegador instale el SW nuevo) al publicar una versión.
- `/manifest.webmanifest`: para poder devolverlo con su tipo MIME
  (application/manifest+json), que Flask no adivina por la extensión.
- `/app-shell`: el shell de la SPA sin ningún dato dentro. Es lo que el SW
  precachea y sirve al navegar sin conexión: el router lee location.pathname,
  monta la sección y los datos los pone el Store desde IndexedDB.
- `/actualizar`: la página de reparación. Desregistra el Service Worker, borra sus
  cachés y la copia local, y vuelve a la app. Existe porque el peor fallo de esta
  arquitectura es quedarse con código viejo pegado en el navegador (HTML nuevo con
  JS de la versión anterior), y salir de ahí exige DevTools o borrar los datos del
  sitio, que en un móvil o en una PWA instalada no siempre es fácil de encontrar.
"""
import re

from flask import Blueprint, Response, jsonify, render_template

import core.config as cfg

pwa_bp = Blueprint("pwa", __name__)


@pwa_bp.route("/app-shell")
def app_shell():
    """Shell vacío, sin `bootstrap_json`. Solo lo pide el Service Worker."""
    return render_template("shell.html")


@pwa_bp.route("/manifest.webmanifest")
def manifest():
    # mimetype explícito: el tipo del manifiesto es application/manifest+json, y
    # jsonify() devolvería application/json.
    resp = jsonify({
        "name": "Sendero",
        "short_name": "Sendero",
        "description": "Bitácora de rutas de montaña",
        "lang": "es",
        "start_url": "/rutas",
        "scope": "/",
        "display": "standalone",
        "background_color": "#0b120e",
        "theme_color": "#0b120e",
        "icons": [
            {"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/static/icons/icon-maskable-512.png", "sizes": "512x512",
             "type": "image/png", "purpose": "maskable"},
        ],
    })
    resp.mimetype = "application/manifest+json"
    return resp


_REPARAR = """<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Actualizar Sendero</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0b120e;color:#ece5d8;font-family:system-ui,sans-serif;padding:24px}
.caja{max-width:520px;width:100%}
h1{font-size:22px;margin:0 0 10px;letter-spacing:.02em;text-transform:uppercase}
p{color:#8b9a8f;margin:0 0 18px;line-height:1.6;font-size:14px}
ul{list-style:none;padding:0;margin:0 0 20px;font-size:13.5px}
li{padding:8px 0;border-bottom:1px solid rgba(236,229,216,.09);
  display:flex;justify-content:space-between;gap:12px}
li span:last-child{color:#8b9a8f;font-family:ui-monospace,monospace;font-size:12.5px}
a.btn{display:inline-block;background:#e2492c;color:#fff5ec;text-decoration:none;
  border-radius:999px;padding:11px 20px;font-size:14px}
.ok{color:#43b97f}.err{color:#e2492c}
</style></head><body><div class="caja">
<h1>Actualizar Sendero</h1>
<p>Esto borra <strong>de este dispositivo</strong> el código guardado de la app y su
copia local de rutas y planes. No toca nada del servidor: al volver, la app se
descarga de cero y se sincroniza otra vez.</p>
<ul id="pasos"></ul>
<a class="btn" id="volver" href="/rutas" style="display:none">Abrir Sendero</a>
</div>
<script>
/* Inline a propósito: si el navegador se ha quedado con JS viejo en caché, un
   <script src> podría ser justo el archivo viejo. Este HTML llega siempre de red
   (el Service Worker no intercepta esta ruta). */
const pasos = document.getElementById('pasos');
function paso(txt) {
  const li = document.createElement('li');
  li.innerHTML = '<span>' + txt + '</span><span>…</span>';
  pasos.appendChild(li);
  return (res, mal) => { li.lastElementChild.textContent = res;
                         li.lastElementChild.className = mal ? 'err' : 'ok'; };
}
(async () => {
  let p = paso('Service Workers registrados');
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    p(regs.length ? regs.length + ' desregistrado(s)' : 'ninguno');
  } catch (e) { p('no se pudo', true); }

  p = paso('Cachés de código y mapas');
  try {
    const n = await caches.keys();
    for (const c of n) await caches.delete(c);
    p(n.length ? n.length + ' borrada(s)' : 'ninguna');
  } catch (e) { p('no se pudo', true); }

  p = paso('Copia local de rutas y planes');
  try {
    await new Promise(res => { const r = indexedDB.deleteDatabase('sendero');
      r.onsuccess = r.onerror = r.onblocked = () => res(); });
    p('borrada');
  } catch (e) { p('no se pudo', true); }

  p = paso('Preferencias de la sesión');
  try { sessionStorage.clear(); localStorage.clear(); p('limpias'); }
  catch (e) { p('no se pudo', true); }

  document.getElementById('volver').style.display = 'inline-block';
})();
</script></body></html>"""


@pwa_bp.route("/actualizar")
def actualizar():
    """Página de reparación: se limpia sola al abrirla.

    Sale del atasco de "código viejo pegado en el navegador" sin DevTools y sin
    buscar dónde se borran los datos del sitio (en una PWA instalada o en un móvil
    eso es lo difícil). El HTML llega siempre de red porque el Service Worker no
    intercepta esta ruta (ver static/sw.js), y el script va inline porque un
    <script src> podría servirse de la caché vieja, que es justo el problema.
    """
    resp = Response(_REPARAR, mimetype="text/html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@pwa_bp.route("/sw.js")
def service_worker():
    """Sirve static/sw.js con la versión de la app inyectada delante.

    Se lee el archivo y se le antepone una línea, en vez de pasarlo por Jinja:
    así `static/sw.js` sigue siendo JavaScript válido por sí solo (se puede
    comprobar con `node --check`) y no hay que escapar nada.
    """
    src = (cfg.BASE / "static" / "sw.js").read_text(encoding="utf-8")
    version = re.sub(r"[^\w.\-]", "", cfg.APP_VERSION)      # no inyectar nada raro
    body = f'self.APP_VERSION = "{version}";\n' + src
    resp = Response(body, mimetype="application/javascript")
    # Que el navegador no sirva un SW viejo de su propia caché: la comparación
    # byte a byte que decide si hay actualización tiene que hacerse contra el
    # archivo de verdad.
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp
