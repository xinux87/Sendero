"""
Vigilante de carpeta para importación automática de GPX.

Apunta SENDERO_WATCH_DIR a la carpeta donde Syncthing deja los GPX del reloj.
Cada SENDERO_POLL segundos busca archivos .gpx nuevos, los sube a Sendero
mediante su API y los mueve a la subcarpeta 'imported/' (o 'failed/' si fallan).

Se ejecuta como proceso aparte (un segundo servicio en docker-compose),
no dentro de los workers de gunicorn, para que solo haya un importador.
"""
import os
import time
import shutil
from pathlib import Path

import requests

WATCH = Path(os.environ.get("SENDERO_WATCH_DIR", "/watch"))
API = os.environ.get("SENDERO_API", "http://sendero:8080").rstrip("/")
POLL = int(os.environ.get("SENDERO_POLL", "30"))

DONE = WATCH / "imported"
FAIL = WATCH / "failed"
DUP = WATCH / "duplicated"


def process(path: Path):
    try:
        with open(path, "rb") as fh:
            # auto=1: una posible duplicada semántica se importa marcada para
            # revisión (dup_suspect_of) en vez de bloquear; solo la dup EXACTA da 409.
            r = requests.post(f"{API}/api/routes?auto=1",
                              files={"gpx": (path.name, fh, "application/gpx+xml")},
                              timeout=60)
        if r.status_code == 201:
            DONE.mkdir(exist_ok=True)
            shutil.move(str(path), DONE / path.name)
            body = r.json()
            if body.get("soft_duplicate"):
                print(f"[dup?] importado {path.name} -> ruta {body.get('id')} "
                      f"(posible duplicada de {body.get('existing_id')}, marcada)", flush=True)
            else:
                print(f"[ok] importado {path.name} -> ruta {body.get('id')}", flush=True)
        elif r.status_code == 409:
            # Ruta repetida (colisión de nombre de GPX): se descarta, no es un fallo real.
            DUP.mkdir(exist_ok=True)
            shutil.move(str(path), DUP / path.name)
            print(f"[dup] descartado {path.name}: ya existe una ruta con ese nombre", flush=True)
        else:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:120]}")
    except Exception as e:
        print(f"[err] {path.name}: {e}", flush=True)
        FAIL.mkdir(exist_ok=True)
        try:
            shutil.move(str(path), FAIL / path.name)
        except Exception:
            pass


def main():
    WATCH.mkdir(parents=True, exist_ok=True)
    print(f"Vigilando {WATCH} (cada {POLL}s) -> {API}", flush=True)
    seen_incomplete = {}
    while True:
        candidates = sorted([*WATCH.glob("*.gpx"), *WATCH.glob("*.fit"),
                              *WATCH.glob("*.GPX"), *WATCH.glob("*.FIT")])
        for p in candidates:
            # espera a que el archivo deje de crecer (Syncthing aún copiando)
            size = p.stat().st_size
            if seen_incomplete.get(p) != size:
                seen_incomplete[p] = size
                continue
            seen_incomplete.pop(p, None)
            process(p)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
