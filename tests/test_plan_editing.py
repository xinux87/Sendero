"""El editor sobre un PLAN (api/planned_editor.py) y la no regresión en RUTAS.

Estos tests sí levantan la app (test client de Flask) y tocan la BD: lo que se
comprueba es justo el cableado —versionado, conflictos de versión, qué se borra
y qué se conserva—, que es lo que la lógica pura de core/editing.py no puede ver.

El SENDERO_DATA temporal lo fija tests/conftest.py antes de importar core.config;
aquí solo se apaga la geocodificación (si no, importar una ruta saldría a
internet) y se deja DEM_URL vacío para probar el 400 de "sin servicio DEM".
Ambas por variable de entorno y no con monkeypatch porque app.before_request
llama a refresh_config() en CADA petición y repondría los valores.
"""
import io
import json
import os

os.environ["GEOCODE_URL"] = ""
os.environ.setdefault("DEM_URL", "")

import gpxpy                                            # noqa: E402
import pytest                                           # noqa: E402

from app import app as flask_app                        # noqa: E402
from core.database import db                            # noqa: E402


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


def _crear_plan(client, xml, name="Plan de prueba"):
    """POST /api/planned con un GPX en memoria → public_id del plan."""
    r = client.post(
        "/api/planned",
        data={"gpx": (io.BytesIO(xml.encode("utf-8")), "plan.gpx"), "name": name},
        content_type="multipart/form-data",
    )
    assert r.status_code == 201, r.get_data(as_text=True)
    return r.get_json()["public_id"]


def _poner_ibp(pid):
    """Simula un índice IBP ya calculado (la API real no se toca en los tests)."""
    with flask_app.app_context():
        con = db()
        con.execute(
            "UPDATE planned_routes SET ibp_index=?, ibp_modality=?, ibp_all=?, ibp_at=? "
            "WHERE public_id=?",
            (73, "HKG", json.dumps({"HKG": 73, "BYC": 40, "RNG": 90}),
             "2026-01-01T00:00:00", pid),
        )
        con.commit()


def _fila_plan(pid):
    with flask_app.app_context():
        r = db().execute("SELECT * FROM planned_routes WHERE public_id=?",
                         (pid,)).fetchone()
        return dict(r) if r else None


def _versiones_en_bd(pid):
    with flask_app.app_context():
        con = db()
        row = con.execute("SELECT id FROM planned_routes WHERE public_id=?",
                          (pid,)).fetchone()
        plan_id = row["id"] if row else -1
        return con.execute("SELECT COUNT(*) FROM plan_versions WHERE plan_id=?",
                           (plan_id,)).fetchone()[0]


# ── metadatos, puntos y guardado ───────────────────────────────────────────

def test_meta_points_y_primer_guardado(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(20,)]), "Plan editable")
    _poner_ibp(pid)

    meta = client.get(f"/api/planned/{pid}/editor").get_json()
    assert meta["kind"] == "plan"
    assert meta["version"] == 0
    assert meta["has_times"] is True
    assert meta["gps_issues"] == []
    assert set(meta["gps_thresholds"]) == {"max_speed_kmh", "max_vert_rate_ms",
                                           "max_ele_m"}
    assert meta["gps_max_speed"] == meta["gps_thresholds"]["max_speed_kmh"]
    assert meta["dem_enabled"] is False

    pts = client.get(f"/api/planned/{pid}/points").get_json()
    assert pts["n"] == 20 and pts["version"] == 0 and pts["source"] == "gpx"
    assert len(pts["lonlat"]) == 20 and pts["segments"] == [[0, 19]]

    dist0 = _fila_plan(pid)["distance_m"]

    body = {"base_version": 0, "summary": "Recorte de prueba",
            "ops": [{"op": "delete_range", "start": 0, "end": 4}]}
    r = client.post(f"/api/planned/{pid}/edit", json=body)
    assert r.status_code == 200, r.get_data(as_text=True)
    d = r.get_json()
    assert d["version"] == 2
    assert d["distance_m"] < dist0
    # Una versión nueva del track invalida el índice IBP: describe otra ruta.
    assert d["ibp_index"] is None and d["ibp_modality"] is None
    assert d["ibp_all"] == {} and _fila_plan(pid)["ibp_at"] is None

    # Mismo POST con la versión base ya caducada: 409, y nada cambia.
    r2 = client.post(f"/api/planned/{pid}/edit", json=body)
    assert r2.status_code == 409
    assert r2.get_json()["code"] == "version_conflict"
    assert _versiones_en_bd(pid) == 2

    vs = client.get(f"/api/planned/{pid}/versions").get_json()
    assert vs["current"] == 2
    assert [v["version_n"] for v in vs["items"]] == [2, 1]
    assert vs["items"][1]["summary"] == "Archivo original"
    assert vs["items"][0]["summary"] == "Recorte de prueba"
    assert all(v["file_ext"] == ".gpx" for v in vs["items"])

    # La descarga de una versión es un GPX válido…
    r3 = client.get(f"/api/planned/{pid}/versions/2/gpx")
    assert r3.status_code == 200
    assert "attachment" in r3.headers["Content-Disposition"]
    assert len(gpxpy.parse(r3.get_data(as_text=True)).tracks) == 1

    # …y v1 son los bytes originales, intactos.
    v1 = client.get(f"/api/planned/{pid}/versions/1/gpx").get_data()
    assert v1 == make_gpx_xml(tracks=[(20,)]).encode("utf-8")

    # Restaurar v1 crea v3 (no borra la 2) y devuelve las métricas originales.
    r4 = client.post(f"/api/planned/{pid}/versions/1/restore")
    assert r4.status_code == 200
    d4 = r4.get_json()
    assert d4["version"] == 3
    assert d4["distance_m"] == pytest.approx(dist0)
    assert client.get(f"/api/planned/{pid}/points").get_json()["n"] == 20
    # Restaurar es una versión nueva del track: el IBP también se vacía.
    assert d4["ibp_index"] is None

    # Restaurar la que ya es la actual no tiene sentido.
    assert client.post(f"/api/planned/{pid}/versions/3/restore").status_code == 400


def test_ops_invalidas_no_dejan_rastro(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(10,)]), "Plan intacto")
    r = client.post(f"/api/planned/{pid}/edit",
                    json={"base_version": 0, "ops": [{"op": "delete_range",
                                                      "start": 0, "end": 99}]})
    assert r.status_code == 400
    # Ni v1 huérfana (que desplazaría base_version) ni cambios en el activo.
    assert _versiones_en_bd(pid) == 0
    assert client.get(f"/api/planned/{pid}/points").get_json()["n"] == 10

    assert client.post(f"/api/planned/{pid}/edit",
                       json={"base_version": 0, "ops": []}).status_code == 400


def test_sin_tiempos_has_times_false(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(6,)], with_times=False),
                      "Plan sin horas")
    assert client.get(f"/api/planned/{pid}/editor").get_json()["has_times"] is False


# ── dividir y unir ─────────────────────────────────────────────────────────

def test_split_crea_plan_b_y_recorta_el_original(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(20,)]), "Plan a dividir")
    _poner_ibp(pid)
    dist0 = _fila_plan(pid)["distance_m"]

    r = client.post(f"/api/planned/{pid}/split",
                    json={"index": 10, "base_version": 0, "name_b": "Segunda mitad"})
    assert r.status_code == 200, r.get_data(as_text=True)
    d = r.get_json()
    assert d["version"] == 2 and d["distance_m"] < dist0
    assert d["ibp_index"] is None
    assert d["b_name"] == "Segunda mitad"

    b = _fila_plan(d["b_id"])
    assert b["name"] == "Segunda mitad"
    assert b["source"] == "gpx"
    assert b["activity_type"] == _fila_plan(pid)["activity_type"]
    assert b["ibp_index"] is None          # el plan nuevo no sube nada a nadie
    assert b["distance_m"] > 0
    # El plan B nace sin historial (versión 0), como cualquier plan importado.
    assert _versiones_en_bd(d["b_id"]) == 0
    pts_b = client.get(f"/api/planned/{d['b_id']}/points").get_json()
    assert pts_b["n"] == 10 and pts_b["version"] == 0

    # Con la versión base vieja, el split también se rechaza.
    assert client.post(f"/api/planned/{pid}/split",
                       json={"index": 5, "base_version": 0}).status_code == 409


def test_merge_crea_un_plan_nuevo_y_deja_los_originales(client, make_gpx_xml):
    a = _crear_plan(client, make_gpx_xml(tracks=[(8,)], start="2024-05-01T09:00:00"),
                    "Tramo A")
    b = _crear_plan(client, make_gpx_xml(tracks=[(8,)], start="2024-05-02T09:00:00",
                                         lat0=43.0), "Tramo B")
    _poner_ibp(a)
    antes_a = _fila_plan(a)

    r = client.post("/api/planned/merge", json={"ids": [a, b], "name": "A + B"})
    assert r.status_code == 201, r.get_data(as_text=True)
    d = r.get_json()
    nuevo = _fila_plan(d["public_id"])
    assert nuevo["name"] == "A + B"
    assert nuevo["source"] == "gpx"
    assert nuevo["activity_type"] == antes_a["activity_type"]
    assert nuevo["ibp_index"] is None
    assert client.get(f"/api/planned/{d['public_id']}/points").get_json()["n"] == 16

    # Los originales, intactos (métricas, historial e índice incluidos).
    ahora_a = _fila_plan(a)
    assert ahora_a["distance_m"] == antes_a["distance_m"]
    assert ahora_a["ibp_index"] == 73
    assert _versiones_en_bd(a) == 0

    assert client.post("/api/planned/merge", json={"ids": [a]}).status_code == 400
    assert client.post("/api/planned/merge",
                       json={"ids": [a, a]}).status_code == 400
    assert client.post("/api/planned/merge",
                       json={"ids": [a, "noexiste"]}).status_code == 404


# ── DEM, rescan y borrado ──────────────────────────────────────────────────

def test_elevation_dem_sin_servicio_configurado(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(6,)]), "Plan sin DEM")
    r = client.post(f"/api/planned/{pid}/elevation-dem", json={"base_version": 0})
    assert r.status_code == 400
    assert "DEM" in r.get_json()["error"]
    assert _versiones_en_bd(pid) == 0


def test_rescan_no_toca_el_ibp_ni_crea_version(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(12,)]), "Plan a reescanear")
    _poner_ibp(pid)
    dist0 = _fila_plan(pid)["distance_m"]

    r = client.post(f"/api/planned/{pid}/rescan")
    assert r.status_code == 200
    d = r.get_json()
    # El track no ha cambiado: mismas métricas, mismo índice y sin versión nueva.
    assert d["distance_m"] == pytest.approx(dist0)
    assert d["ibp_index"] == 73 and d["ibp_modality"] == "HKG"
    assert d["version"] == 0 and _versiones_en_bd(pid) == 0


def test_borrar_el_plan_borra_su_historial(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(10,)]), "Plan efímero")
    client.post(f"/api/planned/{pid}/edit",
                json={"base_version": 0, "summary": "recorte",
                      "ops": [{"op": "delete_range", "start": 0, "end": 2}]})
    assert _versiones_en_bd(pid) == 2
    with flask_app.app_context():
        plan_id = db().execute("SELECT id FROM planned_routes WHERE public_id=?",
                               (pid,)).fetchone()["id"]

    assert client.delete(f"/api/planned/{pid}").status_code == 204
    with flask_app.app_context():
        n = db().execute("SELECT COUNT(*) FROM plan_versions WHERE plan_id=?",
                         (plan_id,)).fetchone()[0]
    assert n == 0
    assert client.get(f"/api/planned/{pid}/points").status_code == 404


def test_la_pagina_del_editor_no_pisa_la_del_detalle(client, make_gpx_xml):
    pid = _crear_plan(client, make_gpx_xml(tracks=[(6,)]), "Plan con página")
    assert client.get(f"/Plan/{pid}").status_code == 200
    assert client.get(f"/Plan/{pid}/editor").status_code == 200
    # Por nombre se redirige al public_id, que es la URL canónica.
    r = client.get("/Plan/Plan con p%C3%A1gina/editor")
    assert r.status_code == 302 and r.headers["Location"].endswith(f"/{pid}/editor")


# ── no regresión: el editor de RUTAS se comporta igual que antes ───────────

def test_editor_de_ruta_sin_regresion(client, make_gpx_xml):
    xml = make_gpx_xml(tracks=[(20,)], name="Ruta editable")
    r = client.post(
        "/api/routes",
        data={"gpx": (io.BytesIO(xml.encode("utf-8")), "ruta_editable.gpx")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 201, r.get_data(as_text=True)
    rid = r.get_json()["public_id"]

    meta = client.get(f"/api/routes/{rid}/editor").get_json()
    assert meta["kind"] == "route"           # campo nuevo, el resto sigue igual
    assert meta["has_times"] is True
    assert meta["version"] == 0
    assert set(meta["gps_thresholds"]) == {"max_speed_kmh", "max_vert_rate_ms",
                                           "max_ele_m"}
    assert meta["gps_issues"] == []
    assert meta["dem_enabled"] is False
    assert meta["name"] == "Ruta editable"

    detalle = client.get(f"/api/routes/{rid}").get_json()
    thumb0, dist0 = detalle["thumb_file"], detalle["distance_m"]
    assert thumb0 and client.get(f"/api/routes/{rid}/thumb").status_code == 200

    pts = client.get(f"/api/routes/{rid}/points").get_json()
    assert pts["n"] == 20 and pts["version"] == 0 and pts["source"] == "gpx"

    body = {"base_version": 0, "summary": "Recorte de prueba",
            "ops": [{"op": "delete_range", "start": 0, "end": 9}]}
    d = client.post(f"/api/routes/{rid}/edit", json=body).get_json()
    assert d["version"] == 2
    assert d["distance_m"] < dist0
    # El thumbnail se regenera CON EL MISMO NOMBRE (de eso dependen la caché y
    # el nombre del archivo activo).
    assert d["thumb_file"] == thumb0

    r409 = client.post(f"/api/routes/{rid}/edit", json=body)
    assert r409.status_code == 409
    assert r409.get_json()["code"] == "version_conflict"

    vs = client.get(f"/api/routes/{rid}/versions").get_json()
    assert vs["current"] == 2
    assert [v["version_n"] for v in vs["items"]] == [2, 1]
    assert vs["items"][1]["summary"] == "Archivo original"
    assert all(v["file_ext"] == ".gpx" for v in vs["items"])

    v2 = client.get(f"/api/routes/{rid}/versions/2/gpx")
    assert v2.status_code == 200
    assert len(gpxpy.parse(v2.get_data(as_text=True)).tracks) == 1

    d3 = client.post(f"/api/routes/{rid}/versions/1/restore").get_json()
    assert d3["version"] == 3
    assert d3["distance_m"] == pytest.approx(dist0)
    assert d3["thumb_file"] == thumb0


def test_editor_de_ruta_fit_materializa_gpx_con_el_mismo_stem(client, sample_fit):
    """El caso FIT vive dentro del target: al editar por primera vez se
    materializa <stem>.gpx (mismo stem → el thumbnail no cambia de nombre) y el
    .fit queda archivado como v1, que se puede restaurar."""
    r = client.post(
        "/api/routes",
        data={"gpx": (io.BytesIO(sample_fit), "actividad_editor.fit")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 201, r.get_data(as_text=True)
    rid = r.get_json()["public_id"]

    antes = client.get(f"/api/routes/{rid}").get_json()
    assert antes["gpx_file"].endswith(".fit")
    thumb0 = antes["thumb_file"]
    assert client.get(f"/api/routes/{rid}/points").get_json()["source"] == "fit"

    d = client.post(f"/api/routes/{rid}/edit",
                    json={"base_version": 0, "summary": "Recorte",
                          "ops": [{"op": "delete_range", "start": 0, "end": 4}]}
                    ).get_json()
    assert d["version"] == 2
    assert d["gpx_file"] == "actividad_editor.gpx"
    assert d["thumb_file"] == thumb0

    vs = client.get(f"/api/routes/{rid}/versions").get_json()
    assert vs["items"][1]["file_ext"] == ".fit"
    assert vs["items"][1]["summary"] == "Archivo original (FIT)"

    # Restaurar el .fit devuelve el activo a esa extensión.
    d2 = client.post(f"/api/routes/{rid}/versions/1/restore").get_json()
    assert d2["version"] == 3
    assert d2["gpx_file"] == "actividad_editor.fit"
    assert d2["thumb_file"] == thumb0
