"""Tests de la sincronización delta.

Dos bloques:
  - core.sync: funciones puras (diff del manifiesto, decimado, remuestreo).
  - los triggers de sync_log: necesitan SQLite, así que montan una BD temporal
    con el mismo init_db() de producción. Es la excepción a la regla de "tests sin
    BD" de este proyecto: el comportamiento que se prueba ES el del esquema, y
    probarlo con un mock no probaría nada.
"""
import importlib
import sqlite3

import pytest

from core.sync import diff_manifest, manifest_in_sync, decimate, resample


# ── core.sync (puro) ────────────────────────────────────────────────────────

def test_diff_manifest_todo_en_orden():
    m = {"a": 1, "b": 2}
    d = diff_manifest(m, dict(m))
    assert d == {"missing": [], "stale": [], "extra": []}
    assert manifest_in_sync(d)


def test_diff_manifest_detecta_las_tres_anomalias():
    local  = {"a": 1, "b": 2, "sobrante": 9}
    remote = {"a": 1, "b": 5, "nueva": 1}
    d = diff_manifest(local, remote)
    assert d["missing"] == ["nueva"]      # está en el servidor y no en local
    assert d["stale"]   == ["b"]          # rev distinto
    assert d["extra"]   == ["sobrante"]   # tombstone perdida
    assert not manifest_in_sync(d)


def test_diff_manifest_rev_local_mayor_tambien_es_divergencia():
    # BD restaurada de un backup: el cliente va "por delante". La copia buena es
    # siempre la del servidor, así que debe salir en stale igual.
    d = diff_manifest({"a": 99}, {"a": 3})
    assert d["stale"] == ["a"]


def test_diff_manifest_vacios():
    assert manifest_in_sync(diff_manifest({}, {}))
    assert diff_manifest(None, None) == {"missing": [], "stale": [], "extra": []}
    assert diff_manifest({}, {"a": 1})["missing"] == ["a"]
    assert diff_manifest({"a": 1}, {})["extra"] == ["a"]


def test_decimate_conserva_primero_y_ultimo():
    coords = [[i, i] for i in range(10)]
    dec = decimate(coords, 4)
    assert dec[0] == coords[0]
    assert dec[-1] == coords[-1]
    assert len(dec) < len(coords)


def test_decimate_no_toca_tracks_cortos():
    assert decimate([[0, 0], [1, 1]], 4) == [[0, 0], [1, 1]]
    assert decimate([], 4) == []


def test_resample_acota_y_conserva_el_final():
    serie = [{"d": i / 10, "e": i} for i in range(5000)]
    out = resample(serie, 500)
    assert len(out) <= 501
    assert out[0] == serie[0]
    assert out[-1] == serie[-1]


def test_resample_no_toca_series_cortas():
    serie = [{"d": 0, "e": 1}, {"d": 1, "e": 2}]
    assert resample(serie, 500) == serie


# ── triggers de sync_log (con BD temporal) ──────────────────────────────────

@pytest.fixture()
def dbcon(tmp_path, monkeypatch):
    """BD temporal con el esquema real, y init_db() ejecutado DOS veces.

    Lo de las dos veces no es paranoia: gunicorn arranca 2 workers y cada uno
    corre init_db() por su cuenta (regla 13 de CLAUDE.md), así que la migración
    tiene que ser idempotente.
    """
    monkeypatch.setenv("SENDERO_DATA", str(tmp_path))
    import core.config as cfg
    importlib.reload(cfg)
    import core.database as database
    importlib.reload(database)
    database.init_db()
    database.init_db()
    con = sqlite3.connect(cfg.DB_PATH)
    con.row_factory = sqlite3.Row
    yield con
    con.close()


def _cursor(con):
    return con.execute("SELECT n FROM sync_seq WHERE id=1").fetchone()[0]


def _log(con, entity="route"):
    return con.execute(
        "SELECT entity_id, public_id, rev, op FROM sync_log WHERE entity=? ORDER BY rev",
        (entity,),
    ).fetchall()


def _add_route(con, name="Ruta", pub="pub1"):
    cur = con.execute(
        "INSERT INTO routes (name, gpx_file, public_id, created_at) VALUES (?,?,?,?)",
        (name, f"{name}.gpx", pub, "2026-01-01T00:00:00"),
    )
    con.commit()
    return cur.lastrowid


def test_insert_de_ruta_crea_fila_y_sube_el_cursor(dbcon):
    antes = _cursor(dbcon)
    rid = _add_route(dbcon)
    assert _cursor(dbcon) > antes
    rows = _log(dbcon)
    assert len(rows) == 1
    assert rows[0]["entity_id"] == rid
    assert rows[0]["op"] == "up"
    assert rows[0]["public_id"] == "pub1"


def test_update_sube_el_rev_sin_duplicar_fila(dbcon):
    rid = _add_route(dbcon)
    rev1 = _log(dbcon)[0]["rev"]
    dbcon.execute("UPDATE routes SET name='Otro' WHERE id=?", (rid,))
    dbcon.commit()
    rows = _log(dbcon)
    assert len(rows) == 1                 # sigue habiendo UNA fila por entidad
    assert rows[0]["rev"] > rev1


def test_delete_deja_tombstone_con_public_id(dbcon):
    rid = _add_route(dbcon)
    dbcon.execute("DELETE FROM routes WHERE id=?", (rid,))
    dbcon.commit()
    rows = _log(dbcon)
    assert len(rows) == 1
    assert rows[0]["op"] == "del"
    # El public_id sobrevive al borrado: es lo único que permite a un cliente
    # apagado semanas saber QUÉ ruta tiene que quitar de su copia local.
    assert rows[0]["public_id"] == "pub1"


def test_foto_sube_el_rev_de_su_ruta(dbcon):
    """Añadir o quitar una foto invalida el detalle cacheado de la ruta."""
    rid = _add_route(dbcon)
    rev0 = _log(dbcon)[0]["rev"]
    cur = dbcon.execute(
        "INSERT INTO photos (route_id, file, original) VALUES (?,?,?)",
        (rid, "f.jpg", "f.jpg"),
    )
    dbcon.commit()
    rev1 = _log(dbcon)[0]["rev"]
    assert rev1 > rev0
    # Y no crea una entidad 'photo' propia: las fotos viajan dentro del detalle.
    assert _log(dbcon, "photo") == []
    dbcon.execute("DELETE FROM photos WHERE id=?", (cur.lastrowid,))
    dbcon.commit()
    assert _log(dbcon)[0]["rev"] > rev1


def test_borrar_fotos_antes_de_la_ruta_no_pisa_la_tombstone(dbcon):
    """Orden real de delete_route(): primero las fotos, luego la ruta."""
    rid = _add_route(dbcon)
    dbcon.execute("INSERT INTO photos (route_id, file) VALUES (?,?)", (rid, "f.jpg"))
    dbcon.commit()
    dbcon.execute("DELETE FROM photos WHERE route_id=?", (rid,))
    dbcon.execute("DELETE FROM routes WHERE id=?", (rid,))
    dbcon.commit()
    rows = _log(dbcon)
    assert len(rows) == 1 and rows[0]["op"] == "del"


def test_borrar_fotos_despues_de_la_ruta_no_resucita_la_entidad(dbcon):
    """Caso inverso (si algún día se activa ON DELETE CASCADE o cambia el orden):
    el EXISTS del trigger evita que el borrado de una foto huérfana se lleve por
    delante la tombstone de su ruta."""
    rid = _add_route(dbcon)
    dbcon.execute("INSERT INTO photos (route_id, file) VALUES (?,?)", (rid, "f.jpg"))
    dbcon.commit()
    dbcon.execute("DELETE FROM routes WHERE id=?", (rid,))
    dbcon.execute("DELETE FROM photos WHERE route_id=?", (rid,))
    dbcon.commit()
    rows = _log(dbcon)
    assert len(rows) == 1
    assert rows[0]["op"] == "del"          # sigue siendo tombstone, no 'up'


def test_planes_son_entidad_propia(dbcon):
    cur = dbcon.execute(
        "INSERT INTO planned_routes (name, public_id, created_at) VALUES (?,?,?)",
        ("Plan", "plan1", "2026-01-01"),
    )
    dbcon.commit()
    rows = _log(dbcon, "planned")
    assert len(rows) == 1 and rows[0]["entity_id"] == cur.lastrowid
    dbcon.execute("DELETE FROM planned_routes WHERE id=?", (cur.lastrowid,))
    dbcon.commit()
    assert _log(dbcon, "planned")[0]["op"] == "del"


def test_revs_son_estrictamente_crecientes(dbcon):
    """El cursor de /api/sync/changes depende de que rev no se repita nunca."""
    revs = []
    for i in range(5):
        _add_route(dbcon, name=f"R{i}", pub=f"pub{i}")
        revs.append(max(r["rev"] for r in _log(dbcon)))
    assert revs == sorted(set(revs))


def test_epoch_y_min_rev_existen(dbcon):
    keys = dict(dbcon.execute(
        "SELECT key, value FROM settings WHERE key IN ('sync_epoch','sync_min_rev')"
    ).fetchall())
    assert keys.get("sync_epoch")            # token no vacío
    assert keys.get("sync_min_rev") == "0"


def test_backfill_cubre_las_filas_previas(tmp_path, monkeypatch):
    """Una BD con rutas creadas ANTES de la migración debe acabar con su fila en
    sync_log: si no, un cliente con since=0 no las vería nunca."""
    monkeypatch.setenv("SENDERO_DATA", str(tmp_path))
    import core.config as cfg
    importlib.reload(cfg)
    import core.database as database
    importlib.reload(database)
    # BD "antigua": tablas mínimas y una ruta, sin nada de sync.
    con = sqlite3.connect(cfg.DB_PATH)
    con.executescript("""
        CREATE TABLE routes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            notes TEXT DEFAULT '', gpx_file TEXT NOT NULL, distance_m REAL,
            ascent_m REAL, descent_m REAL, duration_s REAL, moving_s REAL,
            ele_min REAL, ele_max REAL, avg_speed REAL, started_at TEXT,
            geojson TEXT, elevation TEXT, created_at TEXT);
    """)
    con.execute("INSERT INTO routes (name, gpx_file) VALUES ('Vieja','v.gpx')")
    con.commit()
    con.close()

    database.init_db()

    con = sqlite3.connect(cfg.DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT entity, op, public_id FROM sync_log").fetchall()
    assert len(rows) == 1
    assert rows[0]["entity"] == "route" and rows[0]["op"] == "up"
    assert rows[0]["public_id"]           # el backfill de public_id también corrió
    con.close()
