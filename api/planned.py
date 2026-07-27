import json
import datetime as dt
import re
from flask import Blueprint, abort, redirect, request, jsonify, render_template, Response

import core.config as cfg
from core.database import db, plan_id_from_public, set_public_id
from core.parsers import analyse_gpx, _detect_activity, _gpx_type_lookup
from core.summaries import auto_summary_planned

planned_bp = Blueprint("planned", __name__)

# Columnas del listado de planes. Única fuente de verdad: las lee list_planned() y
# api/sync.py para los 'upserted' del delta (mismo criterio que ROUTE_LIST_COLS en
# api/routes.py). Cubiertas por idx_planned_list_cov (regla 12).
PLANNED_LIST_COLS = ("id,public_id,name,source,source_url,activity_type,"
                     "distance_m,ascent_m,descent_m,ele_max,start_lat,start_lon,"
                     "created_at")


def _build_plan_dict(pid):
    r = db().execute("SELECT * FROM planned_routes WHERE id=?", (pid,)).fetchone()
    if not r:
        abort(404)
    d = dict(r)
    d["geojson"]   = json.loads(d.get("geojson")   or "[]")
    d["elevation"] = json.loads(d.get("elevation") or "[]")
    d["has_gpx"]   = bool(d.get("gpx_data"))
    d["gpx_data"]  = None
    d["auto_summary"] = auto_summary_planned(d)
    return d


@planned_bp.route("/planificacion")
def planificacion_page():
    return render_template("shell.html")


@planned_bp.route("/Plan/<path:ref>")
def plan_detalle_page(ref=None):
    """Detalle de un plan por public_id.

    Acepta también el nombre (enlaces guardados de antes de que los planes
    tuvieran public_id) y en ese caso redirige al public_id, que es la URL
    canónica: el nombre es ambiguo si hay dos planes iguales y se rompe al
    renombrar.

    La vista es una sección de la SPA (templates/sec/plan.html + static/js/sec/
    plan.js): aquí solo se sirve el shell. El plan va como `bootstrap_json` para
    que la primera carga no necesite un fetch extra; si no se resuelve, el módulo
    lo pide al Store (que puede responder desde su copia local sin conexión).
    """
    r = db().execute("SELECT id FROM planned_routes WHERE public_id=?", (ref,)).fetchone()
    if not r:
        byname = db().execute(
            "SELECT public_id FROM planned_routes WHERE name=? "
            "ORDER BY created_at DESC LIMIT 1", (ref,),
        ).fetchone()
        if byname and byname["public_id"]:
            return redirect("/Plan/" + byname["public_id"], code=302)
    bootstrap = json.dumps(_build_plan_dict(r["id"])) if r else ""
    return render_template("shell.html", bootstrap_json=bootstrap)


@planned_bp.route("/api/planned", methods=["GET"])
def list_planned():
    con = db()
    limit  = request.args.get("limit", type=int)
    offset = request.args.get("offset", 0, type=int)
    total  = con.execute("SELECT COUNT(*) FROM planned_routes").fetchone()[0]
    q = (f"SELECT {PLANNED_LIST_COLS} "
         "FROM planned_routes ORDER BY created_at DESC")
    rows = (
        con.execute(q + " LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        if limit is not None
        else con.execute(q).fetchall()
    )
    return jsonify({"items": [dict(r) for r in rows], "total": total})


@planned_bp.route("/api/planned", methods=["POST"])
def create_planned():
    if request.files.get("gpx"):
        f = request.files["gpx"]
        fn_lower = (f.filename or "").lower()
        if not fn_lower.endswith(("gpx", ".gpx")):
            return jsonify({"error": "Solo se aceptan archivos .gpx para planificación"}), 400
        raw = f.read()
        try:
            stats, coords, elev, gpx_name, _ = analyse_gpx(
                raw.decode("utf-8", errors="replace"))
        except Exception as e:
            return jsonify({"error": f"Archivo GPX ilegible: {e}"}), 400

        name = request.form.get("name") or gpx_name or "Ruta planificada"
        activity_type = _detect_activity(name)
        gpx_type = stats.pop("_gpx_type", None)
        if not activity_type and gpx_type:
            activity_type = _gpx_type_lookup(gpx_type)

        source = "gpx"
        source_url = None
        gpx_bytes = raw
    else:
        return jsonify({"error": "Se requiere un archivo GPX"}), 400

    start_lat = coords[0][1] if coords else None
    start_lon = coords[0][0] if coords else None

    con = db()
    cur = con.execute(
        """INSERT INTO planned_routes
           (name,source,source_url,activity_type,distance_m,ascent_m,descent_m,
            ele_min,ele_max,start_lat,start_lon,geojson,elevation,gpx_data,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (name, source, source_url, activity_type,
         stats.get("distance_m"), stats.get("ascent_m"), stats.get("descent_m"),
         stats.get("ele_min"), stats.get("ele_max"),
         start_lat, start_lon,
         json.dumps(coords), json.dumps(elev),
         gpx_bytes,
         dt.datetime.now().isoformat()),
    )
    pub = set_public_id(con, "planned_routes", cur.lastrowid)
    con.commit()
    return jsonify({"id": pub, "public_id": pub, "name": name}), 201


@planned_bp.route("/api/planned/<pid>", methods=["GET"])
def get_planned(pid):
    return jsonify(_build_plan_dict(plan_id_from_public(pid)))


@planned_bp.route("/api/planned/<pid>", methods=["PATCH"])
def update_planned(pid):
    pid = plan_id_from_public(pid)
    data = request.get_json(force=True)
    con = db()
    fields, vals = [], []
    for key in ("name", "notes", "activity_type"):
        if key in data:
            fields.append(f"{key}=?")
            vals.append(data[key])
    if not fields:
        return jsonify({"error": "nada que actualizar"}), 400
    vals.append(pid)
    con.execute(f"UPDATE planned_routes SET {', '.join(fields)} WHERE id=?", vals)
    con.commit()
    return "", 204


@planned_bp.route("/api/planned/<pid>", methods=["DELETE"])
def delete_planned(pid):
    pid = plan_id_from_public(pid)
    con = db()
    if not con.execute("SELECT 1 FROM planned_routes WHERE id=?", (pid,)).fetchone():
        abort(404)
    con.execute("DELETE FROM planned_routes WHERE id=?", (pid,))
    con.commit()
    return "", 204


@planned_bp.route("/api/planned/<pid>/gpx", methods=["GET"])
def download_planned_gpx(pid):
    pid = plan_id_from_public(pid)
    r = db().execute(
        "SELECT name, gpx_data FROM planned_routes WHERE id=?", (pid,)
    ).fetchone()
    if not r or not r["gpx_data"]:
        abort(404)
    safe = re.sub(r'[^\w\-]', '_', r["name"])[:80]
    return Response(
        r["gpx_data"],
        content_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{safe}.gpx"'},
    )
