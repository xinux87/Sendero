import math
import requests

import core.config as cfg


def immich_get(path, **kwargs):
    return requests.get(
        f"{cfg.IMMICH_URL}{path}",
        headers={"x-api-key": cfg.IMMICH_API_KEY},
        timeout=20,
        **kwargs,
    )


def immich_search(taken_after, taken_before):
    """Busca imágenes en Immich tomadas dentro del rango temporal dado."""
    body = {
        "type": "IMAGE",
        "takenAfter": taken_after,
        "takenBefore": taken_before,
        "withExif": True,
        "size": 1000,
        "page": 1,
    }
    r = requests.post(
        f"{cfg.IMMICH_URL}/api/search/metadata",
        headers={"x-api-key": cfg.IMMICH_API_KEY, "Content-Type": "application/json"},
        json=body,
        timeout=20,
    )
    r.raise_for_status()
    items = r.json().get("assets", {}).get("items", [])
    out = []
    for a in items:
        exif = a.get("exifInfo") or {}
        out.append({
            "immich_id": a["id"],
            "taken_at":  a.get("localDateTime") or exif.get("dateTimeOriginal"),
            "lat":       exif.get("latitude"),
            "lon":       exif.get("longitude"),
        })
    return out


def min_dist_to_track(track, lat, lon):
    """Distancia mínima (m) de un punto a cualquier vértice del track [[lon,lat],...]."""
    best = float("inf")
    rlat = math.radians(lat)
    for lon2, lat2 in track:
        dlat = math.radians(lat2 - lat)
        dlon = math.radians(lon2 - lon)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(rlat) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
        d = 2 * 6371000 * math.asin(min(1, math.sqrt(a)))
        if d < best:
            best = d
    return best
