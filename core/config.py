import os
import json
import sqlite3
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("SENDERO_DATA", BASE / "data"))
GPX_DIR = DATA / "gpx"
PHOTO_DIR = DATA / "photos"
THUMB_DIR = DATA / "thumbs"
# Versiones del editor de rutas: data/gpx/versions/<route_id>/v<N>.<ext>
# El archivo activo en data/gpx/ es SIEMPRE idéntico a la versión más alta.
VERSIONS_DIR = GPX_DIR / "versions"
DB_PATH = DATA / "sendero.db"

# Versión de la aplicación. Única fuente de verdad: se muestra en Ajustes y en
# /api/config. Al publicar, el tag de git (vX.Y.Z) y la etiqueta de la imagen
# Docker (xinux87/sendero:X.Y.Z) deben coincidir con este número.
APP_VERSION = "0.4.0"

for d in (DATA, GPX_DIR, PHOTO_DIR, THUMB_DIR, VERSIONS_DIR):
    d.mkdir(parents=True, exist_ok=True)

IMMICH_URL = os.environ.get("IMMICH_URL", "").rstrip("/")
IMMICH_API_KEY = os.environ.get("IMMICH_API_KEY", "")
IMMICH_MARGIN_MIN = int(os.environ.get("IMMICH_MARGIN_MIN", "180"))
IMMICH_DIST_M = int(os.environ.get("IMMICH_DIST_M", "100"))
IMMICH_ENABLED = bool(IMMICH_URL and IMMICH_API_KEY)

# Servicio DEM (OpenTopoData) para recalcular elevación desde el editor.
# URL completa del dataset, p.ej. http://opentopodata:5000/v1/eudem25m
# Vacío = función desactivada (el botón no aparece en el editor).
DEM_URL = os.environ.get("DEM_URL", "").rstrip("/")

# Planificador externo que se abre al pulsar "Dibujar ruta nueva". Por defecto
# brouter-web (permite exportar GPX, que luego se importa a mano). Editable
# desde Ajustes → Editor.
PLANNER_URL = os.environ.get("PLANNER_URL", "https://brouter.de/brouter-web").rstrip("/")

# Auto-importación desde Mi Fit / Zepp (Huami). El servicio aparte mifit_sync.py
# lee estas claves de settings y descarga los entrenamientos nuevos como GPX.
# MIFIT_TOKEN es el apptoken de Huami (lo pega el usuario o lo escribe mifit-auth).
# MIFIT_INTERVAL_MIN = minutos entre sincronizaciones automáticas (0 = solo manual).
MIFIT_ENABLED = os.environ.get("MIFIT_ENABLED", "0") == "1"
MIFIT_TOKEN = os.environ.get("MIFIT_TOKEN", "")
MIFIT_ENDPOINT = os.environ.get("MIFIT_ENDPOINT", "https://api-mifit.huami.com").rstrip("/")
# Suelo de fecha para la importación (YYYY-MM-DD; vacío = todo el historial). Evita
# que la primera sync se traiga entrenamientos anteriores a esta fecha de golpe.
MIFIT_SINCE_DATE = os.environ.get("MIFIT_SINCE_DATE", "")
try:
    MIFIT_INTERVAL_MIN = int(os.environ.get("MIFIT_INTERVAL_MIN", "360"))
except (ValueError, TypeError):
    MIFIT_INTERVAL_MIN = 360

_SETTINGS_KEYS = {"IMMICH_URL", "IMMICH_API_KEY", "IMMICH_MARGIN_MIN", "IMMICH_DIST_M",
                  "DEM_URL", "PLANNER_URL",
                  "MIFIT_ENABLED", "MIFIT_TOKEN", "MIFIT_ENDPOINT", "MIFIT_INTERVAL_MIN",
                  "MIFIT_SINCE_DATE"}
_CUSTOM_GPX_TYPES: dict = {}

# Umbrales por defecto para detectar tramos GPS incorrectos (core/gps_analysis.py):
# velocidad y tasa vertical máximas plausibles por tipo de actividad. Un tramo que
# las supere se marca como fallo de GPS/barómetro, no como esfuerzo real. Editables
# desde Ajustes → "GPS incorrecto" (se guardan en _GPS_THRESHOLDS_CUSTOM, mismo
# patrón que _CUSTOM_GPX_TYPES).
DEFAULT_GPS_THRESHOLDS = {
    "senderismo": {"max_speed_kmh": 15,  "max_vert_rate_ms": 3,   "max_ele_m": 4900},
    "caminata":   {"max_speed_kmh": 10,  "max_vert_rate_ms": 2,   "max_ele_m": 3500},
    "correr":     {"max_speed_kmh": 30,  "max_vert_rate_ms": 3.5, "max_ele_m": 4900},
    "bicicleta":  {"max_speed_kmh": 70,  "max_vert_rate_ms": 6,   "max_ele_m": 4000},
    "esqui":      {"max_speed_kmh": 100, "max_vert_rate_ms": 10,  "max_ele_m": 4900},
    "otros":      {"max_speed_kmh": 40,  "max_vert_rate_ms": 5,   "max_ele_m": 9000},
}
_GPS_THRESHOLDS_CUSTOM: dict = {}


def gps_thresholds_for(activity_type):
    """Umbrales efectivos para una actividad: los guardados en ajustes si existen,
    si no los valores por defecto. `activity_type` desconocido/None cae en 'otros'."""
    act = activity_type if activity_type in DEFAULT_GPS_THRESHOLDS else "otros"
    return _GPS_THRESHOLDS_CUSTOM.get(act) or DEFAULT_GPS_THRESHOLDS[act]


def refresh_config():
    global IMMICH_URL, IMMICH_API_KEY, IMMICH_MARGIN_MIN, IMMICH_DIST_M, IMMICH_ENABLED, _CUSTOM_GPX_TYPES, _GPS_THRESHOLDS_CUSTOM, DEM_URL, PLANNER_URL
    global MIFIT_ENABLED, MIFIT_TOKEN, MIFIT_ENDPOINT, MIFIT_INTERVAL_MIN, MIFIT_SINCE_DATE
    try:
        con = sqlite3.connect(DB_PATH)
        con.execute("PRAGMA busy_timeout=20000")
        rows = dict(con.execute("SELECT key, value FROM settings").fetchall())
        con.close()
    except Exception:
        rows = {}
    IMMICH_URL = (rows.get("IMMICH_URL") or os.environ.get("IMMICH_URL", "")).rstrip("/")
    IMMICH_API_KEY = rows.get("IMMICH_API_KEY") or os.environ.get("IMMICH_API_KEY", "")
    try:
        IMMICH_MARGIN_MIN = int(
            rows.get("IMMICH_MARGIN_MIN") or os.environ.get("IMMICH_MARGIN_MIN", "180")
        )
    except (ValueError, TypeError):
        IMMICH_MARGIN_MIN = 180
    try:
        IMMICH_DIST_M = int(
            rows.get("IMMICH_DIST_M") or os.environ.get("IMMICH_DIST_M", "100")
        )
    except (ValueError, TypeError):
        IMMICH_DIST_M = 100
    IMMICH_ENABLED = bool(IMMICH_URL and IMMICH_API_KEY)
    DEM_URL = (rows.get("DEM_URL") or os.environ.get("DEM_URL", "")).rstrip("/")
    PLANNER_URL = (rows.get("PLANNER_URL") or os.environ.get("PLANNER_URL", "")
                   or "https://brouter.de/brouter-web").rstrip("/")
    MIFIT_ENABLED = (rows.get("MIFIT_ENABLED") or os.environ.get("MIFIT_ENABLED", "0")) == "1"
    MIFIT_TOKEN = rows.get("MIFIT_TOKEN") or os.environ.get("MIFIT_TOKEN", "")
    MIFIT_ENDPOINT = (rows.get("MIFIT_ENDPOINT") or os.environ.get("MIFIT_ENDPOINT", "")
                      or "https://api-mifit.huami.com").rstrip("/")
    MIFIT_SINCE_DATE = rows.get("MIFIT_SINCE_DATE") or os.environ.get("MIFIT_SINCE_DATE", "")
    try:
        MIFIT_INTERVAL_MIN = int(
            rows.get("MIFIT_INTERVAL_MIN") or os.environ.get("MIFIT_INTERVAL_MIN", "360")
        )
    except (ValueError, TypeError):
        MIFIT_INTERVAL_MIN = 360
    try:
        raw = rows.get("GPX_TYPE_CUSTOM", "")
        parsed = json.loads(raw) if raw else {}
        _CUSTOM_GPX_TYPES = parsed if isinstance(parsed, dict) else {}
    except Exception:
        _CUSTOM_GPX_TYPES = {}
    try:
        raw = rows.get("GPS_THRESHOLDS_CUSTOM", "")
        parsed = json.loads(raw) if raw else {}
        _GPS_THRESHOLDS_CUSTOM = parsed if isinstance(parsed, dict) else {}
    except Exception:
        _GPS_THRESHOLDS_CUSTOM = {}
