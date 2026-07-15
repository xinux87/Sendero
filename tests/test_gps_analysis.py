"""Tests de core/gps_analysis.py (detección de tramos GPS anómalos).

Se pasan siempre thresholds explícitos para no depender de ajustes guardados.
"""
import pytest

from core.gps_analysis import detect_gps_anomalies

TH = {"max_speed_kmh": 15, "max_vert_rate_ms": 5, "max_ele_m": 3500}


def _track(n, dlat=0.001, ele=100.0, t0=0, step_s=60):
    """n puntos hacia el norte a dlat por paso: ≈111.2 m/min ≈ 6.7 km/h."""
    lonlat = [[-3.0, 42.0 + i * dlat] for i in range(n)]
    eles = [ele] * n
    times = [f"2024-05-01T09:{(t0 + i * step_s) // 60:02d}:{(t0 + i * step_s) % 60:02d}"
             for i in range(n)]
    return lonlat, eles, times


def test_track_normal_sin_avisos():
    lonlat, ele, time = _track(10)
    assert detect_gps_anomalies(lonlat, ele, time, thresholds=TH) == []


def test_menos_de_dos_puntos():
    assert detect_gps_anomalies([[-3.0, 42.0]], [100.0], ["2024-05-01T09:00:00"],
                                thresholds=TH) == []


def test_salto_de_velocidad():
    lonlat, ele, time = _track(5)
    lonlat[3][1] += 0.01  # +1.1 km extra en 60 s → >60 km/h en ese tramo
    issues = detect_gps_anomalies(lonlat, ele, time, thresholds=TH)
    speed = [i for i in issues if i["type"] == "speed"]
    assert len(speed) >= 1
    assert speed[0]["value_max"] > 15
    assert speed[0]["threshold"] == 15
    assert speed[0]["severity"] == "high"  # ratio >= 2


def test_pico_de_elevacion():
    lonlat, ele, time = _track(5)
    ele = [100.0, 100.0, 500.0, 100.0, 100.0]  # ±400 m en 60 s → 6.7 m/s
    issues = detect_gps_anomalies(lonlat, ele, time, thresholds=TH)
    elev = [i for i in issues if i["type"] == "elevation"]
    assert len(elev) == 1  # los dos tramos contiguos (subida+bajada) se funden
    assert elev[0]["value_max"] == pytest.approx(400 / 60, abs=0.1)
    assert elev[0]["severity"] == "medium"  # ratio < 2


def test_altitud_sin_timestamps():
    """max_ele_m se comprueba incluso sin <time> (contrato documentado)."""
    lonlat, ele, _ = _track(5)
    ele = [100.0, 100.0, 9000.0, 100.0, 100.0]
    issues = detect_gps_anomalies(lonlat, ele, None, thresholds=TH)
    assert [i["type"] for i in issues] == ["altitude"]
    assert issues[0]["value_max"] == 9000.0


def test_tramos_contiguos_se_funden():
    lonlat, ele, time = _track(8)
    lonlat[3][1] += 0.01
    lonlat[4][1] += 0.02  # dos tramos rápidos consecutivos
    issues = detect_gps_anomalies(lonlat, ele, time, thresholds=TH)
    speed = [i for i in issues if i["type"] == "speed"]
    assert len(speed) == 1
    assert speed[0]["d_to"] > speed[0]["d_from"]


def test_actividad_desconocida_cae_en_defaults():
    """Sin thresholds explícitos, actividad desconocida usa los de 'otros'
    (40 km/h): 6.7 km/h no debe generar avisos."""
    lonlat, ele, time = _track(5)
    assert detect_gps_anomalies(lonlat, ele, time, activity_type="marciano") == []
