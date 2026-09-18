"""Lógica pura de la sincronización delta.

Aquí solo hay funciones sin BD ni Flask, para que se puedan probar en tests/:
el esquema (sync_seq/sync_log/triggers) vive en core/database.py y los endpoints
en api/sync.py.
"""


def diff_manifest(local, remote):
    """Compara el manifiesto local con el del servidor y dice qué hacer.

    `local` y `remote` son dicts {public_id: rev}. Responde a la pregunta
    "¿mi copia coincide con la del servidor?" sin descargar los datos, que es lo
    que un delta por `since` no puede contestar por sí solo: si un delta se cortó
    a medias, o una tombstone se perdió, el cursor puede ir por delante de lo que
    realmente tiene el cliente.

    Devuelve un dict con tres listas ordenadas:
      - missing:  están en el servidor y no en local  → descargar
      - stale:    están en los dos con rev distinto   → descargar
      - extra:    están en local y no en el servidor  → borrar del cliente

    `stale` compara por desigualdad, no por "remoto > local": un rev local mayor
    que el del servidor también es divergencia (típico de una BD restaurada de un
    backup), y en ese caso la copia buena es siempre la del servidor.
    """
    local = local or {}
    remote = remote or {}
    missing, stale = [], []
    for pid, rev in remote.items():
        if pid not in local:
            missing.append(pid)
        elif local[pid] != rev:
            stale.append(pid)
    extra = [pid for pid in local if pid not in remote]
    return {
        "missing": sorted(missing),
        "stale":   sorted(stale),
        "extra":   sorted(extra),
    }


def manifest_in_sync(diff):
    """True si un diff de diff_manifest() no requiere ninguna acción."""
    return not (diff["missing"] or diff["stale"] or diff["extra"])


def decimate(coords, step=4, keep=None):
    """Conserva 1 de cada `step` puntos, siempre con el primero y el último.

    Mismo criterio que /api/routes/geojson (que decima con step=4 para el mapa):
    reduce el tamaño del track sin cambiar su forma a la escala en la que se
    dibuja. El último punto se preserva explícitamente para que el track no
    aparezca cortado antes del final.

    `keep` son índices del array original que hay que conservar sí o sí (los
    cortes de segmento, ver decimate_with_segments): sin eso el decimado se
    comería justo el punto que marca dónde se perdió el GPS.
    """
    if step < 2 or len(coords) < 3:
        return list(coords)
    if not keep:
        dec = list(coords[::step])
        if dec[-1] != coords[-1]:
            dec.append(coords[-1])
        return dec
    return [coords[i] for i in decimate_indices(len(coords), step, keep)]


def decimate_indices(n, step=4, keep=None):
    """Índices ORIGINALES que sobreviven al decimado de `n` puntos.

    Es la misma selección que hace decimate(), pero devuelta como índices para
    poder remapear cualquier marca que apunte al array original (hoy solo
    `seg_starts`). Siempre incluye el primero y el último.
    """
    if n <= 0:
        return []
    if step < 2 or n < 3:
        return list(range(n))
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    if keep:
        extra = {i for i in keep if 0 <= i < n}
        if extra:
            idx = sorted(set(idx) | extra)
    return idx


def remap_indices(marks, kept):
    """Traduce índices del array original a índices del array decimado.

    `kept` es la salida de decimate_indices() (ordenada). Una marca que no
    sobreviviera al decimado se ajusta al primer punto conservado a partir de
    ella, así que nunca devuelve un índice fuera de rango.
    """
    if not kept:
        return []
    out = set()
    for m in (marks or []):
        # búsqueda binaria: primer kept >= m
        lo, hi = 0, len(kept) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if kept[mid] < m:
                lo = mid + 1
            else:
                hi = mid
        out.add(lo if kept[lo] >= m else len(kept) - 1)
    return sorted(out)


def decimate_with_segments(coords, seg_starts, step=4):
    """Decima el track SIN perder los cortes de segmento y remapea sus índices.

    Devuelve `(coords_decimados, seg_starts_decimados)`. Existe porque un track
    con varios <trkseg> (pérdida de GPS, o dos rutas unidas) se dibuja como un
    solo LineString y cada corte se vería como una línea recta que parece
    camino: el cliente necesita saber DÓNDE están esos cortes también en la
    variante ligera (?lite=1), que es la que pinta el detalle.

    Se conservan el punto de inicio de cada segmento Y el último del anterior,
    para que el hueco dibujado sea exactamente el hueco real y no se trague
    hasta `step-1` puntos de track de verdad.
    """
    marks = [i for i in (seg_starts or []) if 0 <= i < len(coords)]
    if step < 2 or len(coords) < 3:
        return list(coords), list(marks)
    if len(marks) < 2:
        # 0 o 1 segmento: no hay ningún corte que dibujar, y el índice 0 (si lo
        # hay) sobrevive siempre al decimado.
        return decimate(coords, step), list(marks)
    keep = set(marks) | {m - 1 for m in marks if m > 0}
    kept = decimate_indices(len(coords), step, keep)
    return [coords[i] for i in kept], remap_indices(marks, kept)


def resample(series, n=500):
    """Remuestrea una serie [{d,...}, …] a como máximo `n` puntos.

    Para el modo ligero del detalle (?lite=1): las series de elevación/FC/
    velocidad de una ruta larga traen miles de puntos, y una gráfica de 600 px no
    puede dibujar más de unos cientos. Se toma un paso constante y se conserva
    siempre el último punto, para no recortar el final del perfil.
    """
    if n < 2 or len(series) <= n:
        return list(series)
    step = len(series) / float(n)
    out = [series[int(i * step)] for i in range(n)]
    if out[-1] is not series[-1]:
        out.append(series[-1])
    return out
