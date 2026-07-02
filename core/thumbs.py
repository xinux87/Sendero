import math
from pathlib import Path
from PIL import Image, ImageDraw
import core.config as cfg

_BG = (23, 36, 28)    # --panel (#17241c)
_LINE = (255, 255, 255)
_HEIGHT = 400
_PAD = 40
_MAX_ASPECT = 4.0
_MIN_ASPECT = 0.25
_MAX_PTS = 2000


def generate_thumb(coords, gpx_file):
    """Genera imagen PNG del track. Se nombra igual que gpx_file (mismo stem,
    extensión .png) para que ambos archivos vayan siempre emparejados.
    Devuelve el nombre del archivo o None."""
    if not coords or len(coords) < 2:
        return None

    # Decimar si hay demasiados puntos
    step = max(1, len(coords) // _MAX_PTS)
    pts = coords[::step]
    if pts[-1] is not coords[-1]:
        pts = pts + [coords[-1]]

    lons = [c[0] for c in pts]
    lats = [c[1] for c in pts]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)

    lon_range = max_lon - min_lon
    lat_range = max_lat - min_lat

    # Corrección de escala por latitud (proyección Mercator)
    avg_lat = (min_lat + max_lat) / 2
    lon_corr = lon_range * math.cos(math.radians(avg_lat))

    inner_h = _HEIGHT - 2 * _PAD

    if lat_range <= 0 and lon_corr <= 0:
        return None
    if lat_range <= 0:
        aspect = _MAX_ASPECT
    elif lon_corr <= 0:
        aspect = _MIN_ASPECT
    else:
        aspect = max(_MIN_ASPECT, min(lon_corr / lat_range, _MAX_ASPECT))

    inner_w = max(int(inner_h * aspect), 40)
    width = inner_w + 2 * _PAD

    def to_px(lon, lat):
        x = _PAD + (lon - min_lon) / (max_lon - min_lon) * inner_w if max_lon != min_lon else _PAD + inner_w / 2
        y = _PAD + (max_lat - lat) / (max_lat - min_lat) * inner_h if max_lat != min_lat else _PAD + inner_h / 2
        return (x, y)

    pixels = [to_px(c[0], c[1]) for c in pts]

    img = Image.new("RGB", (width, _HEIGHT), color=_BG)
    draw = ImageDraw.Draw(img)
    draw.line(pixels, fill=_LINE, width=2)

    cfg.THUMB_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{Path(gpx_file).stem}.png"
    img.save(str(cfg.THUMB_DIR / fname), "PNG", optimize=True)
    return fname
