"""Unión inteligente de tracks (core.editing.smart_merge).

Lo que se prueba aquí es la GEOMETRÍA de la costura, que es lo que la unión por
concatenación ciega no miraba: orientar cada track, recortar el trozo que B
repite de A (y al revés, cuando A se pasa de largo), cerrar una circular y
decidir si el hueco que queda se une en recta o se deja como corte de segmento.

Los tracks sintéticos van por `make_gpx_xml` (conftest.py) cuando son rectas
—`dlat` negativo = el mismo tramo guardado al revés— y por `_gpx()` cuando hace
falta una forma (la circular). Todas las distancias salen de que 0,0002° de
latitud ≈ 22,3 m.
"""
import datetime as dt
import io
import math
import os
import time

import gpxpy
import pytest

from core.editing import EditError, extract_points, merge_gpx, smart_merge

M_DEG = 111320.0        # metros por grado (la misma aproximación que el módulo)


# ── constructores ──────────────────────────────────────────────────────────

def _gpx(coords, name="Tramo"):
    """GPX de una lista [(lon, lat), …] sin <time>, como un plan dibujado."""
    pts = "\n".join(f'      <trkpt lat="{la:.6f}" lon="{lo:.6f}">'
                    f"<ele>{100 + i * 0.1:.1f}</ele></trkpt>"
                    for i, (lo, la) in enumerate(coords))
    return gpxpy.parse(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f"  <trk><name>{name}</name><trkseg>\n{pts}\n  </trkseg></trk>\n</gpx>"
    )


def _densify(waypoints, step_m=22.0):
    """Polilínea densificada a ~step_m entre puntos (lista de (lon, lat))."""
    out = []
    for (lo0, la0), (lo1, la1) in zip(waypoints, waypoints[1:]):
        cos = math.cos(math.radians(la0))
        d = math.hypot((lo1 - lo0) * M_DEG * cos, (la1 - la0) * M_DEG)
        n = max(1, int(d / step_m))
        for k in range(n):
            t = k / n
            out.append((lo0 + (lo1 - lo0) * t, la0 + (la1 - la0) * t))
    out.append(waypoints[-1])
    return out


def _line(lat0, n, dlat=0.0002, lon0=-3.0):
    """Recta N-S de n puntos: dlat negativo = el mismo tramo al revés."""
    return _gpx([(lon0, lat0 + i * dlat) for i in range(n)])


def _near(pt, target, m=60.0):
    """¿[lon,lat] a menos de `m` metros de (lon,lat)?"""
    cos = math.cos(math.radians(target[1]))
    return math.hypot((pt[0] - target[0]) * M_DEG * cos,
                      (pt[1] - target[1]) * M_DEG) <= m


def _n_points(xml):
    return extract_points(gpxpy.parse(xml))["n"]


def _segments(xml):
    return extract_points(gpxpy.parse(xml))["segments"]


# ── orientación automática ─────────────────────────────────────────────────

def test_b_guardada_al_reves_se_detecta_y_se_invierte():
    """A termina donde B (guardada al revés) termina: hay que darle la vuelta."""
    a = _line(42.0000, 20)                      # sube hasta 42.0038
    b = _line(42.0076, 20, dlat=-0.0002)        # guardada 42.0076 → 42.0038
    xml, rep = smart_merge([a, b], ["A", "B"])

    assert rep["order"] == [0, 1]
    assert rep["reversed"] == [False, True]
    assert rep["gap_m"] < 1.0                   # las dos mitades se tocan
    assert rep["gap_joined"] is True
    assert len(_segments(xml)) == 1             # y van en el mismo segmento
    assert rep["times_kept"] is False           # un plan no lleva <time>


def test_sin_invertir_gana_el_empate():
    """Dos rectas encaradas: la orientación que no invierte nada gana."""
    a = _line(42.0000, 20)
    b = _line(42.0040, 20)                      # continúa hacia arriba
    rep = smart_merge([a, b])[1]
    assert rep["reversed"] == [False, False]


# ── recorte del solape en la costura ───────────────────────────────────────

def test_solape_en_la_costura_se_recorta_de_b():
    a = _line(42.0000, 20)                      # 42.0000 → 42.0038
    b = _line(42.0030, 20)                      # repite los últimos ~5 puntos
    xml, rep = smart_merge([a, b], ["A", "B"])

    assert rep["reversed"] == [False, False]
    assert rep["trimmed_m"][0] == 0.0           # A no se toca…
    assert 80 < rep["trimmed_m"][1] < 250       # …y a B se le quita la cabeza
    assert rep["tracks"][1]["trimmed_head"]     # que viaja en el informe
    assert not rep["tracks"][1]["trimmed_tail"]
    assert rep["gap_joined"] is True
    assert len(_segments(xml)) == 1
    # Sin el recorte serían 40 puntos; el trozo repetido ya no está.
    assert _n_points(xml) < 40


def test_un_simple_cruce_no_se_recorta():
    """Un punto o dos en común no son un solape (≥3 puntos y ≥2·tol)."""
    a = _line(42.0000, 20)
    b = _line(42.0038, 20)                      # arranca EN el último punto de A
    xml, rep = smart_merge([a, b])
    assert rep["trimmed_m"] == [0.0, 0.0]
    assert _n_points(xml) == 40


def test_a_se_pasa_de_largo_y_su_cola_se_queda_fuera():
    """A sigue de largo por donde va B: esa cola sobra.

    Hasta la v0.10.0 esto se resolvía RECORTANDO la cola de A en la costura.
    Desde que se enumeran propuestas, el inicio de B cae sobre un punto interior
    de A (a 445 m de sus 668), así que A se parte por ahí y la propuesta que
    gana es «A (1ª mitad) + B»: el mismo recorrido, pero con la cola fuera por
    construcción en vez de recortada (por eso `trimmed_m` ya no la cuenta). B va
    suelta —3 puntos para 1,3 km—, así que la junta se encuentra midiendo
    punto→TRAMO y no punto→vértice.
    """
    a = _line(42.0000, 31)                      # 42.0000 → 42.0060
    b = _gpx([(-3.0, 42.0040), (-3.0, 42.0100), (-3.0, 42.0160)])
    xml, rep = smart_merge([a, b], ["A", "B"])

    assert rep["reversed"] == [False, False]
    assert rep["proposals"][0]["label"] == "A (1ª mitad) + B"
    assert rep["proposals"][0]["pieces"][0]["to_m"] == pytest.approx(445, abs=40)
    assert _n_points(xml) < 34                  # la cola de A no está
    assert rep["gap_joined"] is True

    # Con orientación forzada no se parte nada (invertir «la entrada i entera»
    # no tiene sentido sobre trozos), así que se vuelve al recorte de la cola.
    xml2, rep2 = smart_merge([a, b], ["A", "B"], reverse=[False, False])
    assert len(rep2["proposals"]) == 1
    assert rep2["trimmed_m"][0] > 100
    assert rep2["trimmed_m"][1] == 0.0
    assert rep2["tracks"][0]["trimmed_tail"]


def test_ida_y_vuelta_no_se_recorta_y_avisa():
    """B es A al revés: no continúa el recorrido, lo deshace."""
    a = _line(42.0000, 51)
    b = _line(42.0100, 51, dlat=-0.0002)        # exactamente A al revés
    xml, rep = smart_merge([a, b], ["Ida", "Vuelta"])

    assert rep["reversed"] == [False, False]    # empate a hueco 0 → no invertir
    assert rep["trimmed_m"] == [0.0, 0.0]
    assert rep["closed_trim_m"] == 0.0
    assert any("ida y vuelta" in w for w in rep["warnings"])
    assert _n_points(xml) == 102                # no se ha perdido nada


def test_trim_false_no_recorta_nada():
    a = _line(42.0000, 20)
    b = _line(42.0030, 20)
    xml, rep = smart_merge([a, b], trim=False)
    assert rep["trimmed_m"] == [0.0, 0.0]
    assert _n_points(xml) == 40


# ── circular ───────────────────────────────────────────────────────────────

def _circular():
    """Cuadrado de ~550 m de lado partido en dos, con el final montado sobre el
    inicio (el segundo trozo se pasa 150 m por la primera arista)."""
    esquinas = [(-3.0000, 42.0000), (-3.0000, 42.0050), (-2.9940, 42.0050),
                (-2.9940, 42.0000), (-3.0000, 42.0000), (-3.0000, 42.0014)]
    todo = _densify(esquinas)
    corte = len(todo) // 2
    return _gpx(todo[:corte + 1]), _gpx(todo[corte:])


def test_circular_con_la_cola_montada_sobre_el_inicio_se_cierra():
    """Los ~150 m que el 2º trozo se pasa por la primera arista desaparecen.

    Antes los quitaba el recorte de cierre (`closed_trim_m`); ahora el final de
    ese trozo cae sobre un punto interior del primero, así que la propuesta
    ganadora se queda con el circuito exacto y deja fuera el sobrante. Lo que
    importa —que cierre, que no se monte sobre el inicio y que el resultado sea
    el perímetro justo— se comprueba igual.
    """
    a, b = _circular()
    n_bruto = len(a.tracks[0].segments[0].points) + len(b.tracks[0].segments[0].points)
    xml, rep = smart_merge([a, b], ["Vuelta 1", "Vuelta 2"])

    assert rep["closed_loop"] is True
    assert _n_points(xml) < n_bruto
    assert rep["repeated_m"] == 0.0             # el sobrante ya no se repite
    assert rep["proposals"][0]["distance_m"] == pytest.approx(2106, abs=60)
    pts = extract_points(gpxpy.parse(xml))["lonlat"]
    fin = pts[-1]
    ini = pts[0]
    # El final queda a menos de 30 m del inicio (ya no se le monta encima).
    assert abs(fin[1] - ini[1]) * M_DEG < 30


def test_el_recorte_de_cierre_sigue_ahi_con_orientacion_forzada():
    """Con `reverse` no se parte nada, así que la circular la cierra el recorte
    de siempre (`closed_trim_m`), que es el camino que sigue vivo cuando manda
    el usuario o cuando las dos entradas llevan tiempos reales."""
    a, b = _circular()
    xml, rep = smart_merge([a, b], reverse=[False, False])
    assert rep["closed_loop"] is True
    assert rep["closed_trim_m"] > 100
    assert len(rep["proposals"]) == 1


# ── propuestas: costuras INTERIORES ────────────────────────────────────────
#
# El caso real que obligó a esto: un bucle A de 9,5 km dibujado en Wikiloc (con
# 422 <time> IDÉNTICOS, o sea sin tiempos de verdad) y una ruta B grabada que
# ARRANCA en un punto interior de A y termina donde A empieza, volviendo por la
# primera mitad de A en sentido contrario. Encadenar A entera con B deja 3 km de
# hueco y 4 km repetidos; lo que el recorrido pide es partir A por esa junta.
#
# El fixture reproduce la estructura, no las coordenadas: bucle P→(este)→Q→
# (oeste)→P con tiempos idénticos, y un ramal Q→desvío→(este)→P con tiempos
# reales que vuelve pegado a la mitad ESTE del bucle.

P = (-3.0000, 42.0000)
Q = (-3.0000, 42.0200)
ESTE = (-2.9900, 42.0100)       # por donde sube la 1ª mitad de A
OESTE = (-3.0200, 42.0100)      # …y por donde baja la 2ª (más larga)
DESVIO = (-2.9700, 42.0300)


def _gpx_t(coords, start="2020-06-24T08:00:00", step_s=10, name="Tramo"):
    """GPX con <time> por punto; step_s=0 los pone todos IGUALES (Wikiloc)."""
    t0 = dt.datetime.fromisoformat(start)
    pts = []
    for i, (lo, la) in enumerate(coords):
        ts = (t0 + dt.timedelta(seconds=i * step_s)).isoformat()
        pts.append(f'      <trkpt lat="{la:.6f}" lon="{lo:.6f}">'
                   f"<ele>{100 + i * 0.1:.1f}</ele><time>{ts}</time></trkpt>")
    return gpxpy.parse(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f"  <trk><name>{name}</name><trkseg>\n" + "\n".join(pts)
        + "\n  </trkseg></trk>\n</gpx>"
    )


def _bucle_y_ramal(step_a=0):
    """(A, B) con la estructura del caso real. step_a=0 → tiempos falsos en A."""
    a = _gpx_t(_densify([P, ESTE, Q, OESTE, P]), step_s=step_a, name="Bucle")
    b = _gpx_t(_densify([Q, DESVIO, ESTE, P]), step_s=10, name="Ramal")
    return a, b


def test_junta_interior_la_mejor_propuesta_parte_el_bucle():
    """La propuesta 0 es «2ª mitad de A invertida + B»: cierra, no repite nada."""
    a, b = _bucle_y_ramal()
    xml, rep = smart_merge([a, b], ["A", "B"])

    assert rep["had_times"] == [False, True]    # los 422 iguales no cuentan
    assert rep["proposal"] == 0
    p0 = rep["proposals"][0]
    # El ramal vuelve pegado a la mitad ESTE del bucle, así que desde la
    # v0.11.7 esa mitad también es una junta (tramo común, no extremo) y A sale
    # partida en tres. El RECORRIDO es el mismo de siempre —la mitad OESTE
    # invertida + el ramal entero—, pero la etiqueta lo dice por kilómetros:
    # con una entrada partida en más de dos, «1ª/2ª mitad» ya no identifica nada.
    assert p0["label"] == "A (km 2,8→6,8, invertida) + B entera"
    assert p0["closed_loop"] is True
    assert p0["repeated_m"] == 0.0
    assert p0["pieces"][0]["reversed"] is True
    assert p0["pieces"][0]["track"] == 0 and p0["pieces"][1]["track"] == 1
    # 2ª mitad del bucle (≈4,0 km) + el ramal entero (≈6,9 km)
    assert p0["distance_m"] == pytest.approx(10900, rel=0.08)
    # …y `order`/`reversed` van por PIEZA: el ramal entra en sus dos trozos.
    assert rep["order"] == [0, 1, 1]
    assert rep["reversed"] == [True, False, False]
    assert rep["closed_loop"] is True
    assert rep["repeated_m"] == 0.0
    assert _n_points(xml) == rep["n_points"]


def test_la_propuesta_que_repite_la_otra_mitad_existe_y_lo_dice():
    """«1ª mitad + B» también cierra, pero vuelve por donde fue: eso es lo que
    la métrica `repeated_m` pone en números (y por lo que pierde)."""
    a, b = _bucle_y_ramal()
    rep = smart_merge([a, b], ["A", "B"])[1]
    otra = [p for p in rep["proposals"]
            if p["label"] == "A (km 0→1,4) + A (km 1,4→2,8) + B entera"]
    assert otra, [p["label"] for p in rep["proposals"]]
    assert otra[0]["closed_loop"] is True
    assert otra[0]["repeated_m"] > 1000        # el ramal deshace la 1ª mitad
    assert otra[0]["repeated_m"] > rep["proposals"][0]["repeated_m"]
    # …y la unión de toda la vida sigue estando, con su hueco de 2 km.
    entera = [p for p in rep["proposals"]
              if p["label"] == "A entera + B entera"]
    assert entera and entera[0]["gap_m"] > 1000


def test_proposal_elige_otro_ensamblaje():
    base = smart_merge(_bucle_y_ramal(), ["A", "B"])[1]
    etiqueta = base["proposals"][1]["label"]

    # GPX nuevos: smart_merge borra los <time> de los puntos que ensambla, y con
    # ellos cambiaría qué entrada «tiene tiempos» en la segunda pasada.
    a, b = _bucle_y_ramal()
    xml, rep = smart_merge([a, b], ["A", "B"], proposal=1)
    assert rep["proposal"] == 1
    assert rep["proposals"][1]["label"] == etiqueta
    assert [p["label"] for p in rep["proposals"]] == \
           [p["label"] for p in base["proposals"]]
    assert _n_points(xml) == rep["n_points"]


def test_proposal_fuera_de_rango():
    a, b = _bucle_y_ramal()
    with pytest.raises(EditError):
        smart_merge([a, b], proposal=99)
    # …y sin juntas interiores solo existe la 0.
    with pytest.raises(EditError):
        smart_merge([_line(42.0, 20), _line(42.0040, 20)], proposal=1)


def test_tiempos_identicos_no_son_tiempos():
    """422 <time> iguales no describen ningún avance: cuentan como sin tiempos,
    y por eso se puede invertir ese track (y no se conserva ninguna marca)."""
    a, b = _bucle_y_ramal()
    rep = smart_merge([a, b], ["A", "B"])[1]
    assert rep["had_times"] == [False, True]
    assert rep["times_kept"] is False
    assert any(p["reversed"] for p in rep["proposals"][0]["pieces"])
    assert any("marcas de tiempo" in w for w in rep["warnings"])


def test_con_tiempos_reales_en_las_dos_no_se_parte_ni_se_invierte():
    """La misma geometría, pero con el bucle grabado de verdad: manda el reloj,
    no se parte nada y hay una sola propuesta (como antes de todo esto)."""
    a, b = _bucle_y_ramal(step_a=10)
    a = _gpx_t(_densify([P, ESTE, Q, OESTE, P]), start="2020-06-23T08:00:00",
               step_s=10, name="Bucle")
    rep = smart_merge([a, b], ["A", "B"])[1]
    assert rep["had_times"] == [True, True]
    assert rep["reversed"] == [False, False]
    assert len(rep["proposals"]) == 1
    assert rep["times_kept"] is True


# ── propuestas: juntas por TRAMO COMÚN ──────────────────────────────────────
#
# El segundo caso real, y el que obligó a mirar algo más que los extremos: el
# ramal sale de la junta (Q), da una vuelta que VUELVE a Q y desde ahí baja
# pegado al bucle hasta P. Ese punto de vuelta no es extremo de nada, así que
# con las juntas por extremo el ramal no se podía partir ahí: la mejor unión
# acababa llevándose la versión del ramal del sendero Q→P (más larga) en vez de
# la del bucle, o sea 1 km de más y una pieza duplicada.

NORTE = (-3.0100, 42.0320)      # cierra el lazo del ramal, de vuelta a Q
LEJOS = (-2.9600, 42.0000)      # …y por aquí baja el ramal que NO vuelve


def _bucle_y_lazo():
    """(A, B): bucle P→ESTE→Q→OESTE→P, y ramal Q→lazo→Q→ESTE→P.

    El ramal vuelve a Q por su cuenta (lazo) y a partir de ahí repite el sendero
    del bucle. Lo que pide el recorrido es quedarse solo con el lazo.
    """
    a = _gpx_t(_densify([P, ESTE, Q, OESTE, P]), step_s=0, name="Bucle")
    b = _gpx_t(_densify([Q, DESVIO, NORTE, Q, ESTE, P]), step_s=10, name="Lazo")
    return a, b


def test_el_ramal_se_parte_donde_vuelve_a_la_junta():
    """La propuesta 0 es «bucle + lazo empalmado en Q»: A entera (en sus dos
    trozos) con el lazo intercalado, sin repetir el sendero Q→P."""
    a, b = _bucle_y_lazo()
    xml, rep = smart_merge([a, b], ["A", "B"])
    p0 = rep["proposals"][0]

    assert p0["label"] == "A (km 0→2,8) + B (km 0→7,6) + A (km 2,8→6,8)"
    assert p0["closed_loop"] is True
    assert p0["repeated_m"] < 50
    assert [pz["track"] for pz in p0["pieces"]] == [0, 1, 0]
    assert not any(pz["reversed"] for pz in p0["pieces"])
    # A entera (≈7,0 km) + el lazo del ramal (≈7,6 km), sin su cola duplicada
    assert p0["distance_m"] == pytest.approx(14570, rel=0.05)
    assert rep["order"] == [0, 1, 0]
    assert rep["reversed"] == [False, False, False]
    assert _n_points(xml) == rep["n_points"]

    # …y la unión que sí se lleva esa cola sigue en la lista, un km más larga.
    otra = [p for p in rep["proposals"]
            if p["label"] == "A (2ª mitad, invertida) + B entera"]
    assert otra, [p["label"] for p in rep["proposals"]]
    assert otra[0]["closed_loop"] is True


def test_sin_tramo_comun_el_bucle_solo_se_parte_por_el_extremo():
    """El ramal que NO vuelve por el sendero del bucle no parte nada: A sigue en
    dos mitades, B entera, y la etiqueta lo dice con «1ª mitad» (aquí gana esa:
    sin tramo común, cerrar por la mitad ESTE no repite nada y no hay que
    invertir el bucle)."""
    a = _gpx_t(_densify([P, ESTE, Q, OESTE, P]), step_s=0, name="Bucle")
    b = _gpx_t(_densify([Q, DESVIO, LEJOS, P]), step_s=10, name="Ramal")
    rep = smart_merge([a, b], ["A", "B"])[1]
    p0 = rep["proposals"][0]

    assert p0["label"] == "A (1ª mitad) + B"
    assert p0["closed_loop"] is True
    assert [pz["track"] for pz in p0["pieces"]] == [0, 1]
    # una sola junta en A (la del arranque del ramal) y ninguna en B
    assert {pz["track"] for p in rep["proposals"] for pz in p["pieces"]} == {0, 1}
    assert max(len(p["pieces"]) for p in rep["proposals"]) <= 3


def test_las_juntas_por_track_tienen_tope():
    """Un ramal que entra y sale del bucle una docena de veces no puede partirlo
    en una docena de piezas: la enumeración de recorridos crece con ellas."""
    a = _gpx_t(_densify([(-3.0, 42.0 + i * 0.002) for i in range(21)]),
               step_s=0, name="Recta")
    # B se pega a A en tramos de 4 km y se va 2 km en medio, ocho veces
    coords = []
    for i in range(21):
        lejos = (i // 2) % 2
        coords.append((-3.0 if not lejos else -2.97, 42.0 + i * 0.002))
    b = _gpx_t(_densify(coords), step_s=10, name="Sierra")

    from core.editing import _MAX_JUNCTIONS, _flat_entry, _split_units
    entries = []
    for g, nm in ((a, "A"), (b, "B")):
        pts, breaks = _flat_entry(g)
        entries.append((pts, breaks, nm))
    units = _split_units(entries, 30.0, math.cos(math.radians(42.0)), 60.0)
    for src in (0, 1):
        n = len([u for u in units if u.src == src])
        assert n <= _MAX_JUNCTIONS + 1, f"{n} piezas en la entrada {src}"
    assert len(units) > 2                      # …pero alguna junta sí encuentra


# ── extremos del resultado (start / end) ───────────────────────────────────
#
# «La ruta unida empieza en el inicio de B y acaba en el fin de A»: `start` y
# `end` son cadenas «<i><s|e>» (índice de entrada + inicio/fin de su ARCHIVO,
# sin orientar). La condición es sobre el PUNTO, así que en un bucle «0s» y
# «0e» valen los dos.


def test_el_informe_trae_los_extremos_de_las_entradas_y_los_del_resultado():
    a, b = _bucle_y_ramal()
    rep = smart_merge([a, b], ["A", "B"])[1]

    eps = rep["endpoints"]
    assert [e["track"] for e in eps] == [0, 1]
    assert [e["name"] for e in eps] == ["A", "B"]
    assert _near(eps[0]["s"], P, 1) and _near(eps[0]["e"], P, 1)   # el bucle cierra
    assert _near(eps[1]["s"], Q, 1) and _near(eps[1]["e"], P, 1)
    # Los del resultado van siempre, se hayan pedido o no… y sin pedir nada
    # `endpoints_applied` es None (no hubo condición que cumplir ni incumplir).
    assert rep["endpoints_applied"] is None
    assert rep["start_point"] == rep["segments"][0][0]
    assert rep["end_point"] == rep["segments"][-1][-1]


def test_start_obliga_a_empezar_por_el_inicio_del_ramal():
    """«start=1s» (el inicio de B, o sea Q): todas las propuestas arrancan ahí."""
    a, b = _bucle_y_ramal()
    xml, rep = smart_merge([a, b], ["A", "B"], start="1s")

    assert rep["endpoints_applied"] is True
    assert _near(rep["start_point"], Q)
    assert len(rep["proposals"]) >= 2
    for p in rep["proposals"]:
        assert _near(p["segments_lite"][0][0], Q), p["label"]
    assert _n_points(xml) == rep["n_points"]


def test_en_un_bucle_el_inicio_y_el_fin_son_el_mismo_punto():
    """«0s»/«0e» del bucle son P los dos: la condición no descarta nada y sigue
    ganando el circuito de siempre."""
    a, b = _bucle_y_ramal()
    rep = smart_merge([a, b], ["A", "B"], start="0s", end="0e")[1]
    assert rep["endpoints_applied"] is True
    assert _near(rep["start_point"], P) and _near(rep["end_point"], P)
    assert rep["proposals"][0]["label"] == "A (km 2,8→6,8, invertida) + B entera"


def test_extremos_imposibles_no_fallan_avisan_y_dejan_las_propuestas():
    """Pedir algo imposible no puede dejar al usuario sin unión."""
    def dos():                       # dos rectas a 111 km: nada las encadena
        return _line(42.0000, 20), _line(43.0000, 20)

    rep = smart_merge(list(dos()), ["PARTE A", "PARTE B"],
                      start="0s", end="0e")[1]
    assert rep["endpoints_applied"] is False
    aviso = [w for w in rep["warnings"] if "No hay ningún recorrido" in w]
    assert aviso, rep["warnings"]
    assert "el inicio de «PARTE A»" in aviso[0]
    assert "el fin de «PARTE A»" in aviso[0]
    # …y la unión sigue siendo la de siempre, con su ranking intacto.
    assert rep["proposals"][0]["label"] == "A + B"
    assert rep["order"] == [0, 1] and rep["reversed"] == [False, False]


def test_con_reverse_explicito_solo_se_puede_reordenar():
    """Con orientación forzada la restricción se cumple cambiando el ORDEN; si
    esas orientaciones la hacen imposible, manda `reverse` y se avisa."""
    def dos():
        return _line(42.0000, 20), _line(43.0000, 20)

    rep = smart_merge(list(dos()), ["A", "B"], reverse=[False, False],
                      start="1s")[1]
    assert rep["endpoints_applied"] is True
    assert rep["order"] == [1, 0]
    assert rep["reversed"] == [False, False]
    assert not [w for w in rep["warnings"] if "No hay ningún recorrido" in w]

    # «0e» pediría empezar por el FIN de A, que con reverse=[False,…] no ocurre.
    rep2 = smart_merge(list(dos()), ["A", "B"], reverse=[False, False],
                       start="0e")[1]
    assert rep2["endpoints_applied"] is False
    assert rep2["order"] == [0, 1]
    assert any("No hay ningún recorrido" in w for w in rep2["warnings"])


def test_start_y_end_mal_formados_o_fuera_de_rango():
    def dos():
        return _line(42.0000, 20), _line(43.0000, 20)

    for malo in ("0x", "zz", "s", "", "2s"):
        with pytest.raises(EditError):
            smart_merge(list(dos()), start=malo)
    with pytest.raises(EditError):
        smart_merge(list(dos()), start="1s", end="1s")


def test_con_tiempos_reales_los_extremos_mandan_y_se_pierden_las_marcas():
    """Pedir extremos puede obligar a invertir aunque haya tiempos reales: se
    descartan los <time>, con aviso, igual que con `reverse` explícito."""
    a, b = _bucle_y_ramal(step_a=10)
    a = _gpx_t(_densify([P, ESTE, Q, OESTE, P]), start="2020-06-23T08:00:00",
               step_s=10, name="Bucle")
    rep = smart_merge([a, b], ["A", "B"], start="1s")[1]
    assert rep["had_times"] == [True, True]
    assert rep["endpoints_applied"] is True
    assert _near(rep["start_point"], Q)
    assert rep["times_kept"] is False


# ── montaje MANUAL (options.pieces) ────────────────────────────────────────
#
# El usuario dicta los trozos («de A, del km 9,5 al 4,1 —o sea invertido—; de B,
# entera») y el servidor solo arregla las costuras. Las distancias van en la
# misma escala que `track_lengths_m` y que los `from_m`/`to_m` de las
# propuestas: por eso una pieza de una propuesta se puede devolver tal cual.


def _manual(pieces, a=None, b=None, **kw):
    a2, b2 = _bucle_y_ramal() if a is None else (a, b)
    return smart_merge([a2, b2], ["A", "B"], pieces=pieces, **kw)


def test_montaje_manual_reproduce_la_mejor_propuesta():
    """El caso real: «A (2ª mitad, invertida) + B» pedido a mano."""
    auto = smart_merge(_bucle_y_ramal(), ["A", "B"])[1]
    la, lb = auto["track_lengths_m"]
    junta = auto["proposals"][0]["pieces"][0]["from_m"]      # la costura interior
    km_auto = auto["proposals"][0]["distance_m"]

    xml, rep = _manual([{"track": 0, "from_m": la, "to_m": junta},
                        {"track": 1, "from_m": 0, "to_m": lb}])

    assert rep["manual"] is True and rep["proposal"] == 0
    m = rep["proposals"][0]
    assert m["k"] == 0 and m["label"] == "Montaje manual"
    assert len(rep["proposals"]) == 1
    assert rep["closed_loop"] is True
    assert m["repeated_m"] < 200
    assert m["distance_m"] == pytest.approx(km_auto, rel=0.02)
    assert [p["track"] for p in m["pieces"]] == [0, 1]
    assert [p["reversed"] for p in m["pieces"]] == [True, False]
    # A se usa por trozos (no entera) ⇒ su toggle de invertir no significa nada.
    assert m["reversed_inputs"] == [None, False]
    assert m["pieces"][0]["requested"] == {"from_m": round(la, 1),
                                           "to_m": round(junta, 1)}
    assert _n_points(xml) == rep["n_points"]


def test_from_mayor_que_to_invierte_el_trozo():
    """`from_m > to_m` = el trozo al revés, y empieza donde dice `from_m`."""
    a, b = _line(42.0000, 20), _line(43.0000, 20)           # 19 × 22,3 m ≈ 423 m
    xml, rep = smart_merge([a, b], pieces=[{"track": 0, "from_m": 300.0,
                                            "to_m": 0.0}])
    pts = extract_points(gpxpy.parse(xml))["lonlat"]
    assert _near(pts[0], (-3.0, 42.0 + 300.0 / M_DEG))      # el punto del km 0,3
    assert _near(pts[-1], (-3.0, 42.0))
    p0 = rep["proposals"][0]["pieces"][0]
    assert p0["reversed"] is True
    assert p0["from_m"] > p0["to_m"]                        # misma convención
    assert rep["reversed"] == [True] and rep["order"] == [0]


def test_dos_trozos_contiguos_del_mismo_track_no_tienen_costura():
    """Partir un track y volver a montarlo devuelve el track entero."""
    entero = smart_merge([_line(42.0000, 41), _line(43.0000, 20)],
                         pieces=[{"track": 0, "from_m": 0, "to_m": 890}])
    partido = smart_merge([_line(42.0000, 41), _line(43.0000, 20)],
                          pieces=[{"track": 0, "from_m": 0, "to_m": 445},
                                  {"track": 0, "from_m": 445, "to_m": 890}])
    assert (extract_points(gpxpy.parse(partido[0]))["lonlat"]
            == extract_points(gpxpy.parse(entero[0]))["lonlat"])
    rep = partido[1]
    assert rep["junctions"] == [] and rep["gaps"] == []
    assert rep["gap_m"] == 0.0 and rep["gap_joined"] is True
    assert len(_segments(partido[0])) == 1
    assert not [w for w in rep["warnings"] if "Hueco" in w]
    assert rep["proposals"][0]["n_pieces"] == 2


def test_dos_trozos_separados_dejan_corte_y_avisan():
    a = _line(42.0000, 200)                                 # ≈ 4,4 km
    xml, rep = smart_merge([a, _line(43.0000, 20)],
                           pieces=[{"track": 0, "from_m": 0, "to_m": 500},
                                   {"track": 0, "from_m": 3500, "to_m": 4430}])
    assert rep["gap_m"] == pytest.approx(3000, abs=60)
    assert rep["gap_joined"] is False
    assert len(_segments(xml)) == 2
    aviso = [w for w in rep["warnings"] if w.startswith("Hueco")]
    assert aviso, rep["warnings"]
    assert "entre el trozo 1 y el 2" in aviso[0]
    assert "3,0 km" in aviso[0]
    assert "corte de segmento" in aviso[0]


def test_el_solape_de_la_costura_se_recorta_y_se_dice_de_donde():
    """Lo que el cliente necesita para pintar qué se ha quitado de cada trozo."""
    a, b = _line(42.0000, 20), _line(42.0030, 20)           # B repite la cola de A
    xml, rep = smart_merge([a, b], ["A", "B"],
                           pieces=[{"track": 0, "from_m": 0, "to_m": 423},
                                   {"track": 1, "from_m": 0, "to_m": 423}])
    pa, pb = rep["proposals"][0]["pieces"]
    assert pa["trimmed_head_m"] == 0.0 and pa["trimmed_tail_m"] == 0.0
    assert pb["trimmed_head_m"] > 0
    assert pb["from_m"] == pytest.approx(pb["trimmed_head_m"], abs=0.2)
    assert pb["requested"] == {"from_m": 0.0, "to_m": 423.0}
    assert pb["len_m"] < pb["requested"]["to_m"]
    assert _n_points(xml) < 40


def test_pieces_mal_formados_o_imposibles():
    a, b = _line(42.0000, 20), _line(43.0000, 20)
    with pytest.raises(EditError) as e:                     # < 2·tol metros
        smart_merge([a, b], pieces=[{"track": 0, "from_m": 0, "to_m": 10}])
    assert "trozo 1 es demasiado corto" in str(e.value)
    with pytest.raises(EditError) as e:                     # índice inexistente
        smart_merge([a, b], pieces=[{"track": 5, "from_m": 0, "to_m": 400}])
    assert "no existe la ruta 5" in str(e.value)
    for malo in ([], "0", [{"track": 0, "from_m": "x", "to_m": 400}],
                 [{"track": 0, "to_m": 400}], [{"from_m": 0, "to_m": 400}],
                 [42]):
        with pytest.raises(EditError):
            smart_merge([a, b], pieces=malo)


def test_pieces_ignora_proposal_reverse_y_extremos_pero_no_falla():
    auto = smart_merge(_bucle_y_ramal(), ["A", "B"])[1]
    la, lb = auto["track_lengths_m"]
    xml, rep = _manual([{"track": 0, "from_m": 0, "to_m": la},
                        {"track": 1, "from_m": 0, "to_m": lb}],
                       proposal=3, reverse=[True, True], start="1e", end="0x")
    assert rep["manual"] is True and rep["proposal"] == 0
    aviso = [w for w in rep["warnings"] if "montaje manual" in w]
    assert aviso, rep["warnings"]
    assert "«reverse»" in aviso[0] and "«proposal»" in aviso[0]
    assert "extremos" in aviso[0]
    assert rep["reversed"] == [False, False]                # reverse no ha mandado
    assert rep["endpoints_applied"] is None
    assert _n_points(xml) == rep["n_points"]


def test_con_tiempos_reales_invertir_un_trozo_descarta_las_marcas():
    a = _gpx_t(_densify([P, ESTE, Q, OESTE, P]), start="2020-06-23T08:00:00",
               step_s=10, name="Bucle")
    b = _bucle_y_ramal(step_a=10)[1]
    auto = smart_merge([_gpx_t(_densify([P, ESTE, Q, OESTE, P]),
                               start="2020-06-23T08:00:00", step_s=10),
                        _bucle_y_ramal(step_a=10)[1]], ["A", "B"])[1]
    la, lb = auto["track_lengths_m"]
    assert auto["had_times"] == [True, True] and auto["times_kept"] is True

    rep = smart_merge([a, b], ["A", "B"],
                      pieces=[{"track": 0, "from_m": la, "to_m": 0},
                              {"track": 1, "from_m": 0, "to_m": lb}])[1]
    assert rep["had_times"] == [True, True]
    assert rep["times_kept"] is False
    assert any("marcas de tiempo" in w for w in rep["warnings"])


def test_track_lengths_m_va_siempre_y_mide_cada_entrada():
    a, b = _line(42.0000, 20), _line(43.0000, 41)
    rep = smart_merge([a, b])[1]                            # también en automático
    assert rep["manual"] is False
    assert rep["track_lengths_m"] == pytest.approx([422.8, 890.6], rel=0.01)
    # …y es la escala en la que se piden los trozos.
    rep2 = smart_merge([_line(42.0000, 20), _line(43.0000, 41)],
                       pieces=[{"track": 1, "from_m": 0,
                                "to_m": rep["track_lengths_m"][1]}])[1]
    assert rep2["proposals"][0]["pieces"][0]["len_m"] == \
        pytest.approx(rep["track_lengths_m"][1], rel=0.01)
    assert rep2["proposals"][0]["reversed_inputs"] == [None, False]


# ── hueco: unir en recta o cortar el segmento ──────────────────────────────

def test_hueco_pequeno_une_y_hueco_grande_corta():
    a = _line(42.0000, 20)                      # acaba en 42.0038
    cerca = _line(42.0041, 20)                  # ~33 m
    lejos = _line(42.0048, 20)                  # ~111 m

    xml, rep = smart_merge([a, cerca])
    assert rep["gap_m"] < 50 and rep["gap_joined"] is True
    assert len(_segments(xml)) == 1

    a = _line(42.0000, 20)
    xml, rep = smart_merge([a, lejos])
    assert rep["gap_m"] > 50 and rep["gap_joined"] is False
    assert len(_segments(xml)) == 2


def test_join_gap_fuerza_las_dos_decisiones():
    a = _line(42.0000, 20)
    lejos = _line(42.0048, 20)
    xml, rep = smart_merge([a, lejos], join_gap=True)
    assert rep["gap_joined"] is True and len(_segments(xml)) == 1

    a = _line(42.0000, 20)
    cerca = _line(42.0041, 20)
    xml, rep = smart_merge([a, cerca], join_gap=False)
    assert rep["gap_joined"] is False and len(_segments(xml)) == 2


# ── tiempos: con <time> nunca se invierte ──────────────────────────────────

def test_con_tiempos_orden_cronologico_y_sin_invertir(make_gpx_xml):
    """La geometría pediría invertir la segunda, pero invertir borra los <time>."""
    tarde = gpxpy.parse(make_gpx_xml(tracks=[(10,)], start="2024-05-02T09:00:00",
                                     lat0=43.0100, dlat=-0.0002))
    pronto = gpxpy.parse(make_gpx_xml(tracks=[(10,)], start="2024-05-01T09:00:00",
                                      lat0=42.0000, dlat=0.0002))
    xml, rep = smart_merge([tarde, pronto])
    assert rep["order"] == [1, 0]               # primero la de mayo-01
    assert rep["reversed"] == [False, False]
    assert rep["times_kept"] is True
    assert extract_points(gpxpy.parse(xml))["time"] is not None


def test_con_tiempos_solapados_se_descartan(make_gpx_xml):
    a = gpxpy.parse(make_gpx_xml(tracks=[(5,)], start="2024-05-01T09:00:00"))
    b = gpxpy.parse(make_gpx_xml(tracks=[(5,)], start="2024-05-01T09:02:00",
                                 lat0=43.0))
    xml, rep = smart_merge([a, b])
    assert rep["times_kept"] is False
    assert extract_points(gpxpy.parse(xml))["time"] is None
    assert any("tiempos" in w for w in rep["warnings"])


# ── orientación forzada ────────────────────────────────────────────────────

def test_reverse_explicito_manda_sobre_el_automatico():
    a = _line(42.0000, 20)
    b = _line(42.0041, 20)                      # el automático NO la invertiría
    xml, rep = smart_merge([a, b], reverse=[False, True])
    assert rep["reversed"] == [False, True]
    pts = extract_points(gpxpy.parse(xml))["lonlat"]
    assert pts[-1][1] == pytest.approx(42.0041, abs=1e-6)   # B acaba por su inicio

    with pytest.raises(EditError):
        smart_merge([a, b], reverse=[True])


# ── N entradas, informe y envoltorio ───────────────────────────────────────

def test_tres_entradas_encadenadas():
    a = _line(42.0000, 20)                      # → 42.0038
    b = _line(42.0080, 20, dlat=-0.0002)        # guardada al revés: → 42.0042
    c = _line(42.0084, 20)                      # continúa desde 42.0084
    xml, rep = smart_merge([a, b, c], ["A", "B", "C"])

    assert rep["order"] == [0, 1, 2]
    assert rep["reversed"] == [False, True, False]
    assert len(rep["junctions"]) == 2 and len(rep["gaps"]) == 2
    assert _n_points(xml) == rep["n_points"]
    assert [t["idx"] for t in rep["tracks"]] == [0, 1, 2]


# ── 3+ entradas en cualquier orden ─────────────────────────────────────────
# La vista `unir` deja elegir varias, y el orden en que llegan es el de
# SELECCIÓN: el servidor tiene que encontrar el del recorrido. `_zigzag(n)` son
# n tramos rectos de ~3 km que empalman extremo con extremo (sin juntas
# interiores), con los impares guardados al revés.

def _zigzag(n):
    wps = [(-3.0 + 0.03 * i, 42.0 + (0.02 if i % 2 else 0)) for i in range(n + 1)]
    out = []
    for i in range(n):
        c = _densify([wps[i], wps[i + 1]])
        out.append(_gpx(c[::-1] if i % 2 else c, f"T{i}"))
    return out


@pytest.mark.parametrize("orden", [[1, 2, 0], [2, 0, 1], [0, 2, 1]])
def test_tres_entradas_desordenadas_se_encadenan_sin_hueco(orden):
    gs = _zigzag(3)
    xml, rep = smart_merge([gs[i] for i in orden], [f"T{i}" for i in orden])
    p0 = rep["proposals"][0]
    assert p0["gap_m"] < 1 and rep["gap_m"] < 1
    assert len(_segments(xml)) == 1
    # usa las tres, cada una entera y una sola vez
    assert sorted(x["track"] for x in p0["pieces"]) == [0, 1, 2]


def test_un_circuito_con_hueco_no_gana_al_recorrido_continuo():
    """Con [1, 2, 0] salía primera «A + C + B (invertida)»: cerraba circuito
    saltándose 5 km en recta. Cerrar solo cuenta si no deja huecos cortados."""
    gs = _zigzag(3)
    _xml, rep = smart_merge([gs[1], gs[2], gs[0]], ["T1", "T2", "T0"])
    assert rep["proposals"][0]["gap_m"] < 1


@pytest.mark.parametrize("n", [4, 5, 6])
def test_cuatro_o_mas_entradas_desordenadas_se_encadenan_rapido(n):
    """Con 4+ no se prueban todas las permutaciones: los encadenados «al
    extremo más cercano» (_greedy_orders) son los que encuentran el recorrido."""
    import random
    rnd = random.Random(n)
    gs = _zigzag(n)
    orden = list(range(n))
    rnd.shuffle(orden)
    t0 = time.time()
    _xml, rep = smart_merge([gs[i] for i in orden], [f"T{i}" for i in orden])
    assert time.time() - t0 < 2.0
    assert rep["proposals"][0]["gap_m"] < 1


def test_orientacion_forzada_con_tres_reordena_para_no_dejar_hueco():
    gs = _zigzag(3)
    # llegan como [T2, T0, T1]; T1 va guardado al revés → hay que invertirlo
    _xml, rep = smart_merge([gs[2], gs[0], gs[1]], ["T2", "T0", "T1"],
                            reverse=[False, False, True])
    assert len(rep["proposals"]) == 1
    assert rep["order"] == [1, 2, 0]           # T0 → T1 (invertido) → T2
    assert rep["gap_m"] < 1


def test_demasiadas_entradas():
    gs = _zigzag(9)
    with pytest.raises(EditError):
        smart_merge(gs, [f"T{i}" for i in range(9)])


def test_el_informe_va_decimado():
    a = _line(42.0000, 3000, dlat=0.00002)
    b = _line(42.0700, 3000, dlat=0.00002)
    rep = smart_merge([a, b])[1]
    assert all(len(t["coords"]) <= 2000 for t in rep["tracks"])
    assert all(len(s) <= 2000 for s in rep["segments"])
    assert rep["n_points"] == 6000


def test_merge_gpx_sigue_devolviendo_xml_y_times_kept(make_gpx_xml):
    a = gpxpy.parse(make_gpx_xml(tracks=[(5,)], start="2024-05-01T09:00:00"))
    b = gpxpy.parse(make_gpx_xml(tracks=[(5,)], start="2024-05-02T09:00:00",
                                 lat0=43.0))
    xml, times_kept = merge_gpx([a, b])
    assert times_kept is True and _n_points(xml) == 10
    with pytest.raises(EditError):
        merge_gpx([a])


def test_waypoints_y_extensiones_sobreviven(make_gpx_xml):
    a = gpxpy.parse(make_gpx_xml(tracks=[(10,)], hr=150, with_times=False,
                                 waypoints=[(-3.0, 42.0, "Fuente")]))
    b = gpxpy.parse(make_gpx_xml(tracks=[(10,)], hr=160, with_times=False,
                                 lat0=42.05))
    xml = smart_merge([a, b])[0]
    pts = extract_points(gpxpy.parse(xml))
    assert pts["hr"] is not None and pts["hr"][0] == 150
    assert len(gpxpy.parse(xml).waypoints) == 1


# ── rendimiento ────────────────────────────────────────────────────────────

def test_dos_tracks_de_20000_puntos_en_menos_de_dos_segundos():
    """La distancia punto→traza NO puede ser O(n·m): con 20 000 puntos por lado
    serían 4·10⁸ comparaciones en Python puro."""
    a = _line(42.0000, 20000, dlat=0.00001)     # 200 m de paso… 20 000 puntos
    b = _line(42.2100, 20000, dlat=0.00001)
    t0 = time.perf_counter()
    xml, rep = smart_merge([a, b])
    dt = time.perf_counter() - t0
    assert rep["n_points"] == 40000
    assert dt < 2.0, f"smart_merge tardó {dt:.2f} s"
    assert xml


# ── los dos endpoints de unión (preview y creación) ────────────────────────
#
# Se prueba sobre PLANES porque es donde la unión inteligente hace falta (un
# plan casi nunca lleva <time>), pero el flujo —options, preview, informe— es el
# mismo objeto compartido: api/editor.py::run_merge.

os.environ["GEOCODE_URL"] = ""
os.environ.setdefault("DEM_URL", "")

from app import app as flask_app            # noqa: E402


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


def _plan(client, gpx_obj, name):
    r = client.post("/api/planned",
                    data={"gpx": (io.BytesIO(gpx_obj.to_xml().encode()), "p.gpx"),
                          "name": name},
                    content_type="multipart/form-data")
    assert r.status_code == 201, r.get_data(as_text=True)
    return r.get_json()["public_id"]


def test_endpoint_preview_no_crea_nada_y_devuelve_informe(client):
    a = _plan(client, _line(42.3000, 20), "Parte A")
    b = _plan(client, _line(42.3076, 20, dlat=-0.0002), "Parte B")   # al revés
    antes = len(client.get("/api/planned").get_json())

    r = client.post("/api/planned/merge",
                    json={"ids": [a, b], "name": "A + B", "preview": True})
    assert r.status_code == 200
    d = r.get_json()
    assert d["preview"] is True
    assert d["report"]["reversed"] == [False, True]
    assert d["stats"]["distance_m"] > 0 and d["stats"]["n_points"] == 40
    assert len(d["report"]["tracks"]) == 2 and d["report"]["segments"]
    # …y NO se ha creado ningún plan.
    assert len(client.get("/api/planned").get_json()) == antes


def test_endpoint_crea_el_plan_y_adjunta_el_informe(client):
    a = _plan(client, _line(42.4000, 20), "Parte A")
    b = _plan(client, _line(42.4076, 20, dlat=-0.0002), "Parte B")

    r = client.post("/api/planned/merge", json={"ids": [a, b], "name": "Unido"})
    assert r.status_code == 201, r.get_data(as_text=True)
    d = r.get_json()
    assert d["times_kept"] is False
    assert d["report"]["reversed"] == [False, True]
    # El informe de la creación va SIN trazas (pesan y aquí no se pintan).
    assert "tracks" not in d["report"] and "segments" not in d["report"]
    assert client.get(f"/api/planned/{d['public_id']}/points").get_json()["n"] == 40


def test_endpoint_acepta_options(client):
    a = _plan(client, _line(42.5000, 20), "Parte A")
    b = _plan(client, _line(42.5041, 20), "Parte B")     # hueco de ~33 m

    r = client.post("/api/planned/merge",
                    json={"ids": [a, b], "preview": True,
                          "options": {"reverse": [False, True], "trim": False,
                                      "join_gap": False, "tol_m": 10}})
    rep = r.get_json()["report"]
    assert rep["reversed"] == [False, True]
    assert rep["gap_joined"] is False
    assert rep["trimmed_m"] == [0.0, 0.0]

    mal = client.post("/api/planned/merge",
                      json={"ids": [a, b], "options": {"reverse": [True]}})
    assert mal.status_code == 400


def test_endpoint_devuelve_las_propuestas_y_options_proposal_elige(client):
    """Lo que consume el editor: `report.proposals[]` y `options.proposal`."""
    a = _plan(client, _bucle_y_ramal()[0], "Bucle")
    b = _plan(client, _bucle_y_ramal()[1], "Ramal")

    r = client.post("/api/planned/merge",
                    json={"ids": [a, b], "preview": True})
    rep = r.get_json()["report"]
    assert rep["proposal"] == 0
    assert rep["had_times"] == [False, True]
    assert len(rep["proposals"]) >= 2
    assert rep["proposals"][0]["label"] == "A (km 2,8→6,8, invertida) + B entera"
    assert rep["proposals"][0]["pieces"][0]["reversed"] is True
    assert rep["proposals"][0]["segments_lite"]          # para pintarla
    km0 = r.get_json()["stats"]["distance_m"]

    r1 = client.post("/api/planned/merge",
                     json={"ids": [a, b], "preview": True,
                           "options": {"proposal": 1}})
    d1 = r1.get_json()
    assert d1["report"]["proposal"] == 1
    assert d1["stats"]["distance_m"] != km0

    mal = client.post("/api/planned/merge",
                      json={"ids": [a, b], "options": {"proposal": 99}})
    assert mal.status_code == 400

    # …y al crear de verdad, el plan sale con las cifras de esa propuesta.
    cre = client.post("/api/planned/merge",
                      json={"ids": [a, b], "name": "Unido",
                            "options": {"proposal": 1}})
    assert cre.status_code == 201, cre.get_data(as_text=True)
    hecho = cre.get_json()
    assert hecho["report"]["proposal"] == 1
    assert "segments_lite" not in hecho["report"]["proposals"][0]
    plan = client.get(f"/api/planned/{hecho['public_id']}").get_json()
    assert plan["distance_m"] == pytest.approx(d1["stats"]["distance_m"], rel=0.02)


def test_endpoint_de_rutas_tambien_previsualiza(client, make_gpx_xml):
    """El de rutas comparte el flujo (run_merge), pero es otro blueprint: si el
    cableado se queda a medias, falla solo aquí."""
    def ruta(xml, name):
        r = client.post("/api/routes",
                        data={"gpx": (io.BytesIO(xml.encode()), f"{name}.gpx")},
                        content_type="multipart/form-data")
        assert r.status_code == 201, r.get_data(as_text=True)
        return r.get_json()["public_id"]

    a = ruta(make_gpx_xml(tracks=[(10,)], start="2024-06-01T09:00:00",
                          lat0=41.0, name="Mañana"), "a")
    b = ruta(make_gpx_xml(tracks=[(10,)], start="2024-06-02T09:00:00",
                          lat0=41.5, name="Tarde"), "b")
    antes = len(client.get("/api/routes").get_json()["items"])

    r = client.post("/api/routes/merge", json={"ids": [a, b], "preview": True})
    assert r.status_code == 200, r.get_data(as_text=True)
    d = r.get_json()
    assert d["report"]["times_kept"] is True            # con <time> no se invierte
    assert d["report"]["reversed"] == [False, False]
    assert d["stats"]["n_points"] == 20
    assert len(client.get("/api/routes").get_json()["items"]) == antes

    r = client.post("/api/routes/merge", json={"ids": [a, b], "name": "Las dos"})
    assert r.status_code == 201
    assert r.get_json()["report"]["times_kept"] is True
    assert "tracks" not in r.get_json()["report"]


def test_endpoint_valida_start_y_end(client):
    a = _plan(client, _line(42.6000, 20), "Parte A")
    b = _plan(client, _line(42.6041, 20), "Parte B")

    for malo in ("2s", "0x", "zz", "s", 7):
        r = client.post("/api/planned/merge",
                        json={"ids": [a, b], "preview": True,
                              "options": {"start": malo}})
        assert r.status_code == 400, (malo, r.get_data(as_text=True))
        assert "error" in r.get_json()

    igual = client.post("/api/planned/merge",
                        json={"ids": [a, b], "preview": True,
                              "options": {"start": "1s", "end": "1s"}})
    assert igual.status_code == 400
    assert "mismo extremo" in igual.get_json()["error"]


def test_endpoint_start_y_end_eligen_por_donde_empieza_el_resultado(client):
    """Lo que consume el selector de extremos de la sección `unir`."""
    a = _plan(client, _bucle_y_ramal()[0], "Bucle")
    b = _plan(client, _bucle_y_ramal()[1], "Ramal")

    libre = client.post("/api/planned/merge",
                        json={"ids": [a, b], "preview": True}).get_json()
    assert libre["report"]["endpoints_applied"] is None
    assert [e["track"] for e in libre["report"]["endpoints"]] == [0, 1]
    assert _near(libre["report"]["start_point"], P)

    r = client.post("/api/planned/merge",
                    json={"ids": [a, b], "preview": True,
                          "options": {"start": "1s"}})
    rep = r.get_json()["report"]
    assert rep["endpoints_applied"] is True
    assert _near(rep["start_point"], Q)

    # …y al crear de verdad el informe ligero conserva los extremos.
    cre = client.post("/api/planned/merge",
                      json={"ids": [a, b], "name": "Desde Q",
                            "options": {"start": "1s"}})
    assert cre.status_code == 201, cre.get_data(as_text=True)
    lean = cre.get_json()["report"]
    assert lean["endpoints_applied"] is True
    assert _near(lean["start_point"], Q)
    assert lean["endpoints"] and "tracks" not in lean


def test_preview_devuelve_el_perfil_de_elevacion(client):
    """La previsualización trae el perfil del resultado sin crearlo, ya
    remuestreado con `resample` (lo mismo que hace ?lite=1 con el detalle): 500
    puntos de paso constante más el último, que se conserva siempre para no
    recortar el final del perfil."""
    a = _plan(client, _line(42.7000, 1500, dlat=0.00002), "Larga A")
    b = _plan(client, _line(42.7300, 1500, dlat=0.00002), "Larga B")

    d = client.post("/api/planned/merge",
                    json={"ids": [a, b], "preview": True}).get_json()
    elev = d["elevation"]
    assert d["stats"]["n_points"] == 3000        # sin remuestrear serían 3000
    assert 500 <= len(elev) <= 501
    ds = [p["d"] for p in elev]
    assert ds == sorted(ds)
    assert all("e" in p for p in elev)
    assert ds[-1] == pytest.approx(d["stats"]["distance_m"] / 1000.0, rel=0.02)

    # Un perfil corto no se toca (y sigue estando).
    c = _plan(client, _line(42.8000, 20), "Corta A")
    e = _plan(client, _line(42.8041, 20), "Corta B")
    corta = client.post("/api/planned/merge",
                        json={"ids": [c, e], "preview": True}).get_json()
    assert len(corta["elevation"]) == corta["stats"]["n_points"]


def test_endpoint_montaje_manual(client):
    """Lo que consume el modo «unirV2» de la sección `unir`."""
    a = _plan(client, _bucle_y_ramal()[0], "Bucle")
    b = _plan(client, _bucle_y_ramal()[1], "Ramal")

    auto = client.post("/api/planned/merge",
                       json={"ids": [a, b], "preview": True}).get_json()["report"]
    la, lb = auto["track_lengths_m"]
    junta = auto["proposals"][0]["pieces"][0]["from_m"]
    pcs = [{"track": 0, "from_m": la, "to_m": junta},
           {"track": 1, "from_m": 0, "to_m": lb}]

    r = client.post("/api/planned/merge",
                    json={"ids": [a, b], "preview": True,
                          "options": {"pieces": pcs}})
    assert r.status_code == 200, r.get_data(as_text=True)
    d = r.get_json()
    rep = d["report"]
    assert rep["manual"] is True and rep["proposal"] == 0
    assert rep["proposals"][0]["label"] == "Montaje manual"
    assert rep["proposals"][0]["pieces"][0]["reversed"] is True
    assert rep["proposals"][0]["segments_lite"]          # para pintarla
    assert rep["track_lengths_m"] == [la, lb]
    assert d["elevation"] and d["stats"]["distance_m"] > 0
    km = d["stats"]["distance_m"]

    cre = client.post("/api/planned/merge",
                      json={"ids": [a, b], "name": "Montado",
                            "options": {"pieces": pcs}})
    assert cre.status_code == 201, cre.get_data(as_text=True)
    hecho = cre.get_json()
    lean = hecho["report"]
    assert lean["manual"] is True and lean["track_lengths_m"] == [la, lb]
    assert "tracks" not in lean and "segments" not in lean
    assert "segments_lite" not in lean["proposals"][0]
    assert lean["proposals"][0]["pieces"][0]["requested"]["from_m"] == \
        pytest.approx(la, rel=0.001)
    plan = client.get(f"/api/planned/{hecho['public_id']}").get_json()
    assert plan["distance_m"] == pytest.approx(km, rel=0.02)


def test_endpoint_valida_pieces(client):
    a = _plan(client, _line(42.9000, 20), "Parte A")
    b = _plan(client, _line(42.9041, 20), "Parte B")

    for malo in ([], "0", [{"track": 0, "from_m": "x", "to_m": 400}],
                 [{"track": 9, "from_m": 0, "to_m": 400}],
                 [{"track": 0, "from_m": 0, "to_m": 5}]):
        r = client.post("/api/planned/merge",
                        json={"ids": [a, b], "preview": True,
                              "options": {"pieces": malo}})
        assert r.status_code == 400, (malo, r.get_data(as_text=True))
        assert "error" in r.get_json()

    # Con `pieces`, un extremo mal escrito o una propuesta inexistente NO fallan.
    ok = client.post("/api/planned/merge",
                     json={"ids": [a, b], "preview": True,
                           "options": {"pieces": [{"track": 0, "from_m": 0,
                                                   "to_m": 423}],
                                       "start": "0x", "proposal": 99}})
    assert ok.status_code == 200, ok.get_data(as_text=True)
    assert any("montaje manual" in w for w in ok.get_json()["report"]["warnings"])


def test_endpoint_une_tres_planes_en_cualquier_orden(client):
    """Lo que manda la vista `unir` con selección múltiple: A + dos elegidas, en
    el orden en que se marcaron (que no es el del recorrido)."""
    gs = _zigzag(3)
    ids = [_plan(client, gs[i], f"Tramo {i}") for i in (1, 2, 0)]
    r = client.post("/api/planned/merge", json={"ids": ids, "preview": True})
    assert r.status_code == 200, r.get_data(as_text=True)
    rep = r.get_json()["report"]
    assert rep["proposals"][0]["gap_m"] < 1
    assert len(rep["track_lengths_m"]) == 3 and len(rep["endpoints"]) == 3
    # extremos de la TERCERA entrada: «2s»/«2e» son válidos
    r = client.post("/api/planned/merge", json={"ids": ids, "preview": True,
                                                "options": {"start": "2s"}})
    assert r.status_code == 200 and r.get_json()["report"]["endpoints_applied"] is True
    # y un montaje manual con trozos de las tres
    L = rep["track_lengths_m"]
    pieces = [{"track": 2, "from_m": 0, "to_m": L[2]},
              {"track": 0, "from_m": L[0], "to_m": 0},
              {"track": 1, "from_m": 0, "to_m": L[1]}]
    r = client.post("/api/planned/merge", json={"ids": ids, "preview": True,
                                                "options": {"pieces": pieces}})
    assert r.status_code == 200, r.get_data(as_text=True)
    assert len(r.get_json()["report"]["proposals"][0]["pieces"]) == 3
