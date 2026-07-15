"""Fixtures compartidas.

SENDERO_DATA se fija a un directorio temporal ANTES de importar core.config
(que hace mkdir de los paths a nivel de módulo) para que los tests nunca
toquen data/ real.
"""
import os
import tempfile

os.environ.setdefault("SENDERO_DATA", tempfile.mkdtemp(prefix="sendero-tests-"))

import datetime as dt  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

import core.config as cfg  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _sin_ajustes_personalizados(monkeypatch):
    """Aísla cada test de tipos GPX/umbrales personalizados en memoria."""
    monkeypatch.setattr(cfg, "_CUSTOM_GPX_TYPES", {}, raising=False)
    monkeypatch.setattr(cfg, "_GPS_THRESHOLDS_CUSTOM", {}, raising=False)


@pytest.fixture
def make_gpx_xml():
    """Constructor de GPX sintéticos deterministas.

    tracks: lista de tracks, cada uno una tupla de tamaños de segmento,
            p.ej. [(5,)] = 1 track / 1 segmento / 5 puntos.
    El índice de punto es GLOBAL (continúa entre segmentos y tracks): el punto
    i está en lat0 + i*dlat (≈111 m por 0.001°), con ele_start + i*ele_step y
    start + i*step_s — así cada test sabe exactamente qué valor toca.
    hr: None, entero constante, o lista alineada con el índice global.
    """
    def _make(tracks=[(5,)], start="2024-05-01T09:00:00", step_s=60,
              ele_start=100.0, ele_step=1.0, hr=None, with_times=True,
              with_ele=True, name="Ruta de prueba", gpx_type=None,
              lat0=42.0, lon0=-3.0, dlat=0.001, creator="TestDevice",
              waypoints=()):
        t0 = dt.datetime.fromisoformat(start)
        idx = 0
        trks = []
        for ti, seg_sizes in enumerate(tracks):
            segs = []
            for size in seg_sizes:
                pts = []
                for _ in range(size):
                    lat = lat0 + idx * dlat
                    parts = [f'      <trkpt lat="{lat:.6f}" lon="{lon0:.6f}">']
                    if with_ele:
                        parts.append(f"        <ele>{ele_start + idx * ele_step:.1f}</ele>")
                    if with_times:
                        ts = (t0 + dt.timedelta(seconds=idx * step_s)).isoformat()
                        parts.append(f"        <time>{ts}</time>")
                    h = hr[idx] if isinstance(hr, (list, tuple)) else hr
                    if h is not None:
                        parts.append(
                            "        <extensions><gpxtpx:TrackPointExtension>"
                            f"<gpxtpx:hr>{h}</gpxtpx:hr>"
                            "</gpxtpx:TrackPointExtension></extensions>"
                        )
                    parts.append("      </trkpt>")
                    pts.append("\n".join(parts))
                    idx += 1
                segs.append("    <trkseg>\n" + "\n".join(pts) + "\n    </trkseg>")
            meta = ""
            if ti == 0:
                meta = f"    <name>{name}</name>\n"
                if gpx_type:
                    meta += f"    <type>{gpx_type}</type>\n"
            trks.append("  <trk>\n" + meta + "\n".join(segs) + "\n  </trk>")
        wpts = "".join(
            f'  <wpt lat="{la:.6f}" lon="{lo:.6f}"><name>{nm}</name></wpt>\n'
            for lo, la, nm in waypoints
        )
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<gpx version="1.1" creator="{creator}" '
            'xmlns="http://www.topografix.com/GPX/1/1" '
            'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n'
            + wpts + "\n".join(trks) + "\n</gpx>"
        )
    return _make


@pytest.fixture
def sample_fit():
    """FIT de muestra (del repo oficial garmin/fit-python-sdk, solo para tests)."""
    return (FIXTURES / "Activity.fit").read_bytes()
