import datetime as dt
from flask import Blueprint, abort, request, jsonify, send_file, Response

import core.config as cfg
from core.database import db
from core.exif import read_exif
from core.immich import immich_get
from werkzeug.utils import secure_filename

photos_bp = Blueprint("photos", __name__)


@photos_bp.route("/api/routes/<int:rid>/photos", methods=["POST"])
def add_photos(rid):
    if not db().execute("SELECT 1 FROM routes WHERE id=?", (rid,)).fetchone():
        abort(404)
    saved = []
    con = db()
    for f in request.files.getlist("photos"):
        if not f.filename:
            continue
        fname = secure_filename(f.filename)
        stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S%f")
        stored = f"{rid}_{stamp}_{fname}"
        path = cfg.PHOTO_DIR / stored
        f.save(path)
        lat, lon, taken = read_exif(path)
        cur = con.execute(
            "INSERT INTO photos (route_id,file,original,lat,lon,taken_at) VALUES (?,?,?,?,?,?)",
            (rid, stored, f.filename, lat, lon, taken),
        )
        saved.append(cur.lastrowid)
    con.commit()
    return jsonify({"added": saved}), 201


@photos_bp.route("/api/photos/<int:pid>/file")
def photo_file(pid):
    p = db().execute("SELECT file,immich_id FROM photos WHERE id=?", (pid,)).fetchone()
    if not p:
        abort(404)
    if p["immich_id"]:
        size = request.args.get("size", "preview")
        r = immich_get(f"/api/assets/{p['immich_id']}/thumbnail", params={"size": size})
        if r.status_code != 200:
            abort(502)
        return Response(r.content, content_type=r.headers.get("Content-Type", "image/jpeg"))
    return send_file(cfg.PHOTO_DIR / p["file"])


@photos_bp.route("/api/photos/<int:pid>", methods=["DELETE"])
def delete_photo(pid):
    con = db()
    p = con.execute("SELECT file FROM photos WHERE id=?", (pid,)).fetchone()
    if not p:
        abort(404)
    if p["file"]:
        (cfg.PHOTO_DIR / p["file"]).unlink(missing_ok=True)
    con.execute("DELETE FROM photos WHERE id=?", (pid,))
    con.commit()
    return "", 204
