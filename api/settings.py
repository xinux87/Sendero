import json
from flask import Blueprint, jsonify, request

import core.config as cfg
from core.database import db
from core.config import refresh_config

settings_bp = Blueprint("settings", __name__)


@settings_bp.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify({
        "IMMICH_URL":        cfg.IMMICH_URL,
        "IMMICH_API_KEY":    cfg.IMMICH_API_KEY,
        "IMMICH_MARGIN_MIN": str(cfg.IMMICH_MARGIN_MIN),
        "IMMICH_DIST_M":     str(cfg.IMMICH_DIST_M),
        "DEM_URL":           cfg.DEM_URL,
        "PLANNER_URL":       cfg.PLANNER_URL,
        "GEOCODE_URL":       cfg.GEOCODE_URL,
        "IBP_API_KEY":       cfg.IBP_API_KEY,
    })


@settings_bp.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.get_json(force=True) or {}
    con = db()
    for key in cfg._SETTINGS_KEYS:
        if key in data:
            con.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, str(data[key]).strip()),
            )
    con.commit()
    refresh_config()
    return "", 204


@settings_bp.route("/api/settings/gps-thresholds", methods=["GET"])
def get_gps_thresholds():
    """Umbrales EFECTIVOS por actividad (ajustes guardados con fallback a los
    valores por defecto), para el panel Ajustes → GPS incorrecto."""
    return jsonify({act: cfg.gps_thresholds_for(act)
                    for act in cfg.DEFAULT_GPS_THRESHOLDS})


@settings_bp.route("/api/settings/gps-thresholds", methods=["POST"])
def save_gps_thresholds():
    data = request.get_json(force=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Se esperaba un objeto JSON"}), 400
    clean = {}
    for act, th in data.items():
        if act not in cfg.DEFAULT_GPS_THRESHOLDS or not isinstance(th, dict):
            continue
        try:
            clean[act] = {
                "max_speed_kmh":    float(th["max_speed_kmh"]),
                "max_vert_rate_ms": float(th["max_vert_rate_ms"]),
                "max_ele_m":        float(th["max_ele_m"]),
            }
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": f"Umbrales inválidos para «{act}»"}), 400
    con = db()
    con.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ("GPS_THRESHOLDS_CUSTOM", json.dumps(clean)),
    )
    con.commit()
    refresh_config()
    return "", 204


@settings_bp.route("/api/settings/gpx-types", methods=["GET"])
def get_gpx_types():
    return jsonify(cfg._CUSTOM_GPX_TYPES)


@settings_bp.route("/api/settings/gpx-types", methods=["POST"])
def save_gpx_types():
    data = request.get_json(force=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Se esperaba un objeto JSON"}), 400
    con = db()
    con.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ("GPX_TYPE_CUSTOM", json.dumps({str(k).lower(): str(v) for k, v in data.items()})),
    )
    con.commit()
    refresh_config()
    return "", 204


# ── Almacenamiento ──────────────────────────────────────────────────────────
# Lo consume el panel "Almacenamiento" del dashboard (rediseño 2a). Todo sale de
# un os.scandir por carpeta de /data: no hay tabla ni caché que mantener, y a
# cambio la cifra nunca se queda vieja. Se pide una vez por visita al dashboard.

_STORAGE_DIRS = (
    ("db",       lambda: [cfg.DB_PATH, cfg.DB_PATH.with_name(cfg.DB_PATH.name + "-wal")]),
    ("gpx",      lambda: _walk(cfg.GPX_DIR)),
    ("photos",   lambda: _walk(cfg.PHOTO_DIR)),
    ("thumbs",   lambda: _walk(cfg.THUMB_DIR)),
    ("tiles",    lambda: _walk(cfg.TILES_DIR)),
)


def _walk(path):
    """Todos los archivos bajo `path`, recursivo y tolerante a carpetas que no
    existen (una instalación nueva no tiene data/gpx/versions/ hasta la primera
    edición)."""
    try:
        return [p for p in path.rglob("*") if p.is_file()]
    except OSError:
        return []


def _size(paths):
    total = 0
    for p in paths:
        try:
            total += p.stat().st_size
        except OSError:
            pass                      # borrado entre el listado y el stat
    return total


@settings_bp.route("/api/storage")
def api_storage():
    out = {clave: _size(f()) for clave, f in _STORAGE_DIRS}
    out["total"] = sum(out.values())
    # Fotos por referencia (Immich): no ocupan disco aquí, pero saber cuántas hay
    # explica que "fotos" pese poco y en la UI se dice.
    row = db().execute(
        "SELECT COUNT(*) AS n FROM photos WHERE immich_id IS NOT NULL").fetchone()
    out["immich_refs"] = row["n"] if row else 0
    return jsonify(out)
