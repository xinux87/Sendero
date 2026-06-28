def human_duration(seconds):
    if not seconds:
        return None
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, _ = divmod(rem, 60)
    if h:
        return f"{h} h {m} min"
    return f"{m} min"


def auto_summary(r):
    parts = []
    km = (r["distance_m"] or 0) / 1000
    parts.append(f"Ruta de {km:.2f} km")
    if r["ascent_m"]:
        parts.append(f"con {int(r['ascent_m'])} m de desnivel positivo")
    if r["descent_m"]:
        parts.append(f"y {int(r['descent_m'])} m negativo")
    txt = " ".join(parts) + "."
    extra = []
    dur = human_duration(r["moving_s"] or r["duration_s"])
    if dur:
        extra.append(f"Tiempo en movimiento: {dur}")
    if r["avg_speed"]:
        extra.append(f"velocidad media {r['avg_speed']:.1f} km/h")
    if r["ele_max"] is not None:
        extra.append(f"altitud máxima {int(r['ele_max'])} m")
    if extra:
        txt += " " + ", ".join(extra) + "."
    return txt


def auto_summary_planned(r):
    km = (r.get("distance_m") or 0) / 1000
    parts = [f"Ruta planificada de {km:.2f} km"] if km > 0 else []
    if r.get("ascent_m"):
        parts.append(f"con {int(r['ascent_m'])} m de desnivel positivo")
    if r.get("descent_m"):
        parts.append(f"y {int(r['descent_m'])} m negativo")
    txt = (" ".join(parts) + ".") if parts else "Sin datos de distancia."
    extra = []
    if r.get("ele_max") is not None:
        extra.append(f"altitud máxima {int(r['ele_max'])} m")
    if r.get("ele_min") is not None:
        extra.append(f"mínima {int(r['ele_min'])} m")
    if extra:
        txt += " " + ", ".join(extra).capitalize() + "."
    return txt
