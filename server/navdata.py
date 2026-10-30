"""Datos del mundo real: aeropuertos, pistas, VOR, waypoints y aerovias (OurAirports + X-Plane).

Aerovias y navaids van juntas a proposito: load_navdata() dispara load_airways()/load_waypoints(),
y esas a su vez leen NAV. Separarlas en dos modulos crearia un import circular.

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import csv
import heapq
import math
import os
import urllib.request
import urllib.parse

from .core import DATA_DIR
from .geo import _haversine_nm, _bearing


def nearest_airport(lat, lon, max_nm=25.0):
    """Aeropuerto más cercano a un punto, para saber de dónde salió y adónde llegó."""
    if not NAV["ready"] or lat is None:
        return None
    best, bestd = None, max_nm
    for a in NAV["airports"]:
        d = _haversine_nm(lat, lon, a["lat"], a["lon"])
        if d < bestd:
            bestd, best = d, a
    return best


# ---------------------------------------------------------------------------
# Datos de navegación reales (OurAirports): aeropuertos, pistas y VOR
# ---------------------------------------------------------------------------
NAV = {"airports": [], "vors": [], "waypoints": {}, "ready": False}


# Intersecciones (los puntos con nombre de 5 letras tipo ISVON o MATRO). No son antenas:
# son coordenadas con nombre, y son la mayoría de los puntos de una ruta moderna.
# OurAirports no las tiene, así que las traemos de esta base pública.
WAYPOINTS_URL = ("https://raw.githubusercontent.com/FayyazAK/Global-Aviation-Waypoints/"
                 "main/global_aviation_waypoints.csv")


# Aerovías: los corredores publicados que unen los puntos. Cada línea del archivo es un
# tramo con sus dos extremos y sus coordenadas, así que no hace falta ninguna otra base.
# Ciclo 2012: el esqueleto cambia despacio, pero algunas pueden estar renombradas.
AIRWAYS_URL = ("https://raw.githubusercontent.com/mcantsin/x-plane-navdata/"
               "master/earth_awy.dat")


OURAIRPORTS = {
    "airports": "https://davidmegginson.github.io/ourairports-data/airports.csv",
    "runways": "https://davidmegginson.github.io/ourairports-data/runways.csv",
    "navaids": "https://davidmegginson.github.io/ourairports-data/navaids.csv",
}


def _download_csv(name, url):
    path = os.path.join(DATA_DIR, name + ".csv")
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "msfs-tracker/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
        with open(path, "wb") as f:
            f.write(content)
        return path
    except Exception:
        return path if os.path.exists(path) else None


def load_navdata():
    """Descarga (una vez) y parsea aeropuertos, pistas y VOR. Corre en background."""
    try:
        ap_path = _download_csv("airports", OURAIRPORTS["airports"])
        rw_path = _download_csv("runways", OURAIRPORTS["runways"])
        nv_path = _download_csv("navaids", OURAIRPORTS["navaids"])

        # Pistas indexadas por aeropuerto
        runways = {}
        if rw_path and os.path.exists(rw_path):
            with open(rw_path, "r", encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    try:
                        le_lat = float(r["le_latitude_deg"]); le_lon = float(r["le_longitude_deg"])
                        he_lat = float(r["he_latitude_deg"]); he_lon = float(r["he_longitude_deg"])
                    except (ValueError, KeyError, TypeError):
                        continue
                    length_ft = 0.0
                    try:
                        length_ft = float(r.get("length_ft") or 0)
                    except ValueError:
                        pass
                    width_ft = 0.0
                    try:
                        width_ft = float(r.get("width_ft") or 0)
                    except ValueError:
                        pass
                    hdg = _bearing(le_lat, le_lon, he_lat, he_lon)
                    runways.setdefault(r["airport_ident"], []).append({
                        "center": [(le_lat + he_lat) / 2, (le_lon + he_lon) / 2],
                        "hdg": round(hdg, 1),
                        "len_m": round(length_ft * 0.3048) if length_ft else round(
                            _haversine_nm(le_lat, le_lon, he_lat, he_lon) * 1852),
                        "wid_m": round(width_ft * 0.3048) if width_ft else 45,
                        "name": (r.get("le_ident") or "") + "/" + (r.get("he_ident") or ""),
                    })

        airports = []
        if ap_path and os.path.exists(ap_path):
            keep = {"small_airport", "medium_airport", "large_airport"}
            with open(ap_path, "r", encoding="utf-8") as f:
                for a in csv.DictReader(f):
                    if a.get("type") not in keep:
                        continue
                    try:
                        lat = float(a["latitude_deg"]); lon = float(a["longitude_deg"])
                    except (ValueError, KeyError, TypeError):
                        continue
                    ident = a.get("ident") or ""
                    airports.append({
                        "icao": ident,
                        "name": a.get("name") or ident,
                        "city": a.get("municipality") or "",   # para la ruta del tráfico IA
                        "lat": lat,
                        "lon": lon,
                        "elev_ft": a.get("elevation_ft") or "",
                        "type": a.get("type"),
                        "runways": runways.get(ident, []),
                    })

        vors = []
        if nv_path and os.path.exists(nv_path):
            keep = {"VOR", "VOR-DME", "VORTAC", "DVOR", "DVOR-DME"}
            with open(nv_path, "r", encoding="utf-8") as f:
                for n in csv.DictReader(f):
                    if n.get("type") not in keep:
                        continue
                    try:
                        lat = float(n["latitude_deg"]); lon = float(n["longitude_deg"])
                    except (ValueError, KeyError, TypeError):
                        continue
                    freq = n.get("frequency_khz") or ""
                    try:
                        freq = "{:.2f}".format(float(freq) / 1000.0)
                    except ValueError:
                        pass
                    vors.append({
                        "id": n.get("ident") or "",
                        "name": n.get("name") or "",
                        "lat": lat,
                        "lon": lon,
                        "freq": freq,
                    })

        NAV["airports"] = airports
        NAV["vors"] = vors
        NAV["ready"] = True
    except Exception:
        NAV["ready"] = False

    load_waypoints()          # las intersecciones van aparte, y pueden fallar sin romper nada
    load_airways()            # y las aerovías también


# ---------------------------------------------------------------------------
# Red de aerovías
# ---------------------------------------------------------------------------
AWY = {"graph": {}, "pos": {}, "cells": {}, "ready": False}


def _awy_key(ident, lat, lon):
    return "%s@%.2f,%.2f" % (ident, lat, lon)


def load_airways():
    """Descarga (una vez) el archivo de aerovías y arma la red navegable."""
    path = os.path.join(DATA_DIR, "airways.dat")
    if not (os.path.exists(path) and os.path.getsize(path) > 500000):
        try:
            req = urllib.request.Request(AIRWAYS_URL, headers={"User-Agent": "msfs-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                content = resp.read()
            with open(path, "wb") as f:
                f.write(content)
        except Exception:
            pass          # sin internet, pero si ya hay archivo lo usamos igual
    if not os.path.exists(path):
        return
    try:
        graph, pos = {}, {}
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                p = line.split()
                if len(p) < 10:
                    continue
                try:
                    la1, lo1 = float(p[1]), float(p[2])
                    la2, lo2 = float(p[4]), float(p[5])
                except ValueError:
                    continue
                a, b = _awy_key(p[0], la1, lo1), _awy_key(p[3], la2, lo2)
                pos.setdefault(a, (p[0], la1, lo1))
                pos.setdefault(b, (p[3], la2, lo2))
                d = _haversine_nm(la1, lo1, la2, lo2)
                if d <= 0 or d > 600:
                    continue
                awy = p[9]
                graph.setdefault(a, []).append((b, d, awy))
                graph.setdefault(b, []).append((a, d, awy))   # las volamos en los dos sentidos

        cells = {}          # índice por celdas de 1 grado, para encontrar el punto más cercano
        for k, (_id, la, lo) in pos.items():
            cells.setdefault((int(math.floor(la)), int(math.floor(lo))), []).append(k)

        AWY["graph"], AWY["pos"], AWY["cells"] = graph, pos, cells
        AWY["ready"] = len(graph) > 100
    except Exception:
        AWY["ready"] = False


def _awy_near(lat, lon, radius_nm):
    if not AWY["ready"]:
        return []
    dlat = radius_nm / 60.0 + 1
    dlon = radius_nm / 60.0 / max(0.15, math.cos(math.radians(lat))) + 1
    out = []
    for la in range(int(math.floor(lat - dlat)), int(math.floor(lat + dlat)) + 1):
        for lo in range(int(math.floor(lon - dlon)), int(math.floor(lon + dlon)) + 1):
            for k in AWY["cells"].get((la, lo), ()):
                _id, kla, klo = AWY["pos"][k]
                d = _haversine_nm(lat, lon, kla, klo)
                if d <= radius_nm:
                    out.append((d, k))
    out.sort()
    return out


def route_by_airways(lat1, lon1, lat2, lon2, penal=None, entrada_nm=80.0):
    """A* sobre la red de aerovías. 'penal' es un conjunto de aerovías a castigar, para
    que al pedir alternativas no devuelva siempre la misma."""
    import heapq
    if not AWY["ready"]:
        return None
    penal = penal or set()

    entradas = _awy_near(lat1, lon1, entrada_nm)[:12]
    if not entradas:
        return None
    salidas = {k: d for d, k in _awy_near(lat2, lon2, entrada_nm)[:12]}
    if not salidas:
        return None

    best_g, came, visitados = {}, {}, set()
    heap = []
    for d, k in entradas:
        _id, la, lo = AWY["pos"][k]
        best_g[k] = d
        came[k] = (None, None)
        heapq.heappush(heap, (d + _haversine_nm(la, lo, lat2, lon2), d, k))

    destino, pasos = None, 0
    while heap and pasos < 300000:
        pasos += 1
        _f, g, k = heapq.heappop(heap)
        if k in visitados:
            continue
        visitados.add(k)
        # Exigimos haber recorrido al menos un tramo: si no, con el destino cerca la
        # búsqueda terminaba en el mismo punto de entrada y no usaba ninguna aerovía.
        if k in salidas and came.get(k, (None, None))[0] is not None:
            destino = k
            break
        for nk, d, awy in AWY["graph"].get(k, ()):
            if nk in visitados:
                continue
            ng = g + d + (250.0 if awy in penal else 0.0) + 12.0   # castigo leve por tramo
            if ng < best_g.get(nk, float("inf")):
                best_g[nk] = ng
                came[nk] = (k, awy)
                _id, la, lo = AWY["pos"][nk]
                heapq.heappush(heap, (ng + _haversine_nm(la, lo, lat2, lon2), ng, nk))

    if destino is None:
        return None

    cadena, k = [], destino
    while k is not None:
        pk, awy = came[k]
        _id, la, lo = AWY["pos"][k]
        cadena.append({"id": _id, "lat": round(la, 6), "lon": round(lo, 6), "via": awy})
        k = pk
    cadena.reverse()
    return cadena


def load_waypoints():
    """Descarga (una vez) las intersecciones y las indexa por identificador."""
    path = os.path.join(DATA_DIR, "waypoints.csv")
    if not (os.path.exists(path) and os.path.getsize(path) > 100000):
        try:
            req = urllib.request.Request(WAYPOINTS_URL, headers={"User-Agent": "msfs-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                content = resp.read()
            with open(path, "wb") as f:
                f.write(content)
        except Exception:
            pass          # idem: si ya está descargado, seguimos
    if not os.path.exists(path):
        return
    try:
        idx = {}
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for w in csv.DictReader(f):
                ident = (w.get("IDENT") or "").strip().upper()
                if not ident:
                    continue
                try:
                    lat = float(w["LATITUDE"]); lon = float(w["LONGITUDE"])
                except (ValueError, KeyError, TypeError):
                    continue
                # Un mismo nombre puede repetirse en varios países: guardamos todos y
                # después elegimos el más cercano al tramo que estamos armando.
                idx.setdefault(ident, []).append({"id": ident, "lat": lat, "lon": lon,
                                                  "country": w.get("COUNTRY_CODE") or ""})
        NAV["waypoints"] = idx
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Generador de rutas: encadena VOR reales desde el origen hasta el destino
# ---------------------------------------------------------------------------
# No usa aerovías publicadas (no hay fuente gratis, mundial y actualizada), pero
# los puntos son radioayudas reales con nombre y frecuencia, así que la ruta
# resultante es perfectamente volable a mano.
VOR_GRID = {"built": False, "cells": {}}


def _build_vor_grid():
    """Índice espacial por celdas de 1 grado: evita comparar contra los 11k navaids."""
    cells = {}
    for v in NAV["vors"]:
        cells.setdefault((int(math.floor(v["lat"])), int(math.floor(v["lon"]))), []).append(v)
    VOR_GRID["cells"] = cells
    VOR_GRID["built"] = True


def _vor_key(v):
    """Los identificadores de VOR se repiten por el mundo; los hacemos únicos."""
    return "%s@%.3f,%.3f" % (v["id"], v["lat"], v["lon"])


def _vors_near(lat, lon, radius_nm):
    if not VOR_GRID["built"]:
        _build_vor_grid()
    dlat = radius_nm / 60.0 + 1
    dlon = radius_nm / 60.0 / max(0.15, math.cos(math.radians(lat))) + 1
    out = []
    for la in range(int(math.floor(lat - dlat)), int(math.floor(lat + dlat)) + 1):
        for lo in range(int(math.floor(lon - dlon)), int(math.floor(lon + dlon)) + 1):
            for v in VOR_GRID["cells"].get((la, lo), ()):
                d = _haversine_nm(lat, lon, v["lat"], v["lon"])
                if d <= radius_nm:
                    out.append((d, v))
    return out
