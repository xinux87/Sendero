"""Lógica pura del editor de rutas (sin Flask).

Principio central: el cliente manda OPERACIONES por índice de punto, nunca
coordenadas. Aquí se aplican sobre los objetos GPXTrackPoint reales del archivo
original (que conservan time, extensiones HR y atributos que el parser de
Sendero no extrae), y se serializa de vuelta con gpxpy.

El orden de aplanado punto[i] ↔ i-ésimo trkpt es el mismo triple bucle
tracks → segments → points que usa analyse_gpx() en core/parsers.py; mientras
ambos iteren igual, los índices del cliente (que trabaja sobre el geojson
completo) referencian exactamente el mismo punto.
"""
import io
import datetime as dt
import xml.etree.ElementTree as ET

import gpxpy
import gpxpy.gpx
import fitparse

from core.parsers import _hr_from_extensions, _SEMI

_GPXTPX_NS = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"


class EditError(ValueError):
    """Operación de edición inválida; el mensaje va al usuario (en español)."""


def load_gpx(raw: bytes, is_fit: bool):
    """Bytes del archivo activo → objeto gpxpy (materializando el FIT si toca)."""
    if is_fit:
        return fit_to_gpx(raw)
    return gpxpy.parse(raw.decode("utf-8", errors="replace"))


def fit_to_gpx(raw: bytes):
    """Materializa un FIT como objeto gpxpy con time/ele/HR por punto.

    Itera los mensajes 'record' en el mismo orden y con la misma condición
    (lat y lon presentes) que analyse_fit(), para que los índices del editor
    coincidan punto a punto. El HR va en la extensión Garmin
    gpxtpx:TrackPointExtension — el mismo formato que ya lee
    _hr_from_extensions(), garantizando el round-trip al re-analizar.
    """
    fitfile = fitparse.FitFile(io.BytesIO(raw))
    gpx = gpxpy.gpx.GPX()
    gpx.creator = "Sendero"
    gpx.nsmap["gpxtpx"] = _GPXTPX_NS

    track = gpxpy.gpx.GPXTrack()
    seg = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(seg)
    gpx.tracks.append(track)

    fit_sport = None
    creator = None
    for msg in fitfile.get_messages():
        if msg.name == "file_id":
            mfr = msg.get_value("manufacturer")
            prod = msg.get_value("product_name") or msg.get_value("product")
            if mfr:
                creator = (f"{mfr} {prod}" if prod else str(mfr)).strip()
        elif msg.name in ("sport", "session") and not fit_sport:
            sport = msg.get_value("sport")
            if sport:
                fit_sport = str(sport).lower()
        elif msg.name == "record":
            lat_sc = msg.get_value("position_lat")
            lon_sc = msg.get_value("position_long")
            if lat_sc is None or lon_sc is None:
                continue
            p = gpxpy.gpx.GPXTrackPoint(
                latitude=lat_sc * _SEMI,
                longitude=lon_sc * _SEMI,
                elevation=msg.get_value("enhanced_altitude") or msg.get_value("altitude"),
                time=msg.get_value("timestamp"),
            )
            hr = msg.get_value("heart_rate")
            if hr is not None:
                ext = ET.Element(f"{{{_GPXTPX_NS}}}TrackPointExtension")
                hr_el = ET.SubElement(ext, f"{{{_GPXTPX_NS}}}hr")
                hr_el.text = str(int(hr))
                p.extensions.append(ext)
            seg.points.append(p)

    if creator:
        gpx.creator = creator
    if fit_sport:
        track.type = fit_sport
        track.name = fit_sport.replace("_", " ").title()
    return gpx


def extract_points(gpx):
    """Arrays paralelos 1:1 con los trkpt aplanados, para el editor.

    Devuelve {n, segments, lonlat, ele, time, hr}. Los arrays sin ningún valor
    en todo el track van como None (no se serializan 50k nulls). `segments` son
    rangos inclusivos [ini, fin] de índices aplanados por segmento.
    """
    lonlat, ele, time, hr = [], [], [], []
    segments = []
    for track in gpx.tracks:
        for seg in track.segments:
            if not seg.points:
                continue
            start = len(lonlat)
            for p in seg.points:
                lonlat.append([p.longitude, p.latitude])
                ele.append(round(p.elevation, 1) if p.elevation is not None else None)
                time.append(p.time.isoformat() if p.time else None)
                hr.append(_hr_from_extensions(p.extensions) if p.extensions else None)
            segments.append([start, len(lonlat) - 1])
    waypoints = [{
        "lon": w.longitude, "lat": w.latitude,
        "name": w.name or "",
        "ele": round(w.elevation, 1) if w.elevation is not None else None,
    } for w in gpx.waypoints]
    return {
        "n": len(lonlat),
        "segments": segments,
        "lonlat": lonlat,
        "ele": ele if any(e is not None for e in ele) else None,
        "time": time if any(t is not None for t in time) else None,
        "hr": hr if any(h is not None for h in hr) else None,
        "waypoints": waypoints,
    }


def _flatten(gpx):
    """Lista de [seg_key, GPXTrackPoint] en orden de aplanado. seg_key identifica
    la tira contigua a la que pertenece el punto al reconstruir."""
    flat = []
    key = 0
    for track in gpx.tracks:
        for seg in track.segments:
            if not seg.points:
                continue
            for p in seg.points:
                flat.append([key, p])
            key += 1
    return flat


def apply_ops(gpx, ops):
    """Aplica la secuencia de ops sobre el gpx y devuelve (xml, resumen_auto, n_final).

    Las ops se aplican secuencialmente: los índices de cada una se refieren al
    estado resultante de las anteriores (misma semántica que registró el cliente).
    Lanza EditError con mensaje en español si algo no valida.

    Ops F1: delete_range{start,end} · reverse{}
    Ops F2: move_point{i,lon,lat[,ele]} · insert_point{after,lon,lat} ·
            delete_points{indices:[…]} · set_ele{items:[[i,e],…]}
    Ops F3: shift_time{seconds} · wpt_add{lon,lat,name} · wpt_move{i,lon,lat} ·
            wpt_rename{i,name} · wpt_del{i}  (índices sobre gpx.waypoints en ese
            momento de la secuencia, misma semántica que los puntos)
    """
    flat = _flatten(gpx)
    next_key = (max((k for k, _ in flat), default=-1)) + 1
    parts = []
    moved = inserted = deleted_pts = ele_fixed = 0
    wpt_added = wpt_edited = wpt_deleted = 0

    for op in ops:
        kind = op.get("op")
        n = len(flat)
        if kind == "delete_range":
            try:
                start, end = int(op["start"]), int(op["end"])
            except (KeyError, TypeError, ValueError):
                raise EditError("Operación delete_range mal formada")
            if not (0 <= start <= end < n):
                raise EditError(f"Rango fuera de límites: {start}–{end} (la ruta tiene {n} puntos)")
            removed = end - start + 1
            # Si el rango es interior a una tira, la cola pasa a una tira nueva:
            # el hueco parte el segmento en dos (no se fabrica distancia en línea
            # recta sobre él; gpxpy lo trata como pausa).
            if start > 0 and end < n - 1 and flat[start - 1][0] == flat[end + 1][0]:
                broken = flat[end + 1][0]
                for item in flat[end + 1:]:
                    if item[0] != broken:
                        break
                    item[0] = next_key
                next_key += 1
            del flat[start:end + 1]
            if start == 0:
                parts.append(f"Recortados {removed} puntos del inicio")
            elif end == n - 1:
                parts.append(f"Recortados {removed} puntos del final")
            else:
                parts.append(f"Eliminado un tramo intermedio de {removed} puntos")
        elif kind == "reverse":
            flat.reverse()
            # Timestamps descendentes serían inválidos; se eliminan (el frontend
            # avisa antes). started_at pasará a NULL al re-analizar.
            for _, p in flat:
                p.time = None
            parts.append("Invertida la ruta")
        elif kind == "move_point":
            try:
                i = int(op["i"])
                lon, lat = float(op["lon"]), float(op["lat"])
            except (KeyError, TypeError, ValueError):
                raise EditError("Operación move_point mal formada")
            if not (0 <= i < n):
                raise EditError(f"Índice fuera de límites: {i} (la ruta tiene {n} puntos)")
            p = flat[i][1]
            p.longitude, p.latitude = lon, lat
            if op.get("ele") is not None:
                p.elevation = float(op["ele"])
            moved += 1
        elif kind == "insert_point":
            try:
                after = int(op["after"])
                lon, lat = float(op["lon"]), float(op["lat"])
            except (KeyError, TypeError, ValueError):
                raise EditError("Operación insert_point mal formada")
            if not (0 <= after < n - 1):
                raise EditError(f"insert_point: 'after' fuera de límites ({after})")
            prev_p, next_p = flat[after][1], flat[after + 1][1]
            ele = None
            if prev_p.elevation is not None and next_p.elevation is not None:
                ele = round((prev_p.elevation + next_p.elevation) / 2, 1)
            # Sin time: inventar un timestamp intermedio falsearía el ritmo real.
            newp = gpxpy.gpx.GPXTrackPoint(latitude=lat, longitude=lon, elevation=ele)
            flat.insert(after + 1, [flat[after][0], newp])
            inserted += 1
        elif kind == "delete_points":
            idxs = op.get("indices")
            if not isinstance(idxs, list) or not idxs:
                raise EditError("Operación delete_points sin índices")
            try:
                idxs = sorted({int(i) for i in idxs}, reverse=True)
            except (TypeError, ValueError):
                raise EditError("Operación delete_points mal formada")
            if idxs[0] >= n or idxs[-1] < 0:
                raise EditError(f"delete_points: índice fuera de límites (la ruta tiene {n} puntos)")
            # Puntos sueltos (simplificación, Alt+click): NO parten el segmento —
            # los supervivientes conservan su tira.
            for i in idxs:
                del flat[i]
            deleted_pts += len(idxs)
        elif kind == "set_ele":
            items = op.get("items")
            if not isinstance(items, list) or not items:
                raise EditError("Operación set_ele sin items")
            for it in items:
                try:
                    i, e = int(it[0]), float(it[1])
                except (TypeError, ValueError, IndexError):
                    raise EditError("Operación set_ele mal formada")
                if not (0 <= i < n):
                    raise EditError(f"set_ele: índice fuera de límites ({i})")
                flat[i][1].elevation = round(e, 1)
            ele_fixed += len(items)
        elif kind == "shift_time":
            try:
                seconds = float(op["seconds"])
            except (KeyError, TypeError, ValueError):
                raise EditError("Operación shift_time mal formada")
            delta = dt.timedelta(seconds=seconds)
            for _, p in flat:
                if p.time:
                    p.time = p.time + delta
            sign = "+" if seconds >= 0 else "−"
            s = abs(int(seconds))
            parts.append(f"Desplazados los tiempos {sign}{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}")
        elif kind == "wpt_add":
            try:
                lon, lat = float(op["lon"]), float(op["lat"])
            except (KeyError, TypeError, ValueError):
                raise EditError("Operación wpt_add mal formada")
            gpx.waypoints.append(gpxpy.gpx.GPXWaypoint(
                latitude=lat, longitude=lon, name=(op.get("name") or "").strip() or None))
            wpt_added += 1
        elif kind in ("wpt_move", "wpt_rename", "wpt_del"):
            try:
                wi = int(op["i"])
            except (KeyError, TypeError, ValueError):
                raise EditError(f"Operación {kind} mal formada")
            if not (0 <= wi < len(gpx.waypoints)):
                raise EditError(f"{kind}: waypoint fuera de límites ({wi})")
            if kind == "wpt_move":
                try:
                    gpx.waypoints[wi].longitude = float(op["lon"])
                    gpx.waypoints[wi].latitude = float(op["lat"])
                except (KeyError, TypeError, ValueError):
                    raise EditError("Operación wpt_move mal formada")
                wpt_edited += 1
            elif kind == "wpt_rename":
                gpx.waypoints[wi].name = (op.get("name") or "").strip() or None
                wpt_edited += 1
            else:
                del gpx.waypoints[wi]
                wpt_deleted += 1
        else:
            raise EditError(f"Operación desconocida: {kind!r}")

    if len(flat) < 2:
        raise EditError("La edición dejaría la ruta con menos de 2 puntos")

    if moved:
        parts.append(f"Movido{'s' if moved != 1 else ''} {moved} punto{'s' if moved != 1 else ''}")
    if inserted:
        parts.append(f"Añadido{'s' if inserted != 1 else ''} {inserted} punto{'s' if inserted != 1 else ''}")
    if deleted_pts:
        parts.append(f"Eliminado{'s' if deleted_pts != 1 else ''} {deleted_pts} punto{'s' if deleted_pts != 1 else ''} sueltos")
    if ele_fixed:
        parts.append(f"Corregida la elevación de {ele_fixed} punto{'s' if ele_fixed != 1 else ''}")
    if wpt_added:
        parts.append(f"Añadido{'s' if wpt_added != 1 else ''} {wpt_added} waypoint{'s' if wpt_added != 1 else ''}")
    if wpt_edited:
        parts.append(f"Editado{'s' if wpt_edited != 1 else ''} {wpt_edited} waypoint{'s' if wpt_edited != 1 else ''}")
    if wpt_deleted:
        parts.append(f"Eliminado{'s' if wpt_deleted != 1 else ''} {wpt_deleted} waypoint{'s' if wpt_deleted != 1 else ''}")

    _rebuild_tracks(gpx, flat)
    return gpx.to_xml(), " · ".join(parts), len(flat)


def _rebuild_tracks(gpx, flat):
    """Sustituye los tracks del gpx por uno solo (metadatos del primero) con una
    tira de puntos por cada run contiguo de seg_key. waypoints y routes del GPX
    se conservan tal cual."""
    first = gpx.tracks[0] if gpx.tracks else None
    track = gpxpy.gpx.GPXTrack()
    if first is not None:
        track.name = first.name
        track.type = first.type
        track.description = first.description
    seg = None
    prev_key = object()
    for key, p in flat:
        if key != prev_key:
            seg = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(seg)
            prev_key = key
        seg.points.append(p)
    gpx.tracks = [track]
    return gpx


def split_track(gpx, index):
    """Divide el track en el punto `index` (compartido por ambas mitades).

    Devuelve (xml_a, xml_b): A = puntos 0..index reconstruidos sobre el gpx
    original (conserva metadatos y waypoints), B = puntos index..n-1 en un
    GPX nuevo.
    """
    flat = _flatten(gpx)
    n = len(flat)
    if not (1 <= index <= n - 2):
        raise EditError("El punto de corte debe dejar al menos 2 puntos a cada lado")

    gpx_b = gpxpy.gpx.GPX()
    gpx_b.creator = gpx.creator
    gpx_b.nsmap = dict(gpx.nsmap)  # imprescindible para serializar extensiones HR
    first = gpx.tracks[0] if gpx.tracks else None
    track_b = gpxpy.gpx.GPXTrack()
    if first is not None:
        track_b.type = first.type
    gpx_b.tracks = [track_b]
    seg = None
    prev_key = object()
    for key, p in flat[index:]:
        if key != prev_key:
            seg = gpxpy.gpx.GPXTrackSegment()
            track_b.segments.append(seg)
            prev_key = key
        seg.points.append(p)
    xml_b = gpx_b.to_xml()

    _rebuild_tracks(gpx, flat[:index + 1])
    return gpx.to_xml(), xml_b


def merge_gpx(gpxs):
    """Une varios gpx en uno nuevo. Devuelve (xml, times_kept).

    Si TODOS tienen timestamps, se ordenan cronológicamente; si aun así los
    rangos de tiempo se solapan, se eliminan todos los <time> (un track con
    tiempos no monótonos es inválido). Cada ruta de origen aporta sus segmentos
    tal cual (el hueco entre rutas queda como corte de segmento: no se fabrica
    distancia en línea recta). Los waypoints se conservan.
    """
    def bounds(g):
        b = g.get_time_bounds()
        return b.start_time, b.end_time

    bs = [bounds(g) for g in gpxs]
    have_times = all(s and e for s, e in bs)
    order = ([g for _, g in sorted(zip(bs, gpxs), key=lambda t: t[0][0])]
             if have_times else list(gpxs))
    times_kept = have_times
    if have_times:
        prev_end = None
        for g in order:
            s, e = bounds(g)
            if prev_end and s < prev_end:
                times_kept = False
                break
            prev_end = e

    merged = gpxpy.gpx.GPX()
    merged.creator = order[0].creator or "Sendero"
    nsmap = {}
    for g in order:
        nsmap.update(g.nsmap or {})
    merged.nsmap = nsmap

    first = order[0].tracks[0] if order[0].tracks else None
    track = gpxpy.gpx.GPXTrack()
    if first is not None:
        track.name = first.name
        track.type = first.type
    merged.tracks = [track]
    for g in order:
        for t in g.tracks:
            for seg in t.segments:
                if seg.points:
                    track.segments.append(seg)
        merged.waypoints.extend(g.waypoints)

    if not times_kept:
        for seg in track.segments:
            for p in seg.points:
                p.time = None
    if len(track.segments) == 0 or sum(len(s.points) for s in track.segments) < 2:
        raise EditError("Las rutas a unir no contienen puntos suficientes")
    return merged.to_xml(), times_kept
