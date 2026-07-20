"""Tests de la función pura de formato de localidad (core/geocode).

No tocan la red: solo comprueban cómo se traduce una respuesta jsonv2 de
Nominatim a la cadena 'Localidad, Región' que Sendero guarda en routes.locality.
"""
from core.geocode import _format_locality


def test_town_and_state():
    data = {"address": {"town": "Cangas de Onís", "state": "Asturias",
                        "country": "España"}}
    assert _format_locality(data) == "Cangas de Onís, Asturias"


def test_prefers_city_over_county():
    data = {"address": {"city": "Oviedo", "county": "Oviedo", "state": "Asturias"}}
    assert _format_locality(data) == "Oviedo, Asturias"


def test_village_fallback():
    data = {"address": {"village": "Bulnes", "municipality": "Cabrales",
                        "state": "Asturias"}}
    # village gana a municipality; region = state
    assert _format_locality(data) == "Bulnes, Asturias"


def test_region_only():
    data = {"address": {"state": "Asturias"}, "name": "Picos de Europa"}
    assert _format_locality(data) == "Asturias"


def test_dedup_when_place_equals_region():
    data = {"address": {"city": "Madrid", "state": "Madrid"}}
    assert _format_locality(data) == "Madrid"


def test_name_fallback_when_no_address():
    assert _format_locality({"name": "Parque Natural"}) == "Parque Natural"


def test_empty_returns_none():
    assert _format_locality({}) is None
    assert _format_locality(None) is None
