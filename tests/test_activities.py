"""El catálogo de actividades (core/activities.py) es la ÚNICA fuente de verdad.

Estos tests no comprueban un cálculo: comprueban el cableado. Lo que se rompe si
alguien añade un deporte a medias no da error en ninguna parte —simplemente el
deporte no sale en una pantalla, o el cliente y el servidor manejan listas
distintas—, así que se vigila aquí.
"""

import json
import re
from pathlib import Path

import core.config as cfg
import core.ibp as ibp
import core.parsers as parsers
from core import activities

RAIZ = Path(__file__).resolve().parent.parent


def test_catalogo_bien_formado():
    assert activities.IDS, "el catálogo no puede estar vacío"
    assert len(set(activities.IDS)) == len(activities.IDS), "hay ids repetidos"
    for a in activities.ACTIVITIES:
        assert a["id"].isascii() and a["id"].islower(), a["id"]
        assert a["label"] and a["color"].startswith("#")
        assert a["symbol"].strip(), f"{a['id']} sin icono"
        assert set(a["thresholds"]) == {"max_speed_kmh", "max_vert_rate_ms", "max_ele_m"}
        assert all(v > 0 for v in a["thresholds"].values())
    # 'otros' es el cajón al que cae cualquier actividad desconocida
    assert "otros" in activities.IDS


def test_no_hay_palabras_ni_tipos_compartidos():
    """Un mismo <type>/sport/palabra en dos actividades haría que la detección
    dependa del orden del diccionario, que es justo lo que no se debe."""
    for campo in ("gpx_types", "fit_sports", "keywords"):
        vistos = {}
        for a in activities.ACTIVITIES:
            for v in a[campo]:
                assert v not in vistos, f"«{v}» está en {vistos.get(v)} y en {a['id']}"
                vistos[v] = a["id"]


def test_el_servidor_no_tiene_copias_de_la_lista():
    assert cfg.DEFAULT_GPS_THRESHOLDS is activities.THRESHOLDS
    assert parsers._GPX_TYPE_MAP is activities.GPX_TYPES
    assert parsers._FIT_SPORT_MAP is activities.FIT_SPORTS
    assert parsers._ACTIVITY_KEYWORDS is activities.KEYWORDS
    assert ibp._MODALITY_BY_ACTIVITY is activities.IBP_MODALITY
    # Toda modalidad IBP declarada tiene que ser una de las que devuelve la API
    assert set(activities.IBP_MODALITY.values()) <= set(ibp.MODALITIES)


def test_las_palabras_especificas_van_antes_que_las_golosas():
    """'senderismo' tiene palabras que se comen medio idioma ("via", "gr", que va
    dentro de "Segre"): las actividades con keyword_prio negativo se buscan antes."""
    orden = list(activities.KEYWORDS)
    for a in activities.ACTIVITIES:
        if a.get("keyword_prio", 0) < 0:
            assert orden.index(a["id"]) < orden.index("senderismo")


def test_catalogo_del_cliente():
    """Lo que se inyecta en base.html: JSON válido y con los campos que lee
    static/shared.js (a.id, a.label, a.color, a.symbol y a.ibp en sec/plan.js)."""
    catalogo = json.loads(activities.client_json())
    assert [a["id"] for a in catalogo] == list(activities.IDS)
    for a in catalogo:
        assert set(a) == {"id", "label", "color", "symbol", "ibp"}
    # los umbrales NO viajan al cliente: los sirve /api/settings/gps-thresholds
    assert "thresholds" not in catalogo[0]


def test_el_cliente_no_declara_su_propia_lista():
    """El fallo mudo que esto vigila: volver a escribir a mano la lista de
    deportes en el frontend, que entonces se queda corta al añadir uno nuevo."""
    shared = (RAIZ / "static/shared.js").read_text(encoding="utf-8")
    assert "activities-json" in shared, "shared.js ya no lee el catálogo inyectado"
    assert not re.search(r"const ACTIVITIES\s*=\s*\[", shared), \
        "shared.js vuelve a llevar la lista escrita a mano"

    base = (RAIZ / "templates/base.html").read_text(encoding="utf-8")
    assert 'id="activities-json"' in base and "activities_json" in base, \
        "base.html ya no inyecta el catálogo (el cliente se quedaría sin actividades)"
    # y tiene que ir ANTES de shared.js, que lo lee al cargarse
    assert base.index('id="activities-json"') < base.index("/static/shared.js")

    chrome = (RAIZ / "static/js/core/chrome.js").read_text(encoding="utf-8")
    assert "ACTIVITIES.map(a=>a.id)" in chrome, \
        "las tablas de Ajustes vuelven a tener su propia lista de actividades"
