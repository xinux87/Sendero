"""API de ajustes/estado/disparo de la auto-importación desde Mi Fit / Zepp.

El trabajo pesado (descarga + subida de GPX) NO ocurre aquí: vive en el servicio
aparte mifit_sync.py, para no bloquear los workers de gunicorn (misma filosofía
que el watcher). Estos endpoints solo:
- leen/guardan los ajustes de Mi Fit (token, endpoint, intervalo, on/off),
- exponen el estado de la última sincronización,
- encolan una sincronización manual poniendo un flag en settings que mifit_sync
  recoge en su próxima vuelta (≤ MIFIT_POLL segundos).
"""
import datetime as dt
import json

from flask import Blueprint, jsonify, request

import core.config as cfg
from core.config import refresh_config
from core.database import db

mifit_bp = Blueprint("mifit", __name__)


def _get(key, default=""):
    row = db().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


@mifit_bp.route("/api/mifit/settings", methods=["GET"])
def get_mifit_settings():
    # El token no se devuelve entero (dato sensible): solo si hay y sus últimos 4.
    token = cfg.MIFIT_TOKEN or ""
    return jsonify({
        "enabled":     cfg.MIFIT_ENABLED,
        "endpoint":    cfg.MIFIT_ENDPOINT,
        "interval_min": cfg.MIFIT_INTERVAL_MIN,
        "since_date":  cfg.MIFIT_SINCE_DATE,
        "has_token":   bool(token),
        "token_last4": token[-4:] if token else "",
    })


@mifit_bp.route("/api/mifit/settings", methods=["POST"])
def save_mifit_settings():
    data = request.get_json(force=True) or {}
    con = db()

    if "enabled" in data:
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("MIFIT_ENABLED", "1" if data["enabled"] else "0"))
    if "endpoint" in data:
        endpoint = str(data["endpoint"]).strip().rstrip("/") or "https://api-mifit.huami.com"
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("MIFIT_ENDPOINT", endpoint))
    if "interval_min" in data:
        try:
            interval = max(0, int(data["interval_min"]))
        except (ValueError, TypeError):
            return jsonify({"error": "Intervalo inválido"}), 400
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("MIFIT_INTERVAL_MIN", str(interval)))
    if "since_date" in data:
        since_date = str(data["since_date"]).strip()
        if since_date:
            try:
                dt.datetime.strptime(since_date, "%Y-%m-%d")
            except ValueError:
                return jsonify({"error": "Fecha inválida (usa AAAA-MM-DD)"}), 400
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("MIFIT_SINCE_DATE", since_date))
    # El token solo se sobrescribe si viene uno no vacío: así guardar el resto de
    # ajustes no borra el token capturado por mifit-auth o pegado a mano.
    if "token" in data and str(data["token"]).strip():
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("MIFIT_TOKEN", str(data["token"]).strip()))

    con.commit()
    refresh_config()
    return "", 204


@mifit_bp.route("/api/mifit/sync", methods=["POST"])
def trigger_mifit_sync():
    if not cfg.MIFIT_TOKEN:
        return jsonify({"error": "No hay token de Mi Fit/Zepp configurado"}), 400
    data = request.get_json(silent=True) or {}
    con = db()
    # "Reimportar desde la fecha": reinicia la marca incremental para que el suelo
    # efectivo vuelva a ser la fecha de "Importar desde" (no hay forma de bajar la
    # marca desde la UI de otro modo). La dedup por nombre evita duplicados.
    if data.get("reset"):
        con.execute("DELETE FROM settings WHERE key='MIFIT_LAST_TRACKID'")
    con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                ("MIFIT_SYNC_REQUESTED", dt.datetime.now().isoformat()))
    con.commit()
    return jsonify({"queued": True, "reset": bool(data.get("reset"))}), 202


@mifit_bp.route("/api/mifit/status", methods=["GET"])
def get_mifit_status():
    try:
        last_result = json.loads(_get("MIFIT_LAST_RESULT", "") or "null")
    except (ValueError, TypeError):
        last_result = None
    return jsonify({
        "status":      _get("MIFIT_STATUS", "") or ("ok" if cfg.MIFIT_TOKEN else "no_token"),
        "last_sync":   _get("MIFIT_LAST_SYNC", "") or None,
        "last_result": last_result,
        "requested":   bool((_get("MIFIT_SYNC_REQUESTED", "") or "").strip()),
        "enabled":     cfg.MIFIT_ENABLED,
        "interval_min": cfg.MIFIT_INTERVAL_MIN,
        "has_token":   bool(cfg.MIFIT_TOKEN),
    })
