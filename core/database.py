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
    return g.db


def close_db(exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    con = sqlite3.connect(cfg.DB_PATH)
    con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
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
    if "start_lat" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN start_lat REAL")
        con.execute("ALTER TABLE routes ADD COLUMN start_lon REAL")
        con.execute("""UPDATE routes
                       SET start_lat = CAST(json_extract(geojson,'$[0][1]') AS REAL),
                           start_lon = CAST(json_extract(geojson,'$[0][0]') AS REAL)
                       WHERE geojson IS NOT NULL AND geojson != '[]'""")
    if "thumb_file" not in route_cols:
        con.execute("ALTER TABLE routes ADD COLUMN thumb_file TEXT")
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
    con.execute("""CREATE INDEX IF NOT EXISTS idx_routes_list_cov ON routes(
        COALESCE(started_at,created_at) DESC,
        id, name, distance_m, ascent_m, duration_s, moving_s, started_at,
        activity_type, start_lat, start_lon, thumb_file
    )""")
    con.execute("""CREATE INDEX IF NOT EXISTS idx_routes_stats_cov ON routes(
        activity_type, distance_m, ascent_m, moving_s, avg_speed, started_at, name
    )""")

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

    con.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    """)
    con.commit()
    con.close()
