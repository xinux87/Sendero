"""
Sendero — registro autoalojado de rutas de montaña.
Una sola app: sube GPX, los visualiza (mapa + perfil de elevación),
les asocia fotos (con su posición GPS si la llevan en el EXIF)
y genera resúmenes de cada salida.
"""
import os
import io
import json
import sqlite3
import datetime as dt
from pathlib import Path

import gpxpy
import fitparse
import requests
from flask import (
    Flask, request, jsonify, send_file, abort,
    render_template, g, Response
)
from werkzeug.utils import secure_filename
from PIL import Image, ExifTags

# ---------------------------------------------------------------- rutas de datos
BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("SENDERO_DATA", BASE / "data"))
GPX_DIR = DATA / "gpx"
PHOTO_DIR = DATA / "photos"
DB_PATH = DATA / "sendero.db"
for d in (DATA, GPX_DIR, PHOTO_DIR):
    d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- Immich
IMMICH_URL = os.environ.get("IMMICH_URL", "").rstrip("/")
IMMICH_API_KEY = os.environ.get("IMMICH_API_KEY", "")
# margen, en minutos, que se añade antes y después del track al buscar fotos
IMMICH_MARGIN_MIN = int(os.environ.get("IMMICH_MARGIN_MIN", "180"))
IMMICH_ENABLED = bool(IMMICH_URL and IMMICH_API_KEY)


def immich_get(path, **kwargs):
    return requests.get(f"{IMMICH_URL}{path}",
                        headers={"x-api-key": IMMICH_API_KEY},
                        timeout=20, **kwargs)


def min_dist_to_track(track, lat, lon):
    """Distancia mínima (m) de un punto a cualquier vértice del track [[lon,lat],...]."""
    import math
    best = float("inf")
    rlat = math.radians(lat)
    for lon2, lat2 in track:
        dlat = math.radians(lat2 - lat)
        dlon = math.radians(lon2 - lon)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(rlat) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
        d = 2 * 6371000 * math.asin(min(1, math.sqrt(a)))
        if d < best:
            best = d
    return best


def immich_search(taken_after, taken_before):
    """Busca imágenes en Immich tomadas dentro del rango dado."""
    body = {
        "type": "IMAGE",
        "takenAfter": taken_after,
        "takenBefore": taken_before,
        "withExif": True,
        "size": 1000,
        "page": 1,
    }
    r = requests.post(f"{IMMICH_URL}/api/search/metadata",
                      headers={"x-api-key": IMMICH_API_KEY,
                               "Content-Type": "application/json"},
                      json=body, timeout=20)
    r.raise_for_status()
    items = r.json().get("assets", {}).get("items", [])
    out = []
    for a in items:
        exif = a.get("exifInfo") or {}
        out.append({
            "immich_id": a["id"],
            "taken_at": a.get("localDateTime") or exif.get("dateTimeOriginal"),
            "lat": exif.get("latitude"),
            "lon": exif.get("longitude"),
        })
    return out

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB por subida

# ---------------------------------------------------------------- base de datos
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            notes TEXT DEFAULT '',
            gpx_file TEXT NOT NULL,
            distance_m REAL, ascent_m REAL, descent_m REAL,
            duration_s REAL, moving_s REAL,
            ele_min REAL, ele_max REAL,
            avg_speed REAL,
            started_at TEXT,
            geojson TEXT, elevation TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL,
            file TEXT,
            immich_id TEXT,
            original TEXT,
            lat REAL, lon REAL,
            taken_at TEXT,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
        );
        """
    )
    # migraciones defensivas para BDs de versiones anteriores
    photo_cols = [r[1] for r in con.execute("PRAGMA table_info(photos)").fetchall()]
    if "immich_id" not in photo_cols:
        con.execute("ALTER TABLE photos ADD COLUMN immich_id TEXT")
    route_cols = [r[1] for r in con.execute("PRAGMA table_info(routes)").fetchall()]
    if "activity_type" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN activity_type TEXT")
    if "device" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN device TEXT")
    if "immich_checked" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN immich_checked INTEGER DEFAULT 0")
    con.commit()
    con.close()


# ---------------------------------------------------------------- análisis GPX
def analyse_gpx(text):
    """Devuelve stats, geojson (lista de [lon,lat]) y perfil de elevación."""
    gpx = gpxpy.parse(text)

    coords = []           # [lon, lat] para geojson
    elev_profile = []     # {d: km acumulados, e: elevación}
    cum = 0.0
    prev = None
    for track in gpx.tracks:
        for seg in track.segments:
            for p in seg.points:
                coords.append([p.longitude, p.latitude])
                if prev is not None:
                    cum += prev.distance_3d(p) or 0.0
                if p.elevation is not None:
                    elev_profile.append({"d": round(cum / 1000, 3),
                                         "e": round(p.elevation, 1)})
                prev = p

    up, down = gpx.get_uphill_downhill()
    moving = gpx.get_moving_data()
    ele_ext = gpx.get_elevation_extremes()
    bounds = gpx.get_time_bounds()
    length = gpx.length_3d() or gpx.length_2d() or 0.0

    duration = None
    started = None
    if bounds.start_time and bounds.end_time:
        duration = (bounds.end_time - bounds.start_time).total_seconds()
        started = bounds.start_time.isoformat()

    moving_s = moving.moving_time if moving else None
    avg_speed = None
    if moving_s and moving_s > 0:
        avg_speed = (length / moving_s) * 3.6  # km/h

    stats = {
        "distance_m": round(length, 1),
        "ascent_m": round(up or 0, 1),
        "descent_m": round(down or 0, 1),
        "duration_s": duration,
        "moving_s": moving_s,
        "ele_min": round(ele_ext.minimum, 1) if ele_ext and ele_ext.minimum is not None else None,
        "ele_max": round(ele_ext.maximum, 1) if ele_ext and ele_ext.maximum is not None else None,
        "avg_speed": round(avg_speed, 2) if avg_speed else None,
        "started_at": started,
    }
    name = ""
    if gpx.tracks and gpx.tracks[0].name:
        name = gpx.tracks[0].name
    creator = (gpx.creator or "").strip() or None
    return stats, coords, elev_profile, name, creator


# ---------------------------------------------------------------- análisis FIT
_FIT_SPORT_MAP = {
    "running":          "correr",
    "trail":            "correr",
    "cycling":          "bicicleta",
    "mountain_biking":  "bicicleta",
    "hiking":           "senderismo",
    "walking":          "caminata",
    "alpine_skiing":    "esqui",
    "cross_country_skiing": "esqui",
    "nordic_skiing":    "esqui",
    "skiing":           "esqui",
    "snowboarding":     "esqui",
}
_SEMI = 180.0 / (2 ** 31)


def analyse_fit(data: bytes):
    """Parsea un FIT binario. Devuelve la misma tupla que analyse_gpx."""
    fitfile = fitparse.FitFile(io.BytesIO(data))

    coords = []
    elev_profile = []

    name = ""
    creator = None
    started_at = None

    total_distance = total_ascent = total_descent = None
    total_elapsed = total_moving = None
    ele_min = ele_max = avg_speed_ms = None
    fit_sport = None

    for msg in fitfile.get_messages():
        mname = msg.name

        if mname == "file_id":
            mfr = msg.get_value("manufacturer")
            prod = msg.get_value("product_name") or msg.get_value("product")
            if mfr:
                creator = (f"{mfr} {prod}" if prod else str(mfr)).strip()

        elif mname == "sport":
            sport = msg.get_value("sport")
            if sport:
                fit_sport = str(sport).lower()

        elif mname == "session":
            total_distance = msg.get_value("total_distance")
            total_ascent   = msg.get_value("total_ascent")
            total_descent  = msg.get_value("total_descent")
            total_elapsed  = msg.get_value("total_elapsed_time")
            total_moving   = msg.get_value("total_timer_time")
            avg_speed_ms   = msg.get_value("avg_speed")
            ele_min = msg.get_value("enhanced_min_altitude") or msg.get_value("min_altitude")
            ele_max = msg.get_value("enhanced_max_altitude") or msg.get_value("max_altitude")
            ts = msg.get_value("start_time")
            if ts and started_at is None:
                started_at = ts.isoformat()
            if not fit_sport:
                sport = msg.get_value("sport")
                if sport:
                    fit_sport = str(sport).lower()

        elif mname == "record":
            lat_sc = msg.get_value("position_lat")
            lon_sc = msg.get_value("position_long")
            ele    = msg.get_value("enhanced_altitude") or msg.get_value("altitude")
            dist   = msg.get_value("distance")   # metros acumulados
            ts     = msg.get_value("timestamp")

            if lat_sc is not None and lon_sc is not None:
                lat = lat_sc * _SEMI
                lon = lon_sc * _SEMI
                coords.append([lon, lat])
                if ele is not None and dist is not None:
                    elev_profile.append({"d": round(dist / 1000, 3),
                                         "e": round(float(ele), 1)})
                if ts and started_at is None:
                    started_at = ts.isoformat()

    # Nombre: intentar desde workout, caer en sport legible
    if fit_sport and not name:
        name = fit_sport.replace("_", " ").title()

    # Si no hay stats de sesión, calcularlas desde los registros
    if total_distance is None and coords:
        total_distance = (elev_profile[-1]["d"] * 1000) if elev_profile else 0.0

    avg_speed = round(avg_speed_ms * 3.6, 2) if avg_speed_ms else None

    stats = {
        "distance_m": round(float(total_distance), 1) if total_distance else 0.0,
        "ascent_m":   round(float(total_ascent),   1) if total_ascent   else 0.0,
        "descent_m":  round(float(total_descent),  1) if total_descent  else 0.0,
        "duration_s": float(total_elapsed)  if total_elapsed  else None,
        "moving_s":   float(total_moving)   if total_moving   else None,
        "ele_min":    round(float(ele_min),  1) if ele_min is not None else None,
        "ele_max":    round(float(ele_max),  1) if ele_max is not None else None,
        "avg_speed":  avg_speed,
        "started_at": started_at,
    }
    # Pasar el deporte FIT para que _detect_activity pueda leerlo si el nombre no basta
    if fit_sport:
        stats["_fit_sport"] = fit_sport

    return stats, coords, elev_profile, name, creator


# ---------------------------------------------------------------- EXIF de fotos
def _to_deg(value):
    d, m, s = value
    return float(d) + float(m) / 60 + float(s) / 3600


def read_exif(path):
    """Saca (lat, lon, fecha_iso) del EXIF si existen."""
    lat = lon = taken = None
    try:
        img = Image.open(path)
        exif = img._getexif() or {}
        tags = {ExifTags.TAGS.get(k, k): v for k, v in exif.items()}
        when = tags.get("DateTimeOriginal") or tags.get("DateTime")
        if when:
            try:
                taken = dt.datetime.strptime(when, "%Y:%m:%d %H:%M:%S").isoformat()
            except ValueError:
                pass
        gps = tags.get("GPSInfo")
        if gps:
            g_ = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps.items()}
            if "GPSLatitude" in g_ and "GPSLongitude" in g_:
                lat = _to_deg(g_["GPSLatitude"])
                if g_.get("GPSLatitudeRef") == "S":
                    lat = -lat
                lon = _to_deg(g_["GPSLongitude"])
                if g_.get("GPSLongitudeRef") == "W":
                    lon = -lon
    except Exception:
        pass
    return lat, lon, taken


# ---------------------------------------------------------------- resumen auto
def human_duration(seconds):
    if not seconds:
        return None
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, _ = divmod(rem, 60)
    if h:
        return f"{h} h {m} min"
    return f"{m} min"


def auto_summary(r):
    parts = []
    km = (r["distance_m"] or 0) / 1000
    parts.append(f"Ruta de {km:.2f} km")
    if r["ascent_m"]:
        parts.append(f"con {int(r['ascent_m'])} m de desnivel positivo")
    if r["descent_m"]:
        parts.append(f"y {int(r['descent_m'])} m negativo")
    txt = " ".join(parts) + "."
    extra = []
    dur = human_duration(r["moving_s"] or r["duration_s"])
    if dur:
        extra.append(f"Tiempo en movimiento: {dur}")
    if r["avg_speed"]:
        extra.append(f"velocidad media {r['avg_speed']:.1f} km/h")
    if r["ele_max"] is not None:
        extra.append(f"altitud máxima {int(r['ele_max'])} m")
    if extra:
        txt += " " + ", ".join(extra) + "."
    return txt


# ---------------------------------------------------------------- API: rutas
@app.route("/")
def dashboard():
    return render_template("dashboard.html")


@app.route("/Sendero/<path:name>")
def sendero_page(name=None):
    r = db().execute(
        "SELECT id FROM routes WHERE name=? ORDER BY COALESCE(started_at,created_at) DESC LIMIT 1",
        (name,),
    ).fetchone()
    route_json = json.dumps(_route_dict(r["id"])) if r else "null"
    return render_template("sendero.html", route_json=route_json)


@app.route("/api/routes/by-name/<path:name>")
def get_route_by_name(name):
    r = db().execute(
        "SELECT id FROM routes WHERE name=? ORDER BY COALESCE(started_at,created_at) DESC LIMIT 1",
        (name,),
    ).fetchone()
    if not r:
        abort(404)
    return get_route(r["id"])


@app.route("/api/routes", methods=["GET"])
def list_routes():
    rows = db().execute(
        "SELECT id,name,distance_m,ascent_m,duration_s,moving_s,started_at,activity_type,"
        "json_extract(geojson,'$[0][1]') AS start_lat,"
        "json_extract(geojson,'$[0][0]') AS start_lon,"
        "(SELECT COUNT(*) FROM photos WHERE route_id=routes.id) AS photo_count "
        "FROM routes ORDER BY COALESCE(started_at, created_at) DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


_ACTIVITY_KEYWORDS = {
    "senderismo": [
        "senderismo", "sendero", "trekking", "trek", "excursión", "excursion",
        "montaña", "montana", "trail", "gr", "pr", "sl", "camino", "via", "travesia",
    ],
    "bicicleta": [
        "bicicleta", "bici", "ciclismo", "mtb", "mountain bike", "cycling",
        "bike", "cicloturismo", "gravel", "btt",
    ],
    "caminata": [
        "caminata", "caminando", "paseo", "pasear", "vuelta", "walk",
        "walking", "urbano", "ciudad", "rambla", "marcha",
    ],
    "correr": [
        "correr", "running", "carrera", "trail running", "maratón", "maraton",
        "media maratón", "10k", "5k", "fondo", "jogging",
    ],
    "esqui": [
        "esqui", "esquí", "ski", "skiing", "nieve", "snow",
        "pista", "slalom", "esquiando", "nordic",
    ],
}

def _detect_activity(name: str) -> str | None:
    low = name.lower()
    for activity, keywords in _ACTIVITY_KEYWORDS.items():
        if any(kw in low for kw in keywords):
            return activity
    return None


@app.route("/api/routes", methods=["POST"])
def create_route():
    f = request.files.get("gpx")
    fn_lower = (f.filename or "").lower() if f else ""
    is_gpx = fn_lower.endswith(("gpx", ".gpx"))
    is_fit = fn_lower.endswith((".fit", "fit"))
    if not f or not (is_gpx or is_fit):
        return jsonify({"error": "Sube un archivo .gpx o .fit"}), 400

    raw = f.read()
    try:
        if is_fit:
            stats, coords, elev, gpx_name, creator = analyse_fit(raw)
        else:
            stats, coords, elev, gpx_name, creator = analyse_gpx(
                raw.decode("utf-8", errors="replace"))
    except Exception as e:
        return jsonify({"error": f"Archivo ilegible: {e}"}), 400

    fname = secure_filename(f.filename)
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    stored = f"{stamp}_{fname}"
    (GPX_DIR / stored).write_bytes(raw)

    name = (request.form.get("name") or gpx_name
            or stats.get("started_at") or "Ruta sin nombre")

    # Actividad: primero por nombre, luego por deporte FIT si lo hay
    activity_type = _detect_activity(name)
    if not activity_type and is_fit:
        fit_sport = stats.pop("_fit_sport", None)
        activity_type = _FIT_SPORT_MAP.get(fit_sport or "")
    else:
        stats.pop("_fit_sport", None)
    con = db()
    cur = con.execute(
        """INSERT INTO routes
        (name,notes,gpx_file,distance_m,ascent_m,descent_m,duration_s,moving_s,
         ele_min,ele_max,avg_speed,started_at,geojson,elevation,created_at,activity_type,device)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (name, "", stored, stats["distance_m"], stats["ascent_m"],
         stats["descent_m"], stats["duration_s"], stats["moving_s"],
         stats["ele_min"], stats["ele_max"], stats["avg_speed"],
         stats["started_at"], json.dumps(coords), json.dumps(elev),
         dt.datetime.now().isoformat(), activity_type, creator),
    )
    con.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/routes/<int:rid>", methods=["GET"])
def _route_dict(rid):
    r = db().execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    photos = db().execute(
        "SELECT id,file,immich_id,original,lat,lon,taken_at FROM photos WHERE route_id=? ORDER BY taken_at",
        (rid,),
    ).fetchall()
    d = dict(r)
    d["geojson"] = json.loads(d["geojson"] or "[]")
    d["elevation"] = json.loads(d["elevation"] or "[]")
    d["photos"] = [dict(p) for p in photos]
    d["auto_summary"] = auto_summary(r)
    d["device"] = d.get("device") or None
    d["immich_checked"] = bool(d.get("immich_checked"))
    return d


def get_route(rid):
    return jsonify(_route_dict(rid))


@app.route("/api/routes/<int:rid>", methods=["DELETE"])
def delete_route(rid):
    con = db()
    r = con.execute("SELECT gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    for p in con.execute("SELECT file FROM photos WHERE route_id=?", (rid,)).fetchall():
        if p["file"]:
            (PHOTO_DIR / p["file"]).unlink(missing_ok=True)
    (GPX_DIR / r["gpx_file"]).unlink(missing_ok=True)
    con.execute("DELETE FROM photos WHERE route_id=?", (rid,))
    con.execute("DELETE FROM routes WHERE id=?", (rid,))
    con.commit()
    return "", 204


@app.route("/api/routes/<int:rid>", methods=["PATCH"])
def update_route(rid):
    data = request.get_json(force=True)
    con = db()
    fields, vals = [], []
    for key in ("name", "notes", "activity_type", "immich_checked"):
        if key in data:
            fields.append(f"{key}=?")
            vals.append(data[key])
    if not fields:
        return jsonify({"error": "nada que actualizar"}), 400
    vals.append(rid)
    con.execute(f"UPDATE routes SET {', '.join(fields)} WHERE id=?", vals)
    con.commit()
    return "", 204


# ---------------------------------------------------------------- API: fotos
@app.route("/api/routes/<int:rid>/photos", methods=["POST"])
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
        path = PHOTO_DIR / stored
        f.save(path)
        lat, lon, taken = read_exif(path)
        cur = con.execute(
            "INSERT INTO photos (route_id,file,original,lat,lon,taken_at) VALUES (?,?,?,?,?,?)",
            (rid, stored, f.filename, lat, lon, taken),
        )
        saved.append(cur.lastrowid)
    con.commit()
    return jsonify({"added": saved}), 201


@app.route("/api/photos/<int:pid>/file")
def photo_file(pid):
    p = db().execute("SELECT file,immich_id FROM photos WHERE id=?", (pid,)).fetchone()
    if not p:
        abort(404)
    if p["immich_id"]:
        size = request.args.get("size", "preview")  # thumbnail | preview
        r = immich_get(f"/api/assets/{p['immich_id']}/thumbnail", params={"size": size})
        if r.status_code != 200:
            abort(502)
        return Response(r.content, content_type=r.headers.get("Content-Type", "image/jpeg"))
    return send_file(PHOTO_DIR / p["file"])


@app.route("/api/photos/<int:pid>", methods=["DELETE"])
def delete_photo(pid):
    con = db()
    p = con.execute("SELECT file FROM photos WHERE id=?", (pid,)).fetchone()
    if not p:
        abort(404)
    if p["file"]:
        (PHOTO_DIR / p["file"]).unlink(missing_ok=True)
    con.execute("DELETE FROM photos WHERE id=?", (pid,))
    con.commit()
    return "", 204


# ---------------------------------------------------------------- API: Immich
@app.route("/api/config")
def config():
    return jsonify({"immich": IMMICH_ENABLED, "immich_margin_min": IMMICH_MARGIN_MIN})


@app.route("/api/routes/<int:rid>/immich/candidates")
def immich_candidates(rid):
    """Fotos de Immich tomadas durante la ventana temporal del track.
    Para las que tienen GPS, se calcula su distancia mínima al track."""
    if not IMMICH_ENABLED:
        return jsonify({"error": "Immich no está configurado"}), 400
    r = db().execute("SELECT started_at,duration_s,geojson FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    if not r["started_at"]:
        return jsonify({"error": "Este GPX no tiene marcas de tiempo; no se puede cruzar con Immich"}), 400
    start = dt.datetime.fromisoformat(r["started_at"])
    end = start + dt.timedelta(seconds=(r["duration_s"] or 0))
    margin = dt.timedelta(minutes=IMMICH_MARGIN_MIN)
    after = (start - margin).astimezone(dt.timezone.utc)
    before = (end + margin).astimezone(dt.timezone.utc)
    track = json.loads(r["geojson"] or "[]")  # [[lon,lat],...]
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
    # ordena: primero las cercanas (con GPS), luego las sin ubicación
    cands.sort(key=lambda c: (c["dist_m"] is None, c["dist_m"] if c["dist_m"] is not None else 0))
    return jsonify({"window": {"after": after.isoformat(), "before": before.isoformat()},
                    "candidates": cands})


@app.route("/api/routes/<int:rid>/immich/select", methods=["POST"])
def immich_select(rid):
    """Asocia a la ruta las fotos de Immich elegidas (por referencia, sin copiarlas)."""
    if not IMMICH_ENABLED:
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


@app.route("/api/immich/thumb/<asset_id>")
def immich_thumb(asset_id):
    """Proxy de miniatura de un asset de Immich (para previsualizar candidatos)."""
    if not IMMICH_ENABLED:
        abort(404)
    size = request.args.get("size", "thumbnail")
    r = immich_get(f"/api/assets/{asset_id}/thumbnail", params={"size": size})
    if r.status_code != 200:
        abort(502)
    return Response(r.content, content_type=r.headers.get("Content-Type", "image/jpeg"))


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
