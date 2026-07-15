# Based on https://github.com/mireq/MiFitDataExport
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from src.api import WorkoutSummary
from src.exporters.base_exporter import BaseExporter, ExportablePoint

LOGGER = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).parent.parent.parent

# device_names.json — keys are the model code (second field of bind_device).
_DEVICE_NAMES_FILE = _PROJECT_ROOT / "device_names.json"

# workout_types.json — keys are numeric type codes as strings (e.g. "1", "9").
_WORKOUT_TYPES_FILE = _PROJECT_ROOT / "workout_types.json"

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


def _load_json(path: Path, label: str) -> dict:
    if path.exists():
        try:
            with path.open(encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            LOGGER.warning(f"Could not load {label}: {e}")
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
    LOGGER.warning(f"Unhandled type for workout {summary.trackid}: {summary.type} — exporting as-is")
    return type_key


class GpxExporter(BaseExporter):
    def get_supported_file_formats(self) -> List[str]:
        return ["gpx"]

    def export(
        self,
        output_file_path: Path,
        summary: WorkoutSummary,
        points: List[ExportablePoint],
    ):
        ind = "\t"
        with output_file_path.open(mode="w") as fp:
            start_dt = datetime.utcfromtimestamp(int(summary.trackid))
            date_str = start_dt.strftime("%d-%m-%Y")
            workout_name = f"{date_str} {_map_workout_type(summary)}"
            creator = _resolve_device_name(summary.bind_device)

            fp.write("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n")
            fp.write(
                '<gpx xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" '
                'xmlns="http://www.topografix.com/GPX/1/1" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
                'xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" '
                'xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3" '
                'xmlns:ns1="http://www.cluetrust.com/XML/GPXDATA/1/0" '
                f'creator="{creator}" '
                'version="1.1">\n'
            )
            fp.write(f"{ind}<trk>\n")
            fp.write(f"{ind}{ind}<name><![CDATA[{workout_name}]]></name>\n")
            fp.write(f"{ind}{ind}<trkseg>\n")
            for point in points:
                time_str = point.time.strftime("%Y-%m-%dT%H:%M:%SZ")
                fp.write(f'{ind}{ind}{ind}<trkpt lat="{point.latitude}" lon="{point.longitude}">\n')
                fp.write(f"{ind}{ind}{ind}{ind}<ele>{point.altitude}</ele>\n")
                fp.write(f"{ind}{ind}{ind}{ind}<time>{time_str}</time>\n")
                fp.write(f"{ind}{ind}{ind}{ind}<extensions>\n")
                fp.write(f"{ind}{ind}{ind}{ind}{ind}<ns3:TrackPointExtension>\n")
                if point.heart_rate:
                    fp.write(f"{ind}{ind}{ind}{ind}{ind}{ind}<ns3:hr>{int(point.heart_rate)}</ns3:hr>\n")
                if point.cadence:
                    fp.write(f"{ind}{ind}{ind}{ind}{ind}{ind}<ns3:cad>{point.cadence}</ns3:cad>\n")
                fp.write(f"{ind}{ind}{ind}{ind}{ind}</ns3:TrackPointExtension>\n")
                fp.write(f"{ind}{ind}{ind}{ind}</extensions>\n")
                fp.write(f"{ind}{ind}{ind}</trkpt>\n")
            fp.write(f"{ind}{ind}</trkseg>\n")
            fp.write(f"{ind}</trk>\n")
            fp.write("</gpx>")
