"""Tests de core/dedup: hash exacto y firma semántica."""
from core.dedup import content_hash, route_signature


def test_content_hash_stable_and_distinct():
    a = content_hash(b"<gpx>abc</gpx>")
    assert a == content_hash(b"<gpx>abc</gpx>")      # determinista
    assert a != content_hash(b"<gpx>abd</gpx>")      # un byte distinto → hash distinto
    assert len(a) == 64                               # sha-256 hex


COORDS = [[-3.7038, 40.4168], [-3.7040, 40.4170], [-3.7050, 40.4180]]


def test_signature_matches_same_activity():
    a = route_signature("2026-07-01T08:30:15", 12345.0, COORDS)
    # Mismo entreno reexportado: segundos distintos, distancia con ruido, coords
    # con un pelín más de precisión (sub-11 m) → misma firma.
    b = route_signature("2026-07-01T08:30:59", 12800.0,
                        [[-3.70381, 40.41679], [-3.7040, 40.4170], [-3.70499, 40.41801]])
    assert a == b


def test_signature_differs_by_time():
    a = route_signature("2026-07-01T08:30:00", 12345.0, COORDS)
    b = route_signature("2026-07-01T10:00:00", 12345.0, COORDS)
    assert a != b


def test_signature_differs_by_endpoints():
    a = route_signature("2026-07-01T08:30:00", 12345.0, COORDS)
    b = route_signature("2026-07-01T08:30:00", 12345.0,
                        [[-3.80, 40.50], [-3.70, 40.42], [-3.90, 40.60]])
    assert a != b


def test_signature_ignores_distance_when_timed():
    # Con hora, la distancia no entra en la firma (evita falsos negativos de cubo).
    a = route_signature("2026-07-01T08:30:00", 12345.0, COORDS)
    b = route_signature("2026-07-01T08:30:00", 99999.0, COORDS)
    assert a == b


def test_signature_none_without_coords():
    assert route_signature("2026-07-01T08:30:00", 12345.0, []) is None


def test_signature_without_time_uses_geometry_and_count():
    a = route_signature(None, 12345.0, COORDS)
    b = route_signature(None, 12345.0, COORDS)
    assert a == b
    # distinto nº de puntos → firma distinta cuando no hay hora
    c = route_signature(None, 12345.0, COORDS + [[-3.706, 40.419]])
    assert a != c
