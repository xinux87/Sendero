"""Geocodificación inversa (lat/lon → localidad) para etiquetar cada ruta.

Best-effort y totalmente desacoplado: si no hay servicio configurado, no hay red,
o el servicio falla, la ruta simplemente se queda SIN localidad. Nunca rompe la
importación ni el reescaneo (mismo criterio que el thumbnail o los gps_issues).

El endpoint es configurable (Ajustes → Editor, clave GEOCODE_URL) y debe ser
compatible con Nominatim (`/reverse`, formato jsonv2). Por defecto usa el
Nominatim público de OpenStreetMap; para uso intensivo conviene apuntar a un
Nominatim/Photon autoalojado (la política de OSM desaconseja el geocoding masivo).

Función pura de formato (`_format_locality`) testeable sin red en tests/.
"""
import requests

import core.config as cfg

# Nominatim exige un User-Agent identificativo en su política de uso.
_UA = f"Sendero/{cfg.APP_VERSION} (bitacora de rutas autoalojada)"


def _format_locality(data):
    """Respuesta jsonv2 de Nominatim → 'Localidad, Región' o None."""
    addr = (data or {}).get("address") or {}
    place = (addr.get("city") or addr.get("town") or addr.get("village")
             or addr.get("municipality") or addr.get("hamlet")
             or addr.get("suburb") or addr.get("county"))
    region = addr.get("state") or addr.get("province") or addr.get("region")
    parts = [p for p in (place, region) if p]
    if parts:
        # dict.fromkeys preserva el orden y descarta el caso place == region.
        return ", ".join(dict.fromkeys(parts))
    return (data or {}).get("name") or None


def reverse_geocode(lat, lon):
    """(lat, lon) → 'Localidad, Región' o None. Best-effort: nunca lanza."""
    if lat is None or lon is None or not cfg.GEOCODE_URL:
        return None
    try:
        resp = requests.get(
            cfg.GEOCODE_URL + "/reverse",
            params={"lat": lat, "lon": lon, "format": "jsonv2",
                    "zoom": 12, "addressdetails": 1, "accept-language": "es"},
            headers={"User-Agent": _UA},
            timeout=cfg.GEOCODE_TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        return _format_locality(resp.json())
    except Exception:
        return None
