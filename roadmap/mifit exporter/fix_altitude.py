"""
Re-exports already-downloaded GPX files with the fixed altitude logic
(accumulate() applied to altitude deltas, same as lat/lon).

The Mi Fit API stores altitude as incremental deltas, not absolute values.
The previous exporter was missing accumulate() on altitude, causing flat or
negative altitude readings. This script re-fetches only workouts that were
already exported and overwrites them with the corrected data.

Usage:
    uv run fix_altitude.py -o ./mis_gpx [-t TOKEN] [-e ENDPOINT]
"""

import argparse
import logging
import math
from datetime import datetime
from pathlib import Path

from src.api import Api
from src.auth import get_app_token
from src.exporters.base_exporter import parse_points
from src.exporters.gpx_exporter import GpxExporter
from src.scraper import Scraper

LOGGER = logging.getLogger(__name__)

FILENAME_FORMAT = "Workout--%Y-%m-%d--%H-%M-%S"


def existing_trackids(output_dir: Path) -> set[int]:
    trackids = set()
    for gpx_file in output_dir.glob("Workout--*.gpx"):
        try:
            dt = datetime.strptime(gpx_file.stem, FILENAME_FORMAT)
            trackids.add(int(dt.timestamp()))
        except ValueError:
            LOGGER.warning(f"Could not parse date from filename: {gpx_file.name}")
    return trackids


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    ap = argparse.ArgumentParser(description="Fix altitude in already-exported GPX files")
    ap.add_argument("-e", "--endpoint", default="https://api-mifit.huami.com")
    ap.add_argument("-t", "--token", help="A valid application token")
    ap.add_argument("-o", "--output-directory", default="./workouts", type=Path)
    args = vars(ap.parse_args())

    if not args["token"]:
        args["token"] = get_app_token()

    if not args["token"]:
        LOGGER.error("No token provided. Use -t TOKEN or let the auth flow run.")
        raise SystemExit(1)

    output_dir: Path = args["output_directory"]
    if not output_dir.exists():
        LOGGER.error(f"Output directory does not exist: {output_dir}")
        raise SystemExit(1)

    api = Api(args["endpoint"], args["token"])
    exporter = GpxExporter()

    trackids = existing_trackids(output_dir)
    LOGGER.info(f"Found {len(trackids)} existing GPX files in {output_dir}")

    scraper = Scraper(api, exporter, output_dir, "gpx", -math.inf, math.inf)
    all_summaries = scraper.fetch_workout_summaries()

    to_fix = [s for s in all_summaries if int(s.trackid) in trackids]
    LOGGER.info(f"Matched {len(to_fix)} workouts — re-exporting with fixed altitude")

    fixed = 0
    skipped = 0
    for summary in to_fix:
        detail = api.get_workout_detail(summary)
        points = parse_points(summary, detail.data)

        if not points:
            LOGGER.warning(f"Skipping {summary.trackid}: no GPS points")
            skipped += 1
            continue

        file_name = datetime.fromtimestamp(int(summary.trackid)).strftime(FILENAME_FORMAT)
        output_path = output_dir / f"{file_name}.gpx"
        exporter.export(output_path, summary, points)
        LOGGER.info(f"Fixed: {output_path.name}")
        fixed += 1

    LOGGER.info(f"Done — {fixed} fixed, {skipped} skipped")
