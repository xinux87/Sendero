from flask import Flask

from core.database import init_db, close_db
from core.config import refresh_config

from api.routes import routes_bp
from api.photos import photos_bp
from api.planned import planned_bp
from api.settings import settings_bp
from api.immich_api import immich_bp

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB por subida

app.teardown_appcontext(close_db)

for bp in (routes_bp, photos_bp, planned_bp, settings_bp, immich_bp):
    app.register_blueprint(bp)

init_db()
refresh_config()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
