"""
MSFS Live Tracker — backend
Sirve la interfaz y expone la telemetría de Microsoft Flight Simulator 2020 vía SimConnect,
más datos reales del mundo (tráfico ADS-B de OpenSky, aeropuertos/pistas/VOR de OurAirports).

Puerto: 5001  (http://localhost:5001)
"""

from flask import Flask, render_template, jsonify, request
import threading
import time
import webbrowser
import os
import csv
import math
import json
import urllib.request
import urllib.parse
import re
import subprocess
import xml.etree.ElementTree as ET

# SimConnect solo existe en Windows con MSFS. Envolvemos el import para que el servidor
# igual arranque (mostrando "esperando conexión") si la librería no está disponible.
try:
    from SimConnect import SimConnect, AircraftRequests, AircraftEvents
    SIMCONNECT_AVAILABLE = True
except Exception:
    SIMCONNECT_AVAILABLE = False

# Aerovías en vivo (segunda conexión SimConnect, con un DLL más moderno que el que trae
# la librería de arriba, para poder pedir datos que ese DLL viejo no sabe dar). Es un
# módulo aparte y totalmente opcional: si no está disponible, la app sigue igual que
# siempre. Ver live_airways.py para el detalle completo.
try:
    import live_airways
    LIVE_AIRWAYS_AVAILABLE = True
except Exception:
    LIVE_AIRWAYS_AVAILABLE = False

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
CURRENT_FILE = os.path.join(DATA_DIR, "current_flight.json")
HISTORY_FILE = os.path.join(DATA_DIR, "flights_history.json")

state = {
    "connected": False,
    "lat": None,
    "lon": None,
    "alt": None,          # pies
    "heading": None,      # grados verdaderos
    "gs": None,           # ground speed en nudos
    "ias": None,          # velocidad indicada en nudos
    "vs": None,           # velocidad vertical en pies/minuto
    "on_ground": None,
    "gear_pct": None,     # 0 = tren arriba, 1 = tren abajo (para el teleporte de despegue)
    "flaps_pct": None, "flaps_index": None, "spoilers_pct": None, "parking_brake": None,
    "eng_type": None, "eng_count": None,   # 0=pistón 1=jet 3=helicóptero 5=turbohélice
    "aircraft": None,     # nombre del avión cargado (para elegir el perfil de descenso)
    "mach": None,
    "sim_rate": None,     # velocidad de simulación (1x, 2x, 4x...)
    "local_time": None,   # hora local del sim, en segundos desde medianoche
    "pausado": None,      # ¿el simulador avisó que está en pausa? (para el tiempo de vuelo)
    "reloj_sim": None,    # último valor del reloj del sim: si no avanza, está congelado
    "magvar": None,       # declinación magnética: los instrumentos del avión son magnéticos
    "fplan": None,        # plan de vuelo activo del sim (solo lectura): tramo actual y progreso
    "lights": None,       # {"landing","beacon","strobe","nav","taxi"}
    "ap": None,           # {"master","hdg_lock","alt_lock","spd_lock","hdg","alt","spd"}
    "fuel_gal": None,     # combustible total en galones
    "fuel_capacity": None,  # capacidad total de combustible en galones (para % / barra)
    "fuel_flow_gph": None,  # consumo total en galones/hora
    "endurance_min": None,  # autonomía estimada en minutos
    "distance_nm": 0.0,   # distancia total recorrida en millas náuticas
    "guardado_en": None,  # timestamp de cuándo se archivó solo el vuelo (para avisar en pantalla)
    "max_alt": 0,
    "flight_start": None,
    "elapsed_min": 0,
    "weather": None,      # {"station","temp_c","wind_kt","wind_dir"}
}
route = []  # lista de [lat, lon, alt]
MAX_ROUTE_POINTS = 6000   # tope del rastro; más arriba el navegador empieza a sufrir
lock = threading.Lock()
# python-simconnect NO es seguro entre hilos: el loop de telemetría y las peticiones web
# tocan el mismo handle de la DLL y los mismos contadores internos de IDs. Sin este
# candado, un evento (una avería, las luces) se podía perder o llegar tarde porque se
# pisaba con una lectura. Es un candado aparte de `lock`, que solo cuida el dict `state`.
sim_lock = threading.RLock()

last_save = 0
last_weather_fetch = 0
prev_sim_clock = None    # último valor del reloj DEL SIMULADOR, para medir el tiempo de vuelo
prev_wall_clock = None   # reloj de la PC, solo como respaldo si el sim no da la hora
last_pos_t = None        # cuándo llegó la última posición, para el umbral de teletransporte

# Cierre automático del vuelo. Antes el vuelo SOLO pasaba al historial al tocar
# "Reiniciar ruta": si aterrizabas y cerrabas la app, se perdía. Ahora lo guardamos solos
# al detectar que el vuelo terminó (despegaste, aterrizaste y quedaste quieto un rato).
fue_al_aire = False        # ¿este vuelo llegó a despegar? (si no, no hay nada que guardar)
quieto_desde = None        # desde cuándo está detenido en tierra, después de haber volado
vuelo_archivado = False    # ya lo mandamos al historial: no lo repetimos
sim_aq = None       # AircraftRequests, para setear posición/variables (teletransporte)
sim_events = None   # AircraftEvents, para disparar eventos (ej. bajar el tren)


def _gear_down():
    """Baja el tren: manda el evento GEAR_DOWN (confiable) + setea la variable como respaldo."""
    try:
        if sim_aq is not None:
            with sim_lock:
                sim_aq.set("GEAR_HANDLE_POSITION", 1)
    except Exception:
        pass
    trigger_event("GEAR_DOWN")


def _engines_idle():
    """Pone los aceleradores a 0 (motores al mínimo). Para el teleporte de despegue."""
    for i in (1, 2, 3, 4):
        try:
            with sim_lock:
                sim_aq.set("GENERAL_ENG_THROTTLE_LEVER_POSITION:" + str(i), 0)
        except Exception:
            pass
    trigger_event("THROTTLE_CUT")


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
def _haversine_nm(lat1, lon1, lat2, lon2):
    R_NM = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(a))


def _flat_distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _safe_get(aq, name):
    """Lee una variable de SimConnect sin romper el loop si no existe o falla.

    Toma el candado por variable y no por bloque entero: así un evento disparado desde
    la web se puede colar entre dos lecturas en vez de esperar a que termine el ciclo.
    """
    try:
        with sim_lock:
            return aq.get(name)
    except Exception:
        return None


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


# Umbrales del cierre automático. 45 s parado es suficiente para no confundir un
# touch-and-go o una espera en cabecera con el final del vuelo, y lo bastante corto
# para que quede guardado antes de que cierres la app al llegar a plataforma.
FIN_QUIETO_S = 45
FIN_GS_KT = 25      # por debajo de esta velocidad en tierra lo damos por detenido


def _revisar_fin_de_vuelo(on_ground, gs):
    """Archiva el vuelo solo cuando terminó de verdad: despegó, volvió a tierra y quedó
    quieto un rato. NO borra el rastro del mapa (para que puedas seguir mirando la ruta
    que acabás de volar); solo lo marca como guardado. El rastro se limpia al despegar
    de nuevo, o cuando toques "Reiniciar ruta".

    Importante: esta función toma `lock`, así que hay que llamarla FUERA de cualquier
    bloque que ya lo tenga tomado (es un Lock normal, no reentrante: se trabaría)."""
    global fue_al_aire, quieto_desde, vuelo_archivado

    if on_ground is None:
        return

    if not on_ground:
        # Estamos en el aire. Si el vuelo anterior ya quedó guardado, esto es un vuelo
        # nuevo: recién ahora limpiamos el rastro viejo.
        if vuelo_archivado:
            with lock:
                route.clear()
                state["distance_nm"] = 0.0
                state["max_alt"] = 0
                state["flight_start"] = time.time()
                state["elapsed_min"] = 0
                state["guardado_en"] = None
            vuelo_archivado = False
        fue_al_aire = True
        quieto_desde = None
        return

    # En tierra
    if not fue_al_aire or vuelo_archivado:
        return                      # todavía no despegó, o ya lo guardamos

    if (gs or 0) > FIN_GS_KT:
        quieto_desde = None         # aterrizó pero sigue rodando a plataforma
        return

    if quieto_desde is None:
        quieto_desde = time.time()
        return
    if time.time() - quieto_desde < FIN_QUIETO_S:
        return

    if archive_flight_to_history():
        with lock:
            state["guardado_en"] = time.time()
    vuelo_archivado = True
    fue_al_aire = False
    quieto_desde = None


# ---------------------------------------------------------------------------
# Clima real (METAR)
# ---------------------------------------------------------------------------
def fetch_nearest_metar(lat, lon):
    d = 1.0
    url = (
        "https://aviationweather.gov/api/data/metar"
        f"?bbox={lat - d},{lon - d},{lat + d},{lon + d}&format=json"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "msfs-tracker/1.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            stations = json.loads(resp.read().decode("utf-8"))
        if not stations:
            return None
        best = min(
            stations,
            key=lambda s: _flat_distance((lat, lon), (s.get("lat", 0), s.get("lon", 0))),
        )
        return {
            "station": best.get("icaoId"),
            "temp_c": best.get("temp"),
            "wind_kt": best.get("wspd"),
            "wind_dir": best.get("wdir"),
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Loop de telemetría — versión tolerante a fallos (arregla las desconexiones)
# ---------------------------------------------------------------------------
def _update_weather(lat, lon):
    weather = fetch_nearest_metar(lat, lon)
    if weather:
        with lock:
            state["weather"] = weather


def teleport_aircraft(lat, lon, alt=None, hdg=None, spd=None, gear=None, wait_gear=False, eng0=False):
    """Teletransporte (beta): setea posición del avión vía SimConnect.
    alt=pies MSL; hdg=rumbo grados; spd=nudos; gear=tren abajo; eng0=motores a 0."""
    if sim_aq is None:
        return False

    def _place():
        try:
            with sim_lock:
                if alt is not None:
                    sim_aq.set("PLANE_ALTITUDE", alt)
                if hdg is not None:
                    sim_aq.set("PLANE_HEADING_DEGREES_TRUE", math.radians(hdg))  # SimConnect: radianes
                sim_aq.set("PLANE_LATITUDE", lat)
                sim_aq.set("PLANE_LONGITUDE", lon)
        except Exception:
            return
        if spd is not None:
            try:
                with sim_lock:
                    sim_aq.set("VELOCITY_BODY_Z", spd * 1.68781)   # nudos -> ft/s
                    sim_aq.set("AIRSPEED_TRUE", spd)
            except Exception:
                pass
        if eng0:
            _engines_idle()

    if gear:
        _gear_down()

    if gear and wait_gear:
        # Esperar a que el tren termine de bajar ANTES de posarlo, para que no caiga hundido
        def _wait_then_place():
            for _ in range(30):   # hasta ~15s
                try:
                    with sim_lock:
                        p = sim_aq.get("GEAR_CENTER_POSITION")   # 0=arriba, 1=abajo
                    if p is not None and p >= 0.99:
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            _place()
        threading.Thread(target=_wait_then_place, daemon=True).start()
        return True

    _place()
    return True


def set_autopilot(master=None, hdg=None, alt=None, spd=None, vs=None):
    """Control del piloto automático (beta) vía EVENTOS del MCP (más compatible que setear
    variables). Nota: aviones con AP propio (ej. A320 de FlyByWire) pueden ignorarlo igual."""
    if sim_events is None:
        return False

    def ev(name, val=None):
        try:
            with sim_lock:
                e = sim_events.find(name)
                if e is None:
                    return False
                if val is None:
                    e()
                else:
                    e(int(val))
            return True
        except Exception:
            return False

    ok = False
    if hdg is not None:
        ev("HEADING_BUG_SET", round(hdg) % 360); ev("AP_HDG_HOLD_ON"); ok = True
    if alt is not None:
        ev("AP_ALT_VAR_SET_ENGLISH", round(alt)); ok = True
    if vs is not None:
        ev("AP_VS_VAR_SET_ENGLISH", round(vs)); ev("AP_VS_ON"); ok = True
    elif alt is not None:
        ev("AP_ALT_HOLD_ON")
    if spd is not None:
        ev("AP_SPD_VAR_SET", round(spd)); ev("AP_AIRSPEED_ON"); ok = True
    if master is not None:
        try:
            with sim_lock:
                cur = sim_aq.get("AUTOPILOT_MASTER") if sim_aq else None
        except Exception:
            cur = None
        if cur is None or bool(cur) != bool(master):
            ev("AP_MASTER")
        ok = True
    return ok


def set_aircraft(alt=None, hdg=None, pitch=None, spd=None):
    """Ajuste manual (beta): cambia altitud/rumbo/ángulo/velocidad sin mover la posición."""
    if sim_aq is None:
        return False
    try:
        with sim_lock:
            if alt is not None:
                sim_aq.set("PLANE_ALTITUDE", alt)
            if hdg is not None:
                sim_aq.set("PLANE_HEADING_DEGREES_TRUE", math.radians(hdg))
            if pitch is not None:
                sim_aq.set("PLANE_PITCH_DEGREES", math.radians(pitch))
            if spd is not None:
                sim_aq.set("VELOCITY_BODY_Z", spd * 1.68781)
                sim_aq.set("AIRSPEED_TRUE", spd)
        return True
    except Exception:
        return False


def set_sim_time(zulu_seconds=None):
    """Cambia la hora del reloj del sim (ZULU/UTC), en segundos desde medianoche.
    Nota: solo la hora (beta). El clima real vía SimConnect en MSFS2020 no tiene un método
    confiable de "set" directo (a diferencia de la hora) — hay que cambiarlo desde el propio
    menú de clima del juego por ahora."""
    if sim_aq is None or zulu_seconds is None:
        return False
    try:
        with sim_lock:
            sim_aq.set("ZULU_TIME", float(zulu_seconds))
        return True
    except Exception:
        return False


def telemetry_loop():
    global last_save, last_weather_fetch, sim_aq, sim_events, last_pos_t
    global prev_sim_clock, prev_wall_clock
    sm = None
    aq = None
    consecutive_errors = 0
    ERROR_THRESHOLD = 5   # solo damos por "desconectado" tras varios fallos seguidos

    if not SIMCONNECT_AVAILABLE:
        # Sin librería SimConnect: el server sirve la UI igual, pero sin telemetría.
        while True:
            with lock:
                state["connected"] = False
            time.sleep(2)

    while True:
        try:
            if sm is None:
                sm = SimConnect()
                aq = AircraftRequests(sm, _time=100)   # caché más fresco para 4 Hz
                sim_aq = aq
                try:
                    sim_events = AircraftEvents(sm)
                except Exception:
                    sim_events = None

            # Estas dos van SIN _safe_get a propósito: si SimConnect se cayó queremos que
            # la excepción suba y dispare el contador de reconexión.
            with sim_lock:
                lat = aq.get("PLANE_LATITUDE")
                lon = aq.get("PLANE_LONGITUDE")

            # Llegamos hasta acá sin excepción => SimConnect está respondiendo.
            consecutive_errors = 0

            if lat is None or lon is None:
                # Conectado pero sin posición válida: menú principal, pantalla de carga
                # o transición entre vuelos. NO tiramos la conexión ni marcamos
                # desconectado; simplemente esperamos a que haya datos.
                time.sleep(1)
                continue

            # INDICATED_ALTITUDE = lo que marca el altímetro de la cabina (según presión),
            # para que coincida con lo que ves en el juego (no la altitud verdadera MSL).
            alt = _safe_get(aq, "INDICATED_ALTITUDE")
            heading = _safe_get(aq, "PLANE_HEADING_DEGREES_TRUE")
            # SimConnect devuelve el rumbo en RADIANES pese al nombre de la variable.
            if heading is not None:
                heading = math.degrees(heading) % 360
            gs = _safe_get(aq, "GROUND_VELOCITY")
            ias = _safe_get(aq, "AIRSPEED_INDICATED")
            vs = _safe_get(aq, "VERTICAL_SPEED")
            on_ground = _safe_get(aq, "SIM_ON_GROUND")
            gear_pct = _safe_get(aq, "GEAR_CENTER_POSITION")

            # Estado del avión (sistemas)
            flaps_pct = _safe_get(aq, "FLAPS_HANDLE_PERCENT")
            flaps_index = _safe_get(aq, "FLAPS_HANDLE_INDEX")
            eng_type = _safe_get(aq, "ENGINE_TYPE")       # para elegir el ícono del avión
            eng_count = _safe_get(aq, "NUMBER_OF_ENGINES")
            # El modelo del avión sirve para elegir el perfil de descenso (un A320 y un
            # A330 bajan parecido pero no van a la misma velocidad). Solo se lee una vez:
            # es un string y no cambia durante el vuelo.
            if state.get("aircraft") is None:
                titulo = _safe_get(aq, "TITLE")
                if isinstance(titulo, bytes):
                    titulo = titulo.decode("utf-8", "ignore")
                if titulo:
                    with lock:
                        state["aircraft"] = str(titulo).strip()
            mach = _safe_get(aq, "AIRSPEED_MACH")
            sim_rate = _safe_get(aq, "SIMULATION_RATE")
            local_time = _safe_get(aq, "LOCAL_TIME")   # para saber si es de día o de noche
            abs_time = _safe_get(aq, "ABSOLUTE_TIME")  # reloj corrido del sim, para el tiempo de vuelo
            # La librería marca esto cuando SimConnect avisa que pausaste el juego
            try:
                pausado = bool(getattr(sm, "paused", False))
            except Exception:
                pausado = False
            magvar = _safe_get(aq, "MAGVAR")           # grados de diferencia entre norte real y magnético

            # ---- Plan de vuelo activo del propio MSFS (solo lectura) ----
            # SimConnect solo expone el tramo actual (anterior/siguiente) y el progreso,
            # no la lista completa de waypoints.
            fplan = None
            try:
                if _safe_get(aq, "GPS_IS_ACTIVE_FLIGHT_PLAN"):
                    def _fix(la, lo):
                        """Algunas versiones devuelven radianes: elegimos la interpretación
                        que quede más cerca del avión."""
                        if la is None or lo is None:
                            return None
                        best, bestd = None, None
                        for cla, clo in ((la, lo), (math.degrees(la), math.degrees(lo))):
                            if abs(cla) > 90 or abs(clo) > 180:
                                continue
                            d = _haversine_nm(lat, lon, cla, clo)
                            if bestd is None or d < bestd:
                                best, bestd = [cla, clo], d
                        return best
                    dist = _safe_get(aq, "GPS_WP_DISTANCE")
                    fplan = {
                        "index": _safe_get(aq, "GPS_FLIGHT_PLAN_WP_INDEX"),
                        "count": _safe_get(aq, "GPS_FLIGHT_PLAN_WP_COUNT"),
                        "next": _fix(_safe_get(aq, "GPS_WP_NEXT_LAT"), _safe_get(aq, "GPS_WP_NEXT_LON")),
                        "prev": _fix(_safe_get(aq, "GPS_WP_PREV_LAT"), _safe_get(aq, "GPS_WP_PREV_LON")),
                        "dist_nm": (dist / 1852.0) if dist else None,
                    }
            except Exception:
                fplan = None
            spoilers_pct = _safe_get(aq, "SPOILERS_HANDLE_POSITION")
            parking_brake = _safe_get(aq, "BRAKE_PARKING_POSITION")
            lights = {
                "landing": bool(_safe_get(aq, "LIGHT_LANDING")),
                "beacon": bool(_safe_get(aq, "LIGHT_BEACON")),
                "strobe": bool(_safe_get(aq, "LIGHT_STROBE")),
                "nav": bool(_safe_get(aq, "LIGHT_NAV")),
                "taxi": bool(_safe_get(aq, "LIGHT_TAXI")),
            }
            ap_hdg = _safe_get(aq, "AUTOPILOT_HEADING_LOCK_DIR")
            if ap_hdg is not None:
                ap_hdg = math.degrees(ap_hdg) % 360
            ap = {
                "master": bool(_safe_get(aq, "AUTOPILOT_MASTER")),
                "hdg_lock": bool(_safe_get(aq, "AUTOPILOT_HEADING_LOCK")),
                "alt_lock": bool(_safe_get(aq, "AUTOPILOT_ALTITUDE_LOCK")),
                "spd_lock": bool(_safe_get(aq, "AUTOPILOT_AIRSPEED_HOLD")),
                "hdg": ap_hdg,
                "alt": _safe_get(aq, "AUTOPILOT_ALTITUDE_LOCK_VAR"),
                "spd": _safe_get(aq, "AUTOPILOT_AIRSPEED_HOLD_VAR"),
            }

            # Combustible + autonomía (cada campo protegido por si el avión no lo expone)
            fuel_gal = _safe_get(aq, "FUEL_TOTAL_QUANTITY")
            fuel_cap = _safe_get(aq, "FUEL_TOTAL_CAPACITY")
            fuel_flow = 0.0
            for i in (1, 2, 3, 4):
                f = _safe_get(aq, "ENG_FUEL_FLOW_GPH:" + str(i))
                if f:
                    fuel_flow += f
            endurance_min = None
            if fuel_gal is not None and fuel_flow and fuel_flow > 0.1:
                endurance_min = (fuel_gal / fuel_flow) * 60.0

            with lock:
                state["connected"] = True
                state["lat"] = lat
                state["lon"] = lon
                state["alt"] = alt
                state["heading"] = heading
                state["gs"] = gs
                state["ias"] = ias
                state["vs"] = vs
                state["on_ground"] = bool(on_ground) if on_ground is not None else None
                state["gear_pct"] = gear_pct
                state["flaps_pct"] = flaps_pct
                state["flaps_index"] = int(flaps_index) if flaps_index is not None else None
                state["eng_type"] = int(eng_type) if eng_type is not None else None
                state["eng_count"] = int(eng_count) if eng_count is not None else None
                state["mach"] = mach
                state["sim_rate"] = sim_rate
                state["local_time"] = local_time
                # Se publica para poder ver desde la app si detectamos la pausa o no:
                # si el contador sigue corriendo con el juego pausado, mirando esto se
                # sabe si el problema es que el sim no nos avisa.
                state["pausado"] = pausado
                state["reloj_sim"] = abs_time if abs_time is not None else local_time
                state["magvar"] = magvar
                state["fplan"] = fplan
                state["spoilers_pct"] = spoilers_pct
                state["parking_brake"] = bool(parking_brake) if parking_brake is not None else None
                state["lights"] = lights
                state["ap"] = ap
                state["fuel_gal"] = fuel_gal
                state["fuel_capacity"] = fuel_cap
                state["fuel_flow_gph"] = fuel_flow if fuel_flow > 0 else None
                state["endurance_min"] = endurance_min

                if alt is not None:
                    state["max_alt"] = max(state["max_alt"], alt)
                if state["flight_start"] is None:
                    state["flight_start"] = time.time()

                # El tiempo de vuelo se mide con el RELOJ DEL SIMULADOR, no con el de la
                # PC. Así se congela solo cuando pausás el juego (el reloj del sim se
                # detiene) y avanza acelerado cuando usás sim rate, que es lo correcto.
                #
                # Se prefiere ABSOLUTE_TIME (segundos corridos) sobre LOCAL_TIME porque
                # no da la vuelta a medianoche y no cambia si movés la hora del vuelo.
                #
                # Segunda red de seguridad: SimConnect avisa por evento cuando pausás
                # ("Paused"/"Unpaused") y la librería lo guarda en sm.paused. Si por lo que
                # sea el reloj del sim NO se congela al pausar, esto igual frena el conteo.
                # Va aparte a propósito: en algunas versiones ese evento no llega nunca, así
                # que no se puede depender solo de él.
                if pausado:
                    prev_sim_clock = reloj_sim = None
                    prev_wall_clock = None
                else:
                    reloj_sim = abs_time if abs_time is not None else local_time
                if reloj_sim is not None:
                    if prev_sim_clock is not None:
                        d = reloj_sim - prev_sim_clock
                        if abs_time is None and d < -43200:   # LOCAL_TIME cruzó medianoche
                            d += 86400
                        if 0 < d < 120:         # descartamos saltos (cambiaste la hora)
                            state["elapsed_min"] += d / 60.0
                        elif d <= -300:
                            # El reloj del sim retrocedió de verdad más de 5 min (esto ya no
                            # es el cruce de medianoche, corregido arriba): reiniciaste el
                            # vuelo desde el menú de MSFS. La posición puede NO saltar lo
                            # suficiente para que el chequeo de "salto imposible" de más
                            # abajo lo detecte (si reiniciás cerca de donde ya estabas), y
                            # entonces el cronómetro se quedaba con el valor viejo para
                            # siempre. Acá lo reiniciamos por nuestra cuenta. El umbral de
                            # 5 min (en vez de cualquier retroceso) es para no confundir
                            # esto con un pequeño ajuste manual de la hora del sim.
                            route.clear()
                            state["distance_nm"] = 0.0
                            state["max_alt"] = 0
                            state["flight_start"] = time.time()
                            state["elapsed_min"] = 0
                            state["weather"] = None
                            last_weather_fetch = 0
                    prev_sim_clock = reloj_sim
                    prev_wall_clock = None      # volvió el reloj del sim: soltamos el de la PC
                elif pausado:
                    pass                        # en pausa no se cuenta nada, y punto
                else:
                    # Sin reloj del sim seguimos con el de la PC, pero SUMANDO de a poco.
                    # Antes acá se recalculaba `elapsed_min` desde el arranque del vuelo, y
                    # eso era el bug de la pausa: bastaba UNA lectura fallida para que el
                    # contador volviera a incluir todo el rato que estuviste en pausa.
                    ahora_pc = time.time()
                    if prev_wall_clock is not None:
                        d = ahora_pc - prev_wall_clock
                        if 0 < d < 120:
                            state["elapsed_min"] += d / 60.0
                    prev_wall_clock = ahora_pc

                # Teletransporte: un salto imposible reinicia el vuelo. El umbral se
                # calcula según lo que el avión PUDO recorrer: con sim rate alto se
                # recorre mucho más por segundo real, y antes eso disparaba falsos
                # positivos que reiniciaban el vuelo solos.
                now_t = time.time()
                dt = max(0.05, now_t - (last_pos_t or now_t))
                last_pos_t = now_t
                rate = float(sim_rate) if sim_rate else 1.0
                posible = (float(gs or 600) / 3600.0) * rate * dt * 3.0 + 1.0
                if route and _haversine_nm(route[-1][0], route[-1][1], lat, lon) > max(2.7, posible):
                    route.clear()
                    state["distance_nm"] = 0.0
                    state["max_alt"] = 0
                    state["flight_start"] = time.time()
                    state["elapsed_min"] = 0
                    state["weather"] = None
                    last_weather_fetch = 0            # refresca el clima en la nueva posición
                    route.append([lat, lon, alt])
                # Si no, agregamos el punto solo si nos movimos (evita duplicados en tierra)
                elif not route or _flat_distance(route[-1][:2], (lat, lon)) > 0.00005:
                    if route:
                        state["distance_nm"] += _haversine_nm(route[-1][0], route[-1][1], lat, lon)
                    route.append([lat, lon, alt])
                    # A 4 lecturas por segundo, un vuelo de 8 h son ~115.000 puntos: el
                    # navegador se arrastra redibujando eso. Cuando pasamos del tope,
                    # adelgazamos la mitad más vieja (1 de cada 2). La forma del trazo
                    # se mantiene, y lo reciente queda con todo el detalle.
                    if len(route) > MAX_ROUTE_POINTS:
                        mitad = len(route) // 2
                        route[:mitad] = route[:mitad:2]

            # Fuera del `with lock` de arriba a propósito: esta función toma el mismo
            # candado y `lock` no es reentrante.
            _revisar_fin_de_vuelo(on_ground, gs)

            if time.time() - last_save > 10:
                save_current_flight()
                last_save = time.time()

            # El clima se consulta en un hilo aparte para que la consulta (que puede
            # tardar varios segundos) NUNCA congele el envío de posición del avión.
            if time.time() - last_weather_fetch > 120:
                last_weather_fetch = time.time()
                threading.Thread(target=_update_weather, args=(lat, lon), daemon=True).start()

        except Exception:
            # Un error puntual (sim ocupado, pausa, hipo de SimConnect) NO debe tumbar todo.
            consecutive_errors += 1
            if consecutive_errors >= ERROR_THRESHOLD:
                # Ahora sí asumimos que el sim se cerró: soltamos la conexión y esperamos
                # un poco más antes de reintentar (backoff), para no martillar SimConnect.
                with lock:
                    state["connected"] = False
                    state["aircraft"] = None   # al reconectar puede haber otro avión cargado
                sm = None
                aq = None
                sim_aq = None
                sim_events = None
                prev_sim_clock = None     # al reconectar, no arrastramos el reloj viejo
                prev_wall_clock = None
                last_pos_t = None
                consecutive_errors = 0
                time.sleep(3)
            else:
                time.sleep(1)
            continue

        time.sleep(0.25)   # 4 lecturas por segundo (para un movimiento más fluido en el mapa)


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


def _bearing(lat1, lon1, lat2, lon2):
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = (math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
         - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1)))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


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
# Rutas HTTP
# ---------------------------------------------------------------------------
@app.after_request
def _no_cache(resp):
    # Evita que el navegador (iPad) sirva una versión vieja cacheada de la interfaz
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/state")
def api_state():
    with lock:
        return jsonify({**state, "route": route})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    global fue_al_aire, quieto_desde, vuelo_archivado
    # Si el cierre automático ya lo guardó al aterrizar, no lo guardamos dos veces.
    if not vuelo_archivado:
        archive_flight_to_history()
    with lock:
        route.clear()
        state["distance_nm"] = 0.0
        state["max_alt"] = 0
        state["flight_start"] = time.time()
        state["elapsed_min"] = 0
        state["guardado_en"] = None
    fue_al_aire = False
    quieto_desde = None
    vuelo_archivado = False
    return jsonify({"ok": True})


@app.route("/api/teleport", methods=["POST"])
def api_teleport():
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False})
    alt = request.args.get("alt")
    try:
        alt = float(alt) if alt is not None else None
    except ValueError:
        alt = None
    hdg = request.args.get("hdg")
    try:
        hdg = float(hdg) if hdg is not None else None
    except ValueError:
        hdg = None
    spd = request.args.get("spd")
    try:
        spd = float(spd) if spd is not None else None
    except ValueError:
        spd = None
    gear = request.args.get("gear")
    gear = None if gear is None else (gear == "1" or gear.lower() == "true")
    wg = request.args.get("wg") == "1"
    eng0 = request.args.get("eng0") == "1"
    return jsonify({"ok": teleport_aircraft(lat, lon, alt, hdg, spd, gear, wg, eng0)})


@app.route("/api/set_time", methods=["POST"])
def api_set_time():
    """Hora del sim (beta). Recibe hora/minuto en ZULU (UTC) y los pasa a segundos."""
    try:
        hh = int(request.args.get("h"))
        mm = int(request.args.get("m"))
    except (TypeError, ValueError):
        return jsonify({"ok": False})
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return jsonify({"ok": False})
    return jsonify({"ok": set_sim_time(hh * 3600 + mm * 60)})


@app.route("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip().lower()
    if not q or not NAV["ready"]:
        return jsonify([])
    matches = []
    for a in NAV["airports"]:
        ic = a["icao"].lower()
        nm = (a.get("name") or "").lower()
        if q in ic or q in nm:
            score = 0 if ic == q else (1 if ic.startswith(q) else (2 if nm.startswith(q) else 3))
            matches.append((score, a))
    matches.sort(key=lambda x: x[0])
    return jsonify([a for _, a in matches[:20]])


@app.route("/api/gear", methods=["POST"])
def api_gear():
    _gear_down()
    return jsonify({"ok": sim_aq is not None})


def trigger_event(name):
    """Dispara un evento de SimConnect por nombre (tren, flaps, luces, averías...).

    Devuelve (ok, motivo). La librería descarta el resultado real del envío dentro de
    Event.__call__, así que replicamos sus dos pasos a mano para saber de verdad si el
    sim aceptó el evento: sin esto, una avería que nunca llegaba se reportaba como OK.
    """
    if not name:
        return False, "sin evento"
    if sim_events is None:
        return False, "sin conexión con el simulador"
    try:
        with sim_lock:
            ev = sim_events.find(name)
            if ev is None:
                return False, "evento desconocido"
            if ev.event is None:
                ev.event = ev.sm.map_to_sim_event(ev.deff)
            ok = bool(ev.sm.send_event(ev.event))
        return ok, ("" if ok else "el simulador rechazó el evento")
    except Exception as e:
        return False, str(e) or "error al enviar"


@app.route("/api/cmd", methods=["POST"])
def api_cmd():
    ok, motivo = trigger_event(request.args.get("ev") or "")
    return jsonify({"ok": ok, "error": motivo})


@app.route("/api/set", methods=["POST"])
def api_set():
    def num(name):
        v = request.args.get(name)
        try:
            return float(v) if v not in (None, "") else None
        except ValueError:
            return None
    return jsonify({"ok": set_aircraft(num("alt"), num("hdg"), num("pitch"), num("spd"))})


@app.route("/api/ap", methods=["POST"])
def api_ap():
    def num(name):
        v = request.args.get(name)
        try:
            return float(v) if v not in (None, "") else None
        except ValueError:
            return None
    master = request.args.get("master")
    master = None if master is None else (master == "1")
    return jsonify({"ok": set_autopilot(master, num("hdg"), num("alt"), num("spd"), num("vs"))})


@app.route("/api/navdata")
def api_navdata():
    """Aeropuertos y VOR dentro de un radio (nm) del punto dado."""
    if not NAV["ready"]:
        return jsonify({"ready": False, "airports": [], "vors": []})
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"ready": True, "airports": [], "vors": []})
    radius = float(request.args.get("radius", 120))

    def near(items):
        res = []
        for it in items:
            d = _haversine_nm(lat, lon, it["lat"], it["lon"])
            if d <= radius:
                res.append(it)
        return res

    airports = near(NAV["airports"])
    # Limitamos para no saturar el mapa: priorizamos los grandes/medianos
    order = {"large_airport": 0, "medium_airport": 1, "small_airport": 2}
    airports.sort(key=lambda a: order.get(a.get("type"), 3))
    airports = airports[:60]
    vors = near(NAV["vors"])[:40]
    return jsonify({"ready": True, "airports": airports, "vors": vors})


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
            waypoints.append({
                "id": wp.get("id") or "",
                "type": (wtype.text or "").strip() if wtype is not None and wtype.text else "",
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


@app.route("/api/msfs_plan")
def api_msfs_plan():
    return jsonify(read_msfs_plan())


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


def _cross_track_nm(lat1, lon1, lat2, lon2, lat3, lon3):
    """Distancia perpendicular del punto 3 a la línea recta que va del 1 al 2.
    Es la medida de 'cuánto te desviás del rumbo directo'."""
    R = 3440.065
    d13 = _haversine_nm(lat1, lon1, lat3, lon3) / R
    if d13 <= 0:
        return 0.0
    b13 = math.radians(_bearing(lat1, lon1, lat3, lon3))
    b12 = math.radians(_bearing(lat1, lon1, lat2, lon2))
    s = math.sin(d13) * math.sin(b13 - b12)
    return abs(math.asin(max(-1.0, min(1.0, s))) * R)


def generate_route(lat1, lon1, lat2, lon2, max_leg=300.0, close_nm=None,
                   corridor_nm=None, xtk_weight=2.5):
    """Búsqueda A* sobre la red de VOR. Devuelve la lista de puntos intermedios
    o None si no encontró camino con ese salto máximo.

    close_nm: qué tan cerca del destino hay que llegar para dar la ruta por terminada.
    Sin esto, la búsqueda cortaba apenas entraba en el radio de un salto y dejaba un
    tramo final larguísimo en línea recta."""
    import heapq

    if close_nm is None:
        close_nm = min(max_leg, 90.0)
    direct_nm = _haversine_nm(lat1, lon1, lat2, lon2)
    if corridor_nm is None:            # pasillo alrededor de la recta origen-destino
        corridor_nm = max(60.0, direct_nm * 0.18)
    LEG_PENALTY = 30.0                 # castigo por salto: prefiere rutas con menos puntos
    BEARING_WEIGHT = 1.2               # millas equivalentes por cada grado fuera de rumbo
    start = "@ORIGEN"
    best_g = {start: 0.0}
    came = {}                          # clave -> (clave_padre, lat, lon, ident)
    visited = set()
    heap = [(_haversine_nm(lat1, lon1, lat2, lon2), 0.0, start, lat1, lon1)]
    steps = 0

    while heap and steps < 40000:
        steps += 1
        _f, g, key, la, lo = heapq.heappop(heap)
        if key in visited:
            continue
        visited.add(key)

        if key != start and _haversine_nm(la, lo, lat2, lon2) <= close_nm:
            path = []                  # llegamos a tiro del destino: reconstruimos
            k = key
            while k != start:
                pk, plat, plon, ident = came[k]
                path.append({"id": ident, "lat": round(plat, 6), "lon": round(plon, 6)})
                k = pk
            path.reverse()
            return path

        for d, v in _vors_near(la, lo, max_leg):
            if d < 1:
                continue
            vk = _vor_key(v)
            if vk in visited:
                continue
            # Fuera del pasillo ni lo consideramos: así no manda a Barranquilla
            # cuando el destino está al norte.
            xtk = _cross_track_nm(lat1, lon1, lat2, lon2, v["lat"], v["lon"])
            if xtk > corridor_nm:
                continue
            # Cuánto se aparta este salto del rumbo directo al destino. Sin esto la
            # ruta arranca para el lado equivocado aunque el total dé parecido.
            diff = abs((_bearing(la, lo, v["lat"], v["lon"])
                        - _bearing(la, lo, lat2, lon2) + 180.0) % 360.0 - 180.0)
            if diff > 75.0:            # prácticamente ir para atrás
                continue
            ng = g + d + LEG_PENALTY + xtk_weight * xtk + BEARING_WEIGHT * diff
            if ng < best_g.get(vk, float("inf")):
                best_g[vk] = ng
                came[vk] = (key, v["lat"], v["lon"], v["id"])
                h = _haversine_nm(v["lat"], v["lon"], lat2, lon2)
                heapq.heappush(heap, (ng + h, ng, vk, v["lat"], v["lon"]))

    return None


def _path_len(lat1, lon1, wps, lat2, lon2):
    pts = [(lat1, lon1)] + [(w["lat"], w["lon"]) for w in wps] + [(lat2, lon2)]
    return sum(_haversine_nm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
               for i in range(len(pts) - 1))


def generate_route_auto(lat1, lon1, lat2, lon2, tolerance=1.15):
    """Prueba saltos cortos primero (muchos VOR, útil sobre tierra) y va agrandando
    hasta que el desvío sea aceptable. Sobre el mar no hay radioayudas, así que ahí
    termina eligiendo saltos largos por su cuenta."""
    direct = _haversine_nm(lat1, lon1, lat2, lon2)
    cands = []
    # Cada intento afloja dos cosas a la vez: cuánto puede medir un salto y cuán cerca
    # del destino hay que llegar antes de rendirse (sobre el mar hay que aflojar mucho).
    # Cada intento afloja el salto, la cercanía exigida al destino y el ancho del pasillo.
    # Se prueba primero lo más ceñido a la recta; solo si no hay camino se abre la mano.
    base = max(60.0, direct * 0.12)
    cap = max(150.0, direct * 0.30)          # tope al pasillo: nunca serpentea demasiado
    for max_leg, close_nm, corr in ((150.0, 60.0, base), (250.0, 90.0, base * 1.4),
                                    (350.0, 150.0, base * 2.0), (450.0, 300.0, base * 3.0),
                                    (600.0, 600.0, base * 5.0)):
        wps = generate_route(lat1, lon1, lat2, lon2, max_leg, close_nm, min(corr, cap))
        if wps is None:
            continue
        cands.append((_path_len(lat1, lon1, wps, lat2, lon2), wps, max_leg))

    if not cands:
        return None, 0.0, None

    def worst_turn(wps):
        """El giro más feo de la ruta respecto al rumbo directo. Sirve para descartar
        rutas que dan un volantazo al principio aunque el total cierre parecido."""
        worst, pla, plo = 0.0, lat1, lon1
        for w in wps:
            b_leg = _bearing(pla, plo, w["lat"], w["lon"])
            b_goal = _bearing(pla, plo, lat2, lon2)
            worst = max(worst, abs((b_leg - b_goal + 180.0) % 360.0 - 180.0))
            pla, plo = w["lat"], w["lon"]
        return worst

    straight = [c for c in cands if worst_turn(c[1]) <= 35.0]
    if straight:
        cands = straight
    # Entre las variantes que no se desvían más del 8%, preferimos la que MÁS puntos
    # tenga: queremos una ruta con referencias para volar, no una recta pelada.
    # Si ninguna entra en ese margen, nos quedamos con la más corta.
    budget = direct * tolerance
    good = [c for c in cands if c[0] <= budget]
    total, wps, leg = max(good, key=lambda c: (len(c[1]), -c[0])) if good \
        else min(cands, key=lambda c: c[0])

    # Limpieza final: si la ruta tiene varios puntos, sacamos los que estén pegados al
    # aeropuerto de salida o de llegada (no aportan nada, ya estás ahí). Si quedaría
    # vacía, la dejamos como está: en vuelos cortos ese VOR es la única referencia.
    if len(wps) > 1:
        trimmed = [w for w in wps
                   if _haversine_nm(lat1, lon1, w["lat"], w["lon"]) >= 12
                   and _haversine_nm(lat2, lon2, w["lat"], w["lon"]) >= 12]
        if trimmed:
            wps = trimmed
            total = _path_len(lat1, lon1, wps, lat2, lon2)
    return wps, total, leg


# ---------------------------------------------------------------------------
# Interpretar una ruta escrita, del estilo "SKRG DCT RNG UA321 ISVON DCT SKCL"
# ---------------------------------------------------------------------------
# Es el formato que devuelven RouteFinder, SkyVector, SimBrief y compañía. Resolvemos
# cada palabra contra las tres bases que tenemos: aeropuertos, radioayudas e
# intersecciones. Las aerovías (UA321) no las podemos expandir: no hay fuente gratis con
# sus puntos intermedios, así que las anotamos y seguimos de largo.
_AIRWAY_RE = re.compile(r"^[A-Z]{1,3}\d{1,4}[A-Z]?$")   # UA321, J50, V16, UM789...
_SKIP = {"DCT", "SID", "STAR", "IFR", "VFR", "DIRECT"}


def _resolve_token(tok, ref):
    """Busca un identificador en las tres bases. 'ref' es el último punto resuelto, y
    sirve para desempatar cuando el nombre existe en varios países."""
    cands = []
    for a in NAV["airports"]:
        if a["icao"].upper() == tok:
            cands.append({"id": a["icao"], "lat": a["lat"], "lon": a["lon"], "kind": "apt",
                          "name": a.get("name") or a["icao"]})
    for v in NAV["vors"]:
        if (v["id"] or "").upper() == tok:
            cands.append({"id": v["id"], "lat": v["lat"], "lon": v["lon"], "kind": "vor",
                          "name": v.get("name") or v["id"]})
    for w in NAV["waypoints"].get(tok, ()):
        cands.append({"id": w["id"], "lat": w["lat"], "lon": w["lon"], "kind": "wpt",
                      "name": w["id"]})
    if not cands:
        return None
    if ref is None or len(cands) == 1:
        return cands[0]
    return min(cands, key=lambda c: _haversine_nm(ref["lat"], ref["lon"], c["lat"], c["lon"]))


def parse_route_string(text):
    toks = [t.strip().upper() for t in re.split(r"[\s,]+", text or "") if t.strip()]
    puntos, aerovias, desconocidos = [], [], []
    ref = None
    for t in toks:
        if t in _SKIP:
            continue
        if _AIRWAY_RE.match(t) and t not in NAV["waypoints"]:
            aerovias.append(t)          # es una aerovía: no tenemos sus puntos intermedios
            continue
        p = _resolve_token(t, ref)
        if p:
            if not puntos or puntos[-1]["id"] != p["id"]:
                puntos.append(p)
                ref = p
        else:
            desconocidos.append(t)
    return puntos, aerovias, desconocidos


@app.route("/api/parseroute", methods=["POST"])
def api_parseroute():
    if not NAV["ready"]:
        return jsonify({"ok": False, "reason": "nav_not_ready"})
    d = request.get_json(silent=True) or {}
    puntos, aerovias, desconocidos = parse_route_string(d.get("route") or "")
    if len(puntos) < 2:
        return jsonify({"ok": False, "reason": "pocos_puntos",
                        "unknown": desconocidos, "airways": aerovias})
    total = sum(_haversine_nm(puntos[i]["lat"], puntos[i]["lon"],
                              puntos[i + 1]["lat"], puntos[i + 1]["lon"])
                for i in range(len(puntos) - 1))
    return jsonify({"ok": True, "points": puntos, "airways": aerovias,
                    "unknown": desconocidos, "distance_nm": round(total, 1),
                    "have_waypoints": bool(NAV["waypoints"])})


def _resumen_aerovias(pts):
    """Compacta la lista de puntos en 'por qué aerovías va', sin repetir."""
    out = []
    for p in pts:
        v = p.get("via")
        if v and (not out or out[-1] != v):
            out.append(v)
    return out


def _comprimir(pts, lat2, lon2, max_pts=28):
    """Quita solo los puntos que no aportan: los que caen prácticamente sobre la recta
    entre su anterior y su siguiente. Los cambios de aerovía y cualquier giro real se
    conservan, para que la ruta se vea completa y no como cuatro puntos sueltos."""
    # Un plan real lista TODOS los puntos de la aerovía, así que por defecto no tocamos
    # nada. Solo entramos a podar si la lista se vuelve inmanejable.
    if len(pts) <= max_pts:
        return pts
    # Son demasiados: nos quedamos con los cambios de aerovía (que nunca se pierden) y
    # repartimos el resto de forma pareja a lo largo de la ruta. Así queda una lista
    # legible que sigue representando el trazado completo, sin colapsar a cuatro puntos.
    claves = {0, len(pts) - 1}
    for i in range(1, len(pts) - 1):
        if pts[i].get("via") != pts[i - 1].get("via"):
            claves.add(i)
    libres = max_pts - len(claves)
    if libres > 0:
        resto = [i for i in range(1, len(pts) - 1) if i not in claves]
        if resto:
            paso = max(1, len(resto) / float(libres))
            for j in range(libres):
                idx = int(j * paso)
                if idx < len(resto):
                    claves.add(resto[idx])
    return [pts[i] for i in sorted(claves)]


@app.route("/api/genroute_awy")
def api_genroute_awy():
    """Rutas por aerovías reales. Devuelve varias opciones para elegir."""
    if not AWY["ready"]:
        return jsonify({"ok": False, "reason": "sin_aerovias"})
    try:
        lat = float(request.args.get("lat")); lon = float(request.args.get("lon"))
        dlat = float(request.args.get("dlat")); dlon = float(request.args.get("dlon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "reason": "bad_params"})

    directo = _haversine_nm(lat, lon, dlat, dlon)
    opciones, usadas, vistas = [], set(), set()
    for _ in range(4):                       # hasta cuatro alternativas distintas
        pts = route_by_airways(lat, lon, dlat, dlon, penal=usadas)
        if not pts:
            break
        vias = _resumen_aerovias(pts)
        firma = ">".join(vias) or ">".join(p["id"] for p in pts[:6])
        if firma not in vistas:
            vistas.add(firma)
            corta = _comprimir(pts, dlat, dlon)
            total = _path_len(lat, lon, corta, dlat, dlon)
            opciones.append({"waypoints": corta, "airways": vias,
                             "distance_nm": round(total, 1),
                             "detour_pct": round((total / directo - 1) * 100, 1) if directo > 0 else 0})
        usadas.update(vias)
        if not vias:
            break

    if not opciones:
        return jsonify({"ok": False, "reason": "no_route"})
    opciones.sort(key=lambda o: o["distance_nm"])
    return jsonify({"ok": True, "options": opciones[:4], "direct_nm": round(directo, 1)})


@app.route("/api/genroute")
def api_genroute():
    if not NAV["ready"]:
        return jsonify({"ok": False, "reason": "nav_not_ready"})
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
        dlat = float(request.args.get("dlat"))
        dlon = float(request.args.get("dlon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "reason": "bad_params"})

    wps, total, leg = generate_route_auto(lat, lon, dlat, dlon)
    if wps is None:
        return jsonify({"ok": False, "reason": "no_route"})

    direct = _haversine_nm(lat, lon, dlat, dlon)
    return jsonify({
        "ok": True,
        "waypoints": wps,
        "distance_nm": round(total, 1),
        "direct_nm": round(direct, 1),
        "detour_pct": round((total / direct - 1) * 100, 1) if direct > 0 else 0,
        "max_leg_nm": leg,
    })


# ---------------------------------------------------------------------------
# Company Routes: exportar la ruta de la app para cargarla desde el MCDU
# ---------------------------------------------------------------------------
# SimBridge lee archivos XML de su carpeta 'coroutes'. Después, en la página INIT A del
# MCDU, escribís el nombre del archivo en el campo CO RTE y entra la ruta completa.
# El formato lo copiamos del código de FlyByWire (coRoute/dto/*.dto.ts): todos los
# campos son texto y son obligatorios, si falta uno SimBridge descarta el archivo.
SIMBRIDGE_HINT = os.path.join(DATA_DIR, "simbridge_path.txt")

# OJO: SimBridge NO usa la carpeta 'resources' que está en Community. Según su código
# (utilities/pathUtil.ts) arma la ruta como Documentos\FlyByWireSim\Simbridge, y solo si
# Windows le bloquea el acceso a Documentos cae a AppData. Con OneDrive activo, Documentos
# suele estar redirigido, así que hay que contemplar esa variante también.
_USER = os.path.expanduser("~")
SIMBRIDGE_GUESSES = [
    os.path.join(_USER, "OneDrive", "Documentos", "FlyByWireSim", "Simbridge", "resources"),
    os.path.join(_USER, "OneDrive", "Documents", "FlyByWireSim", "Simbridge", "resources"),
    os.path.join(_USER, "Documentos", "FlyByWireSim", "Simbridge", "resources"),
    os.path.join(_USER, "Documents", "FlyByWireSim", "Simbridge", "resources"),
    os.path.join(os.environ.get("APPDATA", ""), "FlyByWireSim", "Simbridge", "resources"),
]


def find_coroutes_dirs():
    """TODAS las carpetas coroutes de SimBridge que existan. Primero mira
    data/simbridge_path.txt (una línea con la ruta a 'resources'), y después las
    ubicaciones habituales.

    Devuelve una lista y no una sola carpeta a propósito: es normal tener dos
    instalaciones (la del addon en la carpeta Community y la de Documentos, que es la que
    SimBridge usa al correr). Escribiendo en todas, la ruta aparece en el MCDU sin que
    haya que adivinar cuál está activa."""
    cands = []
    if os.path.exists(SIMBRIDGE_HINT):
        try:
            with open(SIMBRIDGE_HINT, "r", encoding="utf-8") as f:
                p = f.read().strip()
            if p:
                cands.append(p)
        except Exception:
            pass
    cands += [g for g in SIMBRIDGE_GUESSES if g]
    out = []
    for base in cands:
        if not os.path.isdir(base):
            continue
        d = os.path.join(base, "coroutes")
        try:
            os.makedirs(d, exist_ok=True)
            if d not in out:
                out.append(d)
        except Exception:
            continue
    return out


def find_coroutes_dir():
    """La primera carpeta coroutes utilizable (se mantiene por compatibilidad)."""
    dirs = find_coroutes_dirs()
    return dirs[0] if dirs else None


def _simbridge_port():
    """Puerto del servidor de SimBridge, leído de su properties.json. 8380 por defecto."""
    for base in ([os.path.dirname(d) for d in find_coroutes_dirs()]):
        p = os.path.join(base, "properties.json")
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return int((json.load(f).get("server") or {}).get("port") or 8380)
            except Exception:
                pass
    return 8380


def simbridge_status(name=None):
    """¿SimBridge está corriendo y ve la ruta? Esto es lo que de verdad decide si el MCDU
    va a encontrarla: escribir el archivo no alcanza, el avión se la pide al servidor de
    SimBridge por HTTP. Si SimBridge está cerrado, el MCDU responde error y desde la app
    no había forma de saber por qué."""
    port = _simbridge_port()
    base = "http://localhost:%d" % port
    out = {"puerto": port, "vivo": False, "ruta_visible": None}
    try:
        req = urllib.request.Request(base + "/api/v1/coroute/list",
                                     headers={"User-Agent": "msfs-tracker/1.0"})
        with urllib.request.urlopen(req, timeout=2) as r:
            r.read()
        out["vivo"] = True
    except Exception:
        return out          # no responde: está cerrado (lo demás no tiene sentido probarlo)

    if name:
        try:
            url = base + "/api/v1/coroute?rteNum=" + urllib.parse.quote(name)
            req = urllib.request.Request(url, headers={"User-Agent": "msfs-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=3) as r:
                cuerpo = r.read().decode("utf-8", "ignore")
            # Si la pudo leer y parsear, devuelve el plan con el origen adentro
            out["ruta_visible"] = bool(cuerpo) and ("origin" in cuerpo or "icao_code" in cuerpo)
        except Exception:
            out["ruta_visible"] = False
    return out


@app.route("/api/simbridge_status")
def api_simbridge_status():
    """Diagnóstico: dónde se guardan las rutas y si SimBridge las está sirviendo."""
    st = simbridge_status(request.args.get("name") or None)
    st["carpetas"] = find_coroutes_dirs()
    st["exe"] = find_simbridge_exe()
    # Si no lo encuentra, esto dice dónde miró: sirve para saber qué falta revisar en vez
    # de quedarse con un "null" sin explicación.
    if not st["exe"]:
        st["community"] = _community_dirs()
        st["puede_anotarse_en"] = SIMBRIDGE_EXE_HINT
    return jsonify(st)


# El ejecutable cambia de nombre según cómo lo hayas instalado (el instalador oficial deja
# "FlyByWire SimBridge.exe"; los paquetes portables, "fbw-simbridge.exe").
SIMBRIDGE_EXES = ["FlyByWire SimBridge.exe", "fbw-simbridge.exe", "SimBridge.exe"]


SIMBRIDGE_EXE_HINT = os.path.join(DATA_DIR, "simbridge_exe.txt")


def _buscar_exe_en(raiz, profundidad=4):
    """Recorre una carpeta buscando el ejecutable, sin irse por las ramas: se limita la
    profundidad y se saltan las carpetas gordas (node_modules, caches) porque si no, en
    una carpeta Community con 200 addons esto tarda una eternidad."""
    saltar = {"node_modules", ".git", "__pycache__", "cache", "Cache", "logs",
              "SceneryIndexes", "texture", "TEXTURE", "sound", "SOUND", "model"}
    raiz = os.path.abspath(raiz)
    base_nivel = raiz.count(os.sep)
    try:
        for actual, dirs, files in os.walk(raiz):
            if actual.count(os.sep) - base_nivel >= profundidad:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in saltar and not d.startswith(".")]
            for name in SIMBRIDGE_EXES:
                if name in files:
                    return os.path.join(actual, name)
            # nombres con otra capitalización
            bajos = {f.lower(): f for f in files}
            for name in SIMBRIDGE_EXES:
                if name.lower() in bajos:
                    return os.path.join(actual, bajos[name.lower()])
    except Exception:
        pass
    return None


def find_simbridge_exe():
    """Busca el ejecutable de SimBridge. En orden: el que hayas anotado a mano, después
    al lado de la carpeta 'resources' que ya sabemos usar, después las rutas habituales
    del instalador, y por último rastreando las carpetas donde suele terminar."""
    # 1) anotado a mano en data/simbridge_exe.txt
    if os.path.exists(SIMBRIDGE_EXE_HINT):
        try:
            with open(SIMBRIDGE_EXE_HINT, "r", encoding="utf-8") as f:
                p = f.read().strip()
            if p and os.path.isfile(p):
                return p
        except Exception:
            pass

    # 2) al lado de resources, y rutas conocidas del instalador
    carpetas = []
    for d in find_coroutes_dirs():
        resources = os.path.dirname(d)          # ...\Simbridge\resources
        raiz = os.path.dirname(resources)       # ...\Simbridge
        for c in (raiz, resources):
            if c and c not in carpetas:
                carpetas.append(c)
    local = os.environ.get("LOCALAPPDATA", "")
    appdata = os.environ.get("APPDATA", "")
    pf = os.environ.get("ProgramFiles", "C:\\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    carpetas += [
        os.path.join(local, "Programs", "FlyByWireSimBridge"),
        os.path.join(local, "Programs", "flybywire-simbridge"),
        os.path.join(local, "Programs", "FlyByWire SimBridge"),
        os.path.join(local, "FlyByWireSimBridge"),
        os.path.join(appdata, "FlyByWireSimBridge"),
        os.path.join(pf, "FlyByWire SimBridge"),
        os.path.join(pf86, "FlyByWire SimBridge"),
        os.path.join(_USER, "Documents", "FlyByWireSim", "Simbridge"),
        os.path.join(_USER, "Documentos", "FlyByWireSim", "Simbridge"),
    ]
    for folder in carpetas:
        if not folder or not os.path.isdir(folder):
            continue
        for name in SIMBRIDGE_EXES:
            p = os.path.join(folder, name)
            if os.path.isfile(p):
                return p

    # 3) rastreo acotado. Incluye las carpetas Community de MSFS: el addon
    #    "flybywire-externaltools-simbridge" es el que lanza SimBridge desde el simulador,
    #    y muchas instalaciones dejan ahí adentro el ejecutable.
    raices = [
        os.path.join(local, "Programs"),
        os.path.join(_USER, "OneDrive", "Documentos", "FlyByWireSim"),
        os.path.join(_USER, "OneDrive", "Documents", "FlyByWireSim"),
        os.path.join(_USER, "Documentos", "FlyByWireSim"),
        os.path.join(_USER, "Documents", "FlyByWireSim"),
    ]
    for com in _community_dirs():
        raices.append(os.path.join(com, "flybywire-externaltools-simbridge"))
    for raiz in raices:
        if raiz and os.path.isdir(raiz):
            hallado = _buscar_exe_en(raiz)
            if hallado:
                return hallado
    return None


def _community_dirs():
    """Carpetas Community de MSFS que existan. Se leen del UserCfg.opt del simulador, que
    es donde queda anotada la ruta real (mucha gente la mueve a otro disco), y si no se
    prueban las de siempre."""
    out = []
    cfgs = [
        os.path.join(os.environ.get("APPDATA", ""), "Microsoft Flight Simulator", "UserCfg.opt"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Packages",
                     "Microsoft.FlightSimulator_8wekyb3d8bbwe", "LocalCache", "UserCfg.opt"),
        os.path.join(os.environ.get("APPDATA", ""), "Microsoft Flight Simulator 2024", "UserCfg.opt"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Packages",
                     "Microsoft.Limitless_8wekyb3d8bbwe", "LocalCache", "UserCfg.opt"),
    ]
    for cfg in cfgs:
        if not os.path.isfile(cfg):
            continue
        try:
            with open(cfg, "r", encoding="utf-8", errors="ignore") as f:
                for linea in f:
                    if "InstalledPackagesPath" in linea:
                        ruta = linea.split(" ", 1)[1].strip().strip('"')
                        com = os.path.join(ruta, "Community")
                        if os.path.isdir(com) and com not in out:
                            out.append(com)
        except Exception:
            pass
    return out


@app.route("/api/simbridge_start", methods=["POST"])
def api_simbridge_start():
    """Abre SimBridge si lo encontramos. Sin esto, el MCDU falla y desde la app no había
    forma de arreglarlo: había que ir a buscarlo al menú de inicio."""
    st = simbridge_status()
    if st["vivo"]:
        return jsonify({"ok": True, "ya_estaba": True})

    exe = find_simbridge_exe()
    if not exe:
        return jsonify({"ok": False, "reason": "no_encontrado"})
    try:
        subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
    except Exception as e:
        return jsonify({"ok": False, "reason": "no_pude_abrirlo", "detail": str(e), "exe": exe})

    # Tarda unos segundos en levantar el servidor; esperamos a que conteste.
    for _ in range(20):
        time.sleep(0.5)
        if simbridge_status()["vivo"]:
            return jsonify({"ok": True, "exe": exe})
    return jsonify({"ok": False, "reason": "no_respondio", "exe": exe})


def _xml_esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def build_coroute_xml(origin, destination, fixes, route_str):
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<OFP>",
           "  <general>", "    <route>%s</route>" % _xml_esc(route_str), "  </general>",
           "  <origin><icao_code>%s</icao_code></origin>" % _xml_esc(origin),
           "  <destination><icao_code>%s</icao_code></destination>" % _xml_esc(destination),
           "  <alternate><icao_code>%s</icao_code></alternate>" % _xml_esc(destination),
           "  <navlog>"]
    for f in fixes:
        out += ["    <fix>",
                "      <ident>%s</ident>" % _xml_esc(f["ident"]),
                "      <name>%s</name>" % _xml_esc(f.get("name") or f["ident"]),
                "      <type>%s</type>" % _xml_esc(f.get("type") or "wpt"),
                "      <via_airway>%s</via_airway>" % _xml_esc(f.get("via") or "DCT"),
                "      <is_sid_star>0</is_sid_star>",
                "      <pos_lat>%.6f</pos_lat>" % f["lat"],
                "      <pos_long>%.6f</pos_long>" % f["lon"],
                "    </fix>"]
    out += ["  </navlog>", "</OFP>", ""]
    return "\n".join(out)


@app.route("/api/coroute", methods=["POST"])
def api_coroute():
    """Recibe la ruta de la app y la deja lista para cargar desde el MCDU."""
    d = request.get_json(silent=True) or {}
    origin = (d.get("origin") or "").strip().upper()
    destination = (d.get("destination") or "").strip().upper()
    if not origin or not destination:
        return jsonify({"ok": False, "reason": "faltan_aeropuertos"})

    folders = find_coroutes_dirs()
    if not folders:
        return jsonify({"ok": False, "reason": "no_simbridge"})

    # Antes mandábamos también los puntos intermedios (VOR) de la ruta que arma la app.
    # En la práctica el FMS del avión los busca en SU PROPIA base de navegación (la del
    # sim/Navigraph), que no es la misma de donde salen nuestros VOR (OurAirports). Cuando
    # no los reconoce los descarta sin avisar y deja un "F-PLN DISCONTINUITY" en el medio.
    # Origen y destino sí siempre existen (son aeropuertos ICAO reales), así que ahora solo
    # mandamos esos dos: entra limpio con un solo INSERT, sin cortes ni duplicados.

    def _apt_fix(icao, lat, lon):
        return {"ident": icao, "name": icao, "type": "apt", "via": "DCT",
                "lat": float(lat), "lon": float(lon)}

    fixes = []
    try:
        olat, olon = float(d.get("origin_lat")), float(d.get("origin_lon"))
        fixes.append(_apt_fix(origin, olat, olon))
    except (TypeError, ValueError):
        pass
    try:
        dlat, dlon = float(d.get("dest_lat")), float(d.get("dest_lon"))
        fixes.append(_apt_fix(destination, dlat, dlon))
    except (TypeError, ValueError):
        pass
    if len(fixes) < 2:
        return jsonify({"ok": False, "reason": "ruta_muy_corta"})

    name = (origin + destination)[:9]              # el MCDU acepta hasta 9 caracteres
    route_str = "DCT"
    xml = build_coroute_xml(origin, destination, fixes, route_str)

    escritos, errores = [], []
    for folder in folders:
        path = os.path.join(folder, name + ".xml")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(xml)
            escritos.append(path)
        except Exception as e:
            errores.append("%s: %s" % (path, e))
    if not escritos:
        return jsonify({"ok": False, "reason": "no_pude_escribir", "detail": "; ".join(errores)})

    # El archivo puede estar perfecto y el MCDU dar error igual, simplemente porque
    # SimBridge no está abierto. Se comprueba acá para poder decirlo en pantalla.
    sb = simbridge_status(name)
    return jsonify({"ok": True, "name": name, "fixes": len(fixes),
                    "path": escritos[0], "paths": escritos,
                    "simbridge": sb})


@app.route("/api/history")
def api_history():
    """Vuelos guardados, del más nuevo al más viejo."""
    h = read_history()
    for i, e in enumerate(h):
        e.setdefault("id", i + 1)          # entradas viejas no tenían identificador
    return jsonify(list(reversed(h)))


@app.route("/api/history/delete", methods=["POST"])
def api_history_delete():
    try:
        fid = int(request.args.get("id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False})
    h = read_history()
    for i, e in enumerate(h):
        e.setdefault("id", i + 1)
    nuevo = [e for e in h if e.get("id") != fid]
    if len(nuevo) == len(h):
        return jsonify({"ok": False, "reason": "not_found"})
    return jsonify({"ok": write_history(nuevo), "left": len(nuevo)})


@app.route("/api/airport")
def api_airport():
    """Busca un aeropuerto por ICAO en TODA la base, no solo cerca del avión.
    Hace falta para mostrar el nombre del destino cuando está a miles de millas."""
    icao = (request.args.get("icao") or "").strip().upper()
    if not icao or not NAV["ready"]:
        return jsonify({})
    for a in NAV["airports"]:
        if a["icao"].upper() == icao:
            return jsonify(a)
    return jsonify({})


@app.route("/api/live_airways_status")
def api_live_airways_status():
    """Diagnóstico de las aerovías en vivo: si encontró un SimConnect.dll moderno, si
    logró conectarse, cuántos waypoints/aristas ya sumó al grafo, y el último error si
    lo hubo. Sirve para que, al probar esto en la máquina real con MSFS corriendo, se
    pueda ver acá qué está pasando sin tener que leer la consola del servidor."""
    if not LIVE_AIRWAYS_AVAILABLE:
        return jsonify({"disponible": False, "motivo": "módulo live_airways no cargó"})
    out = dict(live_airways.STATUS)
    out["disponible"] = True
    return jsonify(out)


def _pos_actual():
    with lock:
        return state.get("lat"), state.get("lon")


if __name__ == "__main__":
    load_current_flight()
    threading.Thread(target=telemetry_loop, daemon=True).start()
    threading.Thread(target=load_navdata, daemon=True).start()
    if LIVE_AIRWAYS_AVAILABLE:
        threading.Thread(target=live_airways.run, args=(AWY, _pos_actual, DATA_DIR), daemon=True).start()

    # host="0.0.0.0" => accesible desde el celular/iPad en la misma red (no solo localhost)
    app.run(host="0.0.0.0", debug=True, port=5001, use_reloader=False)
