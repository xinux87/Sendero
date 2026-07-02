"""Consultas de elevación al servicio DEM (OpenTopoData) de Ajustes → Editor.

Lo usan el editor de rutas (recalcular elevación de una ruta) y el dibujo de
rutas nuevas (dar elevación a los puntos dibujados).
"""
import requests

import core.config as cfg

# Límite estándar de OpenTopoData por petición (API pública y default self-hosted).
BATCH = 100


class DemError(RuntimeError):
    """Fallo del servicio DEM; el mensaje va al usuario (en español)."""


def dem_elevations(latlons):
    """[(lat, lon), …] → [float|None, …] con la elevación del terreno.

    Devuelve None (sin consultar) si no hay DEM configurado. Lanza DemError si
    el servicio no responde o devuelve error.
    """
    if not cfg.DEM_URL or not latlons:
        return None
    out = []
    for i in range(0, len(latlons), BATCH):
        batch = latlons[i:i + BATCH]
        locs = "|".join(f"{la:.6f},{lo:.6f}" for la, lo in batch)
        try:
            resp = requests.post(cfg.DEM_URL, json={"locations": locs}, timeout=30)
            payload = resp.json()
        except Exception as e:
            raise DemError("No se pudo contactar con el servicio DEM") from e
        if resp.status_code != 200 or payload.get("status") != "OK":
            raise DemError("El servicio DEM respondió con error: "
                           f"{payload.get('error') or resp.status_code}")
        results = payload.get("results") or []
        out.extend([r.get("elevation") for r in results])
        out.extend([None] * (len(batch) - len(results)))
    return out
