import json
import re
import shutil
import datetime as dt
from flask import Blueprint, abort, request, jsonify, render_template, Response, send_file

import core.config as cfg
from core.database import db
from core.parsers import (
    analyse_gpx, analyse_fit, _detect_activity, _gpx_type_lookup, _FIT_SPORT_MAP
)
from core.summaries import auto_summary
from core.thumbs import generate_thumb
from core.editing import load_gpx, extract_points
from core.gps_analysis import detect_gps_anomalies
from werkzeug.utils import secure_filename

routes_bp = Blueprint("routes", __name__)


def _build_route_dict(rid):
    """Construye el dict JSON completo de una ruta (fotos incluidas)."""
    r = db().execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    photos = db().execute(
        "SELECT id,file,immich_id,original,lat,lon,taken_at FROM photos "
        "WHERE route_id=? ORDER BY taken_at",
        (rid,),
    ).fetchall()
    d = dict(r)
    d["geojson"]    = json.loads(d["geojson"]    or "[]")
    d["elevation"]  = json.loads(d["elevation"]  or "[]")
    d["heart_rate"] = json.loads(d["heart_rate"] or "[]")
    d["speed"]      = json.loads(d["speed"]      or "[]")
    d["gps_issues"] = json.loads(d.get("gps_issues") or "[]")
    d["photos"]     = [dict(p) for p in photos]
    d["auto_summary"]   = auto_summary(r)
    d["device"]         = d.get("device") or None
    d["immich_checked"] = bool(d.get("immich_checked"))
    # Versión actual del editor (0 = nunca editada). Derivada de route_versions
    # a propósito: sin columna nueva en routes (ver CLAUDE.md, reglas 12-13).
    v = db().execute(
        "SELECT MAX(version_n) AS v FROM route_versions WHERE route_id=?", (rid,)
    ).fetchone()
    d["version"] = v["v"] or 0
    return d


@routes_bp.route("/")
def index():
    from flask import redirect
    return redirect("/dashboard")


@routes_bp.route("/dashboard")
def stats_page():
    return render_template("app.html", initial_section="dashboard", planner_url=cfg.PLANNER_URL)


@routes_bp.route("/rutas")
def dashboard():
    return render_template("app.html", initial_section="rutas", planner_url=cfg.PLANNER_URL)


def _recompute_stats(con):
    """Calcula las estadísticas globales y las guarda en settings['stats_cache']."""
    rows = con.execute(
        "SELECT distance_m, ascent_m, moving_s, avg_speed, "
        "activity_type, started_at, name FROM routes"
    ).fetchall()
    total_km = 0.0
    total_ascent = 0.0
    total_moving_s = 0.0
    by_type = {}
    by_year = {}
    records = {"longest": None, "highest": None, "fastest": None}

    for r in rows:
        d = dict(r)
        km = (d["distance_m"] or 0) / 1000
        asc = d["ascent_m"] or 0
        ms = d["moving_s"] or 0
        spd = d["avg_speed"] or 0
        act = d["activity_type"] or "otros"
        year = d["started_at"][:4] if d["started_at"] else None

        total_km += km
        total_ascent += asc
        total_moving_s += ms

        if act not in by_type:
            by_type[act] = {"count": 0, "km": 0.0, "ascent_m": 0.0}
        by_type[act]["count"] += 1
        by_type[act]["km"] += km
        by_type[act]["ascent_m"] += asc

        if year:
            by_year[year] = by_year.get(year, 0) + 1

        name = d["name"]
        if records["longest"] is None or km > records["longest"]["km"]:
            records["longest"] = {"name": name, "km": round(km, 2)}
        if records["highest"] is None or asc > records["highest"]["ascent_m"]:
            records["highest"] = {"name": name, "ascent_m": round(asc, 0)}
        if spd and (records["fastest"] is None or spd > records["fastest"]["avg_speed"]):
            records["fastest"] = {"name": name, "avg_speed": round(spd * 3.6, 1)}

    for v in by_type.values():
        v["km"] = round(v["km"], 2)
        v["ascent_m"] = round(v["ascent_m"], 0)

    payload = json.dumps({
        "total_routes": len(rows),
        "total_km": round(total_km, 2),
        "total_ascent_m": round(total_ascent, 0),
        "total_moving_s": round(total_moving_s, 0),
        "by_type": by_type,
        "by_year": dict(sorted(by_year.items())),
        "records": records,
    })
    con.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('stats_cache',?)",
        (payload,),
    )
    con.execute("DELETE FROM settings WHERE key='stats_dirty'")
    con.commit()


def _mark_stats_dirty(con):
    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('stats_dirty','1')")


@routes_bp.route("/api/stats")
def api_stats():
    con = db()
    dirty = bool(con.execute("SELECT 1 FROM settings WHERE key='stats_dirty'").fetchone())
    row = con.execute("SELECT value FROM settings WHERE key='stats_cache'").fetchone()
    if not row:
        if dirty:
            return jsonify({"dirty": True})
        _recompute_stats(con)
        row = con.execute("SELECT value FROM settings WHERE key='stats_cache'").fetchone()
    if dirty:
        data = json.loads(row["value"])
        data["dirty"] = True
        return jsonify(data)
    return Response(row["value"], mimetype="application/json")


@routes_bp.route("/api/stats/refresh", methods=["POST"])
def refresh_stats():
    _recompute_stats(db())
    return jsonify({"ok": True})


@routes_bp.route("/Sendero/<path:name>")
def sendero_page(name=None):
    r = db().execute(
        "SELECT id FROM routes WHERE name=? ORDER BY COALESCE(started_at,created_at) DESC LIMIT 1",
        (name,),
    ).fetchone()
    route_json = json.dumps(_build_route_dict(r["id"])) if r else "null"
    return render_template("sendero.html", route_json=route_json)


@routes_bp.route("/api/routes/by-name/<path:name>")
def get_route_by_name(name):
    r = db().execute(
        "SELECT id FROM routes WHERE name=? ORDER BY COALESCE(started_at,created_at) DESC LIMIT 1",
        (name,),
    ).fetchone()
    if not r:
        abort(404)
    return jsonify(_build_route_dict(r["id"]))


def _compute_gps_issues(raw, is_fit, activity_type):
    """Tramos GPS anómalos (velocidad/tasa vertical imposibles) como JSON, o None.

    Usa extract_points (arrays 1:1 por trkpt, con time/ele por punto, que
    analyse_gpx no extrae) + detect_gps_anomalies con los umbrales de la
    actividad. Nunca rompe el guardado: ante cualquier fallo devuelve None.
    """
    try:
        pts = extract_points(load_gpx(raw, is_fit))
        issues = detect_gps_anomalies(pts["lonlat"], pts["ele"], pts["time"],
                                      activity_type)
        return json.dumps(issues) if issues else None
    except Exception:
        return None


def _route_bbox(coords):
    """min_lon, min_lat, max_lon, max_lat a partir de la lista de coordenadas del track."""
    if not coords:
        return None
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return min(lons), min(lats), max(lons), max(lats)


@routes_bp.route("/api/routes/geojson", methods=["GET"])
def routes_geojson():
    """GeoJSON FeatureCollection de líneas decimadas para el mapa del dashboard.

    Acepta ?bbox=minLon,minLat,maxLon,maxLat para devolver solo las rutas cuyo
    bounding box corta esa zona (la vista actual del mapa), en vez de las líneas
    de las 475 rutas siempre: así el navegador no descarga ni mantiene en memoria
    nada que el usuario no esté viendo (ni va a ver con un par de niveles de zoom
    de margen). idx_routes_bbox descarta las que no caen dentro sin tocar la fila
    completa (y por tanto sin atravesar geojson/elevation/heart_rate).
    Sin bbox, devuelve todas las rutas (modo de compatibilidad, no usado por el
    dashboard normalmente).
    """
    con = db()
    bbox = request.args.get("bbox")
    where = "geojson IS NOT NULL AND geojson != '[]'"
    params = []
    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox.split(","))
        except ValueError:
            return jsonify({"error": "bbox inválido, formato minLon,minLat,maxLon,maxLat"}), 400
        where += (" AND bbox_min_lon<=? AND bbox_max_lon>=?"
                  " AND bbox_min_lat<=? AND bbox_max_lat>=?")
        params += [max_lon, min_lon, max_lat, min_lat]
    rows = con.execute(
        f"SELECT id, name, activity_type, geojson, started_at, distance_m "
        f"FROM routes WHERE {where}",
        params,
    ).fetchall()
    features = []
    for r in rows:
        coords = json.loads(r["geojson"] or "[]")
        if len(coords) < 2:
            continue
        # Keep every 4th point to reduce payload; always keep first and last
        step = 4
        dec = coords[::step]
        if dec[-1] != coords[-1]:
            dec.append(coords[-1])
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": dec},
            "properties": {
                "id": r["id"],
                "name": r["name"],
                "activity": r["activity_type"] or "otros",
                "year": (r["started_at"] or "")[:4] or None,
                "km": (r["distance_m"] or 0) / 1000,
            },
        })
    return jsonify({"type": "FeatureCollection", "features": features})


@routes_bp.route("/api/routes", methods=["GET"])
def list_routes():
    con = db()
    limit  = request.args.get("limit",  type=int)
    offset = request.args.get("offset", 0, type=int)
    total  = con.execute("SELECT COUNT(*) FROM routes").fetchone()[0]
    q = ("SELECT id,name,distance_m,ascent_m,duration_s,moving_s,"
         "started_at,activity_type,start_lat,start_lon,thumb_file "
         "FROM routes ORDER BY COALESCE(started_at,created_at) DESC")
    if limit is not None:
        rows = con.execute(q + " LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    else:
        rows = con.execute(q).fetchall()
    return jsonify({"items": [dict(r) for r in rows], "total": total})


@routes_bp.route("/api/routes", methods=["POST"])
def create_route():
    f = request.files.get("gpx")
    fn_lower = (f.filename or "").lower() if f else ""
    is_gpx = fn_lower.endswith(("gpx", ".gpx"))
    is_fit = fn_lower.endswith((".fit", "fit"))
    if not f or not (is_gpx or is_fit):
        return jsonify({"error": "Sube un archivo .gpx o .fit"}), 400

    stored = secure_filename(f.filename)
    if not stored:
        return jsonify({"error": "Nombre de archivo inválido"}), 400
    if (cfg.GPX_DIR / stored).exists():
        return jsonify({
            "error": "Ruta repetida: ya existe un GPX con este nombre, se descarta",
            "duplicate": True,
        }), 409

    raw = f.read()
    try:
        if is_fit:
            stats, coords, elev, gpx_name, creator = analyse_fit(raw)
        else:
            stats, coords, elev, gpx_name, creator = analyse_gpx(
                raw.decode("utf-8", errors="replace"))
    except Exception as e:
        return jsonify({"error": f"Archivo ilegible: {e}"}), 400

    (cfg.GPX_DIR / stored).write_bytes(raw)

    name = (request.form.get("name") or gpx_name
            or stats.get("started_at") or "Ruta sin nombre")

    activity_type = _detect_activity(name)
    gpx_type  = stats.pop("_gpx_type",  None)
    fit_sport = stats.pop("_fit_sport", None)
    hr_profile = stats.pop("_hr_profile", [])
    hr_avg = stats.pop("hr_avg", None)
    hr_max = stats.pop("hr_max", None)
    speed_profile = stats.pop("_speed_profile", [])
    if not activity_type and gpx_type:
        activity_type = _gpx_type_lookup(gpx_type)
    if not activity_type and fit_sport:
        activity_type = _FIT_SPORT_MAP.get(fit_sport)

    start_lat = coords[0][1] if coords else None
    start_lon = coords[0][0] if coords else None
    bbox = _route_bbox(coords)
    con = db()
    cur = con.execute(
        """INSERT INTO routes
        (name,notes,gpx_file,distance_m,ascent_m,descent_m,duration_s,moving_s,
         ele_min,ele_max,avg_speed,started_at,geojson,elevation,created_at,
         activity_type,device,start_lat,start_lon,heart_rate,hr_avg,hr_max,
         bbox_min_lon,bbox_min_lat,bbox_max_lon,bbox_max_lat,speed)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (name, "", stored, stats["distance_m"], stats["ascent_m"],
         stats["descent_m"], stats["duration_s"], stats["moving_s"],
         stats["ele_min"], stats["ele_max"], stats["avg_speed"],
         stats["started_at"], json.dumps(coords), json.dumps(elev),
         dt.datetime.now().isoformat(), activity_type, creator,
         start_lat, start_lon,
         json.dumps(hr_profile) if hr_profile else None, hr_avg, hr_max,
         *(bbox or (None, None, None, None)),
         json.dumps(speed_profile) if speed_profile else None),
    )
    con.commit()
    rid = cur.lastrowid
    thumb = generate_thumb(coords, stored)
    if thumb:
        con.execute("UPDATE routes SET thumb_file=? WHERE id=?", (thumb, rid))
    con.execute("UPDATE routes SET gps_issues=? WHERE id=?",
                (_compute_gps_issues(raw, is_fit, activity_type), rid))
    _mark_stats_dirty(con)
    con.commit()
    return jsonify({"id": rid}), 201


@routes_bp.route("/api/routes/<int:rid>", methods=["GET"])
def get_route(rid):
    return jsonify(_build_route_dict(rid))


@routes_bp.route("/api/routes/<int:rid>", methods=["DELETE"])
def delete_route(rid):
    con = db()
    r = con.execute("SELECT gpx_file, thumb_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    for p in con.execute("SELECT file FROM photos WHERE route_id=?", (rid,)).fetchall():
        if p["file"]:
            (cfg.PHOTO_DIR / p["file"]).unlink(missing_ok=True)
    (cfg.GPX_DIR / r["gpx_file"]).unlink(missing_ok=True)
    if r["thumb_file"]:
        (cfg.THUMB_DIR / r["thumb_file"]).unlink(missing_ok=True)
    shutil.rmtree(cfg.VERSIONS_DIR / str(rid), ignore_errors=True)
    con.execute("DELETE FROM photos WHERE route_id=?", (rid,))
    con.execute("DELETE FROM route_versions WHERE route_id=?", (rid,))
    con.execute("DELETE FROM routes WHERE id=?", (rid,))
    _mark_stats_dirty(con)
    con.commit()
    return "", 204


@routes_bp.route("/api/routes/<int:rid>", methods=["PATCH"])
def update_route(rid):
    data = request.get_json(force=True)
    con = db()
    fields, vals = [], []
    for key in ("name", "notes", "activity_type", "immich_checked", "device"):
        if key in data:
            fields.append(f"{key}=?")
            vals.append(data[key])
    if not fields:
        return jsonify({"error": "nada que actualizar"}), 400
    vals.append(rid)
    con.execute(f"UPDATE routes SET {', '.join(fields)} WHERE id=?", vals)
    con.commit()
    return "", 204


def _reanalyse_and_update(con, rid, row):
    """Re-parsea el archivo activo de la ruta y actualiza la fila completa
    (stats, geojson, elevation, heart_rate, speed, bbox, thumb, stats_dirty).

    row necesita al menos name y gpx_file. Devuelve None si todo fue bien, o
    la tupla (respuesta, status) para que el endpoint la propague. Lo usan
    rescan_route y el guardado/restauración del editor (api/editor.py).
    """
    r = row
    fpath = cfg.GPX_DIR / r["gpx_file"]
    if not fpath.exists():
        return jsonify({"error": "Archivo original no encontrado"}), 404

    raw = fpath.read_bytes()
    is_fit = r["gpx_file"].lower().endswith(".fit")
    try:
        if is_fit:
            stats, coords, elev, _, creator = analyse_fit(raw)
        else:
            stats, coords, elev, _, creator = analyse_gpx(
                raw.decode("utf-8", errors="replace"))
    except Exception as e:
        return jsonify({"error": f"Error al parsear: {e}"}), 400

    gpx_type  = stats.pop("_gpx_type",  None)
    fit_sport = stats.pop("_fit_sport", None)
    hr_profile = stats.pop("_hr_profile", [])
    hr_avg = stats.pop("hr_avg", None)
    hr_max = stats.pop("hr_max", None)
    speed_profile = stats.pop("_speed_profile", [])

    activity_type = _detect_activity(r["name"])
    if not activity_type and gpx_type:
        activity_type = _gpx_type_lookup(gpx_type)
    if not activity_type and fit_sport:
        activity_type = _FIT_SPORT_MAP.get(fit_sport)
    if not activity_type:
        # Si la re-detección no da nada (nombre tipo fecha y GPX sin <type> —
        # lo habitual tras una edición: to_xml() no conserva un <type> que gpxpy
        # no leyó), CONSERVAR la actividad ya asignada. Si no, cada guardado del
        # editor/rescan borraba la elegida a mano y los avisos GPS se calculaban
        # con los umbrales de 'otros' (p.ej. 40 km/h en vez de 15 de senderismo).
        prev = con.execute("SELECT activity_type FROM routes WHERE id=?",
                           (rid,)).fetchone()
        if prev:
            activity_type = prev["activity_type"]

    if not creator:
        # Mismo criterio que activity_type: si el re-parseo no da dispositivo
        # (habitual tras una edición, el to_xml() no reescribe el creator que
        # gpxpy no leyó), conservar el device ya guardado — puede haberse
        # editado a mano desde el editor.
        prev = con.execute("SELECT device FROM routes WHERE id=?",
                           (rid,)).fetchone()
        if prev:
            creator = prev["device"]

    start_lat = coords[0][1] if coords else None
    start_lon = coords[0][0] if coords else None
    bbox = _route_bbox(coords) or (None, None, None, None)
    con.execute(
        """UPDATE routes SET
           distance_m=?,ascent_m=?,descent_m=?,duration_s=?,moving_s=?,
           ele_min=?,ele_max=?,avg_speed=?,started_at=?,
           geojson=?,elevation=?,device=?,activity_type=?,
           start_lat=?,start_lon=?,heart_rate=?,hr_avg=?,hr_max=?,
           bbox_min_lon=?,bbox_min_lat=?,bbox_max_lon=?,bbox_max_lat=?,speed=?
           WHERE id=?""",
        (stats["distance_m"], stats["ascent_m"], stats["descent_m"],
         stats["duration_s"], stats["moving_s"],
         stats["ele_min"], stats["ele_max"], stats["avg_speed"], stats["started_at"],
         json.dumps(coords), json.dumps(elev), creator, activity_type,
         start_lat, start_lon,
         json.dumps(hr_profile) if hr_profile else None, hr_avg, hr_max,
         *bbox, json.dumps(speed_profile) if speed_profile else None, rid),
    )
    con.commit()
    thumb = generate_thumb(coords, r["gpx_file"])
    if thumb:
        con.execute("UPDATE routes SET thumb_file=? WHERE id=?", (thumb, rid))
    con.execute("UPDATE routes SET gps_issues=? WHERE id=?",
                (_compute_gps_issues(raw, is_fit, activity_type), rid))
    _mark_stats_dirty(con)
    con.commit()
    return None


@routes_bp.route("/api/routes/<int:rid>/rescan", methods=["POST"])
def rescan_route(rid):
    con = db()
    r = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    err = _reanalyse_and_update(con, rid, r)
    if err:
        return err
    return jsonify(_build_route_dict(rid))


@routes_bp.route("/api/routes/<int:rid>/thumb", methods=["GET"])
def route_thumb(rid):
    r = db().execute("SELECT thumb_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r or not r["thumb_file"]:
        abort(404)
    fpath = cfg.THUMB_DIR / r["thumb_file"]
    if not fpath.exists():
        abort(404)
    # send_file (no Response manual): emite ETag/Last-Modified y responde 304 a
    # revalidaciones. No lleva max_age porque el PNG se regenera CON EL MISMO
    # nombre en cada rescan/edición — un max_age largo mostraría el thumb viejo.
    return send_file(fpath, mimetype="image/png")


@routes_bp.route("/api/routes/<int:rid>/gpx", methods=["GET"])
def download_route_gpx(rid):
    r = db().execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    fpath = cfg.GPX_DIR / r["gpx_file"]
    if not fpath.exists():
        abort(404)
    safe = re.sub(r'[^\w\-]', '_', r["name"])[:80]
    ext = fpath.suffix or ".gpx"
    as_attachment = request.args.get("download", "0") != "0"
    mime = "application/gpx+xml" if ext == ".gpx" else "application/octet-stream"
    disposition = f'attachment; filename="{safe}{ext}"' if as_attachment else "inline"
    return Response(
        fpath.read_bytes(),
        content_type=mime,
        headers={"Content-Disposition": disposition},
    )
