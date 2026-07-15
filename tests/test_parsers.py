"""Tests de core/parsers.py: stats de analyse_gpx, perfiles y detección de
actividad. El GPX sintético avanza 0.001° de latitud (≈111.2 m) por punto,
un punto por minuto → ≈6.67 km/h.
"""
import xml.etree.ElementTree as ET

import pytest

from core.parsers import (
    analyse_gpx, _hr_from_extensions, _gpx_type_lookup, _detect_activity,
)


def test_stats_basicas(make_gpx_xml):
    stats, coords, elev, name, creator = analyse_gpx(make_gpx_xml(tracks=[(5,)]))
    assert len(coords) == 5
    assert coords[0] == [-3.0, 42.0]
    # 4 tramos de ~111.2 m (con ele_step la 3D añade centímetros)
    assert stats["distance_m"] == pytest.approx(445, abs=5)
    assert stats["duration_s"] == 240
    assert stats["started_at"] == "2024-05-01T09:00:00"
    assert stats["ele_min"] == 100.0
    assert stats["ele_max"] == 104.0
    assert stats["ascent_m"] == pytest.approx(4, abs=0.5)
    assert name == "Ruta de prueba"
    assert creator == "TestDevice"
    assert len(elev) == 5
    assert elev[-1]["e"] == 104.0


def test_sin_times_no_hay_duracion_ni_velocidad(make_gpx_xml):
    stats, *_ = analyse_gpx(make_gpx_xml(tracks=[(5,)], with_times=False))
    assert stats["duration_s"] is None
    assert stats["started_at"] is None
    assert stats["_speed_profile"] == []
    assert stats["avg_speed"] is None


def test_perfil_velocidad_suavizado(make_gpx_xml):
    # puntos cada 10 s: la ventana móvil de 15 s (SPEED_WINDOW_S) llega a juntar
    # ≥2 puntos; con paso de 60 s el perfil queda vacío a propósito
    stats, *_ = analyse_gpx(make_gpx_xml(tracks=[(10,)], step_s=10))
    vs = [p["v"] for p in stats["_speed_profile"]]
    assert vs, "con <time> por punto debe haber perfil de velocidad"
    # 111.2 m cada 10 s → velocidad constante de ≈40 km/h
    assert all(v == pytest.approx(40.0, abs=2.0) for v in vs)


def test_perfil_velocidad_vacio_con_puntos_muy_espaciados(make_gpx_xml):
    stats, *_ = analyse_gpx(make_gpx_xml(tracks=[(10,)], step_s=60))
    assert stats["_speed_profile"] == []


def test_hr_perfil_y_agregados(make_gpx_xml):
    stats, *_ = analyse_gpx(make_gpx_xml(tracks=[(4,)], hr=[120, 130, 140, 150]))
    assert stats["hr_avg"] == 135
    assert stats["hr_max"] == 150
    assert [p["hr"] for p in stats["_hr_profile"]] == [120, 130, 140, 150]


def test_tipo_gpx_se_extrae_y_mapea(make_gpx_xml):
    stats, *_ = analyse_gpx(make_gpx_xml(tracks=[(3,)], gpx_type="hiking"))
    assert stats["_gpx_type"] == "hiking"
    assert _gpx_type_lookup("Hiking") == "senderismo"
    assert _gpx_type_lookup("cycling") == "bicicleta"
    assert _gpx_type_lookup("inventado") is None


def _hr_ext(text):
    ns = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
    ext = ET.Element(f"{{{ns}}}TrackPointExtension")
    el = ET.SubElement(ext, f"{{{ns}}}hr")
    el.text = text
    return [ext]


def test_hr_from_extensions_rango_valido():
    assert _hr_from_extensions(_hr_ext("150")) == 150
    assert _hr_from_extensions(_hr_ext("300")) is None   # fuera de 20-250
    assert _hr_from_extensions(_hr_ext("abc")) is None
    assert _hr_from_extensions(None) is None


def test_detect_activity_por_nombre():
    assert _detect_activity("Subida al Ocejón por el sendero GR-10") == "senderismo"
    assert _detect_activity("Vuelta en bici al pantano") == "bicicleta"
    assert _detect_activity("XyZ 123") is None
