import io
import math
import xml.etree.ElementTree as ET
from collections import deque

import gpxpy
import fitparse

import core.config as cfg

SPEED_WINDOW_S = 15

_GPX_TYPE_MAP = {
    "hiking":                "senderismo",
    "trail hiking":          "senderismo",
    "mountaineering":        "senderismo",
    "mountain":              "senderismo",
    "trekking":              "senderismo",
    "walking":               "caminata",
    "casual walking":        "caminata",
    "speed walking":         "caminata",
    "running":               "correr",
    "trail running":         "correr",
    "street running":        "correr",
    "cycling":               "bicicleta",
    "biking":                "bicicleta",
    "mountain biking":       "bicicleta",
    "road cycling":          "bicicleta",
    "gravel cycling":        "bicicleta",
    "virtual cycling":       "bicicleta",
    "skiing":                "esqui",
    "alpine skiing":         "esqui",
    "nordic skiing":         "esqui",
    "cross country skiing":  "esqui",
    "snowboarding":          "esqui",
    "1":  "correr",
    "2":  "bicicleta",
    "11": "caminata",
    "12": "esqui",
    "13": "esqui",
    "14": "esqui",
    "16": "senderismo",
    "17": "senderismo",
}

_FIT_SPORT_MAP = {
    "running":               "correr",
    "trail":                 "correr",
    "cycling":               "bicicleta",
    "mountain_biking":       "bicicleta",
    "hiking":                "senderismo",
    "walking":               "caminata",
    "alpine_skiing":         "esqui",
    "cross_country_skiing":  "esqui",
    "nordic_skiing":         "esqui",
    "skiing":                "esqui",
    "snowboarding":          "esqui",
}

_SEMI = 180.0 / (2 ** 31)

_ACTIVITY_KEYWORDS = {
    "senderismo": [
        "senderismo", "sendero", "trekking", "trek", "excursión", "excursion",
        "montaña", "montana", "trail", "gr", "pr", "sl", "camino", "via", "travesia",
        "hiking", "hike", "mountaineering",
    ],
    "bicicleta": [
        "bicicleta", "bici", "ciclismo", "mtb", "mountain bike", "cycling",
        "bike", "cicloturismo", "gravel", "btt",
    ],
    "caminata": [
        "caminata", "caminando", "paseo", "pasear", "vuelta", "walk",
        "walking", "urbano", "ciudad", "rambla", "marcha",
    ],
    "correr": [
        "correr", "running", "carrera", "trail running", "maratón", "maraton",
        "media maratón", "10k", "5k", "fondo", "jogging",
    ],
    "esqui": [
        "esqui", "esquí", "ski", "skiing", "nieve", "snow",
        "pista", "slalom", "esquiando", "nordic",
    ],
    "otros": [],
}


def _hr_from_extensions(extensions):
    """Extrae FC (bpm) de extensiones de un trkpt GPX. Soporta Garmin, Amazfit y otros."""
    for ext in (extensions or []):
        for el in ext.iter():
            local = el.tag.split('}')[-1] if '}' in el.tag else el.tag
            if local.lower() == 'hr' and el.text:
                try:
                    v = int(float(el.text))
                    if 20 <= v <= 250:
                        return v
                except (ValueError, TypeError):
                    pass
    return None


def _gpx_type_lookup(gpx_type: str):
    """Resuelve tipo GPX a actividad fusionando mapa base con entradas personalizadas."""
    k = gpx_type.lower()
    return cfg._CUSTOM_GPX_TYPES.get(k) or _GPX_TYPE_MAP.get(k)


def _detect_activity(name: str):
    low = name.lower()
    for activity, keywords in _ACTIVITY_KEYWORDS.items():
        if any(kw in low for kw in keywords):
            return activity
    for kw, activity in cfg._CUSTOM_GPX_TYPES.items():
        if kw in low:
            return activity
    return None


def analyse_gpx(text):
    """Parsea texto GPX. Devuelve (stats, coords, elev_profile, name, creator)."""
    gpx = gpxpy.parse(text)

    coords = []
    elev_profile = []
    hr_profile = []
    speed_profile = []
    # Velocidad instantánea punto a punto (a menudo con 1s entre puntos) es puro
    # ruido de GPS; se suaviza con una ventana móvil de SPEED_WINDOW_S segundos,
    # igual que hacen Garmin/Strava, en vez de derivar cada par de puntos consecutivos.
    speed_hist = deque()  # (time, cum_dist_m)
    cum = 0.0
    for track in gpx.tracks:
        for seg in track.segments:
            prev = None
            for p in seg.points:
                coords.append([p.longitude, p.latitude])
                if prev is not None:
                    cum += prev.distance_3d(p) or 0.0
                if p.time:
                    speed_hist.append((p.time, cum))
                    while speed_hist and (p.time - speed_hist[0][0]).total_seconds() > SPEED_WINDOW_S:
                        speed_hist.popleft()
                    if len(speed_hist) >= 2:
                        t0, d0 = speed_hist[0]
                        dt_s = (p.time - t0).total_seconds()
                        if dt_s > 0:
                            speed_profile.append({"d": round(cum / 1000, 3),
                                                  "v": round(((cum - d0) / dt_s) * 3.6, 2)})
                if p.elevation is not None:
                    elev_profile.append({"d": round(cum / 1000, 3),
                                         "e": round(p.elevation, 1)})
                hr = _hr_from_extensions(p.extensions) if p.extensions else None
                if hr is not None:
                    hr_profile.append({"d": round(cum / 1000, 3), "hr": hr})
                prev = p

    up, down = gpx.get_uphill_downhill()
    moving = gpx.get_moving_data()
    ele_ext = gpx.get_elevation_extremes()
    bounds = gpx.get_time_bounds()
    length = gpx.length_3d() or gpx.length_2d() or 0.0

    duration = None
    started = None
    if bounds.start_time and bounds.end_time:
        duration = (bounds.end_time - bounds.start_time).total_seconds()
        started = bounds.start_time.isoformat()

    moving_s = moving.moving_time if moving else None
    avg_speed = None
    if moving_s and moving_s > 0:
        avg_speed = (length / moving_s) * 3.6

    stats = {
        "distance_m": round(length, 1),
        "ascent_m":   round(up or 0, 1),
        "descent_m":  round(down or 0, 1),
        "duration_s": duration,
        "moving_s":   moving_s,
        "ele_min": round(ele_ext.minimum, 1) if ele_ext and ele_ext.minimum is not None else None,
        "ele_max": round(ele_ext.maximum, 1) if ele_ext and ele_ext.maximum is not None else None,
        "avg_speed":  round(avg_speed, 2) if avg_speed else None,
        "started_at": started,
    }

    name = ""
    gpx_type = None
    if gpx.tracks:
        if gpx.tracks[0].name:
            name = gpx.tracks[0].name
        if gpx.tracks[0].type:
            gpx_type = gpx.tracks[0].type.strip()

    # gpxpy 1.6.x no lee <type> con namespace; fallback con ET
    if not gpx_type:
        try:
            root = ET.fromstring(text)
            ns = root.tag.split("}")[0].lstrip("{") if "}" in root.tag else ""
            p = "{" + ns + "}" if ns else ""
            trk = root.find(f"{p}trk")
            if trk is not None:
                t_el = trk.find(f"{p}type")
                if t_el is not None and t_el.text:
                    gpx_type = t_el.text.strip()
        except Exception:
            pass

    if gpx_type:
        stats["_gpx_type"] = gpx_type
    if hr_profile:
        hrs = [p["hr"] for p in hr_profile]
        stats["hr_avg"] = round(sum(hrs) / len(hrs))
        stats["hr_max"] = max(hrs)
    stats["_hr_profile"] = hr_profile
    stats["_speed_profile"] = speed_profile

    creator = (gpx.creator or "").strip() or None
    return stats, coords, elev_profile, name, creator


def analyse_fit(data: bytes):
    """Parsea FIT binario. Devuelve la misma tupla que analyse_gpx."""
    fitfile = fitparse.FitFile(io.BytesIO(data))

    coords = []
    elev_profile = []
    hr_profile = []
    speed_profile = []

    name = ""
    creator = None
    started_at = None

    total_distance = total_ascent = total_descent = None
    total_elapsed = total_moving = None
    ele_min = ele_max = avg_speed_ms = None
    fit_sport = None

    for msg in fitfile.get_messages():
        mname = msg.name

        if mname == "file_id":
            mfr = msg.get_value("manufacturer")
            prod = msg.get_value("product_name") or msg.get_value("product")
            if mfr:
                creator = (f"{mfr} {prod}" if prod else str(mfr)).strip()

        elif mname == "sport":
            sport = msg.get_value("sport")
            if sport:
                fit_sport = str(sport).lower()

        elif mname == "session":
            total_distance = msg.get_value("total_distance")
            total_ascent   = msg.get_value("total_ascent")
            total_descent  = msg.get_value("total_descent")
            total_elapsed  = msg.get_value("total_elapsed_time")
            total_moving   = msg.get_value("total_timer_time")
            avg_speed_ms   = msg.get_value("avg_speed")
            ele_min = msg.get_value("enhanced_min_altitude") or msg.get_value("min_altitude")
            ele_max = msg.get_value("enhanced_max_altitude") or msg.get_value("max_altitude")
            ts = msg.get_value("start_time")
            if ts and started_at is None:
                started_at = ts.isoformat()
            if not fit_sport:
                sport = msg.get_value("sport")
                if sport:
                    fit_sport = str(sport).lower()

        elif mname == "record":
            lat_sc = msg.get_value("position_lat")
            lon_sc = msg.get_value("position_long")
            ele    = msg.get_value("enhanced_altitude") or msg.get_value("altitude")
            dist   = msg.get_value("distance")
            hr     = msg.get_value("heart_rate")
            spd    = msg.get_value("enhanced_speed")
            if spd is None:
                spd = msg.get_value("speed")
            ts     = msg.get_value("timestamp")

            if lat_sc is not None and lon_sc is not None:
                lat = lat_sc * _SEMI
                lon = lon_sc * _SEMI
                coords.append([lon, lat])
                if ele is not None and dist is not None:
                    elev_profile.append({"d": round(dist / 1000, 3),
                                         "e": round(float(ele), 1)})
                if ts and started_at is None:
                    started_at = ts.isoformat()
            if hr is not None and dist is not None:
                hr_profile.append({"d": round(dist / 1000, 3), "hr": int(hr)})
            if spd is not None and dist is not None:
                speed_profile.append({"d": round(dist / 1000, 3),
                                      "v": round(float(spd) * 3.6, 2)})

    if fit_sport and not name:
        name = fit_sport.replace("_", " ").title()

    if total_distance is None and coords:
        total_distance = (elev_profile[-1]["d"] * 1000) if elev_profile else 0.0

    avg_speed = round(avg_speed_ms * 3.6, 2) if avg_speed_ms else None

    stats = {
        "distance_m": round(float(total_distance), 1) if total_distance else 0.0,
        "ascent_m":   round(float(total_ascent),   1) if total_ascent   else 0.0,
        "descent_m":  round(float(total_descent),  1) if total_descent  else 0.0,
        "duration_s": float(total_elapsed)  if total_elapsed  else None,
        "moving_s":   float(total_moving)   if total_moving   else None,
        "ele_min":    round(float(ele_min),  1) if ele_min is not None else None,
        "ele_max":    round(float(ele_max),  1) if ele_max is not None else None,
        "avg_speed":  avg_speed,
        "started_at": started_at,
    }
    if fit_sport:
        stats["_fit_sport"] = fit_sport
    if hr_profile:
        hrs = [p["hr"] for p in hr_profile]
        stats["hr_avg"] = round(sum(hrs) / len(hrs))
        stats["hr_max"] = max(hrs)
    stats["_hr_profile"] = hr_profile
    stats["_speed_profile"] = speed_profile

    return stats, coords, elev_profile, name, creator
