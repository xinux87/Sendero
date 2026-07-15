"""Itera el historial de Huami y produce el GPX de cada entrenamiento nuevo.

Lógica pura (sin la capa HTTP de Sendero): el servicio mifit_sync.py consume el
generador y decide qué hacer con cada GPX (POST a /api/routes). Se separa así
para poder testearlo con un `Api` parcheado, sin red ni base de datos.
"""
import logging
from typing import Iterator, List, Tuple

from core.mifit.api import Api, WorkoutSummary
from core.mifit.gpx import build_gpx, workout_filename
from core.mifit.points import parse_points

LOGGER = logging.getLogger(__name__)


def fetch_summaries(api: Api) -> List[WorkoutSummary]:
    """Recorre el historial paginado (por trackid) y devuelve todos los resúmenes."""
    summaries: List[WorkoutSummary] = []
    history = api.get_workout_history()
    summaries.extend(history.data.summary)
    while history.data.next != -1:
        LOGGER.info("Pidiendo más resúmenes desde el workout %s", history.data.next)
        history = api.get_workout_history(from_track_id=history.data.next)
        summaries.extend(history.data.summary)
    LOGGER.info("Hay %d entrenamientos en total", len(summaries))
    return summaries


def iter_new_workouts(
    api: Api, since_trackid: int = 0
) -> Iterator[Tuple[int, str, str]]:
    """Genera (trackid, nombre_gpx, gpx_str) de los entrenamientos con
    trackid > since_trackid y con puntos GPS, en orden cronológico ascendente.

    Los entrenamientos sin puntos (indoor: cinta, remo, bádminton…) se saltan.
    """
    summaries = fetch_summaries(api)
    for summary in sorted(summaries, key=lambda s: int(s.trackid)):
        trackid = int(summary.trackid)
        if trackid <= since_trackid:
            continue
        detail = api.get_workout_detail(summary)
        points = parse_points(summary, detail.data)
        if not points:
            LOGGER.info("Workout %s sin puntos GPS — se salta (indoor)", trackid)
            continue
        yield trackid, workout_filename(summary), build_gpx(summary, points)
