"""PWA: manifiesto, Service Worker y el shell sin datos (roadmap §5).

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
        "background_color": "#101a14",
        "theme_color": "#17241c",
        "icons": [
            {"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/static/icons/icon-maskable-512.png", "sizes": "512x512",
             "type": "image/png", "purpose": "maskable"},
        ],
    })
    resp.mimetype = "application/manifest+json"
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
