"""Tests de la parte pura del cliente del índice IBP (core/ibp).

No tocan la red: comprueban cómo se traduce el JSON de la API de ibpindex.com al
puñado de campos que Sendero guarda en `planned_routes` (índice efectivo, acrónimo
de la modalidad y las tres puntuaciones), y que los fallos salen como IbpError con
mensaje en español en vez de un índice inventado.

La respuesta real trae ~90 campos por modalidad (ver la documentación de la API
v2.0); aquí se recortan a lo que se lee.
"""
import pytest

from core.ibp import IbpError, modality_for, parse_response


def _resp(**kwargs):
    """Respuesta mínima con las tres modalidades, como la que devuelve la API."""
    data = {"error": "", "reference": "36647160175900", "filename": "ruta.gpx",
            "detectedmodality": "bicycle",
            "bicycle": {"ibp": "140", "acronym": "BYC", "totlengthkm": "116.689"},
            "hiking":  {"ibp": "344", "acronym": "HKG", "totlengthkm": "116.689"},
            "running": {"ibp": "251", "acronym": "RNG", "totlengthkm": "116.689"}}
    data.update(kwargs)
    return data


def test_modalidad_por_actividad():
    assert modality_for("senderismo") == "hiking"
    assert modality_for("caminata")   == "hiking"
    assert modality_for("bicicleta")  == "bicycle"
    assert modality_for("correr")     == "running"
    # esquí y 'otros' no tienen equivalente: se deja decidir al servicio
    assert modality_for("esqui") is None
    assert modality_for("otros") is None
    assert modality_for(None) is None


def test_elige_la_modalidad_de_la_actividad():
    res = parse_response(_resp(), "senderismo")
    assert (res["index"], res["modality"], res["acronym"]) == (344, "hiking", "HKG")
    # y guarda las tres, para que cambiar la actividad no exija volver a subir nada
    assert res["all"] == {"hiking": 344, "bicycle": 140, "running": 251}


def test_bicicleta_puntua_distinto_que_a_pie():
    assert parse_response(_resp(), "bicicleta")["index"] == 140


def test_sin_actividad_usa_la_detectada():
    """Un plan sin actividad (o de esquí) se queda con lo que detectó el servicio."""
    for act in (None, "esqui"):
        res = parse_response(_resp(), act)
        assert (res["index"], res["acronym"]) == (140, "BYC")


def test_detectada_desconocida_cae_a_la_primera_disponible():
    res = parse_response(_resp(detectedmodality="kayak"), None)
    assert res["modality"] == "hiking"        # orden de MODALITIES


def test_actividad_sin_bloque_cae_a_la_detectada():
    data = _resp()
    del data["hiking"]
    res = parse_response(data, "senderismo")
    assert (res["index"], res["acronym"]) == (140, "BYC")


def test_indices_no_numericos_se_ignoran():
    data = _resp(hiking={"ibp": "", "acronym": "HKG"})
    res = parse_response(data, "senderismo")
    assert res["index"] == 140                # cae a la detectada
    assert "hiking" not in res["all"]


def test_clave_invalida_es_error_con_mensaje():
    """La API responde 200 con {"error": ...}: sin índices, es un fallo."""
    with pytest.raises(IbpError) as e:
        parse_response({"error": "Invalid API key, please contact www.ibpindex.com"})
    assert "Invalid API key" in str(e.value)


def test_sin_ninguna_modalidad_es_error():
    with pytest.raises(IbpError):
        parse_response({"error": "", "detectedmodality": "hiking"})


def test_respuesta_que_no_es_un_objeto():
    with pytest.raises(IbpError):
        parse_response("<html>error 500</html>")


def test_error_con_observaciones_no_tumba_un_indice_valido():
    """`error` a veces trae observaciones, no un fallo: si hay índice, vale."""
    res = parse_response(_resp(error="Track with few points"), "senderismo")
    assert res["index"] == 344
