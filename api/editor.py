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

Toda la E/S vive en un TARGET (`RouteTarget` aquí, `PlanTarget` en
api/planned_editor.py) y el flujo de cada operación es común a los dos: así un
plan se edita con el mismo editor que una ruta sin duplicar la semántica de
versionado, que es justo lo que no puede divergir. `core/editing.py` sigue
siendo pura y no sabe nada de esto.
"""
import os
import json
import re
import datetime as dt
from pathlib import Path

from flask import Blueprint, abort, request, jsonify, render_template, Response, redirect

import core.config as cfg
from core.database import db, rid_from_public, set_public_id
from core.dem import dem_elevations, DemError
from core.editing import (
    load_gpx, extract_points, apply_ops, split_track, merge_gpx, EditError
)
from api.routes import _build_route_dict, _reanalyse_and_update

editor_bp = Blueprint("editor", __name__)


class TargetError(Exception):
    """Fallo de E/S del target con mensaje para el usuario (en español).

    Lo lanzan los métodos del target y lo traducen los endpoints a su
    (jsonify, status), que es lo que devolvían antes a mano.
    """

    def __init__(self, message, status=404):
        super().__init__(message)
        self.message = message
        self.status = status

    def response(self):
        return jsonify({"error": self.message}), self.status


# ── target: la E/S del editor, distinta en rutas y en planes ────────────────

class RouteTarget:
    """Editor sobre una RUTA: archivo activo en data/gpx + tabla route_versions.

    Interfaz común con PlanTarget (api/planned_editor.py):
      read_active / is_fit / write_active / current_version /
      archive_v1_if_needed / archive / reanalyse / list_versions /
      read_version / restore_active / build_dict / after_new_version / metrics
    """

    kind = "route"
    noun = "La ruta"

    def __init__(self, con, rid):
        self.con = con
        self.id = rid
        self.row = con.execute(
            "SELECT id, public_id, name, gpx_file, distance_m, ascent_m, geojson "
            "FROM routes WHERE id=?", (rid,)).fetchone()
        if not self.row:
            abort(404)

    # -- archivo activo ------------------------------------------------------
    @property
    def name(self):
        return self.row["name"]

    @property
    def gpx_file(self):
        return self.row["gpx_file"]

    @property
    def is_fit(self):
        return self.gpx_file.lower().endswith(".fit")

    @property
    def source(self):
        return "fit" if self.is_fit else "gpx"

    def read_active(self):
        fpath = cfg.GPX_DIR / self.gpx_file
        if not fpath.exists():
            raise TargetError("Archivo original no encontrado", 404)
        return fpath.read_bytes()

    def write_active(self, xml_bytes):
        """Escribe el nuevo archivo activo de forma atómica.

        Caso FIT: se materializa como <stem>.gpx (mismo stem → mismo thumbnail),
        se actualiza routes.gpx_file y se retira el .fit (ya archivado como v1).
        """
        gpx_file = self.gpx_file
        if gpx_file.lower().endswith(".fit"):
            stem = Path(gpx_file).stem
            active_name = f"{stem}.gpx"
            if (cfg.GPX_DIR / active_name).exists():
                active_name = f"{stem}_editado.gpx"
            _atomic_write(cfg.GPX_DIR / active_name, xml_bytes)
            self.con.execute("UPDATE routes SET gpx_file=? WHERE id=?",
                             (active_name, self.id))
            self.con.commit()
            (cfg.GPX_DIR / gpx_file).unlink(missing_ok=True)
            self._refresh()
            return active_name
        _atomic_write(cfg.GPX_DIR / gpx_file, xml_bytes)
        return gpx_file

    # -- versiones -----------------------------------------------------------
    def current_version(self):
        v = self.con.execute(
            "SELECT MAX(version_n) AS v FROM route_versions WHERE route_id=?",
            (self.id,)).fetchone()
        return v["v"] or 0

    def _version_dir(self):
        d = cfg.VERSIONS_DIR / str(self.id)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def archive_v1_if_needed(self, raw):
        """Primer guardado: archiva el original byte a byte como v1 ANTES de
        tocar el activo. Devuelve la versión actual tras el posible archivado."""
        cur_v = self.current_version()
        if cur_v:
            return cur_v
        vdir = self._version_dir()
        ext = Path(self.gpx_file).suffix or ".gpx"
        v1_name = f"v1{ext}"
        (vdir / v1_name).write_bytes(raw)
        n_orig = len(json.loads(self.row["geojson"] or "[]"))
        self._insert_version(1, v1_name,
                             "Archivo original (FIT)" if self.is_fit else "Archivo original",
                             self.row["distance_m"], self.row["ascent_m"], n_orig or None)
        return 1

    def archive(self, version_n, xml_bytes, summary, distance_m, ascent_m,
                n_points, ext=".gpx"):
        vname = f"v{version_n}{ext}"
        (self._version_dir() / vname).write_bytes(xml_bytes)
        self._insert_version(version_n, vname, summary, distance_m, ascent_m, n_points)

    def _insert_version(self, version_n, fname, summary, distance_m, ascent_m, n_points):
        self.con.execute(
            """INSERT INTO route_versions
               (route_id, version_n, file, summary, distance_m, ascent_m, n_points, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (self.id, version_n, fname, summary, distance_m, ascent_m, n_points,
             dt.datetime.now().isoformat()),
        )

    def list_versions(self):
        rows = self.con.execute(
            "SELECT version_n, summary, distance_m, ascent_m, n_points, created_at, file "
            "FROM route_versions WHERE route_id=? ORDER BY version_n DESC",
            (self.id,),
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            d["file_ext"] = Path(d.pop("file")).suffix
            items.append(d)
        return items

    def version_meta(self, vn):
        ver = self.con.execute(
            "SELECT version_n, file, summary, distance_m, ascent_m, n_points "
            "FROM route_versions WHERE route_id=? AND version_n=?", (self.id, vn),
        ).fetchone()
        if not ver:
            abort(404)
        return ver

    def read_version(self, vn):
        ver = self.version_meta(vn)
        vfile = cfg.VERSIONS_DIR / str(self.id) / ver["file"]
        if not vfile.exists():
            raise TargetError("El archivo de esta versión no se encuentra en disco", 404)
        return vfile.read_bytes(), Path(ver["file"]).suffix

    def restore_active(self, payload, ext):
        """El activo adopta la extensión de la versión restaurada (p.ej. volver
        al .fit original v1 cuando el activo es el .gpx materializado)."""
        old_active = self.gpx_file
        new_active = Path(old_active).stem + ext
        _atomic_write(cfg.GPX_DIR / new_active, payload)
        if new_active != old_active:
            self.con.execute("UPDATE routes SET gpx_file=? WHERE id=?",
                             (new_active, self.id))
            self.con.commit()
            (cfg.GPX_DIR / old_active).unlink(missing_ok=True)
            self._refresh()

    # -- datos ---------------------------------------------------------------
    def _refresh(self):
        self.row = self.con.execute(
            "SELECT id, public_id, name, gpx_file, distance_m, ascent_m, geojson "
            "FROM routes WHERE id=?", (self.id,)).fetchone()

    def reanalyse(self):
        self._refresh()
        return _reanalyse_and_update(self.con, self.id, self.row)

    def metrics(self):
        """(distancia, ascenso, nº de puntos) ya actualizados tras reanalyse()."""
        self._refresh()
        n = len(json.loads(self.row["geojson"] or "[]"))
        return self.row["distance_m"], self.row["ascent_m"], (n or None)

    def build_dict(self):
        return _build_route_dict(self.id)

    def after_new_version(self, reason):
        # Editar la ruta cuenta como revisión: se limpia el aviso de posible
        # duplicada. Solo en el guardado por ops, como antes de la abstracción
        # (dividir, recalcular el DEM o restaurar no lo tocaban).
        if reason == "edit":
            self.con.execute("UPDATE routes SET dup_suspect_of=NULL WHERE id=?",
                             (self.id,))


def _atomic_write(path: Path, data: bytes):
    """Escritura atómica: tmp en el mismo directorio + os.replace (rename atómico)."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ── flujo común (lo comparten rutas y planes) ───────────────────────────────

def version_conflict(target):
    return jsonify({
        "error": f"{target.noun} ha cambiado desde que abriste el editor. "
                 "Recarga para continuar.",
        "code": "version_conflict",
    }), 409


def load_target_gpx(target, raw):
    try:
        return load_gpx(raw, target.is_fit)
    except Exception as e:
        raise TargetError(f"Archivo ilegible: {e}", 400)


def commit_new_version(target, raw, xml_bytes, summary, n_points=None, reason="edit"):
    """Archiva v1 si hace falta, escribe el activo, reanaliza y archiva la
    versión nueva. Devuelve None, o (respuesta, status) si el reanálisis falla.

    El orden importa: el original se archiva ANTES de tocar el activo, y la fila
    de la versión nueva se inserta DESPUÉS del reanálisis, porque guarda las
    métricas ya recalculadas.
    """
    cur_v = target.archive_v1_if_needed(raw)
    target.write_active(xml_bytes)
    err = target.reanalyse()
    if err:
        return err
    distance_m, ascent_m, n_recalc = target.metrics()
    target.archive(cur_v + 1, xml_bytes, summary,
                   distance_m, ascent_m,
                   n_points if n_points is not None else n_recalc)
    target.after_new_version(reason)
    target.con.commit()
    return None


def run_points(target):
    raw = target.read_active()
    gpx = load_target_gpx(target, raw)
    pts = extract_points(gpx)
    if pts["n"] < 2:
        return jsonify({"error": "Este archivo no contiene tracks editables"}), 400
    pts["version"] = target.current_version()
    pts["source"] = target.source
    return jsonify(pts)


def run_edit(target, raw, data):
    ops = data.get("ops")
    if not isinstance(ops, list) or not ops:
        return jsonify({"error": "No hay operaciones que aplicar"}), 400

    cur_v = target.current_version()
    if data.get("base_version") != cur_v:
        return version_conflict(target)

    gpx = load_target_gpx(target, raw)
    # Validar/aplicar en memoria ANTES de archivar o escribir nada: unas ops
    # inválidas no deben dejar rastro (ni v1 huérfana que desplace base_version).
    try:
        xml, auto_summary, n_points = apply_ops(gpx, ops)
    except EditError as e:
        return jsonify({"error": str(e)}), 400

    summary = (data.get("summary") or "").strip() or auto_summary
    err = commit_new_version(target, raw, xml.encode("utf-8"), summary,
                             n_points, reason="edit")
    if err:
        return err
    return jsonify(target.build_dict())


def run_elevation_dem(target, raw, data):
    """Recalcula la elevación de TODOS los puntos contra el servicio DEM
    (OpenTopoData) configurado en Ajustes. Crea una versión nueva."""
    cur_v = target.current_version()
    if data.get("base_version") != cur_v:
        return version_conflict(target)

    gpx = load_target_gpx(target, raw)
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

    err = commit_new_version(target, raw, gpx.to_xml().encode("utf-8"),
                             f"Elevación recalculada con DEM ({changed} puntos)",
                             len(points), reason="dem")
    if err:
        return err
    return jsonify(target.build_dict())


def run_list_versions(target):
    items = target.list_versions()
    return jsonify({"current": items[0]["version_n"] if items else 0, "items": items})


def run_restore(target, vn):
    ver = target.version_meta(vn)
    cur_v = target.current_version()
    if vn == cur_v:
        return jsonify({"error": "Ya es la versión actual"}), 400

    payload, ext = target.read_version(vn)
    target.restore_active(payload, ext)
    target.archive(cur_v + 1, payload, f"Restaurada la versión {vn}",
                   ver["distance_m"], ver["ascent_m"], ver["n_points"], ext=ext)
    target.con.commit()

    err = target.reanalyse()
    if err:
        return err
    target.after_new_version("restore")
    target.con.commit()
    return jsonify(target.build_dict())


def download_version_response(target, vn):
    target.version_meta(vn)          # 404 si esa versión no existe
    try:
        payload, ext = target.read_version(vn)
    except TargetError:
        abort(404)
    safe = re.sub(r'[^\w\-]', '_', target.name)[:80]
    mime = "application/gpx+xml" if ext == ".gpx" else "application/octet-stream"
    return Response(
        payload,
        content_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{safe}_v{vn}{ext}"'},
    )


# ── metadatos de arranque ──────────────────────────────────────────────────

_EDITOR_COLS = ("SELECT id,public_id,name,gpx_file,distance_m,ascent_m,descent_m,started_at,"
                "activity_type,device,gps_issues FROM routes ")


def gps_meta(activity_type):
    """Umbrales de "GPS incorrecto" de la actividad (Ajustes) + estado del DEM.

    Van los TRES umbrales, no solo el de velocidad: "✔ Corregir todo" comprueba
    su propio resultado re-detectando en cliente con el mismo criterio que
    detect_gps_anomalies(), y sin la tasa vertical ni la altitud máxima no podría
    hacerlo — corregía a ciegas y dejaba avisos que solo se veían al guardar.
    """
    th = cfg.gps_thresholds_for(activity_type)
    return {
        "gps_thresholds": {
            "max_speed_kmh":    th.get("max_speed_kmh"),
            "max_vert_rate_ms": th.get("max_vert_rate_ms"),
            "max_ele_m":        th.get("max_ele_m"),
        },
        # Se conserva suelto porque es el valor inicial del panel "Corregir
        # velocidad excesiva", que el usuario puede tocar a mano.
        "gps_max_speed": th["max_speed_kmh"],
        # Recalcular elevación con DEM solo si hay servicio configurado en Ajustes.
        "dem_enabled": bool(cfg.DEM_URL),
    }


def _editor_meta(con, row):
    """Metadatos que el editor necesita para arrancar (el track va por /points)."""
    d = dict(row)
    d["kind"] = "route"
    d["version"] = RouteTarget(con, row["id"]).current_version()
    d.update(gps_meta(d.get("activity_type")))
    # Avisos GPS calculados en create/rescan/guardado: el editor los premarca.
    d["gps_issues"] = json.loads(d.get("gps_issues") or "[]")
    # ¿El track lleva tiempos? started_at sale del primer <time> del archivo al
    # parsearlo, así que un track sin timestamps lo deja en NULL. El editor lo usa
    # para no ofrecer las herramientas que dependen del tiempo (y en los planes,
    # que casi nunca lo llevan, es la norma).
    d["has_times"] = bool(d.get("started_at"))
    return d


@editor_bp.route("/Sendero/<path:ref>/editor")
def editor_page(ref):
    """Editor de una ruta por public_id (con el nombre como camino de compatibilidad).

    Igual que el detalle: si `ref` es un nombre se redirige al public_id, que es
    la URL canónica. Así el enlace "✎ Editar" de la sección `detalle` (que solo
    conoce el public_id) y los marcadores antiguos llevan al mismo sitio.

    Devuelve el shell de la SPA: el editor es la sección `editor`
    (templates/sec/editor.html + static/js/sec/editor.js), y sus metadatos los
    pide el módulo a /api/routes/<id>/editor. No se inyectan aquí a propósito:
    el editor solo tiene sentido con conexión (opera sobre el estado guardado en
    el servidor), así que no gana nada evitando ese fetch.
    """
    con = db()
    r = con.execute(_EDITOR_COLS + "WHERE public_id=?", (ref,)).fetchone()
    if not r:
        byname = con.execute(
            _EDITOR_COLS + "WHERE name=? ORDER BY COALESCE(started_at,created_at) DESC LIMIT 1",
            (ref,),
        ).fetchone()
        if byname and byname["public_id"]:
            return redirect("/Sendero/" + byname["public_id"] + "/editor", code=302)
        if not byname:
            return redirect("/rutas")
    return render_template("shell.html")


@editor_bp.route("/api/routes/<rid>/editor")
def editor_meta(rid):
    """Metadatos de arranque del editor (los inyectaba la plantilla en `route_json`)."""
    con = db()
    r = con.execute(_EDITOR_COLS + "WHERE public_id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    return jsonify(_editor_meta(con, r))


# ── endpoints de RUTA (todos sobre RouteTarget) ────────────────────────────

@editor_bp.route("/api/routes/<rid>/points")
def route_points(rid):
    t = RouteTarget(db(), rid_from_public(rid))
    try:
        return run_points(t)
    except TargetError as e:
        return e.response()


@editor_bp.route("/api/routes/<rid>/edit", methods=["POST"])
def edit_route(rid):
    t = RouteTarget(db(), rid_from_public(rid))
    try:
        raw = t.read_active()
        return run_edit(t, raw, request.get_json(force=True, silent=True) or {})
    except TargetError as e:
        return e.response()


@editor_bp.route("/api/routes/<rid>/split", methods=["POST"])
def split_route(rid):
    """Divide la ruta en el punto `index`: la original se recorta a los puntos
    0..index (como versión nueva) y se crea una ruta nueva con index..n-1.
    Las fotos asociadas se quedan en la original (decisión F2)."""
    con = db()
    t = RouteTarget(con, rid_from_public(rid))
    try:
        raw = t.read_active()
    except TargetError as e:
        return e.response()

    data = request.get_json(force=True, silent=True) or {}
    try:
        index = int(data.get("index"))
    except (TypeError, ValueError):
        return jsonify({"error": "Falta el punto de corte"}), 400
    name_b = (data.get("name_b") or "").strip() or f"{t.name} (2)"

    if data.get("base_version") != t.current_version():
        return version_conflict(t)

    try:
        gpx = load_target_gpx(t, raw)
    except TargetError as e:
        return e.response()
    try:
        xml_a, xml_b = split_track(gpx, index)
    except EditError as e:
        return jsonify({"error": str(e)}), 400

    # Crear la ruta B primero: si algo falla aquí, la original queda intacta.
    stem = Path(t.gpx_file).stem
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
    b_public = set_public_id(con, "routes", bid)
    row_b = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (bid,)).fetchone()
    err = _reanalyse_and_update(con, bid, row_b)
    if err:
        return err

    # Recortar la original como versión nueva (el original queda a salvo como v1).
    err = commit_new_version(t, raw, xml_a.encode("utf-8"),
                             f"Dividida la ruta — la parte 2 es «{name_b}»",
                             reason="split")
    if err:
        return err
    d = t.build_dict()
    d["b_id"] = b_public
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
        r = con.execute("SELECT id, name, gpx_file FROM routes WHERE public_id=?",
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
    b_public = set_public_id(con, "routes", bid)
    row = con.execute("SELECT name, gpx_file FROM routes WHERE id=?", (bid,)).fetchone()
    err = _reanalyse_and_update(con, bid, row)
    if err:
        return err
    return jsonify({"id": b_public, "public_id": b_public, "name": name,
                    "times_kept": times_kept}), 201


@editor_bp.route("/api/routes/<rid>/elevation-dem", methods=["POST"])
def elevation_dem(rid):
    if not cfg.DEM_URL:
        return jsonify({"error": "No hay servicio DEM configurado en Ajustes"}), 400
    t = RouteTarget(db(), rid_from_public(rid))
    try:
        raw = t.read_active()
        return run_elevation_dem(t, raw, request.get_json(force=True, silent=True) or {})
    except TargetError as e:
        return e.response()


@editor_bp.route("/api/routes/<rid>/versions")
def list_versions(rid):
    rid = rid_from_public(rid)
    con = db()
    if not con.execute("SELECT 1 FROM routes WHERE id=?", (rid,)).fetchone():
        abort(404)
    return run_list_versions(RouteTarget(con, rid))


@editor_bp.route("/api/routes/<rid>/versions/<int:vn>/restore", methods=["POST"])
def restore_version(rid, vn):
    t = RouteTarget(db(), rid_from_public(rid))
    try:
        return run_restore(t, vn)
    except TargetError as e:
        return e.response()


@editor_bp.route("/api/routes/<rid>/versions/<int:vn>/gpx")
def download_version(rid, vn):
    return download_version_response(RouteTarget(db(), rid_from_public(rid)), vn)
