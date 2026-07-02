"""Editor de rutas: página, puntos completos, guardado por operaciones y versiones.

Modelo de versionado (append-only, estilo git):
- Los archivos de versión viven en data/gpx/versions/<route_id>/v<N>.<ext>,
  inmutables; la tabla route_versions solo guarda metadatos.
- Invariante: el archivo activo en data/gpx/ es SIEMPRE idéntico a la versión
  más alta. Una ruta nunca editada no tiene filas (versión efectiva 0).
- Primer guardado: se archiva el original byte a byte como v1 ANTES de tocar el
  activo (imposible perderlo); el resultado editado se archiva como v2.
- Restaurar la versión k no borra posteriores: crea v(n+1) con esos bytes.
- Caso FIT: el primer guardado materializa un GPX (mismo stem → el thumbnail
  <stem>.png no cambia de nombre) y el .fit queda archivado como v1.
"""
import os
import json
import re
import datetime as dt
from pathlib import Path

from flask import Blueprint, abort, request, jsonify, render_template, Response, redirect

import core.config as cfg
from core.database import db
from core.dem import dem_elevations, DemError
from core.editing import (
    load_gpx, extract_points, apply_ops, split_track, merge_gpx, EditError
)
from api.routes import _build_route_dict, _reanalyse_and_update

editor_bp = Blueprint("editor", __name__)


def _current_version(con, rid):
    v = con.execute(
        "SELECT MAX(version_n) AS v FROM route_versions WHERE route_id=?", (rid,)
    ).fetchone()
    return v["v"] or 0


def _version_dir(rid):
    d = cfg.VERSIONS_DIR / str(rid)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _insert_version(con, rid, version_n, fname, summary, distance_m, ascent_m, n_points):
    con.execute(
        """INSERT INTO route_versions
           (route_id, version_n, file, summary, distance_m, ascent_m, n_points, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (rid, version_n, fname, summary, distance_m, ascent_m, n_points,
         dt.datetime.now().isoformat()),
    )


def _atomic_write(path: Path, data: bytes):
    """Escritura atómica: tmp en el mismo directorio + os.replace (rename atómico)."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_active(con, rid, gpx_file, xml_bytes):
    """Escribe el nuevo archivo activo de la ruta de forma atómica.

    Caso FIT: se materializa como <stem>.gpx (mismo stem → mismo thumbnail),
    se actualiza routes.gpx_file y se retira el .fit (ya archivado como v1).
    Devuelve el nombre del archivo activo resultante.
    """
    if gpx_file.lower().endswith(".fit"):
        stem = Path(gpx_file).stem
        active_name = f"{stem}.gpx"
        if (cfg.GPX_DIR / active_name).exists():
            active_name = f"{stem}_editado.gpx"
        _atomic_write(cfg.GPX_DIR / active_name, xml_bytes)
        con.execute("UPDATE routes SET gpx_file=? WHERE id=?", (active_name, rid))
        con.commit()
        (cfg.GPX_DIR / gpx_file).unlink(missing_ok=True)
        return active_name
    _atomic_write(cfg.GPX_DIR / gpx_file, xml_bytes)
    return gpx_file


def _archive_v1_if_needed(con, rid, row, raw, is_fit):
    """Primer guardado: archiva el original byte a byte como v1 ANTES de tocar
    el activo. Devuelve la versión actual tras el posible archivado."""
    cur_v = _current_version(con, rid)
    if cur_v:
        return cur_v
    vdir = _version_dir(rid)
    ext = Path(row["gpx_file"]).suffix or ".gpx"
    v1_name = f"v1{ext}"
    (vdir / v1_name).write_bytes(raw)
    n_orig = len(json.loads(row["geojson"] or "[]"))
    _insert_version(con, rid, 1, v1_name,
                    "Archivo original (FIT)" if is_fit else "Archivo original",
                    row["distance_m"], row["ascent_m"], n_orig or None)
    return 1


@editor_bp.route("/Sendero/<path:name>/editor")
def editor_page(name):
    con = db()
    r = con.execute(
        "SELECT id,name,gpx_file,distance_m,ascent_m,descent_m,started_at,activity_type,"
        "gps_issues FROM routes WHERE name=? ORDER BY COALESCE(started_at,created_at) DESC LIMIT 1",
        (name,),
    ).fetchone()
    if not r:
        return redirect("/rutas")
    d = dict(r)
    d["version"] = _current_version(con, r["id"])
    # Umbral de velocidad plausible para la actividad (Ajustes → "GPS incorrecto");
    # el editor lo usa como valor inicial de "Corregir velocidad excesiva".
    d["gps_max_speed"] = cfg.gps_thresholds_for(d.get("activity_type"))["max_speed_kmh"]
    # Avisos GPS calculados en create/rescan/guardado: el editor los premarca.
    d["gps_issues"] = json.loads(d.get("gps_issues") or "[]")
    # Recalcular elevación con DEM solo si hay servicio configurado en Ajustes.
    d["dem_enabled"] = bool(cfg.DEM_URL)
    return render_template("editor.html", route_json=json.dumps(d))


@editor_bp.route("/api/routes/<int:rid>/points")
def route_points(rid):
    con = db()
    r = con.execute("SELECT gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    fpath = cfg.GPX_DIR / r["gpx_file"]
    if not fpath.exists():
        return jsonify({"error": "Archivo original no encontrado"}), 404
    is_fit = r["gpx_file"].lower().endswith(".fit")
    try:
        gpx = load_gpx(fpath.read_bytes(), is_fit)
    except Exception as e:
        return jsonify({"error": f"Archivo ilegible: {e}"}), 400
    pts = extract_points(gpx)
    if pts["n"] < 2:
        return jsonify({"error": "Este archivo no contiene tracks editables"}), 400
    pts["version"] = _current_version(con, rid)
    pts["source"] = "fit" if is_fit else "gpx"
    return jsonify(pts)


@editor_bp.route("/api/routes/<int:rid>/edit", methods=["POST"])
def edit_route(rid):
    con = db()
    r = con.execute("SELECT name, gpx_file, distance_m, ascent_m, geojson "
                    "FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    fpath = cfg.GPX_DIR / r["gpx_file"]
    if not fpath.exists():
        return jsonify({"error": "Archivo original no encontrado"}), 404

    data = request.get_json(force=True, silent=True) or {}
    ops = data.get("ops")
    if not isinstance(ops, list) or not ops:
        return jsonify({"error": "No hay operaciones que aplicar"}), 400

    cur_v = _current_version(con, rid)
    if data.get("base_version") != cur_v:
        return jsonify({
            "error": "La ruta ha cambiado desde que abriste el editor. Recarga para continuar.",
            "code": "version_conflict",
        }), 409

    raw = fpath.read_bytes()
    is_fit = r["gpx_file"].lower().endswith(".fit")
    try:
        gpx = load_gpx(raw, is_fit)
    except Exception as e:
        return jsonify({"error": f"Archivo ilegible: {e}"}), 400

    # Validar/aplicar en memoria ANTES de archivar o escribir nada: unas ops
    # inválidas no deben dejar rastro (ni v1 huérfana que desplace base_version).
    try:
        xml, auto_summary, n_points = apply_ops(gpx, ops)
    except EditError as e:
        return jsonify({"error": str(e)}), 400

    vdir = _version_dir(rid)
    cur_v = _archive_v1_if_needed(con, rid, r, raw, is_fit)

    xml_bytes = xml.encode("utf-8")
    _write_active(con, rid, r["gpx_file"], xml_bytes)

    new_v = cur_v + 1
    vname = f"v{new_v}.gpx"
    (vdir / vname).write_bytes(xml_bytes)

    row = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    err = _reanalyse_and_update(con, rid, row)
    if err:
        return err

    summary = (data.get("summary") or "").strip() or auto_summary
    updated = con.execute("SELECT distance_m, ascent_m FROM routes WHERE id=?",
                          (rid,)).fetchone()
    _insert_version(con, rid, new_v, vname, summary,
                    updated["distance_m"], updated["ascent_m"], n_points)
    con.commit()
    return jsonify(_build_route_dict(rid))


@editor_bp.route("/api/routes/<int:rid>/split", methods=["POST"])
def split_route(rid):
    """Divide la ruta en el punto `index`: la original se recorta a los puntos
    0..index (como versión nueva) y se crea una ruta nueva con index..n-1.
    Las fotos asociadas se quedan en la original (decisión F2)."""
    con = db()
    r = con.execute("SELECT name, gpx_file, distance_m, ascent_m, geojson "
                    "FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    fpath = cfg.GPX_DIR / r["gpx_file"]
    if not fpath.exists():
        return jsonify({"error": "Archivo original no encontrado"}), 404

    data = request.get_json(force=True, silent=True) or {}
    try:
        index = int(data.get("index"))
    except (TypeError, ValueError):
        return jsonify({"error": "Falta el punto de corte"}), 400
    name_b = (data.get("name_b") or "").strip() or f"{r['name']} (2)"

    cur_v = _current_version(con, rid)
    if data.get("base_version") != cur_v:
        return jsonify({
            "error": "La ruta ha cambiado desde que abriste el editor. Recarga para continuar.",
            "code": "version_conflict",
        }), 409

    raw = fpath.read_bytes()
    is_fit = r["gpx_file"].lower().endswith(".fit")
    try:
        gpx = load_gpx(raw, is_fit)
    except Exception as e:
        return jsonify({"error": f"Archivo ilegible: {e}"}), 400
    try:
        xml_a, xml_b = split_track(gpx, index)
    except EditError as e:
        return jsonify({"error": str(e)}), 400

    # Crear la ruta B primero: si algo falla aquí, la original queda intacta.
    stem = Path(r["gpx_file"]).stem
    b_name_file = f"{stem}_2.gpx"
    k = 2
    while (cfg.GPX_DIR / b_name_file).exists():
        k += 1
        b_name_file = f"{stem}_{k}.gpx"
    (cfg.GPX_DIR / b_name_file).write_bytes(xml_b.encode("utf-8"))
    cur_b = con.execute(
        "INSERT INTO routes (name, notes, gpx_file, created_at) VALUES (?,?,?,?)",
        (name_b, "", b_name_file, dt.datetime.now().isoformat()),
    )
    con.commit()
    bid = cur_b.lastrowid
    row_b = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (bid,)).fetchone()
    err = _reanalyse_and_update(con, bid, row_b)
    if err:
        return err

    # Recortar la original como versión nueva (el original queda a salvo como v1).
    vdir = _version_dir(rid)
    cur_v = _archive_v1_if_needed(con, rid, r, raw, is_fit)
    xml_bytes = xml_a.encode("utf-8")
    _write_active(con, rid, r["gpx_file"], xml_bytes)
    new_v = cur_v + 1
    vname = f"v{new_v}.gpx"
    (vdir / vname).write_bytes(xml_bytes)

    row = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    err = _reanalyse_and_update(con, rid, row)
    if err:
        return err

    updated = con.execute("SELECT distance_m, ascent_m FROM routes WHERE id=?",
                          (rid,)).fetchone()
    n_points = len(json.loads(
        con.execute("SELECT geojson FROM routes WHERE id=?", (rid,)).fetchone()["geojson"] or "[]"))
    _insert_version(con, rid, new_v, vname, f"Dividida la ruta — la parte 2 es «{name_b}»",
                    updated["distance_m"], updated["ascent_m"], n_points or None)
    con.commit()
    d = _build_route_dict(rid)
    d["b_id"] = bid
    d["b_name"] = name_b
    return jsonify(d)


@editor_bp.route("/api/routes/merge", methods=["POST"])
def merge_routes():
    """Une 2+ rutas en una RUTA NUEVA; las originales quedan intactas.

    Orden cronológico si todas tienen tiempos; si los rangos se solapan, se
    descartan todos los <time> (times_kept=false en la respuesta)."""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or len(ids) < 2 or len(set(ids)) != len(ids):
        return jsonify({"error": "Indica al menos dos rutas distintas"}), 400
    con = db()
    rows = []
    for rid in ids:
        r = con.execute("SELECT id, name, gpx_file FROM routes WHERE id=?",
                        (rid,)).fetchone()
        if not r:
            return jsonify({"error": f"La ruta {rid} no existe"}), 404
        fpath = cfg.GPX_DIR / r["gpx_file"]
        if not fpath.exists():
            return jsonify({"error": f"Falta el archivo de «{r['name']}»"}), 404
        rows.append((r, fpath.read_bytes()))

    gpxs = []
    for r, raw in rows:
        try:
            gpxs.append(load_gpx(raw, r["gpx_file"].lower().endswith(".fit")))
        except Exception as e:
            return jsonify({"error": f"Archivo ilegible en «{r['name']}»: {e}"}), 400
    try:
        xml, times_kept = merge_gpx(gpxs)
    except EditError as e:
        return jsonify({"error": str(e)}), 400

    name = (data.get("name") or "").strip() or " + ".join(r["name"] for r, _ in rows)
    stem = Path(rows[0][0]["gpx_file"]).stem
    fname = f"{stem}_union.gpx"
    k = 1
    while (cfg.GPX_DIR / fname).exists():
        k += 1
        fname = f"{stem}_union{k}.gpx"
    (cfg.GPX_DIR / fname).write_bytes(xml.encode("utf-8"))
    cur = con.execute(
        "INSERT INTO routes (name, notes, gpx_file, created_at) VALUES (?,?,?,?)",
        (name, "", fname, dt.datetime.now().isoformat()),
    )
    con.commit()
    bid = cur.lastrowid
    row = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (bid,)).fetchone()
    err = _reanalyse_and_update(con, bid, row)
    if err:
        return err
    return jsonify({"id": bid, "name": name, "times_kept": times_kept}), 201


@editor_bp.route("/api/routes/<int:rid>/elevation-dem", methods=["POST"])
def elevation_dem(rid):
    """Recalcula la elevación de TODOS los puntos contra el servicio DEM
    (OpenTopoData) configurado en Ajustes. Crea una versión nueva."""
    if not cfg.DEM_URL:
        return jsonify({"error": "No hay servicio DEM configurado en Ajustes"}), 400
    con = db()
    r = con.execute("SELECT name, gpx_file, distance_m, ascent_m, geojson "
                    "FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    fpath = cfg.GPX_DIR / r["gpx_file"]
    if not fpath.exists():
        return jsonify({"error": "Archivo original no encontrado"}), 404

    data = request.get_json(force=True, silent=True) or {}
    cur_v = _current_version(con, rid)
    if data.get("base_version") != cur_v:
        return jsonify({
            "error": "La ruta ha cambiado desde que abriste el editor. Recarga para continuar.",
            "code": "version_conflict",
        }), 409

    raw = fpath.read_bytes()
    is_fit = r["gpx_file"].lower().endswith(".fit")
    try:
        gpx = load_gpx(raw, is_fit)
    except Exception as e:
        return jsonify({"error": f"Archivo ilegible: {e}"}), 400

    points = [p for t in gpx.tracks for s in t.segments for p in s.points]
    if len(points) < 2:
        return jsonify({"error": "Este archivo no contiene tracks editables"}), 400

    try:
        eles = dem_elevations([(p.latitude, p.longitude) for p in points])
    except DemError as e:
        return jsonify({"error": str(e)}), 502
    changed = 0
    for p, ele in zip(points, eles or []):
        if ele is not None:
            p.elevation = round(float(ele), 1)
            changed += 1
    if not changed:
        return jsonify({"error": "El DEM no devolvió elevación para ningún punto"}), 502

    vdir = _version_dir(rid)
    cur_v = _archive_v1_if_needed(con, rid, r, raw, is_fit)
    xml_bytes = gpx.to_xml().encode("utf-8")
    _write_active(con, rid, r["gpx_file"], xml_bytes)
    new_v = cur_v + 1
    vname = f"v{new_v}.gpx"
    (vdir / vname).write_bytes(xml_bytes)

    row = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    err = _reanalyse_and_update(con, rid, row)
    if err:
        return err
    updated = con.execute("SELECT distance_m, ascent_m FROM routes WHERE id=?",
                          (rid,)).fetchone()
    _insert_version(con, rid, new_v, vname,
                    f"Elevación recalculada con DEM ({changed} puntos)",
                    updated["distance_m"], updated["ascent_m"], len(points))
    con.commit()
    return jsonify(_build_route_dict(rid))


@editor_bp.route("/api/routes/<int:rid>/versions")
def list_versions(rid):
    con = db()
    if not con.execute("SELECT 1 FROM routes WHERE id=?", (rid,)).fetchone():
        abort(404)
    rows = con.execute(
        "SELECT version_n, summary, distance_m, ascent_m, n_points, created_at, file "
        "FROM route_versions WHERE route_id=? ORDER BY version_n DESC",
        (rid,),
    ).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["file_ext"] = Path(d.pop("file")).suffix
        items.append(d)
    return jsonify({"current": items[0]["version_n"] if items else 0, "items": items})


@editor_bp.route("/api/routes/<int:rid>/versions/<int:vn>/restore", methods=["POST"])
def restore_version(rid, vn):
    con = db()
    r = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    ver = con.execute(
        "SELECT version_n, file, summary, distance_m, ascent_m, n_points "
        "FROM route_versions WHERE route_id=? AND version_n=?", (rid, vn),
    ).fetchone()
    if not ver:
        abort(404)
    cur_v = _current_version(con, rid)
    if vn == cur_v:
        return jsonify({"error": "Ya es la versión actual"}), 400

    vdir = _version_dir(rid)
    vfile = vdir / ver["file"]
    if not vfile.exists():
        return jsonify({"error": "El archivo de esta versión no se encuentra en disco"}), 404
    payload = vfile.read_bytes()

    # El activo adopta la extensión de la versión restaurada (p.ej. volver al
    # .fit original v1 cuando el activo es el .gpx materializado).
    ver_ext = Path(ver["file"]).suffix
    old_active = r["gpx_file"]
    new_active = Path(old_active).stem + ver_ext
    _atomic_write(cfg.GPX_DIR / new_active, payload)
    if new_active != old_active:
        con.execute("UPDATE routes SET gpx_file=? WHERE id=?", (new_active, rid))
        con.commit()
        (cfg.GPX_DIR / old_active).unlink(missing_ok=True)

    new_v = cur_v + 1
    vname = f"v{new_v}{ver_ext}"
    (vdir / vname).write_bytes(payload)
    _insert_version(con, rid, new_v, vname, f"Restaurada la versión {vn}",
                    ver["distance_m"], ver["ascent_m"], ver["n_points"])
    con.commit()

    row = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (rid,)).fetchone()
    err = _reanalyse_and_update(con, rid, row)
    if err:
        return err
    return jsonify(_build_route_dict(rid))


@editor_bp.route("/api/routes/<int:rid>/versions/<int:vn>/gpx")
def download_version(rid, vn):
    con = db()
    r = con.execute("SELECT name FROM routes WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    ver = con.execute(
        "SELECT file FROM route_versions WHERE route_id=? AND version_n=?", (rid, vn),
    ).fetchone()
    if not ver:
        abort(404)
    vfile = cfg.VERSIONS_DIR / str(rid) / ver["file"]
    if not vfile.exists():
        abort(404)
    safe = re.sub(r'[^\w\-]', '_', r["name"])[:80]
    ext = Path(ver["file"]).suffix
    mime = "application/gpx+xml" if ext == ".gpx" else "application/octet-stream"
    return Response(
        vfile.read_bytes(),
        content_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{safe}_v{vn}{ext}"'},
    )
