import datetime as dt
from PIL import Image, ExifTags


def _to_deg(value):
    d, m, s = value
    return float(d) + float(m) / 60 + float(s) / 3600


def read_exif(path):
    """Extrae (lat, lon, fecha_iso) del EXIF si existen. Devuelve (None, None, None) si no."""
    lat = lon = taken = None
    try:
        img = Image.open(path)
        exif = img._getexif() or {}
        tags = {ExifTags.TAGS.get(k, k): v for k, v in exif.items()}
        when = tags.get("DateTimeOriginal") or tags.get("DateTime")
        if when:
            try:
                taken = dt.datetime.strptime(when, "%Y:%m:%d %H:%M:%S").isoformat()
            except ValueError:
                pass
        gps = tags.get("GPSInfo")
        if gps:
            g_ = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps.items()}
            if "GPSLatitude" in g_ and "GPSLongitude" in g_:
                lat = _to_deg(g_["GPSLatitude"])
                if g_.get("GPSLatitudeRef") == "S":
                    lat = -lat
                lon = _to_deg(g_["GPSLongitude"])
                if g_.get("GPSLongitudeRef") == "W":
                    lon = -lon
    except Exception:
        pass
    return lat, lon, taken
