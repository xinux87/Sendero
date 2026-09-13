"""Editor de rutas PLANIFICADAS: el mismo editor que el de rutas, sobre un plan.

Un plan guarda su GPX como BLOB en planned_routes.gpx_data (no hay archivo en
data/gpx/), así que su historial vive también en la base: la tabla plan_versions,
con los bytes dentro. Lo demás es idéntico a una ruta y no se reimplementa: el
flujo de cada operación (validar base_version → aplicar en memoria → archivar v1
→ escribir el activo → reanalizar → archivar la versión nueva) está en
api/editor.py y aquí solo se aporta el TARGET, que es la E/S.

Dos diferencias de fondo con una ruta, las dos a propósito:
  - No hay thumbnails, ni avisos GPS guardados, ni detección de actividad al
    reparsear: un plan no se ha hecho todavía.
  - Cada versión NUEVA del track invalida el índice IBP (se pone a NULL y no se
    recalcula solo): el número lo decide un tercero al que hay que subir el GPX,
    y el del track viejo describiría otra ruta. El usuario lo vuelve a pedir con
    «Calcular» en el detalle. El rescan NO lo toca: ahí el track no cambia.
"""
import datetime as dt
import json

from flask import Blueprint, abort, request, jsonify

import core.config as cfg
from core.database import db, plan_id_from_public, set_public_id
from core.editing import load_gpx, split_track, merge_gpx, EditError
from api.editor import (
    TargetError, commit_new_version, download_version_response, gps_meta,
    load_target_gpx, run_edit, run_elevation_dem, run_list_versions, run_points,
    run_restore, version_conflict,
)
from api.planned import _build_plan_dict, _reanalyse_plan

planned_editor_bp = Blueprint("planned_editor", __name__)


class PlanTarget:
    """Editor sobre un PLAN: gpx_data en planned_routes + tabla plan_versions.

    Misma interfaz que RouteTarget (api/editor.py). El plan es siempre GPX:
    `is_fit` es False y no hay caso de materializar nada.
    """

    kind = "plan"
    noun = "El plan"
    is_fit = False
    source = "gpx"

    def __init__(self, con, pid):
        self.con = con
        self.id = pid
        self._refresh()
        if not self.row:
            abort(404)

    def _refresh(self):
        self.row = self.con.execute(
            "SELECT id, public_id, name, activity_type, distance_m, ascent_m, geojson "
            "FROM planned_routes WHERE id=?", (self.id,)).fetchone()

    @property
    def name(self):
        return self.row["name"]

    # -- track activo --------------------------------------------------------
    def read_active(self):
        r = self.con.execute("SELECT gpx_data FROM planned_routes WHERE id=?",
                             (self.id,)).fetchone()
        if not r or not r["gpx_data"]:
            raise TargetError("Este plan no tiene archivo GPX que editar", 404)
        return bytes(r["gpx_data"])

    def write_active(self, xml_bytes):
        self.con.execute("UPDATE planned_routes SET gpx_data=? WHERE id=?",
                         (xml_bytes, self.id))
        self.con.commit()
        return None

    # -- versiones -----------------------------------------------------------
    def current_version(self):
        v = self.con.execute(
            "SELECT MAX(version_n) AS v FROM plan_versions WHERE plan_id=?",
            (self.id,)).fetchone()
        return (v["v"] if v else 0) or 0

    def archive_v1_if_needed(self, raw):
        """Primer guardado: archiva el GPX original byte a byte como v1 ANTES de
        tocar el activo. Devuelve la versión actual tras el posible archivado."""
        cur_v = self.current_version()
        if cur_v:
            return cur_v
        n_orig = len(json.loads(self.row["geojson"] or "[]"))
        self._insert_version(1, raw, "Archivo original",
                             self.row["distance_m"], self.row["ascent_m"],
                             n_orig or None)
        return 1

    def archive(self, version_n, xml_bytes, summary, distance_m, ascent_m,
                n_points, ext=".gpx"):
        self._insert_version(version_n, xml_bytes, summary, distance_m, ascent_m,
                             n_points)

    def _insert_version(self, version_n, blob, summary, distance_m, ascent_m, n_points):
        self.con.execute(
            """INSERT INTO plan_versions
               (plan_id, version_n, gpx_data, summary, distance_m, ascent_m,
                n_points, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (self.id, version_n, blob, summary, distance_m, ascent_m, n_points,
             dt.datetime.now().isoformat()),
        )

    def list_versions(self):
        rows = self.con.execute(
            "SELECT version_n, summary, distance_m, ascent_m, n_points, created_at "
            "FROM plan_versions WHERE plan_id=? ORDER BY version_n DESC",
            (self.id,),
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            d["file_ext"] = ".gpx"      # un plan siempre es GPX (nunca FIT)
            items.append(d)
        return items

    def version_meta(self, vn):
        ver = self.con.execute(
            "SELECT version_n, summary, distance_m, ascent_m, n_points "
            "FROM plan_versions WHERE plan_id=? AND version_n=?", (self.id, vn),
        ).fetchone()
        if not ver:
            abort(404)
        return ver

    def read_version(self, vn):
        ver = self.con.execute(
            "SELECT gpx_data FROM plan_versions WHERE plan_id=? AND version_n=?",
            (self.id, vn),
        ).fetchone()
        if not ver:
            abort(404)
        return bytes(ver["gpx_data"]), ".gpx"

    def restore_active(self, payload, ext):
        self.write_active(payload)

    # -- datos ---------------------------------------------------------------
    def reanalyse(self):
        err = _reanalyse_plan(self.con, self.id)
        self._refresh()
        return err

    def metrics(self):
        self._refresh()
        n = len(json.loads(self.row["geojson"] or "[]"))
        return self.row["distance_m"], self.row["ascent_m"], (n or None)

    def build_dict(self):
        return _build_plan_dict(self.id)

    def after_new_version(self, reason):
        """El track ha cambiado ⇒ el índice IBP que había describe otra ruta.

        Se VACÍA y no se recalcula solo: subir el GPX a ibpindex.com es una
        acción explícita (necesita clave, red y manda el track entero fuera de la
        LAN). El detalle vuelve a ofrecer «Calcular».
        """
        self.con.execute(
            "UPDATE planned_routes SET ibp_index=NULL, ibp_modality=NULL, "
            "ibp_all=NULL, ibp_at=NULL WHERE id=?", (self.id,))


def _target(pid):
    return PlanTarget(db(), plan_id_from_public(pid))


def _has_times(raw):
    """¿Algún trkpt del plan trae <time>? Los planes suelen no llevarlos (son
    recorridos que no se han hecho), y el editor apaga con esto las herramientas
    que dependen del tiempo. Se calcula parseando: son unas decenas de planes."""
    try:
        gpx = load_gpx(raw, False)
    except Exception:
        return False
    return any(p.time for t in gpx.tracks for s in t.segments for p in s.points)


# ── metadatos de arranque ──────────────────────────────────────────────────

@planned_editor_bp.route("/api/planned/<pid>/editor")
def plan_editor_meta(pid):
    """Metadatos de arranque del editor para un plan (espejo del de una ruta).

    `gps_issues` va siempre vacío: los avisos GPS describen un track grabado
    (saltos del receptor), y un plan es un recorrido dibujado o descargado. El
    panel del editor queda en «sin avisos» sin ningún caso especial en cliente.
    """
    pid_int = plan_id_from_public(pid)
    r = db().execute(
        "SELECT id, public_id, name, activity_type, notes, distance_m, ascent_m, "
        "descent_m, gpx_data FROM planned_routes WHERE id=?", (pid_int,)).fetchone()
    if not r:
        abort(404)
    t = PlanTarget(db(), pid_int)
    d = {
        "kind": "plan",
        "id": r["id"],
        "public_id": r["public_id"],
        "name": r["name"],
        "activity_type": r["activity_type"],
        "notes": r["notes"],
        "distance_m": r["distance_m"],
        "ascent_m": r["ascent_m"],
        "descent_m": r["descent_m"],
        "version": t.current_version(),
        "gps_issues": [],
        "has_times": _has_times(bytes(r["gpx_data"])) if r["gpx_data"] else False,
    }
    d.update(gps_meta(r["activity_type"]))
    return jsonify(d)


# ── endpoints (espejo de los de ruta) ──────────────────────────────────────

@planned_editor_bp.route("/api/planned/<pid>/points")
def plan_points(pid):
    try:
        return run_points(_target(pid))
    except TargetError as e:
        return e.response()


@planned_editor_bp.route("/api/planned/<pid>/edit", methods=["POST"])
def edit_plan(pid):
    t = _target(pid)
    try:
        raw = t.read_active()
        return run_edit(t, raw, request.get_json(force=True, silent=True) or {})
    except TargetError as e:
        return e.response()


@planned_editor_bp.route("/api/planned/<pid>/split", methods=["POST"])
def split_plan(pid):
    """Divide el plan en el punto `index`: el original se recorta a 0..index
    (versión nueva) y nace un plan nuevo con index..n-1, que hereda la actividad.

    El plan nuevo NO calcula el índice IBP: subir un track a un tercero es
    siempre una acción explícita del usuario (botón «Calcular» del detalle).
    """
    con = db()
    t = PlanTarget(con, plan_id_from_public(pid))
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

    # Crear el plan B primero: si algo falla aquí, el original queda intacto.
    b_public, err = _create_plan(con, name_b, t.row["activity_type"],
                                 xml_b.encode("utf-8"))
    if err:
        return err

    err = commit_new_version(t, raw, xml_a.encode("utf-8"),
                             f"Dividido el plan — la parte 2 es «{name_b}»",
                             reason="split")
    if err:
        return err
    d = t.build_dict()
    d["b_id"] = b_public
    d["b_name"] = name_b
    return jsonify(d)


@planned_editor_bp.route("/api/planned/merge", methods=["POST"])
def merge_plans():
    """Une 2+ planes en un plan NUEVO; los originales quedan intactos.

    Solo plan + plan: unir un plan con una ruta ya hecha mezclaría dos cosas
    distintas (lo que quiero hacer y lo que hice), y el resultado no cabría en
    ninguna de las dos tablas sin mentir.
    """
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or len(ids) < 2 or len(set(ids)) != len(ids):
        return jsonify({"error": "Indica al menos dos planes distintos"}), 400
    con = db()
    rows = []
    for ref in ids:
        r = con.execute("SELECT id, name, activity_type, gpx_data "
                        "FROM planned_routes WHERE public_id=?", (ref,)).fetchone()
        if not r:
            return jsonify({"error": f"El plan {ref} no existe"}), 404
        if not r["gpx_data"]:
            return jsonify({"error": f"Falta el archivo de «{r['name']}»"}), 404
        rows.append(r)

    gpxs = []
    for r in rows:
        try:
            gpxs.append(load_gpx(bytes(r["gpx_data"]), False))
        except Exception as e:
            return jsonify({"error": f"Archivo ilegible en «{r['name']}»: {e}"}), 400
    try:
        xml, times_kept = merge_gpx(gpxs)
    except EditError as e:
        return jsonify({"error": str(e)}), 400

    name = (data.get("name") or "").strip() or " + ".join(r["name"] for r in rows)
    b_public, err = _create_plan(con, name, rows[0]["activity_type"],
                                 xml.encode("utf-8"))
    if err:
        return err
    return jsonify({"id": b_public, "public_id": b_public, "name": name,
                    "times_kept": times_kept}), 201


def _create_plan(con, name, activity_type, gpx_bytes):
    """Inserta un plan nuevo con ese GPX y lo analiza. Devuelve (public_id, err).

    Sin IBP a propósito (ver split_plan) y sin historial: el plan nace en la
    versión 0, como cualquier plan importado.
    """
    cur = con.execute(
        "INSERT INTO planned_routes (name, notes, source, activity_type, gpx_data, "
        "created_at) VALUES (?,?,?,?,?,?)",
        (name, "", "gpx", activity_type, gpx_bytes, dt.datetime.now().isoformat()),
    )
    bid = cur.lastrowid
    pub = set_public_id(con, "planned_routes", bid)
    con.commit()
    err = _reanalyse_plan(con, bid)
    return pub, err


@planned_editor_bp.route("/api/planned/<pid>/elevation-dem", methods=["POST"])
def plan_elevation_dem(pid):
    if not cfg.DEM_URL:
        return jsonify({"error": "No hay servicio DEM configurado en Ajustes"}), 400
    t = _target(pid)
    try:
        raw = t.read_active()
        return run_elevation_dem(t, raw, request.get_json(force=True, silent=True) or {})
    except TargetError as e:
        return e.response()


@planned_editor_bp.route("/api/planned/<pid>/versions")
def plan_versions(pid):
    return run_list_versions(_target(pid))


@planned_editor_bp.route("/api/planned/<pid>/versions/<int:vn>/restore", methods=["POST"])
def restore_plan_version(pid, vn):
    try:
        return run_restore(_target(pid), vn)
    except TargetError as e:
        return e.response()


@planned_editor_bp.route("/api/planned/<pid>/versions/<int:vn>/gpx")
def download_plan_version(pid, vn):
    return download_version_response(_target(pid), vn)


@planned_editor_bp.route("/api/planned/<pid>/rescan", methods=["POST"])
def rescan_plan(pid):
    """Reparsea el GPX guardado y reescribe las métricas. NO crea versión ni
    toca el IBP: el track es el mismo, solo se rehacen los números derivados."""
    con = db()
    pid_int = plan_id_from_public(pid)
    err = _reanalyse_plan(con, pid_int)
    if err:
        return err
    return jsonify(_build_plan_dict(pid_int))
