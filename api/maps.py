"""Mapas base offline: sirve los archivos PMTiles de data/tiles/.

Un PMTiles es un solo archivo que contiene todas las teselas y se lee por
*range requests*: el navegador pide los bytes del índice y luego los de cada
tesela, así que NO hace falta un servidor de teselas aparte. Es la única capa
base que funciona sin internet (las otras 4 son de terceros; ver
static/shared.js) y por eso es también la única cacheable por el Service
Worker sin incumplir la política de uso de nadie.

Cómo se genera un .pmtiles está documentado en roadmap/spa-offline-sync.md §6.1.
"""
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

import core.config as cfg

maps_bp = Blueprint("maps", __name__)


def _tiles_dir() -> Path:
    return Path(cfg.TILES_DIR)


def available_tilesets():
    """Nombres de los .pmtiles presentes en data/tiles/, ordenados."""
    d = _tiles_dir()
    if not d.is_dir():
        return []
    return sorted(p.name for p in d.glob("*.pmtiles") if p.is_file())


def offline_map_url():
    """URL pública del PMTiles configurado, o "" si no hay ninguno usable.

    Devuelve "" también si el archivo configurado ya no existe: así el selector
    de capas no ofrece una capa offline que daría 404 en cada tesela.
    """
    name = (cfg.MAP_OFFLINE_FILE or "").strip()
    if not name:
        return ""
    if name not in available_tilesets():
        return ""
    return f"/tiles/{name}"


@maps_bp.route("/tiles/<name>")
def serve_tiles(name):
    """Sirve un .pmtiles con soporte de Range (206).

    `conditional=True` hace que Flask/Werkzeug atienda las cabeceras Range e
    If-Range, que es justo lo que necesita pmtiles.js. Sin eso el cliente se
    descargaría el archivo entero (cientos de MB) para leer una tesela.
    """
    # Sin travesía de rutas: solo nombres exactos de archivos ya presentes en
    # data/tiles/ (no se usa el nombre recibido para construir la ruta a ciegas).
    if name not in available_tilesets():
        abort(404)
    resp = send_file(
        _tiles_dir() / name,
        mimetype="application/octet-stream",
        conditional=True,
        max_age=31536000,          # el contenido de un .pmtiles no cambia
    )
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


@maps_bp.route("/api/maps")
def api_maps():
    """Estado de los mapas base para Ajustes → Mapas."""
    return jsonify({
        "tilesets":     available_tilesets(),
        "offline_file": cfg.MAP_OFFLINE_FILE or "",
        "offline_url":  offline_map_url(),
        "default_layer": cfg.MAP_DEFAULT_LAYER or "",
        "maxzoom":      cfg.MAP_OFFLINE_MAXZOOM,
        "attribution":  cfg.MAP_OFFLINE_ATTRIBUTION or "",
        "tiles_dir":    str(_tiles_dir()),
    })


def map_cfg():
    """Config de mapas que el servidor inyecta en <body data-map-cfg>.

    La leen `MAP_CFG`/`buildStyle()` de static/shared.js. Va en el HTML en vez de
    por fetch para que el primer mapa se pinte sin esperar a una petición (y para
    que funcione offline, donde el fetch podría no llegar).
    """
    return {
        "offline_url":         offline_map_url(),
        "offline_maxzoom":     cfg.MAP_OFFLINE_MAXZOOM,
        "offline_attribution": cfg.MAP_OFFLINE_ATTRIBUTION or "Mapa local",
        "default_layer":       cfg.MAP_DEFAULT_LAYER or "",
    }
