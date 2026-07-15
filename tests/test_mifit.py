"""Tests del pipeline Mi Fit/Zepp vendorizado (core/mifit), sin red ni BD.

Construye un resumen + detalle sintéticos (formato crudo de Huami: arrays
delta-codificados separados por ';'), decodifica a puntos, serializa a GPX y
comprueba que:
- el GPX es válido y gpxpy lo re-parsea con los puntos, tiempos y FC correctos,
- el nombre del track ("DD-MM-YYYY hiking") hace que Sendero detecte "senderismo",
- iter_new_workouts respeta since_trackid y salta los entrenamientos sin GPS.
"""
import gpxpy

from core.mifit.api import (WorkoutDetail, WorkoutDetailData, WorkoutHistory,
                            WorkoutHistoryData, WorkoutSummary)
from core.mifit.gpx import build_gpx, workout_filename
from core.mifit.points import parse_points
from core.mifit.sync import iter_new_workouts
from core.parsers import _detect_activity, analyse_gpx

TRACKID = 1700000000  # 2023-11-14 22:13:20 UTC


def _summary(trackid=TRACKID, wtype=22, bind_device="0:MILI_ROCKY_WNFC:abc"):
    return WorkoutSummary(
        trackid=str(trackid), source="run.mi", dis="1234", calorie="100",
        end_time=str(trackid + 120), run_time="120", avg_pace="0",
        avg_frequency="0", avg_heart_rate="122", type=wtype, location="0,0",
        city="", forefoot_ratio="0", bind_device=bind_device, version=1,
        app_name="com.xiaomi.hm.health",
    )


def _detail(trackid=TRACKID, with_gps=True):
    fields = {k: "" for k in WorkoutDetailData.model_fields}
    fields["trackid"] = trackid
    fields["version"] = 1
    if with_gps:
        # 3 puntos a t=0,1,2 s. Deltas: lat/lon en unidades 1e-8 grados.
        fields["time"] = "0;1;1"
        fields["longitude_latitude"] = "5000000000,-8400000000;100000,100000;100000,100000"
        fields["altitude"] = "255241;100;100"
        # heart_rate delta-codificado: acumula a 120, 122, 124
        fields["heart_rate"] = "0,120;1,2;1,2"
    return WorkoutDetailData(**fields)


def test_parse_points_decodes_track():
    pts = parse_points(_summary(), _detail())
    assert len(pts) == 3
    assert abs(pts[0].latitude - 50.0) < 1e-6
    assert abs(pts[0].longitude - (-84.0)) < 1e-6
    assert abs(pts[1].latitude - 50.001) < 1e-6
    assert [int(p.heart_rate) for p in pts] == [120, 122, 124]


def test_build_gpx_roundtrips_through_gpxpy():
    summary = _summary()
    pts = parse_points(summary, _detail())
    xml = build_gpx(summary, pts)

    gpx = gpxpy.parse(xml)
    trkpts = gpx.tracks[0].segments[0].points
    assert len(trkpts) == 3
    assert trkpts[0].time is not None          # <time> presente
    assert trkpts[0].elevation is not None      # <ele> presente
    # nombre del track: "14-11-2023 hiking"
    assert "hiking" in gpx.tracks[0].name
    assert gpx.tracks[0].name.startswith("14-11-2023")
    # creator resuelto desde device_names.json
    assert "T-Rex" in xml


def test_gpx_activity_detected_as_senderismo():
    # El nombre generado ("… hiking") debe hacer que Sendero clasifique senderismo,
    # y analyse_gpx debe leer la FC del GPX resultante.
    summary = _summary()
    xml = build_gpx(summary, parse_points(summary, _detail()))
    stats, coords, elev, name, creator = analyse_gpx(xml)
    assert _detect_activity(name) == "senderismo"
    assert len(coords) == 3
    assert stats["hr_avg"] is not None


def test_workout_filename_is_deterministic():
    # Mismo trackid → mismo nombre (deduplicación por nombre en Sendero).
    assert workout_filename(_summary()) == workout_filename(_summary())
    assert workout_filename(_summary()).startswith("Workout--2023-11-14--")
    assert workout_filename(_summary()).endswith(".gpx")


class _FakeApi:
    """Api simulada: un historial de una página y detalles por trackid."""
    def __init__(self, summaries, details):
        self._summaries = summaries
        self._details = details

    def get_workout_history(self, from_track_id=None):
        return WorkoutHistory(code=1, message="success",
                              data=WorkoutHistoryData(next=-1, summary=self._summaries))

    def get_workout_detail(self, workout):
        return WorkoutDetail(code=1, message="success",
                             data=self._details[int(workout.trackid)])


def test_effective_since_date_floor():
    import mifit_sync as m
    ts_2024 = 1704067200  # 2024-01-01 00:00:00 UTC

    # Sin marca ni fecha → 0 (backfill completo).
    assert m.effective_since({}) == 0
    # Solo fecha → suelo por la fecha (incluye el propio día: floor_ts - 1).
    assert m.effective_since({"MIFIT_SINCE_DATE": "2024-01-01"}) == ts_2024 - 1
    # Marca incremental mayor que la fecha → gana la marca (no re-importa antiguos).
    assert m.effective_since(
        {"MIFIT_LAST_TRACKID": str(ts_2024 + 10_000), "MIFIT_SINCE_DATE": "2024-01-01"}
    ) == ts_2024 + 10_000
    # Marca menor que la fecha → gana la fecha (no baja del suelo elegido).
    assert m.effective_since(
        {"MIFIT_LAST_TRACKID": "100", "MIFIT_SINCE_DATE": "2024-01-01"}
    ) == ts_2024 - 1
    # Fecha inválida → se ignora, cae a la marca.
    assert m.effective_since({"MIFIT_LAST_TRACKID": "555", "MIFIT_SINCE_DATE": "ayer"}) == 555


def test_watermark_flushed_periodically(monkeypatch):
    """La marca incremental se persiste cada WATERMARK_FLUSH_EVERY rutas durante un
    backfill (para no re-descargar todo si el proceso se interrumpe), además del
    guardado final."""
    import mifit_sync as m
    monkeypatch.setattr(m, "WATERMARK_FLUSH_EVERY", 10)
    monkeypatch.setattr(m, "Api", lambda *a, **k: object())
    items = [(1000 + i, f"W{i}.gpx", "<gpx/>") for i in range(25)]
    monkeypatch.setattr(m, "iter_new_workouts", lambda api, since_trackid=0: iter(items))
    monkeypatch.setattr(m, "_post_gpx", lambda name, gpx: (201, False))
    writes = []

    def fake_set(**kv):
        if "MIFIT_LAST_TRACKID" in kv:
            writes.append(kv["MIFIT_LAST_TRACKID"])
    monkeypatch.setattr(m, "set_settings", fake_set)

    m.do_sync({"MIFIT_TOKEN": "t"})
    # flush tras la 10ª (1009) y la 20ª (1019), + guardado final (1024)
    assert writes == [1009, 1019, 1024]


def test_iter_new_workouts_filters_and_orders():
    s_old = _summary(trackid=TRACKID)
    s_new = _summary(trackid=TRACKID + 1000)
    s_indoor = _summary(trackid=TRACKID + 2000)
    api = _FakeApi(
        summaries=[s_new, s_indoor, s_old],  # desordenados a propósito
        details={
            TRACKID: _detail(TRACKID),
            TRACKID + 1000: _detail(TRACKID + 1000),
            TRACKID + 2000: _detail(TRACKID + 2000, with_gps=False),  # indoor
        },
    )
    # since_trackid corta el viejo; el indoor (sin puntos) se salta.
    out = list(iter_new_workouts(api, since_trackid=TRACKID))
    assert [tid for tid, _, _ in out] == [TRACKID + 1000]
    assert out[0][1].endswith(".gpx")
    assert "<trkpt" in out[0][2]
