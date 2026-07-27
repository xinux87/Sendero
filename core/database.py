import json
import secrets
import sqlite3
from flask import abort, g
import core.config as cfg


def new_token():
    """Token público opaco (no secuencial) para URLs de rutas/fotos.

    ~11 chars URL-safe (A-Za-z0-9_-), 64 bits: no adivinable ni enumerable, así
    CrowdSec no ve un patrón secuencial al pedir las miniaturas del listado.
    """
    return secrets.token_urlsafe(8)


# Gunicorn arranca varios workers (procesos) que abren su propia conexión sqlite3
# contra el mismo archivo. Sin busy_timeout, una escritura concurrente de otro
# worker/proceso (p.ej. dos workers corriendo init_db() a la vez al arrancar, o un
# request normal mientras otro escribe) falla al instante con "database is locked"
# en vez de esperar a que se libere; con esto esperan hasta 20s antes de fallar.
BUSY_TIMEOUT_MS = 20000

# ── resumen de gps_issues para el LISTADO ────────────────────────────────────
# La tarjeta de "Mis Rutas" necesita saber si una ruta tiene avisos GPS y
# cuántos, pero NO el JSON entero: pesa (un track ruidoso tiene decenas de
# tramos) y en el listado no se usa ninguno de sus campos. Estas dos
# expresiones lo resumen en dos enteros.
#
# Van DENTRO del índice de cobertura del listado (índice sobre expresiones), y
# ese es todo el truco: `gps_issues` se añadió con ALTER TABLE, así que vive
# físicamente DETRÁS de los blobs geojson/elevation/heart_rate de cada fila y
# leerla obliga a SQLite a atravesarlos (regla 12). Guardando el RESULTADO en
# el índice, la query se resuelve sin tocar la fila. Guardar el JSON crudo en
# el índice también funcionaría, pero ocupa casi el doble (152 KiB vs 80 KiB
# con 500 rutas) y crece con lo ruidoso que sea cada track.
#
# OJO: el texto de la expresión en la query y en el CREATE INDEX debe ser
# IDÉNTICO o SQLite no reconocerá el índice como de cobertura y volverá a
# atravesar los blobs. Por eso viven aquí y las importa api/routes.py
# (ROUTE_LIST_COLS), en vez de estar escritas dos veces.
#   json_valid() como guarda: gps_issues es NULL en la inmensa mayoría de
#   rutas, y en bases antiguas puede ser 'null' o '[]'; json_valid(NULL) es
#   NULL, así que ambas caen en el ELSE y dan 0.
#   '"high"' entrecomillado: la única vez que ese literal aparece en el JSON es
#   como valor de "severity" (los tipos son speed/elevation/altitude), y
#   funciona tanto con separadores compactos como con los de json.dumps.
GPS_ISSUES_N_SQL = ("CASE WHEN json_valid(gps_issues) "
                    "THEN json_array_length(gps_issues) ELSE 0 END")
GPS_ISSUES_HIGH_SQL = ("CASE WHEN gps_issues IS NOT NULL "
                       "AND instr(gps_issues,'\"high\"')>0 THEN 1 ELSE 0 END")


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


def rid_from_public(pub):
    """public_id → id entero interno de la ruta. 404 si no existe.

    Se llama en la 1ª línea de cada endpoint que antes tomaba <int:rid>: a partir
    de ahí el resto del handler opera con el entero como siempre.
    """
    row = db().execute("SELECT id FROM routes WHERE public_id=?", (pub,)).fetchone()
    if not row:
        abort(404)
    return row["id"]


def pid_from_public(pub):
    """public_id → id entero interno de la foto. 404 si no existe."""
    row = db().execute("SELECT id FROM photos WHERE public_id=?", (pub,)).fetchone()
    if not row:
        abort(404)
    return row["id"]


def plan_id_from_public(pub):
    """public_id → id entero interno de la ruta planificada. 404 si no existe."""
    row = db().execute("SELECT id FROM planned_routes WHERE public_id=?",
                       (pub,)).fetchone()
    if not row:
        abort(404)
    return row["id"]


def set_public_id(con, table, row_id):
    """Asigna un public_id nuevo a una fila recién insertada y lo devuelve.

    Para INSERTs que no lo fijan en línea (split/merge de rutas, subida de fotos).
    Reintenta si el token aleatorio choca con el índice UNIQUE (casi imposible).
    """
    while True:
        token = new_token()
        try:
            con.execute(f"UPDATE {table} SET public_id=? WHERE id=?", (token, row_id))
            return token
        except sqlite3.IntegrityError:
            continue


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
    # public_id: identificador opaco no secuencial expuesto en las URLs (la PK
    # entera se queda interna). Evita que /api/photos/<pid>/file sea enumerable.
    # ALTER envuelto por si 2 workers corren init_db() a la vez (regla 13).
    if "public_id" not in photo_cols:
        try:
            con.execute("ALTER TABLE photos ADD COLUMN public_id TEXT")
            con.commit()
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
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
    # locality: sitio donde se hizo la ruta (geocoding inverso del punto de
    # inicio, core/geocode.py). Se rellena best-effort al importar y al reescanear
    # una ruta que aún no la tenga; NULL = sin localidad (servicio desactivado o
    # geocoding fallido). Se lee en el listado → va en idx_routes_list_cov4.
    # public_id: identificador opaco no secuencial expuesto en las URLs de la ruta
    # (/api/routes/<public_id>/...). La PK entera se queda interna. Se lee en el
    # listado → va en idx_routes_list_cov4 (regla 12) y lleva índice UNIQUE propio.
    for _col, _decl in (("content_hash", "TEXT"),
                        ("signature", "TEXT"),
                        ("dup_suspect_of", "INTEGER"),
                        ("locality", "TEXT"),
                        ("public_id", "TEXT")):
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
    # Nombre nuevo (_cov3) porque el listado ahora lee también locality: un
    # CREATE ... IF NOT EXISTS sobre el nombre viejo no lo recrearía con la
    # columna añadida (regla 12). Se crean el nuevo y se descartan los anteriores.
    # Nombre nuevo (_cov5) porque el listado ahora lleva además el resumen de
    # gps_issues (nº de avisos y si alguno es grave). No son columnas: son las
    # EXPRESIONES de GPS_ISSUES_N_SQL/GPS_ISSUES_HIGH_SQL, guardadas ya
    # calculadas en el índice para no tener que leer gps_issues de la fila (que
    # está detrás de los blobs). El texto debe coincidir carácter a carácter con
    # el de ROUTE_LIST_COLS: por eso se interpolan las mismas constantes.
    con.execute(f"""CREATE INDEX IF NOT EXISTS idx_routes_list_cov5 ON routes(
        COALESCE(started_at,created_at) DESC,
        id, name, distance_m, ascent_m, duration_s, moving_s, started_at,
        activity_type, start_lat, start_lon, thumb_file, dup_suspect_of, locality,
        public_id, {GPS_ISSUES_N_SQL}, {GPS_ISSUES_HIGH_SQL}
    )""")
    con.execute("DROP INDEX IF EXISTS idx_routes_list_cov")
    con.execute("DROP INDEX IF EXISTS idx_routes_list_cov2")
    con.execute("DROP INDEX IF EXISTS idx_routes_list_cov3")
    con.execute("DROP INDEX IF EXISTS idx_routes_list_cov4")
    # El listado cuenta las fotos de cada ruta con un subselect correlacionado
    # (una por fila). Sin este índice SQLite se fabrica un "AUTOMATIC COVERING
    # INDEX" sobre photos en CADA petición, cuyo coste crece con el total de
    # fotos; con él son 500 búsquedas en un índice de cobertura.
    con.execute("CREATE INDEX IF NOT EXISTS idx_photos_route ON photos(route_id)")
    # Si esta BD tiene estadísticas (alguien corrió ANALYZE alguna vez), un índice
    # RECIÉN creado no aparece en sqlite_stat1 y el planificador lo descarta a
    # favor de uno con estadísticas: la query del listado se resolvería por
    # idx_routes_date leyendo la fila completa, o sea atravesando los blobs, que
    # es justo el problema que el índice de cobertura evita (25 ms vs 1,4 ms con
    # 500 rutas medidos al añadir cov5; el bug de 7-9 s de CLAUDE.md es este
    # mismo con la caché fría). Se re-analiza UNA vez, solo si hay stats y les
    # falta el índice nuevo. Sin sqlite_stat1 no hace falta: sin estadísticas
    # todos los índices parten iguales y el de cobertura gana solo.
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                   "AND name='sqlite_stat1'").fetchone():
        if not con.execute("SELECT 1 FROM sqlite_stat1 WHERE idx=?",
                           ("idx_routes_list_cov5",)).fetchone():
            try:
                con.execute("ANALYZE routes")
                con.execute("ANALYZE photos")
                con.commit()
            except sqlite3.OperationalError:
                pass          # otro worker lo está haciendo: con uno basta
    # Lookups de public_id → id en el borde de cada endpoint; UNIQUE por tabla.
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_public_id ON routes(public_id)")
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_public_id ON photos(public_id)")
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

    # Backfill de public_id para filas previas a esta migración (public_id NULL).
    # Idempotente (solo toca NULLs) y tolerante a la carrera de 2 workers: el
    # UPDATE lleva "AND public_id IS NULL" (el que pierda no pisa el token del que
    # ganó) y reintenta si el token aleatorio choca con el índice UNIQUE.
    for _tbl in ("routes", "photos"):
        _ids = [row[0] for row in con.execute(
            f"SELECT id FROM {_tbl} WHERE public_id IS NULL").fetchall()]
        for _id in _ids:
            while True:
                try:
                    con.execute(
                        f"UPDATE {_tbl} SET public_id=? WHERE id=? AND public_id IS NULL",
                        (new_token(), _id))
                    break
                except sqlite3.IntegrityError:
                    continue  # colisión UNIQUE (rarísima): otro token
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

    # Limpieza del planner interno (implementado y revertido el mismo día): la
    # columna draw_anchors nunca llegó a leerse ni escribirse, y hasta la v0.9.6
    # aquí se AÑADÍA para no reconstruir la tabla. Ahora se quita: no está en
    # ningún índice ni la nombra ningún trigger, así que el DROP no arrastra nada
    # (comprobado con 200 filas: gpx_data sale intacto byte a byte, los dos
    # índices sobreviven, el listado sigue resolviéndose por
    # idx_planned_list_cov y los 3 triggers de sync siguen moviendo el cursor).
    # Va por PRAGMA + try/except porque el segundo worker lanza "no such column"
    # (regla 13), y las bases nuevas ya nacen sin ella.
    plan_cols = [r[1] for r in con.execute("PRAGMA table_info(planned_routes)").fetchall()]
    if "draw_anchors" in plan_cols:
        try:
            con.execute("ALTER TABLE planned_routes DROP COLUMN draw_anchors")
            con.commit()
        except sqlite3.OperationalError:
            # Se tragan TODAS a propósito: "no such column" es el otro worker
            # adelantándose, y en SQLite < 3.35 el DROP no existe siquiera. En
            # ambos casos la columna sobrando no rompe nada (nadie la lee) y
            # tumbar el arranque por una limpieza cosmética sí.
            pass

    con.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    """)
    con.commit()

    # ── public_id de las rutas planificadas ──────────────────────────────────
    # Mismo criterio que en routes/photos (v0.5.2): identificador opaco no
    # secuencial para las URLs (/Plan/<public_id>) y clave estable de la
    # sincronización. La PK entera se queda interna.
    if "public_id" not in plan_cols:
        try:
            con.execute("ALTER TABLE planned_routes ADD COLUMN public_id TEXT")
            con.commit()
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_planned_public_id "
                "ON planned_routes(public_id)")
    # ── plan realizado ──────────────────────────────────────────────────────
    # `completed_at` (ISO, cuándo se marcó) y `completed_route_id` (la ruta real
    # que lo cumplió, id interno; NULL = marcada sin ruta asociada). Sin FK a
    # propósito: PRAGMA foreign_keys está apagado (regla 14) y si esa ruta se
    # borra, el subselect de PLANNED_LIST_COLS devuelve NULL y la tarjeta queda
    # como "realizada, sin ruta" en vez de romperse.
    for _col, _type in (("completed_at", "TEXT"), ("completed_route_id", "INTEGER")):
        if _col not in plan_cols:
            try:
                con.execute(f"ALTER TABLE planned_routes ADD COLUMN {_col} {_type}")
                con.commit()
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e):
                    raise
    # Índice de cobertura del listado (regla 12): public_id y las demás columnas
    # pequeñas se leen juntas en /api/planned, y en esta tabla vienen físicamente
    # DESPUÉS de geojson/elevation/gpx_data (un BLOB con el GPX entero).
    # cov2 sustituye a cov (añade completed_at/completed_route_id): dejar los dos
    # duplicaría el coste de escritura.
    con.execute("DROP INDEX IF EXISTS idx_planned_list_cov")
    con.execute("""CREATE INDEX IF NOT EXISTS idx_planned_list_cov2 ON planned_routes(
        created_at DESC,
        id, name, source, source_url, activity_type, distance_m, ascent_m,
        descent_m, ele_max, start_lat, start_lon, public_id,
        completed_at, completed_route_id
    )""")
    # Mismo cuidado que con idx_routes_list_cov5 (ver arriba): si la BD tiene
    # estadísticas, un índice recién creado no está en sqlite_stat1 y el
    # planificador lo descarta a favor del que sí tiene — leyendo la fila entera,
    # o sea atravesando el BLOB gpx_data de cada plan. Se re-analiza UNA vez.
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                   "AND name='sqlite_stat1'").fetchone():
        if not con.execute("SELECT 1 FROM sqlite_stat1 WHERE idx=?",
                           ("idx_planned_list_cov2",)).fetchone():
            try:
                con.execute("ANALYZE planned_routes")
                con.commit()
            except sqlite3.OperationalError:
                pass          # otro worker lo está haciendo: con uno basta
    # Backfill idempotente y tolerante a la carrera de 2 workers (igual que el de
    # routes/photos: el UPDATE lleva "AND public_id IS NULL").
    for _id in [row[0] for row in con.execute(
            "SELECT id FROM planned_routes WHERE public_id IS NULL").fetchall()]:
        while True:
            try:
                con.execute("UPDATE planned_routes SET public_id=? "
                            "WHERE id=? AND public_id IS NULL", (new_token(), _id))
                break
            except sqlite3.IntegrityError:
                continue
    con.commit()

    _init_sync(con)
    con.commit()
    con.close()


# ── Sincronización delta ─────────────────────────────────────────────────────
# Un contador monotónico global (sync_seq) y una fila por entidad viva o borrada
# (sync_log). Los mantienen TRIGGERS, no el código Python: las mutaciones de
# routes/photos/planned_routes están repartidas en 13 sitios de 5 blueprints, y
# cualquier esquema que dependa de "acuérdate de tocar el contador aquí" se
# rompería en el primero que se olvide (y en los que se añadan mañana).
#
# Entidades: 'route' y 'planned'. Las fotos NO son una entidad propia: al
# añadirlas/borrarlas suben el rev de SU RUTA, que es lo que hace que el detalle
# cacheado (que incluye las fotos) se invalide en el cliente.
#
# Las filas de sync_log no se borran nunca: op='del' es la tombstone que permite
# que un cliente apagado semanas sepa qué desapareció. Son ~40 bytes por entidad.

_SYNC_DDL = """
CREATE TABLE IF NOT EXISTS sync_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    n  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_log (
    entity    TEXT    NOT NULL,          -- 'route' | 'planned'
    entity_id INTEGER NOT NULL,          -- PK entera interna
    public_id TEXT,                      -- id opaco expuesto al cliente
    rev       INTEGER NOT NULL,
    op        TEXT    NOT NULL,          -- 'up' | 'del'
    PRIMARY KEY (entity, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_log_rev
    ON sync_log(rev, entity, entity_id, public_id, op);
"""


def _sync_triggers_sql():
    """DDL de los 9 triggers que mantienen sync_log.

    Se usa DELETE + INSERT en vez de "INSERT ... ON CONFLICT DO UPDATE" a
    propósito: el upsert dentro del cuerpo de un trigger depende de la versión de
    SQLite, y aquí el coste de las dos sentencias es irrelevante (sync_log no
    tiene triggers propios, así que el DELETE no dispara nada).

    El INSERT ... SELECT contra la tabla base (en vez de VALUES) hace que la fila
    solo se escriba si la entidad sigue existiendo, y el EXISTS del DELETE evita
    que un borrado de fotos posterior al de su ruta se lleve por delante la
    tombstone de esa ruta.
    """
    out = []
    for entity, table in (("route", "routes"), ("planned", "planned_routes")):
        out.append(f"""
CREATE TRIGGER IF NOT EXISTS trg_sync_{table}_ai AFTER INSERT ON {table} BEGIN
    UPDATE sync_seq SET n = n + 1 WHERE id = 1;
    DELETE FROM sync_log WHERE entity = '{entity}' AND entity_id = NEW.id;
    INSERT INTO sync_log(entity, entity_id, public_id, rev, op)
        SELECT '{entity}', id, public_id, (SELECT n FROM sync_seq WHERE id = 1), 'up'
        FROM {table} WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_{table}_au AFTER UPDATE ON {table} BEGIN
    UPDATE sync_seq SET n = n + 1 WHERE id = 1;
    DELETE FROM sync_log WHERE entity = '{entity}' AND entity_id = NEW.id;
    INSERT INTO sync_log(entity, entity_id, public_id, rev, op)
        SELECT '{entity}', id, public_id, (SELECT n FROM sync_seq WHERE id = 1), 'up'
        FROM {table} WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_{table}_ad AFTER DELETE ON {table} BEGIN
    UPDATE sync_seq SET n = n + 1 WHERE id = 1;
    DELETE FROM sync_log WHERE entity = '{entity}' AND entity_id = OLD.id;
    INSERT INTO sync_log(entity, entity_id, public_id, rev, op)
        VALUES ('{entity}', OLD.id, OLD.public_id,
                (SELECT n FROM sync_seq WHERE id = 1), 'del');
END;""")
    # Las fotos suben el rev de su ruta (no son entidad propia de sincronización).
    for op, trg, ref in (("INSERT", "ai", "NEW"), ("UPDATE", "au", "NEW"),
                         ("DELETE", "ad", "OLD")):
        out.append(f"""
CREATE TRIGGER IF NOT EXISTS trg_sync_photos_{trg} AFTER {op} ON photos BEGIN
    UPDATE sync_seq SET n = n + 1 WHERE id = 1;
    DELETE FROM sync_log WHERE entity = 'route' AND entity_id = {ref}.route_id
        AND EXISTS (SELECT 1 FROM routes WHERE id = {ref}.route_id);
    INSERT INTO sync_log(entity, entity_id, public_id, rev, op)
        SELECT 'route', id, public_id, (SELECT n FROM sync_seq WHERE id = 1), 'up'
        FROM routes WHERE id = {ref}.route_id;
END;""")
    return "\n".join(out)


def _init_sync(con):
    """Crea el esquema de sincronización, los triggers, el epoch y el backfill.

    Todo con CREATE ... IF NOT EXISTS / INSERT OR IGNORE, sin ALTER TABLE: es
    re-ejecutable por los 2 workers de gunicorn en paralelo sin try/except
    (regla 13 de CLAUDE.md).
    """
    con.executescript(_SYNC_DDL)
    con.execute("INSERT OR IGNORE INTO sync_seq(id, n) VALUES (1, 0)")
    con.executescript(_sync_triggers_sql())
    con.commit()

    # Epoch: si cambia, los clientes tiran su copia local y recargan de cero. Es
    # la red de seguridad ante una BD restaurada de un backup o reconstruida, donde
    # el contador podría retroceder y un delta por 'since' daría datos fantasma.
    con.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('sync_epoch', ?)",
                (new_token(),))
    # Suelo de revisión: un cliente que pida un 'since' anterior recibe reset. Se
    # queda en 0 porque las tombstones no se purgan; existe como escotilla.
    con.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('sync_min_rev', '0')")

    # Backfill de las filas que existían antes de esta migración: sin esto no
    # tendrían fila en sync_log y un cliente con since=0 no las vería nunca.
    # Idempotente: INSERT OR IGNORE sobre la PK (entity, entity_id).
    for entity, table in (("route", "routes"), ("planned", "planned_routes")):
        missing = con.execute(
            f"SELECT id, public_id FROM {table} t WHERE NOT EXISTS ("
            f"  SELECT 1 FROM sync_log s WHERE s.entity=? AND s.entity_id=t.id)",
            (entity,),
        ).fetchall()
        for row in missing:
            con.execute("UPDATE sync_seq SET n = n + 1 WHERE id = 1")
            con.execute(
                "INSERT OR IGNORE INTO sync_log(entity, entity_id, public_id, rev, op) "
                "SELECT ?, ?, ?, n, 'up' FROM sync_seq WHERE id = 1",
                (entity, row[0], row[1]),
            )
    con.commit()


def sync_cursor(con):
    """Valor actual del contador monotónico global."""
    row = con.execute("SELECT n FROM sync_seq WHERE id = 1").fetchone()
    return (row[0] if row else 0) or 0


def sync_epoch(con):
    """Token del epoch actual (ver _init_sync)."""
    row = con.execute("SELECT value FROM settings WHERE key = 'sync_epoch'").fetchone()
    return (row[0] if row else "") or ""


def entity_rev(con, entity, entity_id):
    """rev actual de una entidad, o 0 si no tiene fila en sync_log."""
    row = con.execute(
        "SELECT rev FROM sync_log WHERE entity = ? AND entity_id = ?",
        (entity, entity_id),
    ).fetchone()
    return (row[0] if row else 0) or 0
