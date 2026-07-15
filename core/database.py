import json
import sqlite3
from flask import g
import core.config as cfg


# Gunicorn arranca varios workers (procesos) que abren su propia conexión sqlite3
# contra el mismo archivo. Sin busy_timeout, una escritura concurrente de otro
# worker/proceso (p.ej. dos workers corriendo init_db() a la vez al arrancar, o un
# request normal mientras otro escribe) falla al instante con "database is locked"
# en vez de esperar a que se libere; con esto esperan hasta 20s antes de fallar.
BUSY_TIMEOUT_MS = 20000


def db():
    if "db" not in g:
        g.db = sqlite3.connect(cfg.DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        # En WAL (activado en init_db), NORMAL solo arriesga durabilidad de los
        # últimos commits ante un corte de luz, nunca corrupción; evita un fsync
        # por commit. Sin WAL (fallback) sqlite lo trata igual de seguro que FULL
        # para este patrón de uso.
        g.db.execute("PRAGMA synchronous=NORMAL")
    return g.db


def close_db(exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    con = sqlite3.connect(cfg.DB_PATH)
    con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    # WAL: lectores no bloquean al escritor ni viceversa — importa con 2 workers
    # de gunicorn + watcher subiendo rutas. Es persistente (queda grabado en el
    # archivo), así que basta activarlo aquí. Defensivo: si el filesystem no
    # soporta WAL (p.ej. un bind mount raro), sqlite devuelve el modo anterior
    # en vez de fallar — se sigue funcionando en modo delete como hasta ahora.
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            notes TEXT DEFAULT '',
            gpx_file TEXT NOT NULL,
            distance_m REAL, ascent_m REAL, descent_m REAL,
            duration_s REAL, moving_s REAL,
            ele_min REAL, ele_max REAL,
            avg_speed REAL,
            started_at TEXT,
            geojson TEXT, elevation TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL,
            file TEXT,
            immich_id TEXT,
            original TEXT,
            lat REAL, lon REAL,
            taken_at TEXT,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
        );
        """
    )
    photo_cols = [r[1] for r in con.execute("PRAGMA table_info(photos)").fetchall()]
    if "immich_id" not in photo_cols:
        con.execute("ALTER TABLE photos ADD COLUMN immich_id TEXT")
    route_cols = [r[1] for r in con.execute("PRAGMA table_info(routes)").fetchall()]
    if "activity_type" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN activity_type TEXT")
    if "device" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN device TEXT")
    if "immich_checked" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN immich_checked INTEGER DEFAULT 0")
    if "heart_rate" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN heart_rate TEXT")
    if "hr_avg" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN hr_avg INTEGER")
    if "hr_max" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN hr_max INTEGER")
    if "speed" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN speed TEXT")
    if "gps_issues" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN gps_issues TEXT")
    if "start_lat" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN start_lat REAL")
        con.execute("ALTER TABLE routes ADD COLUMN start_lon REAL")
        con.execute("""UPDATE routes
                       SET start_lat = CAST(json_extract(geojson,'$[0][1]') AS REAL),
                           start_lon = CAST(json_extract(geojson,'$[0][0]') AS REAL)
                       WHERE geojson IS NOT NULL AND geojson != '[]'""")
    if "thumb_file" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN thumb_file TEXT")
    # Deduplicación de importaciones (ver core/dedup.py y CLAUDE.md):
    #   content_hash   — SHA-256 de los bytes crudos (dup exacta → 409 duro)
    #   signature      — huella semántica del track (dup blanda)
    #   dup_suspect_of — id de la ruta a la que se parece, si la ingesta AUTO la
    #                    importó pese al aviso semántico (NULL = limpia)
    # ALTER TABLE envuelto por si 2 workers corren init_db() a la vez (regla 13).
    for _col, _decl in (("content_hash", "TEXT"),
                        ("signature", "TEXT"),
                        ("dup_suspect_of", "INTEGER")):
        if _col not in route_cols:
            try:
                con.execute(f"ALTER TABLE routes ADD COLUMN {_col} {_decl}")
                con.commit()
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e):
                    raise
    # Bounding box de cada track, para poder pedir al mapa del dashboard solo las
    # rutas que caen dentro de la zona visible (en vez de las líneas de todas
    # siempre). create_route/rescan_route la rellenan al guardar cada ruta; no
    # hay backfill para rutas ya existentes (la base de partida está vacía).
    # Gunicorn arranca 2 workers que ejecutan init_db() cada uno por su cuenta:
    # el ALTER TABLE puede fallar con "duplicate column" si el otro worker ya lo
    # añadió justo antes, así que se tolera ese error concreto en vez de tumbar
    # el worker.
    if "bbox_min_lon" not in route_cols:
        try:
            con.execute("ALTER TABLE routes ADD COLUMN bbox_min_lon REAL")
            con.execute("ALTER TABLE routes ADD COLUMN bbox_min_lat REAL")
            con.execute("ALTER TABLE routes ADD COLUMN bbox_max_lon REAL")
            con.execute("ALTER TABLE routes ADD COLUMN bbox_max_lat REAL")
            con.commit()
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    con.execute("CREATE INDEX IF NOT EXISTS idx_routes_date "
                "ON routes(COALESCE(started_at,created_at) DESC)")
    # Índice compacto solo con el bbox (sin las demás columnas): permite descartar
    # rápidamente qué rutas caen fuera de la zona visible sin tocar la fila completa
    # (y por tanto sin atravesar geojson/elevation/heart_rate) para las que no caen dentro.
    con.execute("""CREATE INDEX IF NOT EXISTS idx_routes_bbox ON routes(
        bbox_min_lon, bbox_max_lon, bbox_min_lat, bbox_max_lat
    )""")
    # Índices de cobertura: start_lat/start_lon/thumb_file/activity_type se añadieron
    # con ALTER TABLE, así que quedan físicamente DESPUÉS de geojson/elevation/heart_rate
    # en cada fila. Sin estos índices, SQLite tiene que atravesar esos blobs (cientos de
    # KB por ruta) solo para llegar a estas columnas pequeñas, lo que hace que listar las
    # rutas (sin pedir geojson) tarde segundos en vez de milisegundos a partir de unas
    # pocas centenas de rutas.
    # Nombre nuevo (_cov2) porque el listado ahora lee también dup_suspect_of: un
    # CREATE ... IF NOT EXISTS sobre el nombre viejo no lo recrearía con la columna
    # añadida, así que se crea el nuevo y se descarta el anterior (regla 12).
    con.execute("""CREATE INDEX IF NOT EXISTS idx_routes_list_cov2 ON routes(
        COALESCE(started_at,created_at) DESC,
        id, name, distance_m, ascent_m, duration_s, moving_s, started_at,
        activity_type, start_lat, start_lon, thumb_file, dup_suspect_of
    )""")
    con.execute("DROP INDEX IF EXISTS idx_routes_list_cov")
    con.execute("""CREATE INDEX IF NOT EXISTS idx_routes_stats_cov ON routes(
        activity_type, distance_m, ascent_m, moving_s, avg_speed, started_at, name
    )""")
    # Lookups de dedup por valor exacto (create_route): su propio índice, no de
    # cobertura — solo se busca "¿existe una fila con este hash / esta firma?".
    con.execute("CREATE INDEX IF NOT EXISTS idx_routes_content_hash ON routes(content_hash)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_routes_signature ON routes(signature)")
    # Backfill único de las rutas ya existentes (las importadas antes de esta
    # migración tienen hash/firma NULL y no se detectarían al reimportarse). La
    # firma sale de la BD (barata); el content_hash requiere leer el archivo
    # activo una vez. Idempotente: solo toca filas con content_hash NULL, así que
    # tras la primera pasada no vuelve a leer archivos. Tolera archivos ausentes.
    from core.dedup import content_hash as _chash, route_signature as _sig
    pending = con.execute(
        "SELECT id, gpx_file, started_at, distance_m, geojson "
        "FROM routes WHERE content_hash IS NULL"
    ).fetchall()
    for _r in pending:
        _sets, _params = [], []
        try:
            _coords = json.loads(_r[4] or "[]")
        except (ValueError, TypeError):
            _coords = []
        _s = _sig(_r[2], _r[3], _coords)
        if _s:
            _sets.append("signature=?"); _params.append(_s)
        try:
            _sets.append("content_hash=?")
            _params.append(_chash((cfg.GPX_DIR / _r[1]).read_bytes()))
        except OSError:
            _sets.pop()  # no se pudo leer el archivo: deja content_hash NULL
        if _sets:
            _params.append(_r[0])
            con.execute(f"UPDATE routes SET {', '.join(_sets)} WHERE id=?", _params)
    con.commit()

    con.executescript("""
        CREATE TABLE IF NOT EXISTS planned_routes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            source      TEXT DEFAULT 'gpx',
            source_url  TEXT,
            activity_type TEXT,
            distance_m  REAL,
            ascent_m    REAL,
            descent_m   REAL,
            ele_min     REAL,
            ele_max     REAL,
            start_lat   REAL,
            start_lon   REAL,
            geojson     TEXT,
            elevation   TEXT,
            notes       TEXT DEFAULT '',
            gpx_data    BLOB,
            created_at  TEXT
        );
    """)

    # Historial de versiones del editor de rutas. Los archivos viven en
    # data/gpx/versions/<route_id>/v<N>.<ext> (inmutables, append-only); aquí solo
    # metadatos. Una ruta nunca editada no tiene filas (versión efectiva 0).
    # Invariante: el archivo activo en data/gpx/ == la versión más alta.
    # Solo CREATE ... IF NOT EXISTS → re-ejecutable por 2 workers en paralelo
    # sin try/except (regla 13 de CLAUDE.md).
    con.executescript("""
        CREATE TABLE IF NOT EXISTS route_versions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id   INTEGER NOT NULL,
            version_n  INTEGER NOT NULL,
            file       TEXT NOT NULL,
            summary    TEXT DEFAULT '',
            distance_m REAL,
            ascent_m   REAL,
            n_points   INTEGER,
            created_at TEXT,
            UNIQUE(route_id, version_n)
        );
    """)
    # Índice de cobertura del panel de historial (regla 12): resuelve el listado
    # completo sin tocar la fila.
    con.execute("""CREATE INDEX IF NOT EXISTS idx_route_versions_route
        ON route_versions(route_id, version_n DESC, summary, distance_m,
                          ascent_m, n_points, created_at, file)""")

    # Columna heredada del planner interno (ya eliminado): nada la lee ni la
    # escribe, pero se conserva la migración para no reconstruir la tabla.
    # Puede ejecutarse dos veces en paralelo (regla 13).
    plan_cols = [r[1] for r in con.execute("PRAGMA table_info(planned_routes)").fetchall()]
    if "draw_anchors" not in plan_cols:
        try:
            con.execute("ALTER TABLE planned_routes ADD COLUMN draw_anchors TEXT")
            con.commit()
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise

    con.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    """)
    con.commit()
    con.close()
