import json

from flask import Flask
from flask_compress import Compress

from core.database import init_db, close_db
from core.config import refresh_config, APP_VERSION

from api.routes import routes_bp
from api.photos import photos_bp
from api.planned import planned_bp
from api.settings import settings_bp
from api.immich_api import immich_bp
from api.editor import editor_bp
from api.mifit import mifit_bp
from api.maps import maps_bp, map_cfg
from api.sync import sync_bp
from api.pwa import pwa_bp

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB por subida

# gzip/brotli en respuestas de texto (HTML y, sobre todo, los JSON grandes de
# /api/routes y /api/routes/geojson). Imágenes y binarios quedan fuera por
# mimetype. En LAN apenas se nota; vía VPN/Tailscale reduce ~80% el JSON.
Compress(app)

app.teardown_appcontext(close_db)


@app.context_processor
def _inject_version():
    # Disponible como {{ app_version }} en todas las plantillas (pie de Ajustes).
    # map_cfg va en <body data-map-cfg> de base.html: lo lee MAP_CFG de
    # static/shared.js para saber si hay capa de mapa offline configurada.
    # planner_url va en <body data-planner-url> por el mismo motivo (lo lee
    # PLANNER_URL de shared.js): en el HTML no necesita fetch y funciona sin red.
    import core.config as _cfg
    return {"app_version": APP_VERSION, "map_cfg_json": json.dumps(map_cfg()),
            "planner_url": _cfg.PLANNER_URL}


@app.before_request
def _refresh_settings():
    # Gunicorn corre 2 workers: un POST de ajustes solo refresca la config del
    # worker que lo atiende y el otro seguiría con valores viejos en memoria
    # (umbrales GPS, Immich, DEM…). Releer settings por request lo hace
    # consistente; es un SELECT de ~10 filas, despreciable en LAN.
    refresh_config()

for bp in (routes_bp, photos_bp, planned_bp, settings_bp, immich_bp, editor_bp, mifit_bp,
           maps_bp, sync_bp, pwa_bp):
    app.register_blueprint(bp)

init_db()
refresh_config()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
