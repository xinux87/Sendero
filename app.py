from flask import Flask

from core.database import init_db, close_db
from core.config import refresh_config

from api.routes import routes_bp
from api.photos import photos_bp
from api.planned import planned_bp
from api.settings import settings_bp
from api.immich_api import immich_bp
from api.editor import editor_bp

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB por subida

app.teardown_appcontext(close_db)


@app.before_request
def _refresh_settings():
    # Gunicorn corre 2 workers: un POST de ajustes solo refresca la config del
    # worker que lo atiende y el otro seguiría con valores viejos en memoria
    # (umbrales GPS, Immich, DEM…). Releer settings por request lo hace
    # consistente; es un SELECT de ~10 filas, despreciable en LAN.
    refresh_config()

for bp in (routes_bp, photos_bp, planned_bp, settings_bp, immich_bp, editor_bp):
    app.register_blueprint(bp)

init_db()
refresh_config()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
