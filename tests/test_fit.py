"""Tests del parsing FIT (garmin-fit-sdk) contra un archivo de muestra real
(tests/fixtures/Activity.fit, del repo oficial garmin/fit-python-sdk).

Los valores esperados son la salida que producía la implementación anterior
con fitparse — la migración debe ser transparente.
"""
import pytest

from core.parsers import analyse_fit
from core.editing import fit_to_gpx, extract_points, load_gpx


def test_analyse_fit_muestra(sample_fit):
    stats, coords, elev, name, creator = analyse_fit(sample_fit)
    assert len(coords) == 3601
    assert stats["distance_m"] == 3600.0
    assert stats["duration_s"] == 3601.0
    assert stats["moving_s"] == 3601.0
    # naive UTC, sin sufijo +00:00 (igual que fitparse; started_at se compara
    # con datetimes naive en el cruce Immich y en merge_gpx)
    assert stats["started_at"] == "2022-08-15T17:39:09"
    assert stats["hr_avg"] == 127
    assert stats["hr_max"] == 254
    assert stats["_fit_sport"] == "stand_up_paddleboarding"
    assert name == "Stand Up Paddleboarding"
    assert creator == "development"
    assert len(stats["_hr_profile"]) == 3601
    assert len(stats["_speed_profile"]) == 3601
    assert len(elev) == 3601


def test_fit_to_gpx_paridad_de_indices(sample_fit):
    """fit_to_gpx debe producir exactamente los mismos puntos, en el mismo
    orden, que analyse_fit — el editor referencia por índice."""
    _, coords, *_ = analyse_fit(sample_fit)
    pts = extract_points(fit_to_gpx(sample_fit))
    assert pts["n"] == len(coords)
    assert pts["lonlat"][0] == pytest.approx(coords[0])
    assert pts["lonlat"][-1] == pytest.approx(coords[-1])
    # time naive y HR embebido como extensión Garmin (round-trip del editor)
    assert pts["time"][0] == "2022-08-15T17:39:09"
    assert pts["hr"] is not None and pts["hr"][0] > 0


def test_fit_materializado_se_reanaliza_como_gpx(sample_fit):
    """El camino real del editor: FIT → gpxpy → to_xml() → analyse_gpx."""
    from core.parsers import analyse_gpx
    xml = fit_to_gpx(sample_fit).to_xml()
    stats, coords, *_ = analyse_gpx(xml)
    assert len(coords) == 3601
    assert stats["started_at"] == "2022-08-15T17:39:09"
    # La FC sobrevive al round-trip. No se compara la media con analyse_fit:
    # la HR sintética de la muestra sale del rango 20-250 que
    # _hr_from_extensions filtra a propósito al releer el GPX.
    assert stats.get("hr_avg") is not None
    assert 20 <= stats["hr_max"] <= 250


def test_load_gpx_despacha_por_is_fit(sample_fit):
    assert extract_points(load_gpx(sample_fit, is_fit=True))["n"] == 3601


def test_fit_corrupto_lanza(sample_fit):
    with pytest.raises(ValueError):
        analyse_fit(b"esto no es un FIT")
    with pytest.raises(ValueError):
        analyse_fit(sample_fit[:100])  # truncado
