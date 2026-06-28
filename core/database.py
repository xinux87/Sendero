import sqlite3
from flask import g
import core.config as cfg


def db():
    if "db" not in g:
        g.db = sqlite3.connect(cfg.DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    con = sqlite3.connect(cfg.DB_PATH)
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
    con.execute("CREATE INDEX IF NOT EXISTS idx_routes_date "
                "ON routes(COALESCE(started_at,created_at) DESC)")

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
