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
import datetime as dt
import itertools
import math
from bisect import bisect_left, bisect_right
import xml.etree.ElementTree as ET

import gpxpy
import gpxpy.gpx

from core.parsers import _hr_from_extensions, _SEMI, _decode_fit, _fit_dt
from core.sync import decimate

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
    messages = _decode_fit(raw)
    gpx = gpxpy.gpx.GPX()
    gpx.creator = "Sendero"
    gpx.nsmap["gpxtpx"] = _GPXTPX_NS

    track = gpxpy.gpx.GPXTrack()
    seg = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(seg)
    gpx.tracks.append(track)

    fid = (messages.get("file_id_mesgs") or [{}])[0]
    mfr = fid.get("manufacturer")
    prod = fid.get("product_name") or fid.get("product")
    creator = (f"{mfr} {prod}" if prod else str(mfr)).strip() if mfr else None

    fit_sport = None
    for m in (messages.get("sport_mesgs") or []) + (messages.get("session_mesgs") or []):
        sport = m.get("sport")
        if sport:
            fit_sport = str(sport).lower()
            break

    for rec in messages.get("record_mesgs") or []:
        lat_sc = rec.get("position_lat")
        lon_sc = rec.get("position_long")
        if lat_sc is None or lon_sc is None:
            continue
        ele = rec.get("enhanced_altitude") or rec.get("altitude")
        p = gpxpy.gpx.GPXTrackPoint(
            latitude=lat_sc * _SEMI,
            longitude=lon_sc * _SEMI,
            # float(): el SDK devuelve int cuando la altitud es entera; fitparse
            # devolvía siempre float y el <ele> serializado debe seguir igual.
            elevation=float(ele) if ele is not None else None,
            time=_fit_dt(rec.get("timestamp")),
        )
        hr = rec.get("heart_rate")
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
    Ops F2: move_point{i,lon,lat[,ele]} · move_points{items:[[i,lon,lat[,ele]],…]} ·
            insert_point{after,lon,lat} · delete_points{indices:[…]} ·
            set_ele{items:[[i,e],…]}
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
        elif kind == "move_points":
            # Igual que move_point pero en lote, para que una corrección de cientos
            # de puntos (velocidad excesiva) sea UNA op: un solo paso de deshacer en
            # el cliente y una sola entrada en la lista de cambios pendientes.
            items = op.get("items")
            if not isinstance(items, list) or not items:
                raise EditError("Operación move_points sin items")
            for it in items:
                try:
                    i = int(it[0])
                    lon, lat = float(it[1]), float(it[2])
                    ele = float(it[3]) if len(it) > 3 and it[3] is not None else None
                except (TypeError, ValueError, IndexError):
                    raise EditError("Operación move_points mal formada")
                if not (0 <= i < n):
                    raise EditError(f"move_points: índice fuera de límites ({i})")
                p = flat[i][1]
                p.longitude, p.latitude = lon, lat
                if ele is not None:
                    p.elevation = round(ele, 1)
            moved += len(items)
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


# ── unión de tracks (smart_merge) ───────────────────────────────────────────
#
# Unir por concatenación ciega —pegar los segmentos de A y luego los de B, que
# es lo que se hacía hasta la v0.10.0— produce barbaridades en cuanto los tracks
# no vienen ya encarados. Con dos planes dibujados por trozos el resultado real
# fue: el segundo guardado al revés (línea recta enorme entre los dos finales),
# el trozo común de la costura duplicado y, en una circular, el final montado
# sobre el inicio.
#
# smart_merge() mira la GEOMETRÍA: orienta cada track, recorta el solape
# contiguo a la costura y decide si el hueco que queda se une en recta o se deja
# como corte de segmento. Nunca reconstruye puntos: reordena los GPXTrackPoint
# originales, así que <time>, HR y extensiones sobreviven intactos.

_EARTH_R = 6371008.8
_DEG_M = 111320.0          # metros por grado (proyección equirectangular local)
_LOOP_MIN_SEP_M = 200.0    # separación mínima A LO LARGO del track para que dos
                           # puntos cuenten como "el final montado sobre el inicio"
_LOOP_MAX_FRAC = 0.25      # …y hasta dónde puede llegar ese montaje (ver _close_loop)
_MIN_OVERLAP_PTS = 3       # un cruce suelto no es un solape…
_MIN_OVERLAP_TOL = 2.0     # …ni lo es algo más corto que 2·tol metros
_REPORT_MAX_PTS = 2000     # tope de puntos por traza del informe
_LITE_MAX_PTS = 300        # …y por traza de una propuesta NO elegida
_JUNCTION_MARGIN = 3.0     # una junta interior queda a >3·tol de los extremos
_MAX_PROPOSALS = 5         # cuántas propuestas se devuelven
_MAX_CHAIN = 8             # piezas encadenadas como mucho (freno del DFS)
_MAX_CHAINS = 400          # candidatos que explora el DFS antes de rendirse
_MAX_JUNCTIONS = 4         # juntas por track (freno de la enumeración)
_MAX_INPUTS = 8            # entradas por unión (la vista `unir` deja elegir 6)
_DETOUR_MIN_M = 500.0      # …y cuánto tienen que separarse dos tracks para que
                           # cuente como que se han separado (ver _overlap_runs)
_JUNCTION_MERGE_M = 250.0  # dos juntas más cerca que esto son la misma junta


def _hav_m(lon1, lat1, lon2, lat2):
    """Distancia haversine en metros (para los huecos, que pueden ser de km)."""
    p = math.pi / 180.0
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * _EARTH_R * math.asin(min(1.0, math.sqrt(a)))


def _pt_seg_dist(px, py, x0, y0, x1, y1):
    """Distancia (en el plano proyectado) de un punto al TRAMO x0y0–x1y1."""
    dx, dy = x1 - x0, y1 - y0
    l2 = dx * dx + dy * dy
    if l2 <= 0.0:
        return math.hypot(px - x0, py - y0)
    t = ((px - x0) * dx + (py - y0) * dy) / l2
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))


class _Poly:
    """Polilínea proyectada a metros con índice de rejilla de sus TRAMOS.

    La distancia de un punto a la traza tiene que costar O(1): comparar dos
    tracks de 20 000 puntos todos contra todos son 4·10⁸ operaciones en Python
    puro. Cada tramo se siembra en las celdas por las que pasa (muestreado cada
    media celda), así que una consulta mira 3×3 celdas y unos pocos tramos, y
    todo el proceso queda en O(n+m).

    La celda mide 2·tol y el muestreo tol: así, cualquier tramo a ≤ tol del punto
    consultado tiene una muestra a ≤ 1,5·tol, y 3×3 celdas de 2·tol cubren
    siempre esa distancia. La distancia final se calcula punto→tramo (no
    punto→vértice), para que un track poco denso no se escape.
    """

    def __init__(self, pts, breaks, cos_lat, cell_m):
        self.pts = pts
        self.n = len(pts)
        self.cos = cos_lat
        self.x = [p.longitude * _DEG_M * cos_lat for p in pts]
        self.y = [p.latitude * _DEG_M for p in pts]
        cum = [0.0] * self.n
        for i in range(1, self.n):
            cum[i] = cum[i - 1] + math.hypot(self.x[i] - self.x[i - 1],
                                             self.y[i] - self.y[i - 1])
        self.cum = cum
        self.cell = max(float(cell_m), 1.0)
        self.breaks = breaks
        self.minx, self.maxx = min(self.x), max(self.x)
        self.miny, self.maxy = min(self.y), max(self.y)
        # La rejilla se siembra en la primera consulta, no aquí: sembrar dos
        # tracks de 20 000 puntos cuesta más que la unión entera, y hay caminos
        # (ver `near_bbox`) que ni siquiera llegan a preguntar.
        self.grid = None

    def _build(self):
        self.grid = {}
        step = self.cell / 2.0
        for i in range(self.n - 1):
            if (i + 1) in self.breaks:
                continue                     # corte de segmento: ese tramo no existe
            self._sow(i, step)

    def near_bbox(self, lon, lat, margin):
        """¿Puede este punto estar a ≤ margin de la traza? (descarte barato)"""
        x = lon * _DEG_M * self.cos
        y = lat * _DEG_M
        return (self.minx - margin <= x <= self.maxx + margin
                and self.miny - margin <= y <= self.maxy + margin)

    def _sow(self, i, step):
        x0, y0 = self.x[i], self.y[i]
        dx, dy = self.x[i + 1] - x0, self.y[i + 1] - y0
        k = min(int(math.hypot(dx, dy) / step) + 1, 4000)
        c = self.cell
        g = self.grid
        for s in range(k + 1):
            t = s / k
            key = (int((x0 + dx * t) // c), int((y0 + dy * t) // c))
            cell = g.get(key)
            if cell is None:
                g[key] = cell = set()
            cell.add(i)

    def dist(self, lon, lat, lo=0, hi=None):
        """Distancia (m) del punto a los tramos contenidos en los puntos [lo,hi)."""
        if self.grid is None:
            self._build()
        hi = self.n if hi is None else hi
        x = lon * _DEG_M * self.cos
        y = lat * _DEG_M
        c = self.cell
        cx, cy = int(x // c), int(y // c)
        best = float("inf")
        seen = set()
        g = self.grid
        top = hi - 2
        for ax in (cx - 1, cx, cx + 1):
            for ay in (cy - 1, cy, cy + 1):
                cell = g.get((ax, ay))
                if not cell:
                    continue
                for i in cell:
                    if i < lo or i > top or i in seen:
                        continue
                    seen.add(i)
                    d = _pt_seg_dist(x, y, self.x[i], self.y[i],
                                     self.x[i + 1], self.y[i + 1])
                    if d < best:
                        best = d
        return best

    def nearest(self, lon, lat, lo=0, hi=None):
        """(distancia, índice de VÉRTICE) del punto más cercano de la traza.

        Lo mismo que dist(), pero devolviendo además dónde cae: es lo que
        convierte «el inicio de B pasa por A» en «…por el punto 189 de A», que
        es la junta por la que hay que partir A.
        """
        if self.grid is None:
            self._build()
        hi = self.n if hi is None else hi
        x = lon * _DEG_M * self.cos
        y = lat * _DEG_M
        c = self.cell
        cx, cy = int(x // c), int(y // c)
        best, best_i = float("inf"), -1
        seen = set()
        g = self.grid
        top = hi - 2
        for ax in (cx - 1, cx, cx + 1):
            for ay in (cy - 1, cy, cy + 1):
                cell = g.get((ax, ay))
                if not cell:
                    continue
                for i in cell:
                    if i < lo or i > top or i in seen:
                        continue
                    seen.add(i)
                    d = _pt_seg_dist(x, y, self.x[i], self.y[i],
                                     self.x[i + 1], self.y[i + 1])
                    if d < best:
                        d0 = math.hypot(x - self.x[i], y - self.y[i])
                        d1 = math.hypot(x - self.x[i + 1], y - self.y[i + 1])
                        best, best_i = d, (i if d0 <= d1 else i + 1)
        return best, best_i


def _flat_entry(gpx):
    """(puntos, cortes) de un GPX con el MISMO triple bucle que analyse_gpx().

    `cortes` son los índices que ABREN un segmento nuevo: entre ese punto y el
    anterior no hay tramo (es una pausa, no una línea recta).
    """
    pts, breaks = [], set()
    for track in gpx.tracks:
        for seg in track.segments:
            if not seg.points:
                continue
            if pts:
                breaks.add(len(pts))
            pts.extend(seg.points)
    return pts, breaks


class _Unit:
    """Una PIEZA colocable de la unión: un trozo contiguo de una entrada.

    Sin costuras interiores hay exactamente una unidad por entrada, que es el
    caso de siempre (y entonces todo lo de las propuestas se queda quieto). Si
    un extremo de otra entrada cae sobre un punto INTERIOR de ésta, la entrada
    se parte ahí y cada trozo pasa a ser una pieza que el ensamblado puede
    colocar por separado y en cualquier sentido.

    Los puntos son los GPXTrackPoint ORIGINALES (no se copian ni se
    reconstruyen), así que <time>, HR y extensiones sobreviven a todo esto igual
    que antes. La junta es un vértice COMPARTIDO por las dos piezas: encadenar
    A(1ª) + A(2ª) vuelve a dar A exacta (el punto repetido se descarta al
    ensamblar).
    """

    __slots__ = ("uid", "src", "name", "ordinal", "of", "pts", "breaks",
                 "from_m", "to_m", "len_m", "poly")

    def __init__(self, uid, src, name, ordinal, of, pts, breaks, from_m, to_m,
                 poly=None):
        self.uid = uid            # índice en la lista de unidades
        self.src = src            # índice de la ENTRADA de la que sale
        self.name = name          # nombre de esa entrada
        self.ordinal = ordinal    # qué trozo es (0…of-1)
        self.of = of              # en cuántos se partió la entrada
        self.pts = pts
        self.breaks = breaks
        self.from_m = from_m      # posición a lo largo de la entrada original
        self.to_m = to_m
        self.len_m = to_m - from_m
        # El índice de la entrada ENTERA, cuando la pieza es la entrada entera:
        # así _Part no vuelve a sembrarlo (es lo caro de todo esto).
        self.poly = poly

    @property
    def whole(self):
        return self.of == 1

    def start(self, rev=False):
        return self.pts[-1] if rev else self.pts[0]

    def end(self, rev=False):
        return self.pts[0] if rev else self.pts[-1]


class _Part:
    """Una PIEZA de la unión, ya orientada, con su recorte por los extremos."""

    def __init__(self, unit, rev, cos_lat, cell_m):
        self.unit = unit
        self.idx = unit.uid        # índice de UNIDAD
        self.src = unit.src        # índice de la ENTRADA (lo que ve el informe)
        self.name = unit.name
        pts, breaks = unit.pts, set(unit.breaks)
        self.rev = rev
        n = len(pts)
        if rev:
            pts = list(reversed(pts))
            breaks = {n - b for b in breaks}
        self.pts = pts
        self.breaks = breaks
        self.poly = (unit.poly if not rev and unit.poly is not None
                     else _Poly(pts, breaks, cos_lat, cell_m))
        self.head = 0                      # puntos recortados por el inicio
        self.tail = 0                      # …y por el final

    # límites del trozo CONSERVADO, en índices de self.pts
    @property
    def lo(self):
        return self.head

    @property
    def hi(self):
        return len(self.pts) - self.tail

    @property
    def kept(self):
        return self.pts[self.lo:self.hi]

    def length_m(self):
        return self.poly.cum[self.hi - 1] - self.poly.cum[self.lo]

    def head_m(self):
        return self.poly.cum[self.head] - self.poly.cum[0] if self.head else 0.0

    def tail_m(self):
        n = len(self.pts)
        return self.poly.cum[n - 1] - self.poly.cum[n - 1 - self.tail] if self.tail else 0.0


def _overlap_run(src, idxs, dst, lo, hi, tol_m, limit_m):
    """Puntos consecutivos de `src` (recorridos en `idxs`) a ≤ tol de `dst`.

    Devuelve (n_puntos, metros_recorridos, excedido). Para en el primer punto
    fuera de tolerancia — el solape que interesa es el CONTIGUO a la costura, no
    cualquier repetición interior— y también en cuanto el solape supera
    `limit_m`, que es cuando deja de recortarse por la protección de ida y
    vuelta (así el caso peor no recorre los 20 000 puntos del track).
    """
    n, ov = 0, 0.0
    if not idxs:
        return 0, 0.0, False
    start = src.poly.cum[idxs[0]]
    for j in idxs:
        p = src.pts[j]
        if dst.poly.dist(p.longitude, p.latitude, lo, hi) > tol_m:
            break
        n += 1
        ov = abs(src.poly.cum[j] - start)
        if ov > limit_m:
            return n, ov, True
    return n, ov, False


def _valid_overlap(n_pts, ov_m, tol_m):
    """Un solape solo cuenta si tiene cuerpo: ≥3 puntos y ≥2·tol metros."""
    return n_pts >= _MIN_OVERLAP_PTS and ov_m >= _MIN_OVERLAP_TOL * tol_m


def _seam(a, b, tol_m, out_and_back_frac, trim):
    """Resuelve la costura A|B sin mutar nada.

    Devuelve (a_tail, b_head, gap_m, warnings): cuántos puntos habría que
    recortar de la cola de A y de la cabeza de B, y qué hueco queda después.
    """
    warns = []
    a_tail = b_head = 0
    if trim:
        limit = out_and_back_frac * min(a.length_m(), b.length_m())
        # (a) la cabeza de B que ya recorre A
        k, ov_b, over = _overlap_run(b, list(range(b.lo, b.hi)), a, a.lo, a.hi,
                                     tol_m, limit)
        k = min(k, (b.hi - b.lo) - 2)
        if not _valid_overlap(k, ov_b, tol_m):
            k, ov_b = 0, 0.0
        # (b) la cola de A que se pasa de largo sobre lo que queda de B
        m, ov_a, over2 = _overlap_run(a, list(range(a.hi - 1, a.lo - 1, -1)),
                                      b, b.lo + k, b.hi, tol_m, limit)
        m = min(m, (a.hi - a.lo) - 2)
        if not _valid_overlap(m, ov_a, tol_m):
            m, ov_a = 0, 0.0
        if over or over2 or (ov_a + ov_b) > limit:
            # Ida y vuelta: B no continúa a A, la deshace. Recortar aquí se
            # comería medio recorrido, así que se avisa y se deja tal cual.
            warns.append(
                f"Parece ida y vuelta: «{b.name}» recorre al menos "
                f"{int(round(max(ov_a, ov_b)))} m sobre «{a.name}»; no se ha recortado."
            )
        else:
            a_tail, b_head = m, k

    def gap_of(at, bh):
        pa = a.pts[a.hi - 1 - at]
        pb = b.pts[b.lo + bh]
        return _hav_m(pa.longitude, pa.latitude, pb.longitude, pb.latitude)

    gap = gap_of(a_tail, b_head)
    if a_tail and b_head:
        # Los dos lados se pisan mutuamente: son los últimos metros de A y los
        # primeros de B sobre el MISMO sendero, no una duplicación. Recortarlos
        # los dos borra ese trozo y deja un agujero donde había una junta
        # limpia (medido: 5,8 m de costura convertidos en 96). Si recortar
        # empeora el hueco, gana la combinación que lo deja menor.
        opts = [(a_tail, b_head), (a_tail, 0), (0, b_head), (0, 0)]
        a_tail, b_head = min(opts, key=lambda o: (round(gap_of(*o), 1),
                                                  -o[0] - o[1]))
        gap = gap_of(a_tail, b_head)
    return a_tail, b_head, gap, warns


def _closes(parts, tol_m):
    """¿El último punto conservado cae a ≤ tol del primero?"""
    first = parts[0].pts[parts[0].lo]
    last = parts[-1].pts[parts[-1].hi - 1]
    return _hav_m(first.longitude, first.latitude,
                  last.longitude, last.latitude) <= tol_m


def _dec(coords):
    """Decima una lista de [lon,lat] a ≤ _REPORT_MAX_PTS (informe/preview)."""
    if len(coords) <= _REPORT_MAX_PTS:
        return [[c[0], c[1]] for c in coords]
    step = int(math.ceil(len(coords) / float(_REPORT_MAX_PTS)))
    return [[c[0], c[1]] for c in decimate(coords, step)]


def _coords(points):
    return [[p.longitude, p.latitude] for p in points]


def _dec_to(coords, maxn):
    if len(coords) <= maxn:
        return [[c[0], c[1]] for c in coords]
    step = int(math.ceil(len(coords) / float(maxn)))
    return [[c[0], c[1]] for c in decimate(coords, step)]


# ── propuestas de ensamblaje ────────────────────────────────────────────────
#
# Mirar solo la costura cola-de-A ↔ cabeza-de-B da por supuesto que las dos
# entradas se tocan por los extremos. El caso que rompió eso: un bucle A de
# 9,5 km y una ruta B que ARRANCA en un punto interior de A (su km 4,09) y
# termina donde A empieza. Encadenar A entera con B deja un hueco de 3 km y
# repite 4 km; lo que el recorrido pide es partir A por esa junta y quedarse
# con media A (invertida) + B.
#
# De ahí estas tres piezas: detectar juntas INTERIORES y partir por ellas
# (_split_units), enumerar recorridos que encadenen esas piezas (_chains), y
# ordenarlos por lo que hace bueno a un recorrido —cerrar el circuito, no
# repetir kilómetros, no dejar huecos— en vez de por la costura.


def _real_times(pts):
    """¿Esta entrada tiene tiempos DE VERDAD?

    Un track dibujado a mano y exportado por Wikiloc puede traer un <time> por
    punto con el MISMO valor en los 422: son marcas de tiempo, pero no
    describen ningún avance, y tratarlas como una ruta grabada prohíbe invertir
    el track sin ningún motivo. Cuentan como tiempos solo si la serie avanza
    (span > 0) y no retrocede nunca (repetidos sí: un GPS a 1 Hz parado los da).
    """
    ts = [p.time for p in pts if p.time]
    if len(ts) < 2:
        return False
    for a, b in zip(ts, ts[1:]):
        if b < a:
            return False
    return (ts[-1] - ts[0]).total_seconds() > 0


def _plain_len(pts, cos_lat):
    """Longitud proyectada de una lista de puntos (sin índice ni cortes)."""
    tot = 0.0
    for a, b in zip(pts, pts[1:]):
        tot += math.hypot((b.longitude - a.longitude) * _DEG_M * cos_lat,
                          (b.latitude - a.latitude) * _DEG_M)
    return tot


def _cum_m(pts, cos_lat):
    """Distancia acumulada (m) punto a punto, la MISMA medida que `_Poly.cum`.

    Es la escala en la que hablan `from_m`/`to_m` —tanto los de las propuestas
    automáticas como los del montaje manual— y la que se publica en
    `track_lengths_m`. Planar (proyección equirectangular local) y sumando
    también el salto entre segmentos: así una distancia sobre un track siempre
    significa lo mismo en todo el módulo, y una pieza de una propuesta se puede
    devolver tal cual como pieza manual y cortar en el mismo sitio.
    """
    cum = [0.0] * len(pts)
    for i in range(1, len(pts)):
        cum[i] = cum[i - 1] + math.hypot(
            (pts[i].longitude - pts[i - 1].longitude) * _DEG_M * cos_lat,
            (pts[i].latitude - pts[i - 1].latitude) * _DEG_M)
    return cum


def _idx_at_m(cum, d):
    """Vértice más cercano a la distancia `d`. NUNCA se interpola un punto nuevo:
    aquí solo se reordenan los GPXTrackPoint originales, como en todo el módulo."""
    i = bisect_left(cum, d)
    if i <= 0:
        return 0
    if i >= len(cum):
        return len(cum) - 1
    return i if (cum[i] - d) < (d - cum[i - 1]) else i - 1


def _fmt_m(m):
    """«1,2 km» / «250 m», para los avisos en español."""
    if m >= 1000.0:
        return f"{m / 1000.0:.1f}".replace(".", ",") + " km"
    return f"{int(round(m))} m"


def normalize_pieces(pieces, n_tracks=None):
    """Valida `options.pieces` → [{track, from_m, to_m}, …] (mensajes en español).

    Con `n_tracks` comprueba además que el índice exista; sin él solo el
    FORMATO, que es lo que puede responder merge_options() (api/editor.py) antes
    de leer ningún archivo — misma división que `endpoint_spec`.

    `from_m > to_m` significa el trozo INVERTIDO; los valores se acotan luego a
    la longitud real del track (aquí no se conoce).
    """
    if not isinstance(pieces, list) or not pieces:
        raise EditError("«pieces» debe ser una lista con al menos un trozo")
    out = []
    for k, sp in enumerate(pieces):
        n = k + 1
        if not isinstance(sp, dict):
            raise EditError(f"El trozo {n} debe ser un objeto con «track», "
                            "«from_m» y «to_m»")
        try:
            track = int(sp["track"])
        except (KeyError, TypeError, ValueError):
            raise EditError(f"El trozo {n}: «track» debe ser el índice de una "
                            "de las rutas que se están uniendo")
        if isinstance(sp["track"], bool) or track < 0:
            raise EditError(f"El trozo {n}: «track» debe ser el índice de una "
                            "de las rutas que se están uniendo")
        if n_tracks is not None and track >= n_tracks:
            raise EditError(f"El trozo {n}: no existe la ruta {track} "
                            f"(se están uniendo {n_tracks})")
        vals = {}
        for field in ("from_m", "to_m"):
            v = sp.get(field)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise EditError(f"El trozo {n}: «from_m» y «to_m» deben ser "
                                "números de metros")
            v = float(v)
            if math.isnan(v) or math.isinf(v):
                raise EditError(f"El trozo {n}: «from_m» y «to_m» deben ser "
                                "números de metros")
            vals[field] = v
        out.append({"track": track, "from_m": vals["from_m"],
                    "to_m": vals["to_m"]})
    return out


def _manual_units(entries, specs, tol_m, cums):
    """Piezas del MONTAJE MANUAL: el usuario dicta los trozos, uno por `_Unit`.

    Devuelve (unidades, invertida_por_unidad, pedido_por_unidad). Cada trozo se
    corta por el vértice más cercano a la distancia pedida (acotada a la
    longitud del track) y se orienta según `from_m > to_m`. Las costuras las
    arregla después el flujo normal de smart_merge.
    """
    units, revs, req = [], [], []
    for k, sp in enumerate(specs):
        i = sp["track"]
        pts, breaks, nm = entries[i]
        cum = cums[i]
        total = cum[-1]
        f = min(max(sp["from_m"], 0.0), total)
        t = min(max(sp["to_m"], 0.0), total)
        rev = f > t
        lo_m, hi_m = (t, f) if rev else (f, t)
        a, b = _idx_at_m(cum, lo_m), _idx_at_m(cum, hi_m)
        if b - a < 1 or (cum[b] - cum[a]) < _MIN_OVERLAP_TOL * tol_m:
            raise EditError(f"El trozo {k + 1} es demasiado corto")
        whole = (a == 0 and b == len(pts) - 1)
        units.append(_Unit(len(units), i, nm, k, 1 if whole else 2,
                           pts[a:b + 1], {x - a for x in breaks if a < x <= b},
                           cum[a], cum[b]))
        revs.append(rev)
        req.append((f, t))
    return units, revs, req


def _manual_piece_info(part, requested):
    """Una pieza del montaje manual TAL COMO HA QUEDADO, tras el recorte.

    `from_m`/`to_m` son los del trozo conservado, en la misma escala y con la
    misma convención que la entrada (from > to = invertido), para que el cliente
    pueda pintar exactamente lo que se ha usado de cada track y lo que no.
    """
    u = part.unit
    hm, tm = part.head_m(), part.tail_m()
    if part.rev:
        f, t = u.to_m - hm, u.from_m + tm
    else:
        f, t = u.from_m + hm, u.to_m - tm
    return {
        "track": part.src,
        "name": part.name,
        "reversed": part.rev,
        "from_m": round(f, 1),
        "to_m": round(t, 1),
        "len_m": round(part.length_m(), 1),
        "trimmed_head_m": round(hm, 1),
        "trimmed_tail_m": round(tm, 1),
        "requested": {"from_m": round(requested[0], 1),
                      "to_m": round(requested[1], 1)},
    }


def _manual_reversed_inputs(parts, n_inputs):
    """Por entrada: True/False solo si el montaje la usa ENTERA en una pieza;
    None si la parte o la usa varias veces (invertirla entera no significa nada
    ahí, igual que en las propuestas automáticas)."""
    out = []
    for src in range(n_inputs):
        ps = [p for p in parts if p.src == src]
        if len(ps) == 1 and ps[0].unit.whole:
            out.append(bool(ps[0].rev))
        else:
            out.append(None)
    return out


def _sample_idx(poly, step_m):
    """Índices de vértice cada `step_m` metros (el primero y el último, siempre)."""
    cum = poly.cum
    out, nxt = [], 0.0
    for i in range(poly.n):
        if cum[i] >= nxt:
            out.append(i)
            nxt = cum[i] + step_m
    if out[-1] != poly.n - 1:
        out.append(poly.n - 1)
    return out


def _overlap_runs(ypoly, yidx, xpoly, tol_m):
    """Tramos contiguos de Y que van PEGADOS a X (≤ tol).

    Devuelve [(i0, i1, metros)] en índices de vértice de Y, ya validados con la
    misma ventana que el resto del módulo (`_valid_overlap`: ≥3 muestras y
    ≥2·tol metros), porque un cruce suelto no es un tramo común.

    Se muestrea cada tol/2 m —igual que `_repeated_m`, y por el mismo motivo:
    con un punto por metro, consultar la rejilla punto a punto cuesta más que
    toda la unión— y se FUNDEN los tramos separados por menos de `_DETOUR_MIN_M`
    (con suelo en 3·tol). Ese margen NO es cosmético: dos dibujos distintos del
    mismo sendero se despegan continuamente unas decenas de metros —medido en
    los dos GPX reales: huecos de 37, 53, 76, 139 y 310 m dentro de un tramo que
    comparten 5 km—, mientras que el desvío que sí merece ser una pieza propia
    se va 6 km. Sin la histéresis salen juntas falsas cada pocos cientos de
    metros, y cada junta falsa multiplica la enumeración de recorridos.
    """
    cum = ypoly.cum
    runs, cur, n_run = [], None, 0
    for i in yidx:
        p = ypoly.pts[i]
        near = (xpoly.near_bbox(p.longitude, p.latitude, tol_m)
                and xpoly.dist(p.longitude, p.latitude) <= tol_m)
        if near:
            if cur is None:
                cur, n_run = [i, i], 1
            else:
                cur[1], n_run = i, n_run + 1
        elif cur is not None:
            runs.append((cur[0], cur[1], n_run))
            cur, n_run = None, 0
    if cur is not None:
        runs.append((cur[0], cur[1], n_run))

    fused = []
    hold = max(_JUNCTION_MARGIN * tol_m, _DETOUR_MIN_M)
    for a, b, n in runs:
        if fused and cum[a] - cum[fused[-1][1]] <= hold:
            f = fused.pop()
            fused.append((f[0], b, f[2] + n))
        else:
            fused.append((a, b, n))
    return [(a, b, cum[b] - cum[a]) for a, b, n in fused
            if _valid_overlap(n, cum[b] - cum[a], tol_m)]


def _keep_junctions(poly, cands, margin):
    """Juntas definitivas de un track: interiores, sin repetir y como mucho 4.

    `cands` son (vértice, prioridad, importancia). Prioridad 0 = junta por
    EXTREMO de otra entrada (la de siempre, manda); 1 = junta por tramo común,
    y ahí la importancia son los metros del tramo que la delimita, para que el
    tope se quede con las que separan los trozos grandes. El tope existe porque
    la enumeración de recorridos crece con el número de piezas: cuatro juntas ya
    son cinco trozos de un solo track.

    Dos juntas a menos de `_JUNCTION_MERGE_M` son la misma junta y se queda la
    de más prioridad: el punto donde un ramal ARRANCA (junta por extremo, exacta)
    y el punto donde los dos tracks dejan de ir pegados (junta por tramo, con la
    precisión del muestreo y del dibujo) describen el mismo sitio, y en los GPX
    reales salían a 107 m uno de otro. Partir dos veces ahí solo fabrica una
    pieza de 107 m que no sirve para ningún recorrido. Entre dos juntas por
    extremo se mantiene el margen de siempre (3·tol).

    Esa misma distancia es el margen de EXTREMO de una junta por tramo, y por lo
    mismo: el solape de una costura normal (la cola de A sobre la cabeza de B)
    llega hasta el final del track, y con solo 3·tol de margen su principio
    contaba como junta interior y partía A a 100 m del final. Una costura ya
    tiene quien la resuelva (`_seam`); partir ahí solo fabrica piezas que no son
    recorridos.
    """
    total = poly.cum[-1]
    if total <= 3.0 * margin:
        return []
    near = max(margin, _JUNCTION_MERGE_M)
    ok = [c for c in cands
          if (margin if c[1] == 0 else near) < poly.cum[c[0]]
          < total - (margin if c[1] == 0 else near)]
    ok.sort(key=lambda c: (c[1], -c[2], poly.cum[c[0]]))
    keep = []
    for k, pr, _imp in ok:
        if any(abs(poly.cum[k] - poly.cum[o]) <= (margin if pr == 0 and opr == 0
                                                  else near)
               for o, opr in keep):
            continue
        keep.append((k, pr))
        if len(keep) >= _MAX_JUNCTIONS:
            break
    return sorted((k for k, _p in keep), key=lambda k: poly.cum[k])


def _split_units(entries, tol_m, cos_lat, cell):
    """Entradas → piezas, partiendo por las juntas interiores.

    Hay dos clases de junta, y las dos se miden A LO LARGO del track y con
    margen respecto a los extremos (`_keep_junctions`): un corte pegado a un
    extremo no es una junta, es la costura de siempre, y partir ahí solo
    fabricaría una pieza de dos metros.

    1. **Por EXTREMO**: un extremo de OTRA entrada cae a ≤ tol de un punto
       interior de ésta (el caso del ramal que arranca a mitad del bucle).
    2. **Por TRAMO COMÚN**: el principio y el final de cada tramo contiguo en
       que las dos entradas van pegadas (`_overlap_runs`). Sin esto, una entrada
       que se va, da una vuelta y VUELVE a la traza de la otra para seguir
       pegada a ella hasta el final no se puede partir por donde se reencuentran
       —ahí no hay ningún extremo—, así que el trozo «solo el desvío» no existe
       y la unión acaba llevándose los kilómetros duplicados de una de las dos.
       El corte se anota en las dos entradas: en Y (donde empieza/acaba el
       tramo) y en X (el punto más cercano de X a ese mismo sitio).
    """
    polys = [_Poly(pts, breaks, cos_lat, cell) for pts, breaks, _n in entries]
    margin = _JUNCTION_MARGIN * tol_m
    cands = [[] for _ in entries]

    for i, poly in enumerate(polys):
        if poly.cum[-1] <= 3.0 * margin:
            continue
        for j, (ptsj, _bj, _nj) in enumerate(entries):
            if i == j:
                continue
            for q in (ptsj[0], ptsj[-1]):
                if not poly.near_bbox(q.longitude, q.latitude, tol_m):
                    continue              # ni se siembra la rejilla
                d, k = poly.nearest(q.longitude, q.latitude)
                if k < 0 or d > tol_m:
                    continue
                cands[i].append((k, 0, 0.0))

    step = max(tol_m / 2.0, 1.0)
    samples = [None] * len(polys)
    for i, poly in enumerate(polys):
        for j, pj in enumerate(polys):
            if i == j:
                continue
            if not (poly.minx - tol_m <= pj.maxx and pj.minx - tol_m <= poly.maxx
                    and poly.miny - tol_m <= pj.maxy
                    and pj.miny - tol_m <= poly.maxy):
                continue                  # ni se rozan: nada que muestrear
            if samples[i] is None:
                samples[i] = _sample_idx(poly, step)
            for a, b, m in _overlap_runs(poly, samples[i], pj, tol_m):
                for k in (a, b):
                    cands[i].append((k, 1, m))
                    p = poly.pts[k]
                    d, kx = pj.nearest(p.longitude, p.latitude)
                    if kx >= 0 and d <= tol_m:
                        cands[j].append((kx, 1, m))

    units = []
    for i, ((pts, breaks, nm), poly) in enumerate(zip(entries, polys)):
        keep = _keep_junctions(poly, cands[i], margin)
        bounds = [0] + keep + [len(pts) - 1]
        of = len(bounds) - 1
        for o in range(of):
            a, b = bounds[o], bounds[o + 1]
            units.append(_Unit(len(units), i, nm, o, of, pts[a:b + 1],
                               {k - a for k in breaks if a < k <= b},
                               poly.cum[a], poly.cum[b],
                               poly=poly if of == 1 else None))
    return units


def _chain_gaps(seq, units):
    gaps = []
    for (ua, ra), (ub, rb) in zip(seq, seq[1:]):
        a, b = units[ua].end(ra), units[ub].start(rb)
        gaps.append(_hav_m(a.longitude, a.latitude, b.longitude, b.latitude))
    return gaps


def _chain_points(seq, units, gaps, gap_join_m):
    """Puntos y cortes de segmento del recorrido candidato (antes de recortar)."""
    pts, breaks = [], set()
    for k, (uid, rev) in enumerate(seq):
        u = units[uid]
        pp = list(reversed(u.pts)) if rev else list(u.pts)
        bb = ({len(u.pts) - b for b in u.breaks} if rev else set(u.breaks))
        if pts and gaps[k - 1] > gap_join_m:
            breaks.add(len(pts))
        base = len(pts)
        for b in bb:
            if 0 < b < len(pp):
                breaks.add(base + b)
        pts.extend(pp)
    return pts, breaks


def _thin_poly(pts, breaks, cos_lat, cell_m, step_m):
    """_Poly del recorrido adelgazado a un punto cada `step_m` metros.

    La medida de repetición solo necesita la FORMA. Con un punto por metro (un
    GPS a 1 Hz) la rejilla acaba con decenas de tramos por celda y consultarla
    cuesta más que toda la unión junta; a tol/2 de paso la traza es la misma
    dentro de la tolerancia y la consulta mira cuatro tramos.
    """
    n = len(pts)
    keep, acc = [0], 0.0
    for i in range(1, n):
        acc += math.hypot(
            (pts[i].longitude - pts[i - 1].longitude) * _DEG_M * cos_lat,
            (pts[i].latitude - pts[i - 1].latitude) * _DEG_M)
        if i in breaks or acc >= step_m or i == n - 1:
            keep.append(i)
            acc = 0.0
    nb, sub = set(), []
    for k, i in enumerate(keep):
        if k and i in breaks:
            nb.add(k)
        sub.append(pts[i])
    return _Poly(sub, nb, cos_lat, cell_m)


def _repeated_m(poly, tol_m):
    """Metros del recorrido que vuelven a pisar algo ya recorrido.

    Es la métrica que distingue «media A invertida + B» (0 km repetidos) de
    «media A + B» (4 km de vuelta por donde se fue), y las dos cierran circuito
    y tienen la misma costura: sin esto no hay forma de preferir una.

    Solo cuenta lo ANTERIOR (a más de `sep` metros hacia atrás a lo largo del
    propio recorrido, para que un track denso no se pise a sí mismo) y solo si
    la repetición tiene cuerpo, con la misma ventana que `_valid_overlap`.
    """
    n = poly.n
    if n < 4:
        return 0.0
    cum = poly.cum
    sep = max(_LOOP_MIN_SEP_M, 5.0 * tol_m)
    # Se muestrea cada tol/2 metros en vez de punto a punto: con un GPS a 1 Hz
    # hay un punto por metro y consultar la rejilla 40 000 veces cuesta más que
    # todo lo demás junto. La ventana mínima que valida un solape son 2·tol, así
    # que cualquier repetición que cuente cae sobre 4 muestras o más.
    step = max(tol_m / 2.0, 1.0)
    idxs, nxt = [], 0.0
    for i in range(n):
        if cum[i] >= nxt:
            idxs.append(i)
            nxt = cum[i] + step
    if idxs[-1] != n - 1:
        idxs.append(n - 1)

    total = 0.0
    run_start = None
    run_n = 0

    def close(i_end):
        nonlocal total
        if run_start is None:
            return
        ov = cum[i_end] - cum[run_start]
        if _valid_overlap(run_n, ov, tol_m):
            total += ov

    prev = None
    for i in idxs:
        hi = bisect_right(cum, cum[i] - sep)
        ok = False
        if hi >= 2:
            p = poly.pts[i]
            ok = poly.dist(p.longitude, p.latitude, 0, hi) <= tol_m
        if ok:
            if run_start is None:
                run_start, run_n = i, 1
            else:
                run_n += 1
        elif run_start is not None:
            close(prev)
            run_start, run_n = None, 0
        prev = i
    close(idxs[-1])
    return total


def _chains(units, groups, link_max):
    """Recorridos que encadenan piezas sin repetirlas y empalmando (≤ link_max).

    Dos condiciones para aceptar uno, y ninguna sobra: que aparezca **algo de
    cada entrada** (unir dos rutas y devolver solo una no es unir: la mejor
    propuesta salía siendo «A entera», sin rastro de B) y que **alguna entrada
    vaya completa** (unir es «añadir esta ruta a aquella», no quedarse con dos
    trozos sueltos). El DFS es barato porque la adyacencia es rarísima —un
    extremo tiene que caer sobre otro—, pero lleva tope por si alguien une diez
    tracks que se tocan todos.
    """
    n = len(units)
    out = []

    def complete(used):
        srcs = {units[uid].src for uid in used}
        if len(srcs) < len(groups):
            return False
        return any(all(u.uid in used for u in g) for g in groups.values())

    def dfs(seq, used):
        if len(seq) >= 2 and complete(used):
            out.append(list(seq))
            if len(out) >= _MAX_CHAINS:
                return True
        if len(seq) >= _MAX_CHAIN:
            return False
        ua, ra = seq[-1]
        e = units[ua].end(ra)
        for uid in range(n):
            if uid in used:
                continue
            u = units[uid]
            for rev in (False, True):
                s = u.start(rev)
                if _hav_m(e.longitude, e.latitude,
                          s.longitude, s.latitude) > link_max:
                    continue
                seq.append((uid, rev))
                used.add(uid)
                stop = dfs(seq, used)
                seq.pop()
                used.discard(uid)
                if stop:
                    return True
        return False

    for uid in range(n):
        for rev in (False, True):
            if dfs([(uid, rev)], {uid}):
                return out
    return out


def _whole_chains(groups, n_inputs):
    """Los recorridos «entradas enteras», que son los de siempre.

    Sin ellos, la unión de toda la vida (cola de A ↔ cabeza de B) podría no
    salir como propuesta en cuanto aparece una junta interior — y tiene que
    seguir estando, aunque el hueco sea de tres kilómetros: puede ser justo lo
    que el usuario quería.
    """
    orders = (list(itertools.permutations(range(n_inputs))) if n_inputs <= 3
              else [tuple(range(n_inputs))])
    masks = range(1 << n_inputs) if n_inputs <= 4 else [0]
    seqs = []
    for perm in orders:
        for mask in masks:
            seqs.append(_whole_seq(groups, perm, [bool((mask >> s) & 1)
                                                  for s in range(n_inputs)]))
    # Con 4+ entradas no se prueban todas las permutaciones (24, 120… por cada
    # orientación), y el orden dado es el de SELECCIÓN en la vista `unir`, o
    # sea arbitrario: sin esto, cuatro tramos que encadenan salían con huecos
    # de kilómetros. Se añaden los encadenados «al extremo más cercano».
    if n_inputs >= 4:
        seqs += [_whole_seq(groups, perm, revs)
                 for perm, revs in _greedy_orders(groups, n_inputs)]
    return seqs


def _whole_seq(groups, perm, revs):
    """Secuencia de piezas de las entradas ENTERAS en el orden `perm`, cada una
    orientada según `revs[src]`."""
    seq = []
    for src in perm:
        g = groups[src]
        rev = bool(revs[src])
        seq.extend((u.uid, rev) for u in (reversed(g) if rev else g))
    return seq


def _whole_ends(g, rev):
    """Primer y último punto de la entrada entera `g` (sus piezas en orden)."""
    return (g[-1].start(True), g[0].end(True)) if rev else \
        (g[0].start(False), g[-1].end(False))


def _greedy_orders(groups, n_inputs):
    """Órdenes «vecino más cercano»: desde cada entrada y orientación, se
    empalma siempre la entrada libre (y la orientación) cuyo inicio queda más
    cerca del final actual. 2·n recorridos, O(n³): barato para cualquier n."""
    out = []
    for s0 in range(n_inputs):
        for r0 in (False, True):
            revs = [False] * n_inputs
            revs[s0] = r0
            perm = [s0]
            end = _whole_ends(groups[s0], r0)[1]
            left = set(range(n_inputs)) - {s0}
            while left:
                best = None
                for s in sorted(left):
                    for r in (False, True):
                        st, en = _whole_ends(groups[s], r)
                        d = _hav_m(end.longitude, end.latitude,
                                   st.longitude, st.latitude)
                        if best is None or d < best[0]:
                            best = (d, s, r, en)
                _d, s, r, end = best
                perm.append(s)
                revs[s] = r
                left.discard(s)
            out.append((tuple(perm), revs))
    return out


def _order_min_gap(units, order, forced):
    """Orientación FORZADA con 3+ entradas: el orden que deja menos hueco entre
    el final de cada una y el principio de la siguiente. Con ≤5 entradas se
    prueban todas las permutaciones (120 como mucho, cada una O(n)); con más,
    el vecino más cercano desde cada entrada. Empate → el orden dado."""
    def cost(perm):
        tot = 0.0
        for a, b in zip(perm, perm[1:]):
            e = units[a].end(bool(forced[a]))
            s = units[b].start(bool(forced[b]))
            tot += _hav_m(e.longitude, e.latitude, s.longitude, s.latitude)
        return tot

    base = tuple(order)
    if len(base) <= 5:
        cands = itertools.permutations(base)
    else:
        cands = []
        for first in base:
            perm, left = [first], [u for u in base if u != first]
            while left:
                e = units[perm[-1]].end(bool(forced[perm[-1]]))
                nxt = min(left, key=lambda u: _hav_m(
                    e.longitude, e.latitude,
                    units[u].start(bool(forced[u])).longitude,
                    units[u].start(bool(forced[u])).latitude))
                perm.append(nxt)
                left.remove(nxt)
            cands.append(tuple(perm))
    best, best_c = base, cost(base)
    for perm in cands:
        c = cost(perm)
        if c < best_c - 1.0:
            best, best_c = perm, c
    return list(best)


def _variants(seq, closed):
    """Las formas de escribir el MISMO recorrido: al revés y, si cierra
    circuito, empezando por cualquier pieza."""
    rev = [(uid, not r) for uid, r in reversed(seq)]
    out = [seq, rev]
    if closed:
        for k in range(1, len(seq)):
            out.append(seq[k:] + seq[:k])
            out.append(rev[k:] + rev[:k])
    return out


def _ep_ok(seq, units, want_s, want_e, tol_m):
    """¿Este recorrido empieza y acaba donde el usuario ha pedido?

    `want_s`/`want_e` son (lon, lat) de un extremo de una entrada ORIGINAL (ver
    `endpoint_spec`), y la condición es sobre el PUNTO, no sobre el extremo: en
    un bucle cuyo inicio y fin coinciden geográficamente, «0s» y «0e» valen los
    dos y decide el ranking.

    La holgura que se le pasa es `close_tol` (= max(tol, gap_join)), la misma
    con la que `_closes()` da un circuito por cerrado, y por el mismo motivo:
    medido con los dos GPX reales, el fin del ramal cae a 30,0 m del fin del
    bucle, o sea JUSTO en el borde de `tol`, y con `tol` a secas «acaba en el
    fin de A» salía imposible en un recorrido que evidentemente acaba ahí.
    """
    if want_s is None and want_e is None:
        return True
    if want_s is not None:
        a = units[seq[0][0]].start(seq[0][1])
        if _hav_m(a.longitude, a.latitude, want_s[0], want_s[1]) > tol_m:
            return False
    if want_e is not None:
        b = units[seq[-1][0]].end(seq[-1][1])
        if _hav_m(b.longitude, b.latitude, want_e[0], want_e[1]) > tol_m:
            return False
    return True


def _pick_variant(variants, units, had_times, want_s=None, want_e=None,
                  tol_m=30.0):
    """De todas las escrituras equivalentes, la que menos estropea.

    Primero, si se han pedido extremos: la que los cumple (esa es la petición
    explícita del usuario, y cumplirla puede costar invertir). Después: no
    invertir una entrada con tiempos REALES (invertirla borra su serie temporal;
    recorrer el mismo circuito al revés es gratis). Y por último la que empieza
    por la pieza de la entrada más baja y sin invertir.
    """
    def key(v):
        u = units[v[0][0]]
        bad = sum(1 for uid, r in v if r and had_times[units[uid].src])
        ep = 0 if _ep_ok(v, units, want_s, want_e, tol_m) else 1
        return (ep, bad, u.src, int(v[0][1]), u.ordinal)
    return min(variants, key=key)


def _letter(i):
    return chr(65 + i) if i < 26 else f"R{i + 1}"


def _fmt_km(m):
    """«0» / «4,1» / «9,5»: kilómetros para las etiquetas (sin el «,0»)."""
    s = f"{m / 1000.0:.1f}".replace(".", ",")
    return s[:-2] if s.endswith(",0") else s


def _label(seq, units, groups):
    """Etiqueta corta en español: «A (2ª mitad, invertida) + B».

    Una entrada que va ENTERA y seguida se colapsa a «A entera». Las demás se
    nombran «1ª mitad»/«2ª mitad» solo cuando son exactamente eso: dos mitades,
    y la entrada aparece una sola vez. En cuanto una entrada sale más de una vez
    o está partida en más de dos, todos los trozos sueltos pasan a llevar sus
    kilómetros —«A (km 0→4,1) + B (km 0→6,1) + A (km 4,1→9,5)»—, que es la única
    forma de leer un recorrido que va y vuelve al mismo track: con «1ª/2ª mitad»
    repetidas no se sabe cuál es cuál.
    """
    # 1ª pasada: qué se colapsa a «X entera» y qué queda como trozo suelto.
    plan = []
    i = 0
    while i < len(seq):
        uid, rev = seq[i]
        u = units[uid]
        grp = groups[u.src]
        k = len(grp)
        if k > 1 and i + k <= len(seq):
            chunk = seq[i:i + k]
            ids = [c[0] for c in chunk]
            revs = {c[1] for c in chunk}
            want = [g.uid for g in grp]
            if len(revs) == 1:
                r = chunk[0][1]
                if ids == (list(reversed(want)) if r else want):
                    plan.append(("whole", u, r))
                    i += k
                    continue
        plan.append(("part", u, rev))
        i += 1

    veces = {}
    for kind, u, _r in plan:
        if kind == "part":
            veces[u.src] = veces.get(u.src, 0) + 1
    km = any(u.of > 2 or veces[u.src] > 1
             for kind, u, _r in plan if kind == "part")

    out = []
    for kind, u, rev in plan:
        suf = ", invertida" if rev else ""
        if kind == "whole":
            out.append(f"{_letter(u.src)} entera{suf}")
        elif u.of == 1:
            out.append(_letter(u.src) + (" (invertida)" if rev else ""))
        else:
            trozo = (f"km {_fmt_km(u.from_m)}→{_fmt_km(u.to_m)}" if km
                     else ("1ª mitad", "2ª mitad")[u.ordinal])
            out.append(f"{_letter(u.src)} ({trozo}{suf})")
    return " + ".join(out)


def _reversed_inputs(seq, units, groups):
    """Por entrada: True/False si se usa entera y en un solo sentido; None si
    la propuesta la parte (la orientación ya no es de la entrada, es de cada
    pieza)."""
    out = []
    pos = {uid: k for k, (uid, _r) in enumerate(seq)}
    for src in sorted(groups):
        grp = groups[src]
        if not all(u.uid in pos for u in grp):
            out.append(None)
            continue
        revs = {seq[pos[u.uid]][1] for u in grp}
        if len(revs) != 1:
            out.append(None)
            continue
        r = revs.pop()
        order = [u.uid for u in sorted(grp, key=lambda u: pos[u.uid])]
        want = [u.uid for u in grp]
        out.append(r if order == (list(reversed(want)) if r else want) else None)
    return out


def _candidate(seq, units, groups, tol_m, gap_join_m, close_tol, cos_lat, cell):
    gaps = _chain_gaps(seq, units)
    pts, breaks = _chain_points(seq, units, gaps, gap_join_m)
    dist = 0.0
    for i in range(1, len(pts)):
        if i in breaks:
            continue
        dist += math.hypot(
            (pts[i].longitude - pts[i - 1].longitude) * _DEG_M * cos_lat,
            (pts[i].latitude - pts[i - 1].latitude) * _DEG_M)
    poly = _thin_poly(pts, breaks, cos_lat, cell, tol_m / 2.0)
    closed = _hav_m(pts[0].longitude, pts[0].latitude,
                    pts[-1].longitude, pts[-1].latitude) <= close_tol
    return {
        "seq": seq,
        "gaps": [round(g, 1) for g in gaps],
        "distance_m": round(dist, 1),
        "closed_loop": closed,
        "repeated_m": round(_repeated_m(poly, tol_m), 1),
        "gap_m": round(max(gaps, default=0.0), 1),
        "n_pieces": len(seq),
        "n_rev": sum(1 for _u, r in seq if r),
        "label": _label(seq, units, groups),
        "pieces": [{
            "track": units[uid].src,
            "name": units[uid].name,
            "reversed": bool(rev),
            "from_m": round(units[uid].from_m, 1),
            "to_m": round(units[uid].to_m, 1),
            "len_m": round(units[uid].len_m, 1),
        } for uid, rev in seq],
        "reversed_inputs": _reversed_inputs(seq, units, groups),
        # La geometría se pinta solo de las que sobreviven al recorte a 5: ver
        # _propose(). Aquí solo viaja para no volver a encadenar los puntos.
        "_pts": pts,
        "_breaks": breaks,
    }


def _lite_segments(pts, breaks):
    segs, cur = [], []
    for i, p in enumerate(pts):
        if i in breaks and cur:
            segs.append(cur)
            cur = []
        cur.append([p.longitude, p.latitude])
    if cur:
        segs.append(cur)
    total = sum(len(s) for s in segs)
    if total <= _LITE_MAX_PTS:
        return segs
    share = max(2, _LITE_MAX_PTS // max(1, len(segs)))
    return [_dec_to(s, share) for s in segs]


def _propose(units, groups, n_inputs, had_times, tol_m, gap_join_m, close_tol,
             cos_lat, cell, want_s=None, want_e=None):
    """Todas las propuestas, ordenadas, deduplicadas y recortadas a las 5 mejores.

    Devuelve `(propuestas, extremos_aplicados)`.

    El orden dice qué es un buen recorrido, y este es el criterio: cerrar
    circuito, luego repetir menos kilómetros, luego dejar menos hueco, luego
    usar más piezas (más completa) y por último invertir menos. Los últimos
    desempates son por entrada/pieza para que el resultado sea determinista.

    Si se han pedido extremos (`want_s`/`want_e`) y ALGUNA propuesta los cumple,
    solo salen las que cumplen (la 0 sigue siendo la mejor según ese mismo
    criterio). Si no los cumple ninguna, salen todas y se avisa: fallar dejaría
    al usuario sin ninguna unión por haber pedido algo imposible.
    """
    classic_seq = [(u.uid, False) for src in sorted(groups)
                   for u in groups[src]]
    seqs = _chains(units, groups, max(tol_m, gap_join_m))
    seqs += _whole_chains(groups, n_inputs)
    seqs.append(classic_seq)

    seen = {}
    picked = {}
    classic = None
    for seq in seqs:
        closed = _hav_m(units[seq[0][0]].start(seq[0][1]).longitude,
                        units[seq[0][0]].start(seq[0][1]).latitude,
                        units[seq[-1][0]].end(seq[-1][1]).longitude,
                        units[seq[-1][0]].end(seq[-1][1]).latitude) <= close_tol
        variants = _variants(list(seq), closed)
        key = min(tuple(v) for v in variants)
        if list(seq) == classic_seq and classic is None:
            classic = key
        if key in seen:
            continue
        pick = _pick_variant(variants, units, had_times, want_s, want_e,
                             close_tol)
        # Dos clases pueden solaparse (un recorrido que cierra circuito llega
        # una vez como tal —con sus rotaciones— y otra por una rotación suya que
        # no se vio cerrada), y entonces las dos eligen la misma escritura: sin
        # esto saldrían dos tarjetas idénticas.
        if tuple(pick) in picked:
            seen[key] = picked[tuple(pick)]
            continue
        cand = _candidate(pick, units, groups, tol_m, gap_join_m, close_tol,
                          cos_lat, cell)
        cand["_ep"] = _ep_ok(pick, units, want_s, want_e, close_tol)
        seen[key] = picked[tuple(pick)] = cand

    def order_key(c):
        u = units[c["seq"][0][0]]
        # Un hueco que se une en recta no es un defecto: si no, una propuesta
        # que se deja medio track fuera ganaría a la completa por 30 m de nada.
        gap = 0.0 if c["gap_m"] <= gap_join_m else c["gap_m"]
        # Un «circuito» con kilómetros de hueco sin coser no es un circuito:
        # con 3+ entradas salía uno que cerraba saltándose 5 km y ganaba al
        # recorrido continuo. Cerrar solo cuenta si no deja huecos cortados.
        return (0 if c["closed_loop"] and gap == 0.0 else 1,
                round(c["repeated_m"] / 10.0),
                round(gap / 5.0),
                -c["n_pieces"], c["n_rev"],
                u.src, u.ordinal, int(c["seq"][0][1]))

    uniq = {}
    for c in seen.values():                 # dos claves pueden compartir dict
        uniq.setdefault(id(c), c)
    allp = sorted(uniq.values(), key=order_key)
    props, applied = allp, False
    if want_s is not None or want_e is not None:
        ok = [c for c in allp if c["_ep"]]
        if ok:
            props, applied = ok, True
    top = props[:_MAX_PROPOSALS]
    # La unión de toda la vida (entradas enteras, en el orden dado) no puede
    # quedarse fuera aunque puntúe mal: puede ser justo lo que se pedía. Salvo
    # con extremos pedidos y cumplidos: ahí la lista es exactamente «lo que
    # cumple», y colar una que no cumple sería mentir.
    if not applied and classic is not None and not any(c is seen[classic] for c in top):
        top = top[:_MAX_PROPOSALS - 1] + [seen[classic]]
    for k, c in enumerate(top):
        c["k"] = k
        c["segments_lite"] = _lite_segments(c.pop("_pts"), c.pop("_breaks"))
    for c in allp:
        c.pop("_pts", None)
        c.pop("_breaks", None)
        c.pop("_ep", None)
    return top, applied


def endpoint_spec(val, field="start"):
    """«0s»/«1e» → (índice de entrada, 's'|'e'). None se queda en None.

    Solo valida el FORMATO: el índice se comprueba contra el número de entradas
    en smart_merge, que es quien las conoce. La usa también merge_options()
    (api/editor.py) para responder 400 sin cargar ningún archivo.

    `s` es el PRIMER punto del archivo de esa entrada y `e` el último, siempre
    sin orientar: lo que el usuario ve en el mapa es el archivo tal cual, no
    cómo lo acabe colocando la unión.
    """
    if val is None:
        return None
    s = str(val).strip().lower()
    if len(s) < 2 or s[-1] not in ("s", "e") or not s[:-1].isdigit():
        raise EditError(f"«{field}» debe indicar un extremo, como «0s» (inicio "
                        "de la primera) o «1e» (fin de la segunda)")
    return int(s[:-1]), s[-1]


def _endpoint_spec(val, n, field):
    spec = endpoint_spec(val, field)
    if spec is not None and not (0 <= spec[0] < n):
        raise EditError(f"«{field}»: no existe la ruta {spec[0]} "
                        f"(se están uniendo {n})")
    return spec


def _ep_text(spec, names):
    i, w = spec
    nm = names[i] or _letter(i)
    return ("el inicio" if w == "s" else "el fin") + f" de «{nm}»"


def _endpoints_warning(s_spec, e_spec, names):
    if s_spec and e_spec:
        que = (f"empiece en {_ep_text(s_spec, names)} y acabe en "
               f"{_ep_text(e_spec, names)}")
    elif s_spec:
        que = f"empiece en {_ep_text(s_spec, names)}"
    else:
        que = f"acabe en {_ep_text(e_spec, names)}"
    return (f"No hay ningún recorrido que {que}; se muestran las propuestas "
            "sin esa condición.")


def _order_for_endpoints(units, order, forced, want_s, want_e, tol_m):
    """Camino clásico (orientación forzada): reordena las entradas enteras para
    empezar/acabar donde se pide. Devuelve el orden nuevo, o None si con esas
    orientaciones no hay ninguno que cumpla (ahí manda `reverse`, que es más
    explícito, y se avisa).
    """
    base = tuple(order)
    cands = [base]
    if len(base) <= 4:
        cands += [p for p in itertools.permutations(base) if p != base]
    for perm in cands:
        seq = [(uid, bool(forced[uid])) for uid in perm]
        if _ep_ok(seq, units, want_s, want_e, tol_m):
            return list(perm)
    return None


def smart_merge(gpxs, names=None, *, reverse=None, trim=True, join_gap=None,
                tol_m=30.0, gap_join_m=50.0, out_and_back_frac=0.5,
                proposal=0, start=None, end=None, pieces=None):
    """Une dos o más GPX mirando la geometría. Devuelve (xml, report).

    - `reverse`: None = orientación automática; o una lista de bool por entrada
      (en el orden de `gpxs`) que la FUERZA. La usa la previsualización del
      editor, donde manda el usuario.
    - `trim`: recortar el solape contiguo a cada costura (y la cola montada
      sobre el inicio en una circular).
    - `join_gap`: None = unir en el mismo segmento si el hueco ≤ `gap_join_m`;
      True = unir siempre en recta; False = dejar siempre corte de segmento.

    Reglas que no son negociables sin rehacer esto:
    - **Con tiempos no se invierte nada.** Invertir destruye los <time> (es lo
      que hace la op `reverse` del editor, avisando antes), así que si TODAS las
      entradas los llevan se ordenan cronológicamente y punto. La orientación
      automática es para los planes, que casi nunca los tienen.
    - Si aun así los rangos de tiempo se solapan, se descartan todos los <time>
      (un track con tiempos no monótonos es inválido) → `times_kept: false`,
      igual que antes de existir esta función.
    - El solape se busca solo contra la parte ANTERIOR de la costura, no contra
      todo lo acumulado: con 3+ entradas, pasar otra vez por donde se pasó al
      principio es una revisita legítima, no una costura duplicada.

    Propuestas (`proposal`, desde la v0.11.7):
    - Si un extremo de una entrada cae sobre un punto INTERIOR de otra, esa otra
      se parte por ahí y se enumeran los recorridos que encadenan las piezas
      resultantes: el informe los devuelve en `proposals[]` y `proposal` elige
      cuál se ensambla (0 = la mejor). Sin juntas interiores hay una sola
      propuesta y todo funciona exactamente como antes.
    - `reverse` explícito manda: si viene, NO se enumera nada (invertir «la
      entrada i entera» solo tiene sentido sobre entradas sin partir) y la única
      propuesta es la de siempre, así que `proposal` debe ser 0.
    - Con tiempos reales en TODAS las entradas tampoco se enumera: ahí el orden
      lo da el reloj y no se puede invertir nada.

    Extremos (`start`/`end`, desde la v0.11.7):
    - Cadenas «<i><s|e>» («0s» = inicio del primer archivo, «1e» = fin del
      segundo): el recorrido tiene que EMPEZAR a ≤ tol de ese punto y ACABAR a
      ≤ tol del otro. La condición es sobre el punto, así que en un bucle cuyo
      inicio y fin coinciden, «0s» y «0e» valen los dos.
    - Pedirlos hace que se enumeren propuestas aunque no haya juntas interiores
      (hay que poder cambiar el ORDEN y la orientación de las entradas enteras),
      y con tiempos reales puede obligar a invertir: entonces se descartan los
      <time>, con aviso, igual que con `reverse` explícito.
    - Con `reverse` explícito solo se puede reordenar; si esas orientaciones no
      permiten cumplirlo, manda `reverse` y se avisa.
    - Si NINGÚN recorrido cumple, no se falla: salen las propuestas sin la
      condición, `endpoints_applied: false` y un aviso. Pedir algo imposible no
      puede dejar al usuario sin unión.

    Montaje MANUAL (`pieces`, desde la v0.11.7):
    - `[{track, from_m, to_m}, …]`: el usuario dicta los trozos y el servidor
      arregla las costuras. `track` es el índice de la entrada en `gpxs`;
      `from_m`/`to_m` son distancias a lo largo del track ORIGINAL (en su orden
      de archivo, misma escala que `track_lengths_m` y que los `from_m`/`to_m`
      de las propuestas), y **`from_m > to_m` significa el trozo invertido**.
    - El corte va al vértice más cercano: nunca se fabrican puntos.
    - Entre piezas consecutivas se aplica la MISMA lógica de costura que en el
      modo automático (recorte del solape si `trim`, hueco en recta si
      ≤ `gap_join_m`), salvo que las dos piezas sean del mismo track y
      contiguas: eso se encadena sin costura, y encadenar dos mitades devuelve
      el track entero.
    - Con `pieces` se IGNORAN `reverse`, `proposal`, `start` y `end` (avisan, no
      fallan); `trim`, `join_gap` y `tol_m` sí se aplican. El informe lleva
      `manual: true` y una sola propuesta, «Montaje manual», con las piezas
      REALES tras el recorte.
    """
    gpxs = list(gpxs)
    if len(gpxs) < 2:
        raise EditError("Indica al menos dos rutas que unir")
    if len(gpxs) > _MAX_INPUTS:
        raise EditError(f"Como mucho se pueden unir {_MAX_INPUTS} rutas a la vez")
    tol_m = float(tol_m)

    # El montaje manual manda: el recorrido lo dicta el usuario pieza a pieza,
    # así que enumerar propuestas, forzar orientaciones o pedir extremos ya no
    # significa nada. Se anulan ANTES de validarlos (un «start» mal escrito que
    # de todas formas se ignora no debe tumbar la unión) y se avisa.
    ignored = []
    if pieces is not None:
        if reverse is not None:
            ignored.append("«reverse»")
        if proposal not in (None, 0, False, "0", ""):
            ignored.append("«proposal»")
        if start is not None or end is not None:
            ignored.append("los extremos pedidos")
        reverse, start, end, proposal = None, None, None, 0
    names = list(names or [])
    names += [""] * (len(gpxs) - len(names))

    entries = []
    for i, g in enumerate(gpxs):
        pts, breaks = _flat_entry(g)
        if len(pts) < 2:
            raise EditError("Las rutas a unir no contienen puntos suficientes")
        nm = names[i] or (g.tracks[0].name if g.tracks and g.tracks[0].name
                          else f"Ruta {i + 1}")
        entries.append((pts, breaks, nm))

    lat_ref = sum(p[0][0].latitude for p in entries) / len(entries)
    cos_lat = max(0.05, math.cos(lat_ref * math.pi / 180.0))
    cell = 2.0 * tol_m
    # Un circuito se da por cerrado con la misma holgura con la que un hueco se
    # une en recta: pedir `tol` dejaba «sin cerrar» un bucle real que acababa a
    # 30,4 m de su inicio, y la diferencia decide qué propuesta gana.
    close_tol = max(tol_m, float(gap_join_m))

    # -- ¿hay tiempos DE VERDAD? ---------------------------------------------
    had_times = [_real_times(pts) for pts, _b, _n in entries]
    have_times = all(had_times)

    forced = None
    if reverse is not None:
        if len(reverse) != len(gpxs):
            raise EditError("La lista de orientaciones no coincide con el número de rutas")
        forced = [bool(x) for x in reverse]

    # -- extremos pedidos ----------------------------------------------------
    s_spec = _endpoint_spec(start, len(entries), "start")
    e_spec = _endpoint_spec(end, len(entries), "end")
    if s_spec is not None and s_spec == e_spec:
        raise EditError("El inicio y el fin no pueden ser el mismo extremo")

    def _anchor(spec):
        if spec is None:
            return None
        pts = entries[spec[0]][0]
        p = pts[0] if spec[1] == "s" else pts[-1]
        return (p.longitude, p.latitude)

    want_s, want_e = _anchor(s_spec), _anchor(e_spec)
    want = want_s is not None or want_e is not None
    ep_applied = False

    # -- piezas y propuestas -------------------------------------------------
    manual = pieces is not None
    if manual:
        cums = [_cum_m(pts, cos_lat) for pts, _b, _n in entries]
        track_lengths = [c[-1] for c in cums]
    else:
        cums = None
        track_lengths = [_plain_len(pts, cos_lat) for pts, _b, _n in entries]

    requested = None
    free = False
    if manual:
        specs = normalize_pieces(pieces, len(entries))
        units, manual_rev, requested = _manual_units(entries, specs, tol_m, cums)
        forced = [False] * len(units)
        for u, r in zip(units, manual_rev):
            forced[u.uid] = r
    else:
        free = forced is None and not have_times
        units = (_split_units(entries, tol_m, cos_lat, cell) if free else
                 [_Unit(i, i, nm, 0, 1, pts, set(breaks), 0.0,
                        track_lengths[i])
                  for i, (pts, breaks, nm) in enumerate(entries)])
    groups = {}
    for u in units:
        groups.setdefault(u.src, []).append(u)

    proposals = None
    chosen = None
    try:
        proposal = int(proposal or 0)
    except (TypeError, ValueError):
        raise EditError("«proposal» debe ser un número entero")
    # Pedir extremos obliga a enumerar aunque no haya juntas interiores: la
    # condición se cumple eligiendo el ORDEN y la orientación de las entradas,
    # y eso es justo lo que enumera _propose.
    # Y con 3+ entradas sin tiempos, también: el orden en que llegan es el de
    # SELECCIÓN, no el del recorrido, y con dos solo había un orden posible.
    if forced is None and (len(units) > len(entries) or want
                           or (free and len(entries) >= 3)):
        proposals, ep_applied = _propose(units, groups, len(entries), had_times,
                                         tol_m, gap_join_m, close_tol, cos_lat,
                                         cell, want_s, want_e)
    if proposals:
        if not (0 <= proposal < len(proposals)):
            raise EditError(f"No existe la propuesta {proposal}: "
                            f"hay {len(proposals)}")
        chosen = proposals[proposal]
    elif proposal != 0:
        raise EditError(f"No existe la propuesta {proposal}: solo hay 1")

    # -- orden y orientación de las piezas -----------------------------------
    ubounds = []
    for u in units:
        ts = [p.time for p in u.pts if p.time]
        ubounds.append((min(ts), max(ts)) if ts else (None, None))
    if manual:
        order = [u.uid for u in units]
    elif chosen is not None:
        order = [uid for uid, _r in chosen["seq"]]
        forced = [False] * len(units)
        for uid, rev in chosen["seq"]:
            forced[uid] = bool(rev)
    else:
        order = (sorted(range(len(units)), key=lambda i: ubounds[i][0])
                 if have_times else list(range(len(units))))
        if forced is not None and not have_times and len(units) >= 3:
            # Orientación forzada: lo único libre es el orden, y el que llega es
            # el de selección. Se elige el que menos hueco deja (antes de mirar
            # los extremos pedidos, que pueden reordenarlo otra vez).
            order = _order_min_gap(units, order, forced)
        if want and forced is not None:
            # Con `reverse` explícito lo único que queda libre es el orden.
            alt = _order_for_endpoints(units, order, forced, want_s, want_e,
                                       close_tol)
            if alt is not None:
                order, ep_applied = alt, True

    ep_warning = None if (not want or ep_applied) else \
        _endpoints_warning(s_spec, e_spec, names)

    def make(i, rev):
        return _Part(units[i], rev, cos_lat, cell)

    warnings = [ep_warning] if ep_warning else []
    seams = []          # por costura: {"gap_m", "joined", "junction"}
    parts = []
    pending = None      # la 1ª entrada, cuya orientación decide la 1ª costura

    # Dos trozos seguidos del MISMO track, contiguos y en el mismo sentido, no
    # tienen costura: se encadenan y punto. Sin esto, partir un track en dos y
    # volver a montarlo pasaría por _seam (que buscaría un solape que no existe)
    # y por la decisión de hueco, y el resultado ya no sería el track entero.
    seamless = set()
    if manual:
        if ignored:
            que = (ignored[0] if len(ignored) == 1
                   else ", ".join(ignored[:-1]) + " y " + ignored[-1])
            warnings.append("Con un montaje manual se "
                            + ("ignoran " if len(ignored) > 1 else "ignora ")
                            + que + ".")
        for k in range(1, len(specs)):
            if (specs[k]["track"] == specs[k - 1]["track"]
                    and manual_rev[k] == manual_rev[k - 1]
                    and abs(requested[k - 1][1] - requested[k][0]) <= tol_m):
                seamless.add(k)

    for k, ei in enumerate(order):
        if k == 0:
            if forced is not None or have_times:
                parts.append(make(ei, bool(forced[ei]) if forced else False))
            else:
                pending = ei
            continue

        if k in seamless:
            # Contiguas y del mismo track: ni se busca solape ni se decide hueco.
            a, b = parts[-1], make(ei, bool(forced[ei]))
            a_tail = b_head = 0
            pa, pb = a.pts[a.hi - 1], b.pts[b.lo]
            gap = _hav_m(pa.longitude, pa.latitude, pb.longitude, pb.latitude)
            a.tail, b.head = 0, 0
            seams.append({"gap_m": round(gap, 1), "joined": True,
                          "seamless": True,
                          "junction": [(pa.longitude + pb.longitude) / 2,
                                       (pa.latitude + pb.latitude) / 2]})
            parts.append(b)
            continue

        cand_b = ([bool(forced[ei])] if forced is not None
                  else ([False] if have_times else [False, True]))
        cand_a = [None] if pending is None else [False, True]

        # Se prueban las combinaciones de orientación y gana la que deja MENOR
        # hueco en la costura DESPUÉS del recorte (empate a 1 m → preferir no
        # invertir; segundo desempate → preferir la que cierra circuito).
        best = None
        for ra in cand_a:
            a = parts[-1] if ra is None else make(pending, ra)
            for rb in cand_b:
                b = make(ei, rb)
                a_tail, b_head, gap, warns = _seam(a, b, tol_m,
                                                   out_and_back_frac, trim)
                head_part = parts[0] if parts else a
                h, t = head_part.pts[head_part.lo], b.pts[b.hi - 1]
                loop = _hav_m(h.longitude, h.latitude,
                              t.longitude, t.latitude) <= tol_m
                n_rev = (int(ra) if ra is not None else 0) + int(rb)
                key = (round(gap, 0), n_rev, 0 if loop else 1)
                if best is None or key < best[0]:
                    best = (key, a, b, a_tail, b_head, gap, warns, ra)

        _, a, b, a_tail, b_head, gap, warns, ra = best
        if ra is not None:                      # la 1ª parte se fija ahora
            parts.append(a)
            pending = None
        a.tail = a_tail
        b.head = b_head
        warnings.extend(warns)

        if join_gap is None:
            joined = gap <= gap_join_m
        else:
            joined = bool(join_gap)
        if manual and not joined:
            warnings.append(
                f"Hueco de {_fmt_m(gap)} entre el trozo {k} y el {k + 1}: "
                "quedará un corte de segmento.")
        pa = a.pts[a.hi - 1]
        pb = b.pts[b.lo]
        seams.append({
            "gap_m": round(gap, 1),
            "joined": joined,
            "seamless": False,
            "junction": [(pa.longitude + pb.longitude) / 2,
                         (pa.latitude + pb.latitude) / 2],
        })
        parts.append(b)

    # -- cierre de circular: la cola montada sobre la cabeza -----------------
    closed_trim_m = 0.0
    if trim:
        closed_trim_m = _close_loop(parts, tol_m, out_and_back_frac, warnings,
                                    cos_lat, cell)
    closed_loop = _closes(parts, close_tol)

    # -- tiempos -------------------------------------------------------------
    any_rev = any(p.rev for p in parts)
    times_kept = have_times and not any_rev
    if times_kept:
        prev_end = None
        for p in parts:
            start, end = ubounds[p.idx]
            if prev_end and start < prev_end:
                times_kept = False
                warnings.append("Los tiempos de los tracks se solapan: "
                                "se han descartado todas las marcas de tiempo.")
                break
            prev_end = end
    elif have_times and any_rev:
        warnings.append("Se ha invertido algún track: se han descartado "
                        "las marcas de tiempo.")
    elif any(had_times):
        # Con una sola entrada sin tiempos (o con tiempos falsos: 422 <time>
        # idénticos de un track dibujado) el resultado no puede llevar una serie
        # temporal coherente, así que se descartan también los buenos. Antes se
        # hacía en silencio.
        warnings.append("Solo algunas rutas tienen marcas de tiempo válidas: "
                        "se han descartado todas.")

    # -- ensamblado ----------------------------------------------------------
    merged = gpxpy.gpx.GPX()
    src0 = gpxs[parts[0].src]
    merged.creator = src0.creator or "Sendero"
    nsmap = {}
    for src in dict.fromkeys(p.src for p in parts):
        nsmap.update(gpxs[src].nsmap or {})
        merged.waypoints.extend(gpxs[src].waypoints)
    merged.nsmap = nsmap
    track = gpxpy.gpx.GPXTrack()
    first_trk = src0.tracks[0] if src0.tracks else None
    if first_trk is not None:
        track.name = first_trk.name
        track.type = first_trk.type
    merged.tracks = [track]

    seg = None
    total = 0
    last_pt = None
    segments_report = []
    for i, p in enumerate(parts):
        cut = i > 0 and not seams[i - 1]["joined"]
        for j in range(p.lo, p.hi):
            pt = p.pts[j]
            # Dos piezas de la misma entrada comparten el vértice de la junta:
            # encadenadas, ese punto llegaría dos veces seguidas.
            if pt is last_pt:
                continue
            if seg is None or cut or (j in p.breaks and j > p.lo):
                seg = gpxpy.gpx.GPXTrackSegment()
                track.segments.append(seg)
                segments_report.append([])
                cut = False
            if not times_kept:
                pt.time = None
            seg.points.append(pt)
            segments_report[-1].append([pt.longitude, pt.latitude])
            last_pt = pt
            total += 1
    if total < 2:
        raise EditError("Las rutas a unir no contienen puntos suficientes")

    warnings = list(dict.fromkeys(warnings))          # sin repetir el mismo aviso
    # Las uniones «sin costura» del montaje manual (dos trozos contiguos del
    # mismo track) no son juntas: no se pintan ni cuentan para el hueco.
    real_seams = [s for s in seams if not s["seamless"]]
    gaps = [{"gap_m": s["gap_m"], "joined": s["joined"]} for s in real_seams]
    final_poly = _thin_poly([pt for s in track.segments for pt in s.points],
                            _seg_breaks(track), cos_lat, cell, tol_m / 2.0)
    repeated_m = round(_repeated_m(final_poly, tol_m), 1)
    report = {
        # OJO: `order`/`reversed`/`trimmed_m`/`tracks` van por PIEZA ensamblada,
        # no por entrada. Sin juntas interiores (el caso normal) hay una pieza
        # por entrada y son exactamente lo de siempre; cuando la propuesta parte
        # una entrada, `order` puede repetir un índice o dejarse alguno fuera.
        # Lo que va por entrada es `had_times` y el `reversed_inputs` de cada
        # propuesta.
        "order": [p.src for p in parts],
        "reversed": [p.rev for p in parts],
        "trimmed_m": [round(p.head_m() + p.tail_m(), 1) for p in parts],
        # Con 2 entradas (el caso normal) describen LA costura; con más,
        # el hueco mayor y si se unieron todas.
        "gap_m": round(max((s["gap_m"] for s in real_seams), default=0.0), 1),
        "gap_joined": all(s["joined"] for s in real_seams) if real_seams else True,
        "gaps": gaps,
        "closed_loop": closed_loop,
        "closed_trim_m": round(closed_trim_m, 1),
        "times_kept": times_kept,
        "warnings": warnings,
        "junctions": [s["junction"] for s in real_seams],
        "proposal": proposal,
        "repeated_m": repeated_m,
        "had_times": had_times,
        # Siempre, también en modo automático: el cliente lo necesita para
        # escalar las selecciones de `pieces` sobre cada track.
        "manual": manual,
        "track_lengths_m": [round(v, 1) for v in track_lengths],
        # Extremos: dónde empieza y acaba lo ensamblado (siempre), si se ha
        # podido cumplir lo pedido, y los 2N extremos de las entradas
        # ORIGINALES sin orientar (para pintarlos y etiquetar el selector).
        "endpoints_applied": (bool(ep_applied) if want else None),
        "start_point": list(segments_report[0][0]),
        "end_point": list(segments_report[-1][-1]),
        "endpoints": [{
            "track": i,
            "name": nm,
            "s": [pts[0].longitude, pts[0].latitude],
            "e": [pts[-1].longitude, pts[-1].latitude],
        } for i, (pts, _b, nm) in enumerate(entries)],
        "tracks": [{
            "idx": p.src,
            "name": p.name,
            "reversed": p.rev,
            "trimmed_head_m": round(p.head_m(), 1),
            "trimmed_tail_m": round(p.tail_m(), 1),
            "coords": _dec(_coords(p.kept)),
            "trimmed_head": _dec(_coords(p.pts[:p.head])),
            "trimmed_tail": _dec(_coords(p.pts[len(p.pts) - p.tail:])) if p.tail else [],
        } for p in parts],
        "segments": [_dec(s) for s in segments_report],
        "n_points": total,
    }
    if manual:
        # Una sola propuesta, la que acaba de montar el usuario, con las piezas
        # REALES: lo pedido menos lo que el recorte de las costuras se ha
        # llevado por cada extremo.
        proposals = [{
            "k": 0,
            "label": "Montaje manual",
            "distance_m": round(sum(p.length_m() for p in parts), 1),
            "closed_loop": closed_loop,
            "repeated_m": repeated_m,
            "gap_m": report["gap_m"],
            "n_pieces": len(parts),
            "pieces": [_manual_piece_info(p, requested[p.unit.ordinal])
                       for p in parts],
            "reversed_inputs": _manual_reversed_inputs(parts, len(entries)),
            "segments_lite": [
                _dec_to(s, max(2, _LITE_MAX_PTS // max(1, len(segments_report))))
                for s in segments_report],
        }]
    elif proposals is None:
        # Sin juntas interiores hay una sola forma de unir: la de siempre. Se
        # publica igual como propuesta para que el cliente no tenga dos caminos.
        seq = [(p.idx, p.rev) for p in parts]
        proposals = [{
            "k": 0,
            "label": _label(seq, units, groups),
            "distance_m": round(sum(p.length_m() for p in parts), 1),
            "closed_loop": closed_loop,
            "repeated_m": repeated_m,
            "gap_m": report["gap_m"],
            "n_pieces": len(parts),
            "pieces": [{
                "track": p.src, "name": p.name, "reversed": p.rev,
                "from_m": round(p.unit.from_m, 1),
                "to_m": round(p.unit.to_m, 1),
                "len_m": round(p.unit.len_m, 1),
            } for p in parts],
            "reversed_inputs": _reversed_inputs(seq, units, groups),
            "segments_lite": [
                _dec_to(s, max(2, _LITE_MAX_PTS // max(1, len(segments_report))))
                for s in segments_report],
        }]
    else:
        # Lo elegido ya está recortado y cerrado: sus cifras mandan sobre las
        # que se estimaron al enumerar (que van sin recortar, por coste).
        c = proposals[proposal]
        c["closed_loop"] = closed_loop
        c["repeated_m"] = repeated_m
        c["gap_m"] = report["gap_m"]
        c["distance_m"] = round(sum(p.length_m() for p in parts), 1)
        c["segments_lite"] = [
            _dec_to(s, max(2, _LITE_MAX_PTS // max(1, len(segments_report))))
            for s in segments_report]
    for c in proposals:
        c.pop("seq", None)
        c.pop("gaps", None)
        c.pop("n_rev", None)
    report["proposals"] = proposals
    return merged.to_xml(), report


def _seg_breaks(track):
    """Índices que abren segmento en un GPXTrack ya ensamblado."""
    out, n = set(), 0
    for seg in track.segments:
        if n:
            out.add(n)
        n += len(seg.points)
    return out


def _close_loop(parts, tol_m, out_and_back_frac, warnings, cos_lat, cell):
    """Recorta la cola que se monta sobre el inicio en una circular.

    Dos filtros, y ninguno sobra:
    - La separación se mide A LO LARGO del track, no por número de puntos: en un
      track denso el punto i está siempre a menos de tol del i−3, y filtrar por
      índice recortaría el recorrido entero.
    - La "cabeza" son solo los primeros `_LOOP_MAX_FRAC` del recorrido, y el
      recorte se cancela si llega hasta ahí. Una ida y vuelta también termina
      donde empezó y su vuelta ENTERA está sobre la ida: sin tope, cerrar el
      circuito se comería medio recorrido. (Un "lollipop" —ida, lazo y vuelta
      por el mismo palo— es indistinguible de esto salvo por el tamaño; de ahí
      que el tope sea la cuarta parte y no la mitad.)
    """
    pts, breaks = [], set()
    for p in parts:
        for j in range(p.lo, p.hi):
            if j in p.breaks and j > p.lo:
                breaks.add(len(pts))
            pts.append(p.pts[j])
    if len(pts) < 4:
        return 0.0
    poly = _Poly(pts, breaks, cos_lat, cell)
    n = len(pts)
    cum = poly.cum
    sep = max(_LOOP_MIN_SEP_M, 5.0 * tol_m)
    cap = min(out_and_back_frac, _LOOP_MAX_FRAC) * cum[n - 1]
    head_hi = bisect_right(cum, cap)            # la "cabeza" del recorrido
    cut, ov = 0, 0.0
    for i in range(n - 1, 1, -1):
        hi = min(head_hi, bisect_right(cum, cum[i] - sep))
        if hi < 2:
            break
        p = pts[i]
        if poly.dist(p.longitude, p.latitude, 0, hi) > tol_m:
            break
        cut += 1
        ov = cum[n - 1] - cum[i]
        if ov > cap:
            warnings.append(
                "El final se monta sobre el inicio más de la cuarta parte del "
                "recorrido: no se ha recortado (¿es una ida y vuelta?)."
            )
            return 0.0
    if not _valid_overlap(cut, ov, tol_m):
        return 0.0
    # Afinado: de todos los puntos que se pueden quitar, el corte va en el que
    # deja el final MÁS CERCA del inicio. Sin esto la cola se recorta "hasta que
    # deje de pisar la cabeza", que se pasa de largo media tolerancia y el
    # circuito no llega a cerrarse.
    first = pts[0]
    lo = max(1, n - 1 - cut)
    best_i = min(range(lo, n),
                 key=lambda i: _hav_m(first.longitude, first.latitude,
                                      pts[i].longitude, pts[i].latitude))
    cut = min(n - 1 - best_i, n - 2)
    if not cut:
        return 0.0
    ov = cum[n - 1] - cum[n - 1 - cut]
    # El recorte se aplica sobre la ÚLTIMA parte (la cola del resultado).
    left = cut
    for p in reversed(parts):
        room = (p.hi - p.lo) - 2
        take = min(left, max(0, room))
        p.tail += take
        left -= take
        if left <= 0:
            break
    return ov


def merge_gpx(gpxs, names=None):
    """Envoltorio compatible de smart_merge(): devuelve (xml, times_kept)."""
    xml, report = smart_merge(gpxs, names)
    return xml, report["times_kept"]
