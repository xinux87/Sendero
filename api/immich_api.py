import json
import datetime as dt
from flask import Blueprint, abort, request, jsonify, Response

import core.config as cfg
from core.database import db
from core.immich import immich_get, immich_search, min_dist_to_track

immich_bp = Blueprint("immich", __name__)


@immich_bp.route("/api/config")
def config():
    return jsonify({
        "immich":            cfg.IMMICH_ENABLED,
        "immich_margin_min": cfg.IMMICH_MARGIN_MIN,
        "immich_dist_m":     cfg.IMMICH_DIST_M,
    })


@immich_bp.route("/api/routes/<int:rid>/immich/candidates")
def immich_candidates(rid):
    """Fotos de Immich tomadas durante la ventana temporal del track."""
    if not cfg.IMMICH_ENABLED:
        return jsonify({"error": "Immich no está configurado"}), 400
    r = db().execute("SELECT started_at,duration_s,geojson FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    if not r["started_at"]:
        return jsonify({"error": "Este GPX no tiene marcas de tiempo; no se puede cruzar con Immich"}), 400
    start = dt.datetime.fromisoformat(r["started_at"])
    end = start + dt.timedelta(seconds=(r["duration_s"] or 0))
    margin = dt.timedelta(minutes=cfg.IMMICH_MARGIN_MIN)
    after  = (start - margin).astimezone(dt.timezone.utc)
    before = (end   + margin).astimezone(dt.timezone.utc)
    track = json.loads(r["geojson"] or "[]")
    taken = {row["immich_id"] for row in db().execute(
        "SELECT immich_id FROM photos WHERE route_id=? AND immich_id IS NOT NULL", (rid,))}
    try:
        cands = immich_search(after.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                              before.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    except Exception as e:
        return jsonify({"error": f"No se pudo consultar Immich: {e}"}), 502
    cands = [c for c in cands if c["immich_id"] not in taken]
    for c in cands:
        c["dist_m"] = (round(min_dist_to_track(track, c["lat"], c["lon"]))
                       if c["lat"] is not None and c["lon"] is not None and track else None)
    cands.sort(key=lambda c: (c["dist_m"] is None, c["dist_m"] if c["dist_m"] is not None else 0))
    return jsonify({"window": {"after": after.isoformat(), "before": before.isoformat()},
                    "candidates": cands})


@immich_bp.route("/api/routes/<int:rid>/immich/select", methods=["POST"])
def immich_select(rid):
    """Asocia fotos Immich elegidas a la ruta (por referencia, sin copiarlas)."""
    if not cfg.IMMICH_ENABLED:
        return jsonify({"error": "Immich no está configurado"}), 400
    if not db().execute("SELECT 1 FROM routes WHERE id=?", (rid,)).fetchone():
        abort(404)
    items = request.get_json(force=True).get("items", [])
    con = db()
    added = 0
    for it in items:
        if not it.get("immich_id"):
            continue
        con.execute(
            "INSERT INTO photos (route_id,immich_id,original,lat,lon,taken_at) VALUES (?,?,?,?,?,?)",
            (rid, it["immich_id"], it.get("immich_id"), it.get("lat"),
             it.get("lon"), it.get("taken_at")),
        )
        added += 1
    con.commit()
    return jsonify({"added": added}), 201


@immich_bp.route("/api/immich/thumb/<asset_id>")
def immich_thumb(asset_id):
    """Proxy de miniatura de un asset de Immich."""
    if not cfg.IMMICH_ENABLED:
        abort(404)
    size = request.args.get("size", "thumbnail")
    r = immich_get(f"/api/assets/{asset_id}/thumbnail", params={"size": size})
    if r.status_code != 200:
        abort(502)
    return Response(r.content, content_type=r.headers.get("Content-Type", "image/jpeg"))
