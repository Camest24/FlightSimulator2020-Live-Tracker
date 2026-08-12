"""Persistencia del vuelo: el vuelo en curso y el historial, en data/*.json.

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import json
import os
import time

from .core import CURRENT_FILE, HISTORY_FILE, state, route, lock
from .geo import _haversine_nm
from .navdata import nearest_airport


# ---------------------------------------------------------------------------
# Persistencia del vuelo
# ---------------------------------------------------------------------------
def load_current_flight():
    if not os.path.exists(CURRENT_FILE):
        return
    try:
        with open(CURRENT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        with lock:
            route.extend(data.get("route", []))
            state["distance_nm"] = data.get("distance_nm", 0.0)
            state["max_alt"] = data.get("max_alt", 0)
            state["flight_start"] = data.get("flight_start")
            state["elapsed_min"] = data.get("elapsed_min", 0)
    except Exception:
        pass


def save_current_flight():
    try:
        with lock:
            payload = {
                "route": route,
                "distance_nm": state["distance_nm"],
                "max_alt": state["max_alt"],
                "flight_start": state["flight_start"],
                "elapsed_min": state["elapsed_min"],
            }
        with open(CURRENT_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except Exception:
        pass


def read_history():
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            h = json.load(f)
        return h if isinstance(h, list) else []
    except Exception:
        return []


def write_history(h):
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(h, f, indent=2)
        return True
    except Exception:
        return False


def archive_flight_to_history():
    with lock:
        if not route:
            return False
        start, end = state["flight_start"], time.time()
        snapshot = list(route)
        first, last = route[0], route[-1]
        pts = len(route)

    # La distancia la recalculamos desde el rastro en vez de confiar en el acumulador:
    # ese arrastra saltos de teletransporte y valores heredados de sesiones anteriores.
    # Ignoramos tramos de más de 5 NM entre dos lecturas: a 0,25 s ni con el simulador
    # a 8x se recorre tanto, así que solo pueden ser saltos.
    dist = 0.0
    for i in range(len(snapshot) - 1):
        d = _haversine_nm(snapshot[i][0], snapshot[i][1], snapshot[i + 1][0], snapshot[i + 1][1])
        if d <= 5.0:
            dist += d

    if pts < 5 or dist < 1.0:
        if os.path.exists(CURRENT_FILE):
            try:
                os.remove(CURRENT_FILE)
            except Exception:
                pass
        return False

    org = nearest_airport(first[0], first[1])
    dst = nearest_airport(last[0], last[1])
    entry = {
        "id": int(end * 1000),
        "start_time": start,
        "end_time": end,
        "distance_nm": round(dist, 1),
        "max_alt_ft": state["max_alt"],
        "points": pts,
        "from_icao": org["icao"] if org else None,
        "from_name": org["name"] if org else None,
        "to_icao": dst["icao"] if dst else None,
        "to_name": dst["name"] if dst else None,
    }
    history = read_history()
    history.append(entry)
    write_history(history)
    if os.path.exists(CURRENT_FILE):
        try:
            os.remove(CURRENT_FILE)
        except Exception:
            pass
    return True
