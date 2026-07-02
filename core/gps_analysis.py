"""Detección de tramos GPS incorrectos: picos de elevación imposibles en poco
tiempo (fallo de GPS/barómetro) y velocidades irreales para el tipo de actividad.

Función pura, sin Flask ni acceso a BD. Consume el mismo formato de puntos que
devuelve extract_points() en core/editing.py — arrays paralelos lonlat/ele/time,
1:1 por índice — para que sea directamente reutilizable desde el editor de rutas
sin volver a parsear nada. Ver roadmap/logicaGPXincorrectos.md para el contrato
de integración completo.
"""
import datetime as dt
import math

import core.config as cfg


def _haversine_m(lon1, lat1, lon2, lat2):
    R = 6371000
    r = math.pi / 180
    dla = (lat2 - lat1) * r
    dlo = (lon2 - lon1) * r
    a = math.sin(dla / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _parse_time(t):
    if not t:
        return None
    try:
        return dt.datetime.fromisoformat(t)
    except (ValueError, TypeError):
        return None


def detect_gps_anomalies(lonlat, ele, time, activity_type=None, thresholds=None):
    """Detecta tramos con velocidad, subida/bajada o altitud imposibles.

    lonlat: list[[lon, lat]], obligatorio (longitud n).
    ele:    list[float|None] alineado con lonlat, o None si el track no tiene
            elevación en ningún punto (mismo contrato que extract_points()).
    time:   list[str ISO8601|None] alineado con lonlat, o None si no hay
            timestamps en ningún punto. Sin tiempo no hay velocidad ni tasa
            vertical, pero la altitud máxima se comprueba igualmente.
    activity_type: clave de core.config.DEFAULT_GPS_THRESHOLDS; cualquier valor
            desconocido (incluido None) cae en 'otros'.
    thresholds: dict {"max_speed_kmh", "max_vert_rate_ms", "max_ele_m"} para
            forzar unos umbrales concretos; si no se pasa, se resuelven con
            core.config.gps_thresholds_for(activity_type) (ajustes guardados,
            con fallback a los valores por defecto).

    Devuelve list[dict], ordenada por d_from (distancia acumulada en km):
        {"type": "speed"|"elevation"|"altitude", "d_from": float, "d_to": float,
         "value_max": float, "threshold": float, "severity": "medium"|"high"}
    Tramos contiguos del mismo tipo se funden en un único rango.
    """
    n = len(lonlat)
    if n < 2:
        return []
    th = thresholds or cfg.gps_thresholds_for(activity_type)
    max_speed = th.get("max_speed_kmh") or 40
    max_vert = th.get("max_vert_rate_ms") or 5
    # .get: los umbrales guardados antes de existir max_ele_m no lo traen
    max_ele = th.get("max_ele_m")

    times = [_parse_time(t) for t in time] if time else None
    flags = []
    cum_m = 0.0
    d_prev = 0.0
    if max_ele and ele and ele[0] is not None and ele[0] > max_ele:
        flags.append((0.0, 0.0, "altitude", ele[0]))
    for i in range(1, n):
        lon1, lat1 = lonlat[i - 1]
        lon2, lat2 = lonlat[i]
        dist_m = _haversine_m(lon1, lat1, lon2, lat2)
        cum_m += dist_m
        d_cur = cum_m / 1000
        if max_ele and ele and ele[i] is not None and ele[i] > max_ele:
            flags.append((d_prev, d_cur, "altitude", ele[i]))
        if times:
            t0, t1 = times[i - 1], times[i]
            if t0 is not None and t1 is not None:
                dt_s = (t1 - t0).total_seconds()
                if dt_s > 0:
                    speed_kmh = (dist_m / 1000) / (dt_s / 3600)
                    if speed_kmh > max_speed:
                        flags.append((d_prev, d_cur, "speed", speed_kmh))
                    if ele and ele[i - 1] is not None and ele[i] is not None:
                        vert_rate = abs(ele[i] - ele[i - 1]) / dt_s
                        if vert_rate > max_vert:
                            flags.append((d_prev, d_cur, "elevation", vert_rate))
        d_prev = d_cur
    return _merge_flags(flags, {"speed": max_speed, "elevation": max_vert,
                                "altitude": max_ele})


def _merge_flags(flags, thresholds_by_type):
    by_type = {}
    for d_from, d_to, typ, val in flags:
        by_type.setdefault(typ, []).append((d_from, d_to, val))
    out = []
    for typ, ranges in by_type.items():
        ranges.sort(key=lambda r: r[0])
        threshold = thresholds_by_type.get(typ)
        cur_from, cur_to, cur_max = ranges[0]
        for d_from, d_to, val in ranges[1:]:
            if d_from <= cur_to + 1e-9:
                cur_to = max(cur_to, d_to)
                cur_max = max(cur_max, val)
            else:
                out.append(_issue(typ, cur_from, cur_to, cur_max, threshold))
                cur_from, cur_to, cur_max = d_from, d_to, val
        out.append(_issue(typ, cur_from, cur_to, cur_max, threshold))
    out.sort(key=lambda x: x["d_from"])
    return out


def _issue(typ, d_from, d_to, value_max, threshold):
    ratio = value_max / threshold if threshold else 2
    return {
        "type": typ,
        "d_from": round(d_from, 3),
        "d_to": round(d_to, 3),
        "value_max": round(value_max, 2),
        "threshold": threshold,
        "severity": "high" if ratio >= 2 else "medium",
    }
