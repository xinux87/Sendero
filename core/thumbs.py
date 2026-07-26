import math
from pathlib import Path
from PIL import Image, ImageDraw
import core.config as cfg

# PNG con TRANSPARENCIA, no con el color del panel: la miniatura se pinta encima
# de la tarjeta de "Mis Rutas" (y de lo que venga después), así que cualquier
# fondo opaco se vería como un recuadro más claro o más oscuro que la tarjeta —
# y al pasar el ratón, cuando la tarjeta cambia de color, el recuadro cantaba.
# Así solo se ve la traza. Las miniaturas generadas antes de esto conservan su
# fondo hasta que se reescanee la ruta ("Mis Rutas" → ✎ Editar → ↻ Re-escanear).
_BG = (0, 0, 0, 0)
_LINE = (255, 255, 255, 255)
# La miniatura se genera a 400 px de alto y en la tarjeta se ve a ~1/3, así que
# una línea de 2 px acababa en sub-píxel: sobre la tarjeta, al 22 % de opacidad,
# no se veía. A 6 px queda en ~2 px efectivos, que es el grosor del prototipo.
_LINE_W = 6
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

    img = Image.new("RGBA", (width, _HEIGHT), color=_BG)
    draw = ImageDraw.Draw(img)
    # joint="curve" redondea los vértices: con una línea gruesa, los cambios de
    # dirección de un track dejaban muescas.
    draw.line(pixels, fill=_LINE, width=_LINE_W, joint="curve")

    cfg.THUMB_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{Path(gpx_file).stem}.png"
    img.save(str(cfg.THUMB_DIR / fname), "PNG", optimize=True)
    return fname
