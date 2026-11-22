"""Lectura del plan de vuelo que armaste en el mapa del mundo de MSFS (archivo .PLN).

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import os
import re
import time
import xml.etree.ElementTree as ET


# ---------------------------------------------------------------------------
# Plan de vuelo armado en el mapa del mundo de MSFS (pre-partida)
# ---------------------------------------------------------------------------
# Al arrancar un vuelo desde el mapa del mundo, MSFS deja el plan en
# CustomFlight.PLN (XML). De ahí sacamos origen, destino y waypoints, que es
# información que SimConnect NO expone (solo da el tramo activo).
PLN_PATHS = [
    # MSFS 2020 - Steam
    (os.environ.get("APPDATA", ""), "Microsoft Flight Simulator", "MISSIONS", "Custom", "CustomFlight", "CustomFlight.PLN"),
    # MSFS 2020 - Microsoft Store / Game Pass
    (os.environ.get("LOCALAPPDATA", ""), "Packages", "Microsoft.FlightSimulator_8wekyb3d8bbwe", "LocalCache", "MISSIONS", "Custom", "CustomFlight", "CustomFlight.PLN"),
    # MSFS 2024 - Steam
    (os.environ.get("APPDATA", ""), "Microsoft Flight Simulator 2024", "MISSIONS", "Custom", "CustomFlight", "CustomFlight.PLN"),
    # MSFS 2024 - Microsoft Store
    (os.environ.get("LOCALAPPDATA", ""), "Packages", "Microsoft.Limitless_8wekyb3d8bbwe", "LocalCache", "MISSIONS", "Custom", "CustomFlight", "CustomFlight.PLN"),
]


def _find_pln():
    for parts in PLN_PATHS:
        if not parts[0]:
            continue
        p = os.path.join(*parts)
        if os.path.exists(p):
            return p
    return None


def _parse_world_position(txt):
    """'N10° 26' 30.00",W75° 30' 45.00",+000035.00' -> (lat, lon) en grados decimales."""
    if not txt:
        return None
    try:
        parts = txt.split(",")
        vals = []
        for chunk in parts[:2]:
            m = re.match(r"\s*([NSEW])\s*([\d.]+)[^\d]+([\d.]+)[^\d]+([\d.]+)", chunk.strip())
            if not m:
                return None
            hemi, d, mi, s = m.group(1), float(m.group(2)), float(m.group(3)), float(m.group(4))
            dec = d + mi / 60.0 + s / 3600.0
            if hemi in ("S", "W"):
                dec = -dec
            vals.append(dec)
        return (vals[0], vals[1]) if len(vals) == 2 else None
    except Exception:
        return None


PLN_CACHE = {"mtime": None, "data": None}


def _num(txt):
    try:
        v = float(txt)
        return int(round(v)) if v > 0 else None
    except (TypeError, ValueError):
        return None


def read_msfs_plan():
    path = _find_pln()
    if not path:
        return {"ok": False, "reason": "no_file"}
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {"ok": False, "reason": "no_file"}
    if PLN_CACHE["mtime"] == mtime and PLN_CACHE["data"]:
        d = dict(PLN_CACHE["data"])       # el archivo no cambió: devolvemos lo parseado
        d["age_h"] = round((time.time() - mtime) / 3600.0, 2)
        return d

    try:
        root = ET.parse(path).getroot()
        fp = root.find(".//FlightPlan.FlightPlan")
        if fp is None:
            return {"ok": False, "reason": "bad_file"}

        def txt(tag):
            e = fp.find(tag)
            return (e.text or "").strip() if e is not None and e.text else ""

        waypoints = []
        for wp in fp.findall("ATCWaypoint"):
            pos = wp.find("WorldPosition")
            ll = _parse_world_position(pos.text if pos is not None else None)
            if not ll:
                continue
            wtype = wp.find("ATCWaypointType")
            tipo = (wtype.text or "").strip() if wtype is not None and wtype.text else ""
            # MSFS mete por su cuenta TIMECLIMB/TIMECRUIS/TIMEDSCNT (tipo "User") con su propia
            # estimación de tope de ascenso/descenso, que cae en cualquier lado (en un TNCM-SKCG
            # el "crucero" quedaba a 400 NM de la salida). Como puntos de ruta solo estorbaban:
            # el usuario los ignoraba siempre. Los marcadores de ascenso/descenso los calcula la app.
            if tipo == "User" and (wp.get("id") or "").upper().startswith("TIME"):
                continue
            waypoints.append({
                "id": wp.get("id") or "",
                "type": tipo,
                "lat": round(ll[0], 6),
                "lon": round(ll[1], 6),
            })

        dep_id, dest_id = txt("DepartureID"), txt("DestinationID")
        dest_ll = None
        for w in reversed(waypoints):          # el destino suele ser el último waypoint
            if w["id"] == dest_id:
                dest_ll = w
                break
        if dest_ll is None and waypoints:
            dest_ll = waypoints[-1]

        dep_ll = None
        for w in waypoints:                    # y la salida, el primero
            if w["id"] == dep_id:
                dep_ll = w
                break
        if dep_ll is None and waypoints:
            dep_ll = waypoints[0]

        data = {
            "ok": bool(dep_id and dest_id),
            "departure": dep_id,
            "destination": dest_id,
            "title": txt("Title"),
            # Altitud de crucero planeada en el mapa de MSFS (pies): base para el T/C y el T/D
            "cruise_alt": _num(txt("CruisingAlt")),
            "dest_lat": dest_ll["lat"] if dest_ll else None,
            "dest_lon": dest_ll["lon"] if dest_ll else None,
            "dep_lat": dep_ll["lat"] if dep_ll else None,
            "dep_lon": dep_ll["lon"] if dep_ll else None,
            "waypoints": waypoints,
            "mtime": mtime,
            # MSFS no borra este archivo al empezar un vuelo sin ruta: queda el de la
            # partida anterior. La antigüedad sirve para descartarlo.
            "age_h": round((time.time() - mtime) / 3600.0, 2),
        }
        PLN_CACHE["mtime"], PLN_CACHE["data"] = mtime, data
        return data
    except Exception:
        return {"ok": False, "reason": "parse_error"}
