import os
import json
import sqlite3
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("SENDERO_DATA", BASE / "data"))
GPX_DIR = DATA / "gpx"
PHOTO_DIR = DATA / "photos"
THUMB_DIR = DATA / "thumbs"
DB_PATH = DATA / "sendero.db"

for d in (DATA, GPX_DIR, PHOTO_DIR, THUMB_DIR):
    d.mkdir(parents=True, exist_ok=True)

IMMICH_URL = os.environ.get("IMMICH_URL", "").rstrip("/")
IMMICH_API_KEY = os.environ.get("IMMICH_API_KEY", "")
IMMICH_MARGIN_MIN = int(os.environ.get("IMMICH_MARGIN_MIN", "180"))
IMMICH_DIST_M = int(os.environ.get("IMMICH_DIST_M", "100"))
IMMICH_ENABLED = bool(IMMICH_URL and IMMICH_API_KEY)

_SETTINGS_KEYS = {"IMMICH_URL", "IMMICH_API_KEY", "IMMICH_MARGIN_MIN", "IMMICH_DIST_M"}
_CUSTOM_GPX_TYPES: dict = {}


def refresh_config():
    global IMMICH_URL, IMMICH_API_KEY, IMMICH_MARGIN_MIN, IMMICH_DIST_M, IMMICH_ENABLED, _CUSTOM_GPX_TYPES
    try:
        con = sqlite3.connect(DB_PATH)
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
    try:
        raw = rows.get("GPX_TYPE_CUSTOM", "")
        parsed = json.loads(raw) if raw else {}
        _CUSTOM_GPX_TYPES = parsed if isinstance(parsed, dict) else {}
    except Exception:
        _CUSTOM_GPX_TYPES = {}
