"""Sincronizador de Mi Fit / Zepp para auto-importación de rutas.

Proceso INDEPENDIENTE (un segundo/tercer servicio en docker-compose, como el
watcher), no un hilo dentro de gunicorn: así solo hay un importador aunque el
web corra con varios workers.

Cada MIFIT_POLL segundos lee los ajustes de la BD (settings) y decide si toca
sincronizar (por intervalo o por petición manual del botón de Ajustes). Al
sincronizar, descarga los entrenamientos nuevos de Huami como GPX y los sube a
Sendero por su propia API (/api/routes), igual que watch.py — reutilizando así
la generación de thumbnail y la detección de actividad. El estado (última sync,
resultado, errores) se escribe de vuelta en settings para que la UI lo lea.

Comunicación con el web SOLO por la BD de settings (mismo bus que usa
refresh_config): ningún socket ni cola nueva.
"""
import datetime as dt
import json
import logging
import os
import sqlite3
import time

import requests

import core.config as cfg
from core.mifit.api import Api, TokenExpiredError
from core.mifit.sync import iter_new_workouts

API = os.environ.get("SENDERO_API", "http://sendero:8080").rstrip("/")
POLL = int(os.environ.get("MIFIT_POLL", "30"))
# Cada cuántas rutas procesadas se persiste la marca incremental a mitad de un
# backfill (para no re-descargar todo si el proceso se interrumpe).
WATERMARK_FLUSH_EVERY = int(os.environ.get("MIFIT_WATERMARK_FLUSH_EVERY", "10"))
# Servicio de autenticación (fase 4). Vacío = sin refresco silencioso de token.
AUTH_URL = os.environ.get("MIFIT_AUTH_URL", "").rstrip("/")

LOG = logging.getLogger("mifit_sync")


# ── acceso a settings (conexión propia; el web usa la suya) ──────────────────
def _con():
    con = sqlite3.connect(cfg.DB_PATH)
    con.execute("PRAGMA busy_timeout=20000")
    return con


def read_settings():
    try:
        con = _con()
        rows = dict(con.execute("SELECT key, value FROM settings").fetchall())
        con.close()
        return rows
    except Exception as e:
        # La tabla puede no existir aún si el web no ha arrancado init_db().
        LOG.debug("No se pudieron leer settings todavía: %s", e)
        return {}


def set_settings(**kv):
    con = _con()
    for key, value in kv.items():
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    (key, str(value)))
    con.commit()
    con.close()


# ── subida a Sendero (misma semántica que watch.py: 201 nueva / 409 dup) ─────
def _post_gpx(name: str, gpx_str: str):
    """Sube un GPX. Devuelve (status_code, soft_dup): 201 nueva / 409 duplicada
    exacta (se descarta). soft_dup=True cuando entró (201) pero el servidor la
    marcó como posible duplicada semántica (dup_suspect_of) para revisión."""
    r = requests.post(
        f"{API}/api/routes?auto=1",  # auto: la dup blanda se importa marcada, no bloquea
        files={"gpx": (name, gpx_str.encode("utf-8"), "application/gpx+xml")},
        timeout=120,
    )
    if r.status_code not in (201, 409):
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:120]}")
    soft = False
    if r.status_code == 201:
        try:
            soft = bool(r.json().get("soft_duplicate"))
        except ValueError:
            pass
    return r.status_code, soft


def effective_since(rows: dict) -> int:
    """Suelo de trackid para la importación: el máximo entre la marca incremental
    (MIFIT_LAST_TRACKID) y el suelo de fecha (MIFIT_SINCE_DATE). Así la primera
    sync no se trae todo el historial si el usuario fija una fecha de inicio.
    trackid = timestamp Unix de inicio del entrenamiento."""
    try:
        since = int(rows.get("MIFIT_LAST_TRACKID") or 0)
    except (ValueError, TypeError):
        since = 0
    since_date = (rows.get("MIFIT_SINCE_DATE") or "").strip()
    if since_date:
        try:
            floor_ts = int(dt.datetime.strptime(since_date, "%Y-%m-%d")
                           .replace(tzinfo=dt.timezone.utc).timestamp())
            since = max(since, floor_ts - 1)  # -1 para incluir el propio día elegido
        except ValueError:
            LOG.warning("MIFIT_SINCE_DATE inválida (%r), se ignora", since_date)
    return since


def do_sync(rows: dict):
    token = (rows.get("MIFIT_TOKEN") or "").strip()
    if not token:
        set_settings(MIFIT_STATUS="no_token")
        LOG.info("Sin token de Mi Fit/Zepp; nada que sincronizar")
        return
    endpoint = (rows.get("MIFIT_ENDPOINT") or "https://api-mifit.huami.com").rstrip("/")
    since = effective_since(rows)

    set_settings(MIFIT_STATUS="running")
    LOG.info("Sincronizando desde trackid > %s (%s)", since, endpoint)
    api = Api(endpoint, token)

    nuevas = duplicadas = sospechosas = errores = 0
    # watermark avanza solo por un prefijo contiguo de éxitos: si un workout
    # falla, no saltamos por encima de él (se reintenta en la próxima sync).
    watermark = since
    saved_watermark = since
    prefix_ok = True
    try:
        for trackid, name, gpx in iter_new_workouts(api, since_trackid=since):
            try:
                code, soft = _post_gpx(name, gpx)
            except Exception as e:
                errores += 1
                prefix_ok = False
                LOG.warning("Error subiendo %s: %s", name, e)
                continue
            if code == 201:
                # La sospechosa SÍ se importó (está marcada para revisión), así que
                # el watermark avanza igual: no hay que re-descargarla.
                if soft:
                    sospechosas += 1
                    LOG.info("Importado %s (posible duplicada, marcada)", name)
                else:
                    nuevas += 1
                    LOG.info("Importado %s", name)
            else:  # 409
                duplicadas += 1
            if prefix_ok:
                watermark = trackid
                # Persistir la marca cada WATERMARK_FLUSH_EVERY para que un backfill
                # largo interrumpido (reinicio del contenedor, crash) no vuelva a
                # descargar todo desde el principio la próxima vez.
                if watermark > saved_watermark and \
                        (nuevas + duplicadas + sospechosas) % WATERMARK_FLUSH_EVERY == 0:
                    set_settings(MIFIT_LAST_TRACKID=watermark)
                    saved_watermark = watermark
    except TokenExpiredError:
        LOG.warning("Token caducado durante la sincronización")
        # Fase 4: aquí se intentará un refresco silencioso vía mifit-auth.
        status = "needs_login" if AUTH_URL else "token_expired"
        upd = {
            "MIFIT_STATUS": status,
            "MIFIT_LAST_RESULT": json.dumps({
                "nuevas": nuevas, "duplicadas": duplicadas,
                "sospechosas": sospechosas, "errores": errores,
                "mensaje": "El token ha caducado; reconecta tu cuenta.",
            }),
        }
        if watermark > saved_watermark:  # no perder el progreso del backfill
            upd["MIFIT_LAST_TRACKID"] = watermark
        set_settings(**upd)
        return
    except Exception as e:
        LOG.exception("Fallo en la sincronización")
        upd = {
            "MIFIT_STATUS": "error",
            "MIFIT_LAST_RESULT": json.dumps({
                "nuevas": nuevas, "duplicadas": duplicadas,
                "sospechosas": sospechosas, "errores": errores,
                "mensaje": f"Error: {e}",
            }),
        }
        if watermark > saved_watermark:  # no perder el progreso del backfill
            upd["MIFIT_LAST_TRACKID"] = watermark
        set_settings(**upd)
        return

    updates = {
        "MIFIT_LAST_SYNC": dt.datetime.now().isoformat(),
        "MIFIT_LAST_RESULT": json.dumps({
            "nuevas": nuevas, "duplicadas": duplicadas,
            "sospechosas": sospechosas, "errores": errores,
            "mensaje": f"{nuevas} nuevas, {duplicadas} duplicadas"
                       + (f", {sospechosas} posibles duplicadas" if sospechosas else "")
                       + (f", {errores} con error" if errores else ""),
        }),
        "MIFIT_STATUS": "ok" if errores == 0 else "error",
    }
    if watermark > since:
        updates["MIFIT_LAST_TRACKID"] = watermark
    set_settings(**updates)
    LOG.info("Sync terminada: %d nuevas, %d duplicadas, %d sospechosas, %d errores",
             nuevas, duplicadas, sospechosas, errores)


def _is_due(rows: dict) -> bool:
    """¿Toca sincronizar ya? Por petición manual (flag) o por intervalo."""
    if (rows.get("MIFIT_SYNC_REQUESTED") or "").strip():
        return True
    if (rows.get("MIFIT_ENABLED") or "0") != "1":
        return False
    try:
        interval = int(rows.get("MIFIT_INTERVAL_MIN") or 0)
    except (ValueError, TypeError):
        interval = 0
    if interval <= 0:
        return False
    last = rows.get("MIFIT_LAST_SYNC")
    if not last:
        return True
    try:
        elapsed = (dt.datetime.now() - dt.datetime.fromisoformat(last)).total_seconds()
    except (ValueError, TypeError):
        return True
    return elapsed >= interval * 60


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    LOG.info("mifit_sync iniciado (poll %ss) -> %s", POLL, API)
    while True:
        rows = read_settings()
        if _is_due(rows):
            # Consumimos la petición manual antes de sincronizar: si llega otra
            # durante la sync, se atenderá en la siguiente vuelta.
            if (rows.get("MIFIT_SYNC_REQUESTED") or "").strip():
                set_settings(MIFIT_SYNC_REQUESTED="")
            try:
                do_sync(rows)
            except Exception:
                LOG.exception("Error inesperado en do_sync")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
