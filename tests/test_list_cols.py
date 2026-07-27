"""Columnas del LISTADO de rutas: resumen de gps_issues, nº de fotos e índices.

Dos cosas que se rompen en silencio y cuestan mucho de diagnosticar:

  1. Las expresiones que resumen `gps_issues` (nº de avisos y si alguno es
     grave) tienen que dar 0 para todas las formas que puede tener esa columna:
     NULL, la cadena 'null', '[]' o un JSON con la lista.
  2. La query del listado tiene que resolverse DESDE los índices de cobertura.
     Si el planificador deja de usarlos, SQLite lee la fila completa y atraviesa
     los blobs geojson/elevation/heart_rate de cada ruta: el listado pasa de
     milisegundos a segundos (regla 12 de CLAUDE.md). Al ir las expresiones
     DENTRO del índice, basta con que su texto deje de coincidir carácter a
     carácter con el de la query para perderlo.
"""
import json
import sqlite3

import pytest

import core.config as cfg
from core.database import GPS_ISSUES_HIGH_SQL, GPS_ISSUES_N_SQL, init_db
from api.routes import ROUTE_LIST_COLS

LIST_QUERY = (f"SELECT {ROUTE_LIST_COLS} FROM routes "
              "ORDER BY COALESCE(started_at,created_at) DESC")


def _evaluar(valor):
    """(nº de avisos, ¿alguno grave?) tal y como los calcula el listado."""
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE routes (gps_issues TEXT)")
    con.execute("INSERT INTO routes VALUES (?)", (valor,))
    return con.execute(
        f"SELECT {GPS_ISSUES_N_SQL}, {GPS_ISSUES_HIGH_SQL} FROM routes").fetchone()


def _issue(sev):
    return {"type": "speed", "d_from": 0.0, "d_to": 1.0, "value_max": 90.0,
            "threshold": 15, "severity": sev}


@pytest.mark.parametrize("valor,esperado", [
    (None,   (0, 0)),                        # lo normal: ruta sin avisos
    ("null", (0, 0)),                        # bases antiguas
    ("[]",   (0, 0)),
    ("no soy json", (0, 0)),                 # nunca debe reventar la query
    (json.dumps([_issue("medium")]), (1, 0)),
    (json.dumps([_issue("high")]),   (1, 1)),
    (json.dumps([_issue("medium"), _issue("medium"), _issue("high")]), (3, 1)),
])
def test_resumen_de_gps_issues(valor, esperado):
    assert _evaluar(valor) == esperado


def test_el_listado_no_lleva_el_json_entero():
    """El JSON de gps_issues pesa y en la tarjeta no se usa: solo el resumen."""
    assert "gps_issues_n" in ROUTE_LIST_COLS
    assert "gps_issues_high" in ROUTE_LIST_COLS
    assert "n_photos" in ROUTE_LIST_COLS
    # ni la columna cruda ni ningún campo suyo viajan al cliente
    assert " gps_issues," not in ROUTE_LIST_COLS
    assert not ROUTE_LIST_COLS.endswith("gps_issues")


def test_la_query_del_listado_sale_de_los_indices_de_cobertura(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg, "DB_PATH", tmp_path / "sendero.db")
    init_db()
    con = sqlite3.connect(cfg.DB_PATH)
    plan = " | ".join(r[-1] for r in
                      con.execute("EXPLAIN QUERY PLAN " + LIST_QUERY))
    # Las rutas, por el índice de cobertura (que incluye las expresiones de
    # gps_issues ya calculadas): sin esto se leería la fila entera.
    assert "idx_routes_list_cov5" in plan, plan
    # Las fotos, por su índice: sin él SQLite escanea photos una vez por ruta.
    assert "idx_photos_route" in plan, plan
    assert "SCAN photos" not in plan, plan


def test_los_indices_de_cobertura_anteriores_se_descartan(tmp_path, monkeypatch):
    """cov5 sustituye a cov4: dejar los dos duplicaría el coste de escritura."""
    monkeypatch.setattr(cfg, "DB_PATH", tmp_path / "sendero.db")
    init_db()
    con = sqlite3.connect(cfg.DB_PATH)
    idx = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index'")}
    assert "idx_routes_list_cov5" in idx
    assert not (idx & {"idx_routes_list_cov", "idx_routes_list_cov2",
                       "idx_routes_list_cov3", "idx_routes_list_cov4"})


def test_init_db_es_idempotente(tmp_path, monkeypatch):
    """Cada worker de gunicorn corre init_db() por su cuenta (regla 13)."""
    monkeypatch.setattr(cfg, "DB_PATH", tmp_path / "sendero.db")
    init_db()
    init_db()
    con = sqlite3.connect(cfg.DB_PATH)
    assert con.execute("SELECT COUNT(*) FROM routes").fetchone()[0] == 0
