"""Catálogo de actividades de Sendero. LA fuente de verdad, y la única.

**Añadir un deporte es editar este archivo** (y subir `APP_VERSION`, que es lo que
invalida el precache del Service Worker). De aquí sale todo, sin tocar nada más:

  · Servidor — los umbrales de "GPS incorrecto" (`core.config.DEFAULT_GPS_THRESHOLDS`),
    los tres mapas de detección de `core.parsers` (`<type>` del GPX, deporte del FIT
    y palabras del nombre) y la modalidad del índice IBP (`core.ibp`).
  · Cliente  — el `ACTIVITIES` de `static/shared.js`, del que cuelgan las píldoras de
    filtro de «Mis Rutas», el selector del detalle, los iconos de los mapas, el color
    de la traza del editor, el panel «Por actividad» del dashboard y las dos tablas de
    Ajustes (umbrales GPS y tipos GPX personalizados).

El cliente lo recibe **inyectado como JSON** en `base.html` (`#activities-json`, lo pone
el context processor de `app.py`), no por `fetch`. Dos motivos: las secciones lo leen de
forma SÍNCRONA al montar (`ACTIVITIES.forEach(...)`, sin `await`), y así funciona sin
conexión con solo el shell precacheado.

Del icono: es el interior de un `<svg viewBox="0 0 26 26">` cuyo círculo de fondo pinta
`iconSvg()` con el `color` de la actividad. El glifo va SIEMPRE en `#0b120e` (tinta
oscura sobre el color, nunca blanca) y dentro del círculo de radio 11 centrado en 13,13.
El color es lo único del proyecto que puede ser un hex fuera de los tokens de
`base.html` (regla 9), porque es un dato de la actividad, no un color de la interfaz.
"""

import json

# ─────────────────────────────────────────────────────────────────────────────
# El catálogo. El ORDEN es el que ve el usuario en filtros y selectores; 'otros'
# va el último a propósito.
#
# Campos:
#   id           clave que se guarda en routes.activity_type / planned_routes
#                (ASCII, sin acentos: es la que va en la BD y en las URLs)
#   label/color/symbol   presentación (ver la cabecera sobre el icono)
#   thresholds   umbrales de GPS incorrecto (core/gps_analysis.py). Editables por
#                el usuario en Ajustes → "GPS incorrecto"; esto es el de fábrica
#   gpx_types    valores del <type> de un GPX que mapean aquí (en minúsculas; los
#                numéricos son los códigos que escriben algunos dispositivos)
#   fit_sports   valores del campo sport de un FIT
#   keywords     palabras que, si aparecen en el NOMBRE, delatan la actividad
#   keyword_prio orden en que se buscan las palabras (menor = antes). Ver KEYWORDS
#   ibp          modalidad del índice IBP, o None si no tiene equivalente
# ─────────────────────────────────────────────────────────────────────────────
ACTIVITIES = [
    {
        "id": "senderismo", "label": "Senderismo", "color": "#e8863c",
        "thresholds": {"max_speed_kmh": 15, "max_vert_rate_ms": 3, "max_ele_m": 4900},
        "gpx_types": ("hiking", "trail hiking", "mountaineering", "mountain",
                      "trekking", "16", "17"),
        "fit_sports": ("hiking",),
        "keywords": ("senderismo", "sendero", "trekking", "trek", "excursión",
                     "excursion", "montaña", "montana", "trail", "gr", "pr", "sl",
                     "camino", "via", "travesia", "hiking", "hike", "mountaineering"),
        "ibp": "hiking",
        "symbol": """
    <circle cx="13" cy="8.5" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="15.5" y2="11"  stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="10.5" y2="13.5" stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="10.5" y1="13.5" x2="9.5" y2="18"  stroke="#0b120e" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15.5" y2="19"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="10.5" y2="18"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  """,
    },
    {
        "id": "bicicleta", "label": "Bicicleta", "color": "#3d9be9",
        "thresholds": {"max_speed_kmh": 70, "max_vert_rate_ms": 6, "max_ele_m": 4000},
        "gpx_types": ("cycling", "biking", "mountain biking", "road cycling",
                      "gravel cycling", "virtual cycling", "2"),
        "fit_sports": ("cycling", "mountain_biking"),
        "keywords": ("bicicleta", "bici", "ciclismo", "mtb", "mountain bike",
                     "cycling", "bike", "cicloturismo", "gravel", "btt"),
        "ibp": "bicycle",
        "symbol": """
    <circle cx="9.5"  cy="17.5" r="2.3" fill="none" stroke="#0b120e" stroke-width="1.6"/>
    <circle cx="16.5" cy="17.5" r="2.3" fill="none" stroke="#0b120e" stroke-width="1.6"/>
    <path d="M9.5,17.5 L13,14 L16.5,17.5 M13,14 L11.5,17.5"
      stroke="#0b120e" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="15.5" cy="10" r="1.5" fill="#0b120e"/>
    <line x1="15.5" y1="11.5" x2="13" y2="14"   stroke="#0b120e" stroke-width="1.7" stroke-linecap="round"/>
    <line x1="14.5" y1="12.5" x2="12" y2="13.5" stroke="#0b120e" stroke-width="1.4" stroke-linecap="round"/>
  """,
    },
    {
        "id": "caminata", "label": "Caminata", "color": "#43b97f",
        "thresholds": {"max_speed_kmh": 10, "max_vert_rate_ms": 2, "max_ele_m": 3500},
        "gpx_types": ("walking", "casual walking", "speed walking", "11"),
        "fit_sports": ("walking",),
        "keywords": ("caminata", "caminando", "paseo", "pasear", "vuelta", "walk",
                     "walking", "urbano", "ciudad", "rambla", "marcha"),
        "ibp": "hiking",
        "symbol": """
    <circle cx="13" cy="8.5" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="15.5" y2="13.5" stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="10.5" y2="13"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15"   y2="19"   stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="11"   y2="18.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  """,
    },
    {
        "id": "correr", "label": "Correr", "color": "#e34b4b",
        "thresholds": {"max_speed_kmh": 30, "max_vert_rate_ms": 3.5, "max_ele_m": 4900},
        "gpx_types": ("running", "trail running", "street running", "1"),
        "fit_sports": ("running", "trail"),
        "keywords": ("correr", "running", "carrera", "trail running", "maratón",
                     "maraton", "media maratón", "10k", "5k", "fondo", "jogging"),
        "ibp": "running",
        "symbol": """
    <circle cx="14" cy="8" r="1.6" fill="#0b120e"/>
    <line x1="14" y1="9.6"  x2="12" y2="15"   stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="16" y2="10"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="10" y2="13"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12" y1="15"   x2="15.5" y2="19" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="12" y1="15"   x2="9.5"  y2="18" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  """,
    },
    {
        "id": "esqui", "label": "Esquí", "color": "#a86ee0",
        "thresholds": {"max_speed_kmh": 100, "max_vert_rate_ms": 10, "max_ele_m": 4900},
        "gpx_types": ("skiing", "alpine skiing", "nordic skiing",
                      "cross country skiing", "snowboarding", "12", "13", "14"),
        "fit_sports": ("alpine_skiing", "cross_country_skiing", "nordic_skiing",
                       "skiing", "snowboarding"),
        "keywords": ("esqui", "esquí", "ski", "skiing", "nieve", "snow", "pista",
                     "slalom", "esquiando", "nordic"),
        "ibp": None,   # el IBP no tiene modalidad de nieve: que la deduzca del track
        "symbol": """
    <circle cx="13" cy="8" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="9.6"  x2="11" y2="14.5"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="12" y1="11.5" x2="8.5" y2="13"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12" y1="11.5" x2="16.5" y2="13"  stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="8.5"  y1="13" x2="8"   y2="17.5" stroke="#0b120e" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="16.5" y1="13" x2="17"  y2="17.5" stroke="#0b120e" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="11"   y1="14.5" x2="9.5" y2="18" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="11"   y1="14.5" x2="13" y2="18"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="7.5"  y1="19"   x2="12" y2="19"  stroke="#0b120e" stroke-width="2"   stroke-linecap="round"/>
    <line x1="12"   y1="19"   x2="16" y2="19"  stroke="#0b120e" stroke-width="2"   stroke-linecap="round"/>
  """,
    },
    {
        "id": "kayak", "label": "Kayak", "color": "#23bfc4",
        # En el agua la cota es casi constante: una tasa vertical alta es ruido
        # del GPS (o del barómetro), no terreno. De ahí que sea más estricta que a pie.
        "thresholds": {"max_speed_kmh": 20, "max_vert_rate_ms": 2.5, "max_ele_m": 3500},
        "gpx_types": ("kayaking", "kayak", "sea kayaking", "whitewater kayaking",
                      "canoeing", "paddling", "rowing"),
        "fit_sports": ("kayaking", "canoeing", "paddling", "rowing",
                       "stand_up_paddleboarding"),
        # Ojo: nada de "remo" suelto, que va dentro de "extremo".
        "keywords": ("kayak", "kayac", "kaiac", "kayaking", "piragu", "piragü",
                     "canoa", "canoe", "canoeing", "paddle", "paddling", "remada",
                     "remando"),
        "keyword_prio": -1,   # ver KEYWORDS, más abajo
        "ibp": None,          # el IBP es de recorridos por tierra
        "symbol": """
    <circle cx="13" cy="7.4" r="1.5" fill="#0b120e"/>
    <line x1="13" y1="8.9"   x2="13"    y2="15.8" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.3" x2="10.5"   y2="13.5" stroke="#0b120e" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="13" y1="11.3" x2="15.5"   y2="12.1" stroke="#0b120e" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="7.8" y1="14.2" x2="18.2"  y2="11.4" stroke="#0b120e" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="7.1" y1="13.1" x2="8.5"   y2="15.3" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="17.5" y1="10.3" x2="18.9" y2="12.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M5.6,16.5 C8.6,20.2 17.4,20.2 20.4,16.5 Z" fill="#0b120e"/>
  """,
    },
    {
        "id": "otros", "label": "Otros", "color": "#e055c0",
        "thresholds": {"max_speed_kmh": 40, "max_vert_rate_ms": 5, "max_ele_m": 9000},
        "gpx_types": (),
        "fit_sports": (),
        "keywords": (),   # es el cajón de sastre: no se detecta, se cae en él
        "ibp": None,
        "symbol": """
    <circle cx="13" cy="8.5" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="8.5" y2="11"  stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="17.5" y2="11" stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="11"   y2="19" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15"   y2="19" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  """,
    },
]

# ── vistas derivadas: nadie de fuera recorre ACTIVITIES a mano ───────────────

IDS = tuple(a["id"] for a in ACTIVITIES)

THRESHOLDS = {a["id"]: dict(a["thresholds"]) for a in ACTIVITIES}

GPX_TYPES = {t: a["id"] for a in ACTIVITIES for t in a["gpx_types"]}

FIT_SPORTS = {s: a["id"] for a in ACTIVITIES for s in a["fit_sports"]}

# Se recorre EN ORDEN y gana la primera que casa, así que el orden importa: las
# palabras de 'senderismo' son muy golosas ("travesia", "via", "gr" —que va dentro
# de "Segre"—) y se quedarían con "Travesía en canoa". Por eso una actividad de
# palabras específicas puede adelantarse con keyword_prio negativo.
KEYWORDS = {
    a["id"]: tuple(a["keywords"])
    for a in sorted(ACTIVITIES, key=lambda a: a.get("keyword_prio", 0))
}

IBP_MODALITY = {a["id"]: a["ibp"] for a in ACTIVITIES if a["ibp"]}


def client_catalog():
    """Lo que necesita el cliente: presentación + la modalidad IBP (que `sec/plan.js`
    usa para reelegir el índice al cambiar de actividad sin pedir red). Los umbrales
    NO van: el cliente los pide a /api/settings/gps-thresholds, que ya devuelve los
    efectivos (los personalizados del usuario con estos de respaldo)."""
    return [{"id": a["id"], "label": a["label"], "color": a["color"],
             "symbol": a["symbol"], "ibp": a["ibp"]} for a in ACTIVITIES]


def client_json():
    """El catálogo tal cual se inyecta en `base.html` (#activities-json)."""
    return json.dumps(client_catalog(), ensure_ascii=False, separators=(",", ":"))
