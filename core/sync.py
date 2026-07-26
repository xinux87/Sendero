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


def decimate(coords, step=4):
    """Conserva 1 de cada `step` puntos, siempre con el primero y el último.

    Mismo criterio que /api/routes/geojson (que decima con step=4 para el mapa):
    reduce el tamaño del track sin cambiar su forma a la escala en la que se
    dibuja. El último punto se preserva explícitamente para que el track no
    aparezca cortado antes del final.
    """
    if step < 2 or len(coords) < 3:
        return list(coords)
    dec = list(coords[::step])
    if dec[-1] != coords[-1]:
        dec.append(coords[-1])
    return dec


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
