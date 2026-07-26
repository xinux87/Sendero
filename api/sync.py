"""Sincronización delta.

Tres endpoints, con tres preguntas distintas:

  GET /api/sync/state     ¿ha cambiado algo? → ETag; la respuesta normal es 304.
  GET /api/sync/changes   ¿qué ha cambiado desde `since`? → solo la diferencia.
  GET /api/sync/manifest  ¿mi copia coincide de verdad? → [public_id, rev] de todo.

El contador y las tombstones los mantienen los triggers de core/database.py; aquí
solo se leen. `rev` es un cursor opaco: no es una fecha y no debe mostrarse ni
usarse para ordenar.
"""
import json

from flask import Blueprint, jsonify, request

from core.database import db, sync_cursor, sync_epoch
from api.routes import ROUTE_LIST_COLS
from api.planned import PLANNED_LIST_COLS

sync_bp = Blueprint("sync", __name__)

# Tope de entidades por respuesta de /changes. El cliente itera hasta
# complete:true, así que un backfill de miles de rutas no monta una respuesta
# enorme ni deja al servidor construyendo JSON durante segundos.
DEFAULT_LIMIT = 500
MAX_LIMIT = 2000

_ENTITIES = (
    ("route",   "routes",         ROUTE_LIST_COLS),
    ("planned", "planned_routes", PLANNED_LIST_COLS),
)


def _min_rev(con):
    row = con.execute("SELECT value FROM settings WHERE key='sync_min_rev'").fetchone()
    try:
        return int(row[0]) if row else 0
    except (ValueError, TypeError):
        return 0


def _counts(con):
    return {
        "routes":  con.execute("SELECT COUNT(*) FROM routes").fetchone()[0],
        "planned": con.execute("SELECT COUNT(*) FROM planned_routes").fetchone()[0],
        "photos":  con.execute("SELECT COUNT(*) FROM photos").fetchone()[0],
    }


@sync_bp.route("/api/sync/state")
def sync_state():
    """Estado de la sincronización. Barato a propósito: un SELECT del contador y
    tres COUNT(*). Con If-None-Match devuelve 304 sin cuerpo, que es la respuesta
    normal cuando no ha cambiado nada — sustituye al TTL de 10 min del cliente.
    """
    con = db()
    epoch = sync_epoch(con)
    cursor = sync_cursor(con)
    etag = f"{epoch}:{cursor}"
    # Comparación tolerante (el proxy puede añadir W/ y las comillas las pone
    # set_etag): basta con que el token aparezca en la cabecera.
    if etag in (request.headers.get("If-None-Match") or ""):
        return "", 304
    resp = jsonify({
        "epoch":   epoch,
        "cursor":  cursor,
        "min_rev": _min_rev(con),
        "counts":  _counts(con),
    })
    resp.set_etag(etag)
    # no-cache, no no-store: queremos que el navegador revalide con If-None-Match
    # en cada sondeo (y que pueda contestar 304), no que se salte la caché.
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@sync_bp.route("/api/sync/changes")
def sync_changes():
    """Diferencias desde `since`.

    `since=0` (o epoch distinto) equivale a la carga inicial completa. Devuelve
    `reset:true` cuando el cliente debe vaciar su copia antes de aplicar nada:
    epoch distinto, cursor retrocedido (BD restaurada) o `since` por debajo del
    suelo de revisión.
    """
    con = db()
    epoch = sync_epoch(con)
    cursor = sync_cursor(con)
    try:
        since = int(request.args.get("since", 0))
    except (ValueError, TypeError):
        since = 0
    try:
        limit = min(int(request.args.get("limit", DEFAULT_LIMIT)), MAX_LIMIT)
    except (ValueError, TypeError):
        limit = DEFAULT_LIMIT
    limit = max(limit, 1)
    client_epoch = request.args.get("epoch") or ""

    reset = False
    if client_epoch and client_epoch != epoch:
        reset = True                     # otra BD (o restaurada de un backup)
    if since > cursor:
        reset = True                     # el contador retrocedió
    if since < _min_rev(con):
        reset = True                     # tombstones purgadas por debajo de since
    if reset:
        since = 0

    # Se pide un elemento más del límite para saber si queda cola sin devolver.
    rows = con.execute(
        "SELECT entity, entity_id, public_id, rev, op FROM sync_log "
        "WHERE rev > ? ORDER BY rev LIMIT ?",
        (since, limit + 1),
    ).fetchall()
    complete = len(rows) <= limit
    rows = rows[:limit]

    out = {e: {"upserted": [], "deleted": []} for e, _, _ in _ENTITIES}
    up_ids = {e: [] for e, _, _ in _ENTITIES}
    for r in rows:
        ent = r["entity"]
        if ent not in out:
            continue                     # entidad de una versión futura: se ignora
        if r["op"] == "del":
            if r["public_id"]:
                out[ent]["deleted"].append(r["public_id"])
        else:
            up_ids[ent].append((r["entity_id"], r["rev"]))

    # Los datos de cada upsert salen de la tabla base (no de sync_log): así el
    # public_id y el resto de campos son siempre los actuales.
    for ent, table, cols in _ENTITIES:
        ids = up_ids[ent]
        if not ids:
            continue
        revs = dict(ids)
        marks = ",".join("?" * len(ids))
        found = con.execute(
            f"SELECT {cols} FROM {table} WHERE id IN ({marks})",
            [i for i, _ in ids],
        ).fetchall()
        for row in found:
            d = dict(row)
            d["rev"] = revs.get(d["id"], 0)
            out[ent]["upserted"].append(d)
        out[ent]["upserted"].sort(key=lambda d: d["rev"])

    # Con la página completa el cursor es el global; si quedó cola, el del último
    # elemento entregado, para que la siguiente petición siga justo ahí.
    next_cursor = cursor if complete else rows[-1]["rev"]
    return jsonify({
        "epoch":    epoch,
        "cursor":   next_cursor,
        "complete": complete,
        "reset":    reset,
        "routes":   out["route"],
        "planned":  out["planned"],
    })


@sync_bp.route("/api/sync/manifest")
def sync_manifest():
    """[public_id, rev] de todas las entidades vivas: ~30 bytes por ruta.

    Permite al cliente corroborar su copia y descargar SOLO lo que divergía, en
    vez de recargar todo (core.sync.diff_manifest hace la comparación). Con 500
    rutas son ~15 KB, y flask-compress los deja en bastante menos.
    """
    con = db()
    payload = {"epoch": sync_epoch(con), "cursor": sync_cursor(con)}
    for ent, table, _ in _ENTITIES:
        rows = con.execute(
            f"SELECT t.public_id, s.rev FROM {table} t "
            f"JOIN sync_log s ON s.entity=? AND s.entity_id=t.id "
            f"WHERE t.public_id IS NOT NULL ORDER BY s.rev",
            (ent,),
        ).fetchall()
        payload["routes" if ent == "route" else ent] = [[r[0], r[1]] for r in rows]
    return jsonify(payload)
