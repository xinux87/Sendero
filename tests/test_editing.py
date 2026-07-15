"""Tests de core/editing.py: el invariante central es que cliente y servidor
apliquen las ops igual, y que el aplanado punto[i] ↔ i-ésimo trkpt coincida
con analyse_gpx(). Cada test construye un GPX sintético, aplica ops y
re-extrae del XML resultante (el mismo camino que sigue el servidor real).
"""
import datetime as dt

import gpxpy
import pytest

from core.editing import (
    EditError, apply_ops, extract_points, split_track, merge_gpx, load_gpx,
)
from core.parsers import analyse_gpx


def _apply(xml, ops):
    """Aplica ops sobre un XML y devuelve extract_points del resultado."""
    out_xml, summary, n = apply_ops(gpxpy.parse(xml), ops)
    assert isinstance(summary, str) and summary
    pts = extract_points(gpxpy.parse(out_xml))
    assert pts["n"] == n
    return pts


# ---------------------------------------------------------------- extract

def test_extract_points_basico(make_gpx_xml):
    pts = extract_points(gpxpy.parse(make_gpx_xml(tracks=[(5,)], hr=140)))
    assert pts["n"] == 5
    assert pts["segments"] == [[0, 4]]
    assert pts["lonlat"][0] == [-3.0, 42.0]
    assert pts["ele"] == [100.0, 101.0, 102.0, 103.0, 104.0]
    assert pts["time"][0] == "2024-05-01T09:00:00"
    assert pts["hr"] == [140] * 5
    assert pts["waypoints"] == []


def test_extract_points_multisegmento_y_multitrack(make_gpx_xml):
    pts = extract_points(gpxpy.parse(make_gpx_xml(tracks=[(3, 4), (2,)])))
    assert pts["n"] == 9
    assert pts["segments"] == [[0, 2], [3, 6], [7, 8]]


def test_extract_points_colapsa_arrays_vacios(make_gpx_xml):
    pts = extract_points(
        gpxpy.parse(make_gpx_xml(with_times=False, with_ele=False))
    )
    assert pts["ele"] is None
    assert pts["time"] is None
    assert pts["hr"] is None


def test_paridad_aplanado_con_analyse_gpx(make_gpx_xml):
    """El orden tracks→segments→points debe ser idéntico en los dos módulos."""
    xml = make_gpx_xml(tracks=[(3, 2), (4,)])
    _, coords, _, _, _ = analyse_gpx(xml)
    pts = extract_points(gpxpy.parse(xml))
    assert pts["lonlat"] == coords


# ---------------------------------------------------------------- ops

def test_delete_range_intermedio_parte_el_segmento(make_gpx_xml):
    xml = make_gpx_xml(tracks=[(10,)], hr=list(range(120, 130)))
    pts = _apply(xml, [{"op": "delete_range", "start": 3, "end": 5}])
    assert pts["n"] == 7
    assert pts["segments"] == [[0, 2], [3, 6]]
    # time y HR sobreviven en los supervivientes (índice original 6 → nuevo 3)
    assert pts["time"][3] == "2024-05-01T09:06:00"
    assert pts["hr"] == [120, 121, 122, 126, 127, 128, 129]


def test_delete_range_al_inicio_no_parte(make_gpx_xml):
    pts = _apply(make_gpx_xml(tracks=[(10,)]),
                 [{"op": "delete_range", "start": 0, "end": 2}])
    assert pts["n"] == 7
    assert pts["segments"] == [[0, 6]]
    assert pts["time"][0] == "2024-05-01T09:03:00"


def test_delete_points_no_parte_el_segmento(make_gpx_xml):
    pts = _apply(make_gpx_xml(tracks=[(10,)]),
                 [{"op": "delete_points", "indices": [3, 4, 5]}])
    assert pts["n"] == 7
    assert pts["segments"] == [[0, 6]]


def test_reverse_invierte_y_elimina_times(make_gpx_xml):
    xml = make_gpx_xml(tracks=[(5,)])
    original = extract_points(gpxpy.parse(xml))
    pts = _apply(xml, [{"op": "reverse"}])
    assert pts["lonlat"] == original["lonlat"][::-1]
    assert pts["time"] is None  # timestamps descendentes serían inválidos


def test_move_point(make_gpx_xml):
    pts = _apply(make_gpx_xml(tracks=[(5,)]),
                 [{"op": "move_point", "i": 2, "lon": -3.5, "lat": 42.5, "ele": 999.0}])
    assert pts["lonlat"][2] == [-3.5, 42.5]
    assert pts["ele"][2] == 999.0


def test_insert_point_ele_media_y_sin_time(make_gpx_xml):
    pts = _apply(make_gpx_xml(tracks=[(5,)]),
                 [{"op": "insert_point", "after": 2, "lon": -3.0005, "lat": 42.0025}])
    assert pts["n"] == 6
    assert pts["ele"][3] == pytest.approx((102.0 + 103.0) / 2)
    assert pts["time"][3] is None  # no se inventa timestamp
    assert pts["time"][2] is not None and pts["time"][4] is not None


def test_set_ele_redondea(make_gpx_xml):
    pts = _apply(make_gpx_xml(tracks=[(5,)]),
                 [{"op": "set_ele", "items": [[1, 123.456]]}])
    assert pts["ele"][1] == 123.5


def test_shift_time(make_gpx_xml):
    pts = _apply(make_gpx_xml(tracks=[(3,)]),
                 [{"op": "shift_time", "seconds": 3600}])
    assert pts["time"][0] == "2024-05-01T10:00:00"
    assert pts["time"][2] == "2024-05-01T10:02:00"


def test_waypoints_ciclo_completo(make_gpx_xml):
    xml = make_gpx_xml(tracks=[(3,)])
    pts = _apply(xml, [
        {"op": "wpt_add", "lon": -3.1, "lat": 42.1, "name": "Cima"},
        {"op": "wpt_add", "lon": -3.2, "lat": 42.2},
        {"op": "wpt_move", "i": 0, "lon": -3.15, "lat": 42.15},
        {"op": "wpt_rename", "i": 1, "name": "Fuente"},
    ])
    assert len(pts["waypoints"]) == 2
    assert pts["waypoints"][0]["name"] == "Cima"
    assert pts["waypoints"][0]["lon"] == pytest.approx(-3.15)
    assert pts["waypoints"][1]["name"] == "Fuente"

    pts2 = _apply(xml, [{"op": "wpt_add", "lon": -3.1, "lat": 42.1, "name": "X"},
                        {"op": "wpt_del", "i": 0}])
    assert pts2["waypoints"] == []


def test_ops_secuenciales_reindexan(make_gpx_xml):
    """Los índices de cada op se refieren al estado tras las anteriores."""
    pts = _apply(make_gpx_xml(tracks=[(5,)]), [
        {"op": "delete_points", "indices": [0]},
        {"op": "set_ele", "items": [[0, 555.0]]},  # el que era índice 1
    ])
    assert pts["ele"] == [555.0, 102.0, 103.0, 104.0]


def test_op_desconocida_y_validaciones(make_gpx_xml):
    xml = make_gpx_xml(tracks=[(3,)])
    with pytest.raises(EditError):
        apply_ops(gpxpy.parse(xml), [{"op": "explotar"}])
    with pytest.raises(EditError):
        apply_ops(gpxpy.parse(xml), [{"op": "move_point", "i": 99, "lon": 0, "lat": 0}])
    with pytest.raises(EditError):  # dejaría <2 puntos
        apply_ops(gpxpy.parse(xml), [{"op": "delete_points", "indices": [0, 1]}])


# ---------------------------------------------------------------- split/merge

def test_split_track_comparte_el_punto_de_corte(make_gpx_xml):
    gpx = gpxpy.parse(make_gpx_xml(tracks=[(10,)], hr=150))
    xml_a, xml_b = split_track(gpx, 4)
    a = extract_points(gpxpy.parse(xml_a))
    b = extract_points(gpxpy.parse(xml_b))
    assert a["n"] == 5 and b["n"] == 6
    assert a["lonlat"][-1] == b["lonlat"][0]
    assert b["hr"] is not None  # las extensiones HR sobreviven al split


def test_split_track_valida_bordes(make_gpx_xml):
    for idx in (0, 9):
        with pytest.raises(EditError):
            split_track(gpxpy.parse(make_gpx_xml(tracks=[(10,)])), idx)


def test_merge_ordena_cronologicamente(make_gpx_xml):
    tarde = gpxpy.parse(make_gpx_xml(tracks=[(3,)], start="2024-05-02T09:00:00",
                                     lat0=43.0))
    pronto = gpxpy.parse(make_gpx_xml(tracks=[(3,)], start="2024-05-01T09:00:00"))
    xml, times_kept = merge_gpx([tarde, pronto])
    assert times_kept is True
    pts = extract_points(gpxpy.parse(xml))
    assert pts["n"] == 6
    assert pts["segments"] == [[0, 2], [3, 5]]  # el hueco queda como corte
    assert pts["lonlat"][0] == [-3.0, 42.0]     # la de mayo-01 va primero


def test_merge_solapado_descarta_times(make_gpx_xml):
    a = gpxpy.parse(make_gpx_xml(tracks=[(5,)], start="2024-05-01T09:00:00"))
    b = gpxpy.parse(make_gpx_xml(tracks=[(5,)], start="2024-05-01T09:02:00",
                                 lat0=43.0))
    xml, times_kept = merge_gpx([a, b])
    assert times_kept is False
    assert extract_points(gpxpy.parse(xml))["time"] is None


def test_load_gpx_bytes(make_gpx_xml):
    gpx = load_gpx(make_gpx_xml(tracks=[(3,)]).encode(), is_fit=False)
    assert extract_points(gpx)["n"] == 3
