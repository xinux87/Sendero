"""Índice IBP (ibpindex.com) de una ruta planificada.

El IBP es una puntuación de dificultad (0 → ∞) que calcula un tercero a partir de
la latitud, longitud y altura del track: reparto de la distancia por franjas de
pendiente, desniveles acumulados, kilómetros en altura y distribución de rampas.

**El algoritmo no es público y no se puede reimplementar.** Ni su web ni su
documentación publican la fórmula: la calculadora sube el archivo a su servidor y
recibe el resultado. La única forma de tener el número REAL —el que es comparable
con el de las rutas de cualquier otra persona, que es lo que hace útil al índice—
es su API: se manda el GPX por POST multipart y devuelve un JSON con un bloque por
modalidad (`bicycle`, `hiking`, `running`), cada uno con su `ibp`.

Alcance: **solo rutas planificadas**. Las rutas ya hechas no lo llevan a propósito
— el IBP sirve para decidir si te metes en una ruta, no para etiquetar la que ya
anduviste (para eso están sus propios datos: tiempo real, velocidad, FC).

Tres cosas que conviene tener presentes antes de tocar esto:

- **Aquí sale el track completo de la LAN**, y es el único sitio de Sendero donde
  eso pasa (la geocodificación manda un punto). Por eso la clave se pone a mano en
  Ajustes y sin clave la función no existe: nunca se sube nada por defecto.
- **El servicio contesta HTTP 200 con `{"error": "..."}`** cuando la clave no vale,
  así que mirar el código de estado no basta.
- La respuesta trae **las tres modalidades de una vez**, así que se guardan las tres
  (`ibp_all` en `planned_routes`) y cambiar la actividad del plan elige otra sin
  volver a subir nada.

`parse_response()` es pura y está cubierta por tests/test_ibp.py (sin red).
"""
import requests

import core.config as cfg

# Bloques de modalidad del JSON, en el orden en que se prefieren si no se sabe
# cuál toca. El acrónimo es el que el propio servicio usa al publicar el índice
# («344 HKG»), y es el que se muestra en la UI: sin él, el número no dice de qué
# modalidad es y dos planes no son comparables.
MODALITIES = ("hiking", "bicycle", "running")
ACRONYMS = {"hiking": "HKG", "bicycle": "BYC", "running": "RNG"}

# Actividad de Sendero → modalidad del IBP. Las que no tienen equivalente
# (esquí, otros, o un plan sin actividad) se dejan a la modalidad que detecta el
# propio servicio a partir del track: inventar una falsearía el índice.
_MODALITY_BY_ACTIVITY = {
    "senderismo": "hiking",
    "caminata":   "hiking",
    "correr":     "running",
    "bicicleta":  "bicycle",
}

_UA = f"Sendero/{cfg.APP_VERSION} (bitacora de rutas autoalojada)"


class IbpError(Exception):
    """Fallo al obtener el índice, con un mensaje ya en español para la UI.

    Se lanza en vez de devolver None porque el usuario necesita saber CUÁL de los
    fallos posibles ha sido: sin clave, clave inválida, sin conexión o un GPX que
    el servicio no sabe analizar se arreglan de formas distintas. Quien lo llame
    en un camino best-effort (importar un plan) lo captura y sigue.
    """


def modality_for(activity_type):
    """Actividad de Sendero → modalidad del IBP, o None si no hay equivalente."""
    return _MODALITY_BY_ACTIVITY.get(activity_type or "")


def _to_int(v):
    """'344' / 344.0 → 344; '' / None / basura → None."""
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def parse_response(data, activity_type=None):
    """JSON de la API → {'index', 'modality', 'acronym', 'all'}. Pura.

    `all` son las tres modalidades que vinieron ({'hiking': 344, …}), y `index` la
    que corresponde a la actividad del plan; si esa actividad no tiene equivalente
    IBP, se usa la que el servicio detectó (`detectedmodality`).
    """
    if not isinstance(data, dict):
        raise IbpError("Respuesta ilegible del servicio IBP")
    todos = {}
    for m in MODALITIES:
        blk = data.get(m)
        if isinstance(blk, dict):
            v = _to_int(blk.get("ibp"))
            if v is not None:
                todos[m] = v
    if not todos:
        # 'error' viene en toda respuesta y a veces trae solo observaciones, así
        # que solo se trata como fallo cuando además no hay ningún índice.
        raise IbpError((str(data.get("error") or "").strip()
                        or "El servicio IBP no devolvió ningún índice"))
    detected = data.get("detectedmodality")
    for cand in (modality_for(activity_type), detected):
        if cand in todos:
            mod = cand
            break
    else:
        mod = next(m for m in MODALITIES if m in todos)
    return {"index": todos[mod], "modality": mod,
            "acronym": ACRONYMS[mod], "all": todos}


def analyse(gpx_bytes, activity_type=None, filename="ruta.gpx", timeout=None):
    """Sube el GPX a la API del IBP y devuelve lo que da `parse_response()`.

    Lanza IbpError con un mensaje en español en cualquier fallo (sin clave, sin
    red, clave inválida, GPX que no sabe analizar).

    `timeout` permite ser menos paciente en el camino best-effort: al importar un
    plan el usuario está esperando delante, así que vale más quedarse sin índice
    (lo recalcula el botón del detalle) que dejar la subida colgada un minuto.
    """
    if not cfg.IBP_API_KEY:
        raise IbpError("Falta la clave de la API (Ajustes → IBP Index)")
    if not gpx_bytes:
        raise IbpError("Este plan no tiene archivo GPX que analizar")
    try:
        resp = requests.post(
            cfg.IBP_URL,
            files={"file": (filename or "ruta.gpx", gpx_bytes, "application/gpx+xml")},
            data={"key": cfg.IBP_API_KEY},
            headers={"User-Agent": _UA},
            timeout=timeout or cfg.IBP_TIMEOUT,
        )
    except Exception:
        raise IbpError("No se pudo contactar con ibpindex.com")
    if resp.status_code != 200:
        raise IbpError(f"ibpindex.com respondió {resp.status_code}")
    try:
        data = resp.json()
    except ValueError:
        raise IbpError("Respuesta ilegible del servicio IBP")
    return parse_response(data, activity_type)
