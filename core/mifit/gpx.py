"""Serializa los puntos de un entrenamiento de Huami a un GPX 1.1 en memoria.

Vendorizado y adaptado desde `roadmap/mifit exporter/src/exporters/gpx_exporter.py`
(basado en https://github.com/mireq/MiFitDataExport). Cambios respecto al original:
- devuelve el GPX como str en vez de escribirlo a disco (build_gpx / workout_filename)
- las tablas device_names.json / workout_types.json se leen de core/mifit/

El nombre del track queda como "DD-MM-YYYY <tipo>" (tipo en inglés: hiking, cycling,
walking, running, skiing…). Esas palabras ya están en las keywords de
core.parsers._detect_activity, así que Sendero asigna la actividad española al
importar sin necesidad de mapeo extra.
"""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import List
from xml.sax.saxutils import escape

from core.mifit.api import WorkoutSummary
from core.mifit.points import ExportablePoint

LOGGER = logging.getLogger(__name__)

_HERE = Path(__file__).parent
_DEVICE_NAMES_FILE = _HERE / "device_names.json"   # clave: código de modelo (2º campo de bind_device)
_WORKOUT_TYPES_FILE = _HERE / "workout_types.json"  # clave: código numérico de tipo como string

_DEFAULT_WORKOUT_TYPES = {
    "1": "running",
    "6": "walking",
    "8": "treadmill_running",
    "9": "cycling",
    "10": "indoor_cycling",
    "16": "other",
    "22": "hiking",
    "23": "indoor_rowing",
    "92": "badminton",
}

FILENAME_FORMAT = "Workout--%Y-%m-%d--%H-%M-%S"


def _load_json(path: Path, label: str) -> dict:
    if path.exists():
        try:
            with path.open(encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            LOGGER.warning(f"No se pudo cargar {label}: {e}")
    return {}


def _resolve_device_name(bind_device: str) -> str:
    if not bind_device:
        return "Mi Fit Exporter"
    parts = bind_device.split(":")
    model_code = parts[1] if len(parts) > 1 else bind_device
    return _load_json(_DEVICE_NAMES_FILE, "device_names.json").get(model_code, bind_device)


def _map_workout_type(summary: WorkoutSummary) -> str:
    mapping = {**_DEFAULT_WORKOUT_TYPES, **_load_json(_WORKOUT_TYPES_FILE, "workout_types.json")}
    type_key = str(summary.type)
    if workout_type := mapping.get(type_key):
        return workout_type
    LOGGER.warning(f"Tipo no mapeado para el workout {summary.trackid}: {summary.type} — se exporta tal cual")
    return type_key


def workout_filename(summary: WorkoutSummary) -> str:
    """Nombre de archivo GPX determinista para un entrenamiento (para deduplicar
    por nombre en Sendero: reimportar el mismo workout da un nombre idéntico)."""
    start_dt = datetime.utcfromtimestamp(int(summary.trackid))
    return start_dt.strftime(FILENAME_FORMAT) + ".gpx"


def build_gpx(summary: WorkoutSummary, points: List[ExportablePoint]) -> str:
    """Devuelve el GPX 1.1 (str) del entrenamiento con <time>/<ele>/<hr>/<cad>."""
    ind = "\t"
    out: List[str] = []
    start_dt = datetime.utcfromtimestamp(int(summary.trackid))
    date_str = start_dt.strftime("%d-%m-%Y")
    workout_name = f"{date_str} {_map_workout_type(summary)}"
    creator = escape(_resolve_device_name(summary.bind_device), {'"': "&quot;"})

    out.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n")
    out.append(
        '<gpx xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" '
        'xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" '
        'xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3" '
        'xmlns:ns1="http://www.cluetrust.com/XML/GPXDATA/1/0" '
        f'creator="{creator}" '
        'version="1.1">\n'
    )
    out.append(f"{ind}<trk>\n")
    out.append(f"{ind}{ind}<name><![CDATA[{workout_name}]]></name>\n")
    out.append(f"{ind}{ind}<trkseg>\n")
    for point in points:
        time_str = point.time.strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append(f'{ind}{ind}{ind}<trkpt lat="{point.latitude}" lon="{point.longitude}">\n')
        out.append(f"{ind}{ind}{ind}{ind}<ele>{point.altitude}</ele>\n")
        out.append(f"{ind}{ind}{ind}{ind}<time>{time_str}</time>\n")
        out.append(f"{ind}{ind}{ind}{ind}<extensions>\n")
        out.append(f"{ind}{ind}{ind}{ind}{ind}<ns3:TrackPointExtension>\n")
        if point.heart_rate:
            out.append(f"{ind}{ind}{ind}{ind}{ind}{ind}<ns3:hr>{int(point.heart_rate)}</ns3:hr>\n")
        if point.cadence:
            out.append(f"{ind}{ind}{ind}{ind}{ind}{ind}<ns3:cad>{int(point.cadence)}</ns3:cad>\n")
        out.append(f"{ind}{ind}{ind}{ind}{ind}</ns3:TrackPointExtension>\n")
        out.append(f"{ind}{ind}{ind}{ind}</extensions>\n")
        out.append(f"{ind}{ind}{ind}</trkpt>\n")
    out.append(f"{ind}{ind}</trkseg>\n")
    out.append(f"{ind}</trk>\n")
    out.append("</gpx>")
    return "".join(out)
