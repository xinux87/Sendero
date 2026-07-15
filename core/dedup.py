"""Deduplicación de rutas importadas (ver CLAUDE.md, sección dedup).

Dos niveles, ambos funciones puras (sin BD ni Flask, testeables en tests/):

- `content_hash(raw)`  — SHA-256 de los bytes crudos del archivo subido. Detecta
  reimportaciones IDÉNTICAS byte a byte aunque cambie el nombre. Cero falsos
  positivos. Es la defensa "dura" (→ 409 siempre, también en la ingesta auto).

- `route_signature(...)` — huella SEMÁNTICA del entrenamiento, deliberadamente
  tolerante, para pillar el MISMO track reexportado en otro formato/fuente (bytes
  distintos). Puede tener falsos positivos, así que es la defensa "blanda": en la
  web pide confirmación; en la ingesta automática importa pero marca la ruta con
  `dup_suspect_of` para revisión humana (nunca borra en silencio).
"""
import hashlib


def content_hash(raw: bytes) -> str:
    """SHA-256 hex de los bytes crudos del GPX/FIT tal cual se suben."""
    return hashlib.sha256(raw).hexdigest()


def _round_pt(pt):
    # 4 decimales ≈ 11 m: tolera las pequeñas diferencias de precisión entre un
    # export GPX y el mismo track venido por FIT/API, sin colisionar tracks
    # realmente distintos.
    return (round(pt[0], 4), round(pt[1], 4))


def route_signature(started_at, distance_m, coords):
    """Huella semántica del entrenamiento, o None si no hay geometría.

    Con hora, la firma es started_at al MINUTO + primer/último punto a 4 decimales
    (~11 m). Es un identificador robustísimo: dos actividades distintas tendrían
    que empezar el mismo minuto del mismo día Y compartir inicio y fin a 11 m —
    prácticamente imposible. Deliberadamente NO se incluye la distancia: al ser un
    hash por igualdad exacta, redondearla a intervalos genera falsos negativos
    justo en cada frontera del intervalo (dos exports del mismo track con ruido de
    unos metros cayendo en cubos distintos), sin aportar discriminación real sobre
    hora+extremos.

    Sin started_at (GPX sin timestamps) sí se añaden distancia (a 100 m) y nº de
    puntos como discriminadores geométricos, para no colisionar dos tracks
    distintos que compartan extremos (p.ej. ida y vuelta desde el mismo parking).
    Ahí un fallo de cubo solo provoca que se importe como nueva (comportamiento
    actual), nunca un falso positivo.
    """
    if not coords:
        return None
    parts = [str(_round_pt(coords[0])), str(_round_pt(coords[-1]))]
    if started_at:
        parts.insert(0, str(started_at)[:16])  # 'YYYY-MM-DDTHH:MM'
    else:
        dist_bucket = round((distance_m or 0) / 100.0)
        parts += [str(dist_bucket), str(len(coords))]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
