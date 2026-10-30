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
import sys
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
# siempre. Ver server/live_airways.py para el detalle completo.
try:
    from server import live_airways
    LIVE_AIRWAYS_AVAILABLE = True
except Exception:
    LIVE_AIRWAYS_AVAILABLE = False

# Tráfico IA (AIG/FSLTL/MSFS) por una tercera conexión SimConnect, también opcional. Ver
# server/traffic.py para por qué no puede usar la conexión de telemetry_loop.
try:
    from server import traffic
    TRAFFIC_AVAILABLE = True
except Exception:
    TRAFFIC_AVAILABLE = False

# Fotos de JetPhotos para la tarjeta del tráfico (API no oficial de roowus corriendo en
# local, ver server/jetphotos.py). Opcional: sin ella la tarjeta usa Wikimedia Commons.
try:
    from server import jetphotos
    JETPHOTOS_AVAILABLE = True
except Exception:
    JETPHOTOS_AVAILABLE = False

# La logica que no depende del estado mutable del simulador vive en server/ (ver
# server/core.py para por que el estado mutable NO se movio). Se reimportan los nombres al
# namespace de app.py porque demo_medellin.py y el resto del codigo los usan como
# `app.<nombre>`, y porque las rutas HTTP de mas abajo los llaman sin prefijo.
from server.core import (BASE_DIR, DATA_DIR, CURRENT_FILE, HISTORY_FILE,
                         state, route, MAX_ROUTE_POINTS, lock, sim_lock)
from server.geo import _haversine_nm, _flat_distance, _bearing, _cross_track_nm
from server.weather import fetch_nearest_metar
from server.msfs_plan import PLN_PATHS, PLN_CACHE, _find_pln, _parse_world_position, read_msfs_plan
from server.navdata import (NAV, AWY, VOR_GRID, OURAIRPORTS, WAYPOINTS_URL, AIRWAYS_URL,
                            _download_csv, load_navdata, nearest_airport, load_airways,
                            load_waypoints, route_by_airways, _awy_key, _awy_near,
                            _build_vor_grid, _vor_key, _vors_near)
from server.routing import (generate_route, generate_route_auto, _path_len, parse_route_string,
                            _resolve_token, _resumen_aerovias, _comprimir, _AIRWAY_RE, _SKIP)
from server.flight_store import (load_current_flight, save_current_flight, read_history,
                                 write_history, archive_flight_to_history)
from server.simbridge import (SIMBRIDGE_HINT, SIMBRIDGE_GUESSES, SIMBRIDGE_EXES,
                              SIMBRIDGE_EXE_HINT, find_coroutes_dirs, find_coroutes_dir,
                              _simbridge_port, simbridge_status, _buscar_exe_en,
                              find_simbridge_exe, _community_dirs, _xml_esc, build_coroute_xml)

app = Flask(__name__)

# Se probó una versión con WebSocket (push) para la telemetría en vez del polling HTTP de
# abajo. En la práctica, con el servidor de desarrollo de Flask (de por sí no pensado para
# sostener WebSocket bajo carga) el envío quedó más brusco y más espaciado que el polling
# simple: el loop del servidor manda-y-duerme de forma SECUENCIAL, así que cualquier demora
# de red en un ws.send() atrasa directamente el siguiente envío — algo que el polling por
# HTTP no sufre, porque cada pedido del navegador sale independiente de los demás. Se
# revirtió a polling HTTP puro a propósito; no reintroducir WebSocket para esto sin medir
# primero con un servidor de verdad (gunicorn/eventlet), no con el dev server.

# python-simconnect NO es seguro entre hilos: el loop de telemetría y las peticiones web
# tocan el mismo handle de la DLL y los mismos contadores internos de IDs. Sin este
# candado, un evento (una avería, las luces) se podía perder o llegar tarde porque se
# pisaba con una lectura. Es un candado aparte de `lock`, que solo cuida el dict `state`.

last_save = 0
last_weather_fetch = 0
prev_sim_clock = None    # último valor del reloj DEL SIMULADOR, para medir el tiempo de vuelo
prev_wall_clock = None   # reloj de la PC, solo como respaldo si el sim no da la hora
prev_time_source = None  # 'abs' o 'local': para no comparar reloj_sim de dos fuentes distintas
last_pos_t = None        # cuándo llegó la última posición, para el umbral de teletransporte
last_known_sim_rate = 1.0  # último SIMULATION_RATE válido, por si una lectura puntual falla

# Modo debug: `python app.py --debug` arranca sin tocar SimConnect, con un avión de
# mentira parado en SKRG (José María Córdoba, Rionegro) para probar la interfaz sin
# tener MSFS abierto. Los botones que mandan comandos al sim (teleport, autopiloto,
# tren...) siguen sin hacer nada de verdad en este modo: ya están protegidos contra
# sim_aq/sim_events en None, así que no rompen, pero tampoco hay simulador del otro lado
# que reaccione. Sirve para el resto de la interfaz: mapa, paneles, capas, historial.
DEBUG_MODE = "--debug" in sys.argv
DEBUG_AIRPORT_ICAO = "SKRG"
DEBUG_FALLBACK_LATLON = (6.1645, -75.4231)   # SKRG, por si la base de aeropuertos no cargó a tiempo
DEBUG_FALLBACK_ELEV_FT = 7031.0

# Cierre automático del vuelo. Antes el vuelo SOLO pasaba al historial al tocar
# "Reiniciar ruta": si aterrizabas y cerrabas la app, se perdía. Ahora lo guardamos solos
# al detectar que el vuelo terminó (despegaste, aterrizaste y quedaste quieto un rato).
fue_al_aire = False        # ¿este vuelo llegó a despegar? (si no, no hay nada que guardar)
quieto_desde = None        # desde cuándo está detenido en tierra, después de haber volado
vuelo_archivado = False    # ya lo mandamos al historial: no lo repetimos
sim_aq = None       # AircraftRequests, para setear posición/variables (teletransporte)
sim_events = None   # AircraftEvents, para disparar eventos (ej. bajar el tren)
sim_raw = None      # objeto SimConnect() crudo, SOLO para camera_jump_to() (ver más abajo):
                     # necesita el handle y el binding de bajo nivel (.dll), algo que
                     # AircraftRequests/AircraftEvents no exponen.


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






def _safe_get(aq, name):
    """Lee una variable de SimConnect sin romper el loop si no existe o falla.

    Toma el candado por variable y no por bloque entero: así un evento disparado desde
    la web se puede colar entre dos lecturas en vez de esperar a que termine el ciclo.
    """
    try:
        cada = FRECUENCIA_S.get(name)
        if cada is None:
            with sim_lock:
                return aq.get(name)
        return _leer_sin_esperar(aq, name, cada)
    except Exception:
        return None


def _leer_sin_esperar(aq, name, cada):
    """Variables lentas (ver SIMVARS_CADA_1S/10S): se manda el pedido y NO se espera la
    respuesta; se devuelve el último valor conocido. La respuesta la deja el hilo de dispatch
    de la librería en Request.outData y se toma en la vuelta siguiente. Darles solo un caché
    más largo (Request.time) NO alcanzaba: al vencer se volvían a esperar una por una, y como
    vencían todas juntas la vuelta seguía tardando ~1 s.

    Usa partes internas de python-simconnect (find, _deff_test, request_data, outData): si se
    actualiza la librería, revisar que sigan igual. El último valor se guarda EN el Request,
    así al reconectar (aq nuevo) arranca limpio solo."""
    r = aq.find(name)
    if r is None:
        return None
    if r.outData is not None:              # request_data() lo pone en None al pedir: se guarda antes
        r.ultimo_valor = r.outData
    ahora = time.time()
    if ahora - getattr(r, "pedido_t", 0.0) >= cada:
        r.pedido_t = ahora
        with sim_lock:
            if r._deff_test():
                r.sm.request_data(r)
    return getattr(r, "ultimo_valor", None)














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


def set_sim_time(hh=None, mm=None):
    """Cambia la hora del reloj del sim (ZULU/UTC).
    Nota: ZULU_TIME es una SimVar de SOLO LECTURA en SimConnect (por eso `.set()` no
    rompía pero tampoco hacía nada — fallaba en silencio). La forma soportada de cambiar
    la hora es disparando los EVENTOS ZULU_HOURS_SET / ZULU_MINUTES_SET, igual que ya
    hacemos con el autopiloto en set_autopilot(). El clima real, aparte, sigue sin tener
    un "set" confiable — hay que cambiarlo desde el menú de clima del juego por ahora."""
    if sim_events is None or hh is None or mm is None:
        return False
    try:
        with sim_lock:
            eh = sim_events.find("ZULU_HOURS_SET")
            em = sim_events.find("ZULU_MINUTES_SET")
            if eh is None or em is None:
                return False
            eh(int(hh))
            em(int(mm))
        return True
    except Exception:
        return False


def camera_jump_to(lat, lon):
    """EXPERIMENTAL — NO usado por la UI todavía, solo para pruebas manuales vía
    /api/camera_test. Intenta saltar la cámara ACTIVA del sim (la del jugador, ej. la
    cámara libre/drone) al punto (lat, lon) dado, usando SimConnect_CameraSetRelative6DOF.

    Contexto importante (para quien retome esto):
    - Esta función de SimConnect está marcada como OBSOLETA / sin mantenimiento por Asobo
      (foro de soporte oficial: "obsolete in MSFS SDK context and is not maintained...
      this call causes rendering and performance issues"). Hay reportes de que puede dejar
      la cámara totalmente trabada (no gira, no hace zoom) después de usarla.
    - La librería SimConnect (pip) tiene el binding crudo en Attributes.py pero con un bug:
      le falta el primer argtype HANDLE. Por eso lo redeclaramos acá antes de llamarlo.
    - Los deltas X/Y/Z son relativos al AVIÓN (no al mundo), según la doc histórica de
      FSX/P3D. SUPOSICIÓN SIN VERIFICAR contra doc actual de MSFS — puede que el signo o
      el eje esté invertido. Necesita calibrarse mirando qué pasa en pantalla.
    - Devuelve un dict con el resultado y los deltas calculados, para poder ver en la
      respuesta del endpoint qué se mandó exactamente.
    """
    from ctypes import c_float
    from ctypes.wintypes import HANDLE
    global sim_raw
    if sim_raw is None:
        return {"ok": False, "reason": "sin conexión a SimConnect"}
    if lat is None or lon is None:
        return {"ok": False, "reason": "faltan lat/lon"}
    st = dict(state)
    plane_lat, plane_lon = st.get("lat"), st.get("lon")
    hdg = st.get("heading") or 0.0
    if plane_lat is None or plane_lon is None:
        return {"ok": False, "reason": "todavía no hay posición del avión"}
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "lat/lon inválidos"}

    dist_m = _haversine_nm(plane_lat, plane_lon, lat, lon) * 1852.0
    brg_deg = _bearing(plane_lat, plane_lon, lat, lon)
    brg_rad = math.radians(brg_deg)
    d_east = dist_m * math.sin(brg_rad)
    d_north = dist_m * math.cos(brg_rad)

    # SUPOSICIÓN SIN VERIFICAR: rotamos el offset este/norte al frame del avión
    # (lateral=X, vertical=Y, adelante/atrás=Z), usando el heading actual.
    hdg_rad = math.radians(hdg)
    dx = d_east * math.cos(hdg_rad) - d_north * math.sin(hdg_rad)
    dz = d_east * math.sin(hdg_rad) + d_north * math.cos(hdg_rad)
    dy = 0.0

    IGNORE = -1.0   # SIMCONNECT_CAMERA_IGNORE_FIELD (SimConnect/Constants.py), no reexportado

    auto_reset = False
    try:
        with sim_lock:
            fn = sim_raw.dll.CameraSetRelative6DOF
            # Corrigiendo el bug de la librería: le falta el HANDLE como primer argtype.
            fn.argtypes = [HANDLE, c_float, c_float, c_float, c_float, c_float, c_float]
            hr = fn(sim_raw.hSimConnect,
                    c_float(dx), c_float(dy), c_float(dz),
                    c_float(IGNORE), c_float(IGNORE), c_float(IGNORE))
            # La cámara suele quedar TRABADA después de esto (confirmado por Asobo y por
            # pruebas reales). El usuario notó que salir de la cámara y volver a entrar la
            # destraba. Intentamos automatizar exactamente eso disparando NEXT_VIEW y
            # PREV_VIEW (cicla a la vista siguiente y vuelve) — es un intento, no una
            # solución confirmada; si falla no rompe el resultado principal del salto.
            if sim_events is not None:
                try:
                    ev_next = sim_events.find("NEXT_VIEW")
                    ev_prev = sim_events.find("PREV_VIEW")
                    if ev_next is not None and ev_prev is not None:
                        ev_next()
                        time.sleep(0.15)
                        ev_prev()
                        auto_reset = True
                except Exception:
                    pass
        return {
            "ok": True, "hresult": int(hr), "auto_reset_attempted": auto_reset,
            "dx": round(dx, 1), "dy": round(dy, 1), "dz": round(dz, 1),
            "dist_m": round(dist_m, 1), "brg_deg": round(brg_deg, 1),
        }
    except Exception as e:
        return {"ok": False, "reason": str(e)}


def _debug_position():
    """Dónde parar el avión de mentira: el SKRG real (con su elevación) si la base de
    aeropuertos ya cargó, si no el fallback hardcodeado (arranca igual sin esperar la
    descarga de OurAirports ni depender de tener internet)."""
    for a in NAV["airports"]:
        if a["icao"].upper() == DEBUG_AIRPORT_ICAO:
            try:
                elev = float(a["elev_ft"])
            except (TypeError, ValueError):
                elev = DEBUG_FALLBACK_ELEV_FT
            return a["lat"], a["lon"], elev
    lat, lon = DEBUG_FALLBACK_LATLON
    return lat, lon, DEBUG_FALLBACK_ELEV_FT


def _debug_telemetry_loop():
    """Reemplazo de telemetry_loop() para --debug: nunca toca SimConnect. Avión quieto en
    la pista de SKRG, con datos estáticos coherentes, para probar mapa/paneles/capas sin
    tener MSFS abierto. No incrementa elapsed_min ni dispara el archivado automático de
    vuelo: como on_ground nunca deja de ser True, _revisar_fin_de_vuelo() lo ignora
    (fue_al_aire nunca pasa a True porque el avión nunca despega)."""
    # Espera corta a que load_navdata() (lanzado en paralelo) resuelva el aeropuerto real;
    # si tarda o falla, seguimos con el fallback en vez de dejar la app sin arrancar.
    esperado = time.time() + 8
    while not NAV["ready"] and time.time() < esperado:
        time.sleep(0.5)
    lat, lon, elev = _debug_position()

    with lock:
        state["debug"] = True
        state["connected"] = True
        state["lat"] = lat
        state["lon"] = lon
        state["alt"] = elev
        state["heading"] = 0.0
        state["gs"] = 0.0
        state["ias"] = 0.0
        state["vs"] = 0.0
        state["on_ground"] = True
        state["gear_pct"] = 1.0
        state["flaps_pct"] = 0.0
        state["flaps_index"] = 0
        state["spoilers_pct"] = 0.0
        state["parking_brake"] = True
        state["eng_type"] = 1
        state["eng_count"] = 2
        state["aircraft"] = "DEBUG · estático en " + DEBUG_AIRPORT_ICAO
        state["mach"] = 0.0
        state["sim_rate"] = 1.0
        state["pausado"] = False
        state["magvar"] = 0.0
        state["fplan"] = None
        state["lights"] = {"landing": False, "beacon": True, "strobe": False, "nav": True, "taxi": False}
        state["ap"] = {"master": False, "hdg_lock": False, "alt_lock": False, "spd_lock": False,
                        "hdg": 0.0, "alt": elev, "spd": 0.0}
        state["fuel_gal"] = 500.0
        state["fuel_capacity"] = 1000.0
        state["fuel_flow_gph"] = 0.0
        state["endurance_min"] = None
        state["distance_nm"] = 0.0
        state["max_alt"] = elev
        state["flight_start"] = None
        state["elapsed_min"] = 0

    while True:
        with lock:
            state["local_time"] = time.time() % 86400
            state["reloj_sim"] = state["local_time"]
        time.sleep(1)


# ---------------------------------------------------------------------------
# Frecuencia de lectura de cada SimVar
# ---------------------------------------------------------------------------
# python-simconnect lee UNA variable por pedido y se queda esperando la respuesta del sim
# (~1 frame, ver get_data en su SimConnect.py). Con ~45 variables por vuelta, cada vuelta
# tardaba ~1 s (la posición del avión se actualizaba ~1 vez por segundo, no 10) aunque casi
# todo cambia poco y el panel se redibuja 1 vez por segundo. Ahora solo lo que mueve el
# avión en el mapa/3D se pide y se espera en cada vuelta; las de estas listas se piden cada
# 1/3/10 s SIN esperar la respuesta (ver _leer_sin_esperar). Medido con un SimConnect falso
# a 40 FPS: la posición pasa de ~0,8 a ~2,3 actualizaciones por segundo, con menos pedidos
# al sim (de ~37 a ~30 por segundo).
# 1 s: lo que el panel muestra (se redibuja 1 vez/s) o lo que usa la lógica de vuelo
# (fin de vuelo, salto imposible con sim rate, tiempo de vuelo con el reloj del sim) y las
# luces, para que el botón de la app responda rápido.
SIMVARS_CADA_1S = (
    "SIM_ON_GROUND", "GEAR_CENTER_POSITION", "AIRSPEED_INDICATED", "AIRSPEED_MACH",
    "SIMULATION_RATE", "ABSOLUTE_TIME",
    "LIGHT_LANDING", "LIGHT_BEACON", "LIGHT_STROBE", "LIGHT_NAV", "LIGHT_TAXI",
)
# 3 s: cambia despacio (combustible, hora local para la ETA y el día/noche, tramo del GPS)
SIMVARS_CADA_3S = (
    "LOCAL_TIME", "FUEL_TOTAL_QUANTITY",
    "GPS_IS_ACTIVE_FLIGHT_PLAN", "GPS_WP_DISTANCE", "GPS_FLIGHT_PLAN_WP_INDEX",
    "GPS_FLIGHT_PLAN_WP_COUNT", "GPS_WP_NEXT_LAT", "GPS_WP_NEXT_LON", "GPS_WP_PREV_LAT", "GPS_WP_PREV_LON",
)
# 10 s: no cambia en vuelo
SIMVARS_CADA_10S = ("ENGINE_TYPE", "NUMBER_OF_ENGINES", "MAGVAR", "FUEL_TOTAL_CAPACITY")
FRECUENCIA_S = dict([(n, 1) for n in SIMVARS_CADA_1S] + [(n, 3) for n in SIMVARS_CADA_3S]
                    + [(n, 10) for n in SIMVARS_CADA_10S])
FUEL_FLOW_CADA = 10   # s. ENG_FUEL_FLOW_GPH:n comparte UN Request para todos los motores y la
                      # librería lo redefine (ClearDataDefinition + otro pedido) al cambiar de n,
                      # así que no puede ir "sin esperar": se lee esperando, pero cada 10 s.


def telemetry_loop():
    global last_save, last_weather_fetch, sim_aq, sim_events, sim_raw, last_pos_t
    global prev_sim_clock, prev_wall_clock, prev_time_source, last_known_sim_rate
    sm = None
    aq = None
    consecutive_errors = 0
    ERROR_THRESHOLD = 5   # solo damos por "desconectado" tras varios fallos seguidos
    fuel_flow, fuel_flow_t = 0.0, 0.0

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
                aq = AircraftRequests(sm, _time=100)   # caché de lo que se pide en cada vuelta;
                                                       # las lentas van aparte (FRECUENCIA_S)
                sim_aq = aq
                sim_raw = sm   # objeto crudo, lo necesita camera_jump_to() (ver más abajo)
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
            # Banqueo REAL del avión (no estimado): antes el frontend trataba de adivinar
            # el ángulo de banco derivando la velocidad de giro del rumbo entre muestras —
            # fràgil (dependía del framerate/buffer del lado del cliente) y seguía
            # "destellando" en las curvas. SimConnect ya lo expone directo, igual que
            # VERTICAL_SPEED para el cabeceo (ver cesium-3d.js, que sí funcionó bien de
            # entrada con vs). Mismo signo raro que el rumbo: viene en radianes.
            bank = _safe_get(aq, "PLANE_BANK_DEGREES")
            if bank is not None:
                bank = math.degrees(bank)
            gs = _safe_get(aq, "GROUND_VELOCITY")
            ias = _safe_get(aq, "AIRSPEED_INDICATED")
            vs = _safe_get(aq, "VERTICAL_SPEED")
            on_ground = _safe_get(aq, "SIM_ON_GROUND")
            gear_pct = _safe_get(aq, "GEAR_CENTER_POSITION")

            # Estado del avión (sistemas). Flaps, spoilers, freno de parqueo y piloto automático
            # ya NO se leen: el panel quedó solo con las luces (ver renderStatus en tools-ui.js)
            # y eran 11 pedidos al sim por vuelta para nada. Si vuelven a la UI, leerlos acá
            # (con frecuencia de 1 s, ver SIMVARS_CADA_1S).
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
            lights = {
                "landing": bool(_safe_get(aq, "LIGHT_LANDING")),
                "beacon": bool(_safe_get(aq, "LIGHT_BEACON")),
                "strobe": bool(_safe_get(aq, "LIGHT_STROBE")),
                "nav": bool(_safe_get(aq, "LIGHT_NAV")),
                "taxi": bool(_safe_get(aq, "LIGHT_TAXI")),
            }

            # Combustible + autonomía (cada campo protegido por si el avión no lo expone)
            fuel_gal = _safe_get(aq, "FUEL_TOTAL_QUANTITY")
            fuel_cap = _safe_get(aq, "FUEL_TOTAL_CAPACITY")
            if time.time() - fuel_flow_t > FUEL_FLOW_CADA:
                # Solo los motores que tiene el avión (antes eran siempre 4, y cada cambio
                # de índice redefine la variable en la librería).
                fuel_flow_t = time.time()
                n_motores = int(eng_count) if eng_count else 4
                fuel_flow = 0.0
                for i in range(1, max(1, min(4, n_motores)) + 1):
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
                state["bank"] = bank
                state["gs"] = gs
                state["ias"] = ias
                state["vs"] = vs
                state["on_ground"] = bool(on_ground) if on_ground is not None else None
                state["gear_pct"] = gear_pct
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
                state["lights"] = lights
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
                    prev_time_source = None
                else:
                    reloj_sim = abs_time if abs_time is not None else local_time
                cur_time_source = None if reloj_sim is None else ("abs" if abs_time is not None else "local")
                if reloj_sim is not None:
                    # ABSOLUTE_TIME (segundos desde 1900) y LOCAL_TIME (segundos desde
                    # medianoche) son magnitudes completamente distintas. Antes, si una sola
                    # lectura de ABSOLUTE_TIME fallaba (más frecuente cuanto más rápido corre
                    # el sim rate, según reportado con x4), el código caía a LOCAL_TIME por un
                    # tick y comparaba contra el prev_sim_clock viejo basado en ABSOLUTE_TIME:
                    # eso da un "salto atrás" de miles de millones de segundos, que disparaba
                    # el reinicio de vuelo de más abajo SIN que el vuelo se haya reiniciado de
                    # verdad. Por eso: si la fuente cambió respecto a la muestra anterior, no
                    # comparamos — solo re-anclamos el reloj con la fuente nueva y seguimos.
                    if prev_sim_clock is not None and prev_time_source == cur_time_source:
                        d = reloj_sim - prev_sim_clock
                        if cur_time_source == "local" and d < -43200:   # LOCAL_TIME cruzó medianoche
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
                    prev_time_source = cur_time_source
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
                # Si esta lectura puntual de SIMULATION_RATE falló, usamos la última válida
                # en vez de asumir 1.0 a secas: con sim rate alto (x4, x8...) un solo hueco acá
                # subestimaba mucho lo que el avión pudo recorrer y disparaba un reinicio de
                # vuelo falso ("salto imposible" que en realidad era vuelo normal acelerado).
                if sim_rate:
                    last_known_sim_rate = float(sim_rate)
                rate = last_known_sim_rate
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
                sim_raw = None
                prev_sim_clock = None     # al reconectar, no arrastramos el reloj viejo
                prev_wall_clock = None
                prev_time_source = None
                # last_pos_t NO se resetea a propósito: si lo hiciéramos, el próximo dt
                # daría ~0 en vez de reflejar lo que duró el corte, y el cálculo de
                # "distancia posible" (más abajo) subestimaría muchísimo cuánto pudo
                # avanzar el avión mientras estuvimos desconectados. Eso disparaba un
                # falso "salto imposible" que reiniciaba el vuelo entero al reconectar
                # (más notorio cuanto más rápido volabas, porque más lejos llegabas
                # durante el corte). Dejando el last_pos_t viejo, el dt del próximo tick
                # incluye el tiempo real del corte y el margen se calcula bien.
                consecutive_errors = 0
                time.sleep(3)
            else:
                time.sleep(1)
            continue

        time.sleep(0.1)   # pausa entre vueltas (ver AircraftRequests(_time=100) más arriba: 100ms
                          # de caché, pedir más rápido no traería datos más frescos). OJO: la
                          # vuelta en sí tarda además ~1 frame del sim por cada variable que
                          # se espera, por eso las lentas van sin esperar (FRECUENCIA_S).
























# ---------------------------------------------------------------------------
# Rutas HTTP
# ---------------------------------------------------------------------------
@app.after_request
def _no_cache(resp):
    # Evita que el navegador (iPad) sirva una versión vieja cacheada de la interfaz
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _cesium_ion_token():
    """Mismo patrón que simconnect_dll_path.txt: un archivo de una línea en data/, no
    commiteado (ver .gitignore), para no hardcodear el token personal en el HTML. Sin el
    archivo, el modo Terreno 3D simplemente no tiene terreno/imágenes reales (ver
    cesium-3d.js) — no rompe nada, solo se degrada."""
    hint_file = os.path.join(DATA_DIR, "cesium_ion_token.txt")
    if os.path.exists(hint_file):
        try:
            with open(hint_file, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            return ""
    return ""


def _cesium3d_version():
    """Fecha de modificación de cesium-3d.js como query string (?v=...) del <script> que lo
    carga. Sin esto, el navegador (sobre todo Safari/iOS, que cachea agresivo) puede seguir
    sirviendo una versión vieja del archivo después de un cambio aunque hagas F5 — pasó en
    vivo probando en iPad. Al cambiar el archivo, cambia el mtime, cambia la URL, y el
    navegador la trata como un recurso nuevo sin que haga falta pedirle un hard-refresh."""
    try:
        path = os.path.join(BASE_DIR, "static", "js", "cesium-3d.js")
        return str(int(os.path.getmtime(path)))
    except Exception:
        return "0"


@app.route("/")
def index():
    return render_template(
        "index.html",
        cesium_ion_token=_cesium_ion_token(),
        cesium3d_version=_cesium3d_version(),
    )


@app.route("/api/state")
def api_state():
    # OJO: a propósito SIN la ruta acá. `route` puede tener hasta MAX_ROUTE_POINTS (6000)
    # puntos, y este endpoint se pide 10 veces por segundo (ver poll() en tools-ui.js) — el
    # frontend solo necesita la ruta completa ~1 vez por segundo (updateRoute/drawRoute están
    # dentro del bloque "pesado" gateado a 900ms). Mandarla en cada tick significa serializar
    # y transferir un JSON de cientos de KB 10x/seg, incluso en los 9 de cada 10 pedidos que
    # ni la usan: eso es lo que hacía que "el mapa se mueva fluido pero el avión se actualice
    # cada mucho" (el fetch tardaba más que los 100ms del intervalo, así que las lecturas
    # nuevas se acumulaban esperando red en vez de llegar al buffer de interpolación a tiempo).
    # La ruta ahora vive en /api/route, pedida aparte y con menos frecuencia.
    with lock:
        return jsonify({**state})


@app.route("/api/route")
def api_route():
    with lock:
        return jsonify({"route": route})


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
    return jsonify({"ok": set_sim_time(hh, mm)})


@app.route("/api/camera_test")
def api_camera_test():
    """EXPERIMENTAL, NO ligado a ningún botón de la UI todavía.
    Prueba manual: /api/camera_test?lat=...&lon=...
    Intenta mandar la cámara activa del sim (ej. la cámara libre/drone, Insert) al punto
    dado. Ver camera_jump_to() más arriba para el contexto completo de por qué esto es
    un experimento de resultado incierto (función de SimConnect obsoleta)."""
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "reason": "faltan/inválidos lat y lon"})
    return jsonify(camera_jump_to(lat, lon))


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












@app.route("/api/msfs_plan")
def api_msfs_plan():
    return jsonify(read_msfs_plan())
























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


# ---------------------------------------------------------------------------
# Cerrar la app cuando se cierra MSFS
# ---------------------------------------------------------------------------
MSFS_EXES = ('"flightsimulator.exe"', '"flightsimulator2024.exe"')


def _msfs_abierto():
    """True/False según haya un proceso de MSFS; None si no se pudo mirar (en ese caso
    no se decide nada: mejor no cerrar que cerrar por un tasklist que falló)."""
    try:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                             timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except Exception:
        return None
    out = out.lower()
    return any(n in out for n in MSFS_EXES)


def _cerrar_con_msfs():
    """Hilo: si MSFS estuvo abierto y se cerró, guarda el vuelo y termina el proceso.
    Solo si llegó a verlo abierto: abrir la app sin el sim (para mirar el historial) no
    la cierra. Pide 3 ausencias seguidas (~15 s) para no cortar por un tasklist raro.
    Sale con código 0 a propósito: iniciar.bat solo deja la ventana en pausa si es != 0."""
    visto = False
    ausencias = 0
    while True:
        time.sleep(5)
        abierto = _msfs_abierto()
        if abierto is None:
            continue
        if abierto:
            visto, ausencias = True, 0
        elif visto:
            ausencias += 1
            if ausencias >= 3:
                # flush: os._exit no vacía el buffer de salida y el aviso se perdía
                print("MSFS se cerró: guardando el vuelo y cerrando MSFS Live.", flush=True)
                save_current_flight()
                if JETPHOTOS_AVAILABLE:
                    jetphotos.detener_servicio()    # os._exit no corre atexit: si no, queda node vivo
                os._exit(0)


@app.route("/api/traffic")
def api_traffic():
    """Tráfico IA dentro de ?radius= NM del avión propio (el mismo radio de aeropuertos de
    la UI). Se recorta a ~108 NM: es lo máximo que SimConnect deja pedir por tipo."""
    if not TRAFFIC_AVAILABLE:
        return jsonify({"disponible": False, "motivo": "módulo traffic no cargó", "aircraft": []})
    try:
        radio = float(request.args.get("radius", 60))
    except ValueError:
        radio = 60.0
    lat, lon = _pos_actual()
    out = dict(traffic.STATUS)
    out["disponible"] = True
    out["radio_max_nm"] = round(traffic.RADIO_MAX_NM)
    out["aircraft"] = traffic.snapshot(lat, lon, radio)
    return jsonify(out)


@app.route("/api/jetphoto")
def api_jetphoto():
    """Foto de JetPhotos de ?reg=<matrícula>. {"foto": null} si no hay (o el servicio está
    caído): el frontend sigue con Wikimedia Commons. Puede tardar varios segundos la
    primera vez; después sale del caché."""
    if not JETPHOTOS_AVAILABLE:
        return jsonify({"foto": None})
    return jsonify({"foto": jetphotos.buscar(request.args.get("reg", ""))})


@app.route("/api/jetphoto_status")
def api_jetphoto_status():
    return jsonify(jetphotos.STATUS if JETPHOTOS_AVAILABLE else {"servicio": False})


if __name__ == "__main__":
    if os.environ.get("MSFS_LIVE_QUIET"):
        # Arrancado en segundo plano por iniciar-con-msfs.pyw: el log va a un archivo y no
        # tiene que anotar cada pedido HTTP, solo advertencias y errores. python-simconnect
        # loguea "SIM def(...)" como error en cada reintento mientras MSFS no responde: ruido.
        import logging
        logging.getLogger("werkzeug").setLevel(logging.WARNING)
        logging.getLogger("SimConnect").setLevel(logging.CRITICAL)
    if not DEBUG_MODE:
        load_current_flight()
    threading.Thread(target=(_debug_telemetry_loop if DEBUG_MODE else telemetry_loop), daemon=True).start()
    threading.Thread(target=load_navdata, daemon=True).start()
    if DEBUG_MODE:
        print("Modo DEBUG: avion estatico en " + DEBUG_AIRPORT_ICAO + ", sin tocar SimConnect.")
    elif LIVE_AIRWAYS_AVAILABLE:
        threading.Thread(target=live_airways.run, args=(AWY, _pos_actual, DATA_DIR), daemon=True).start()
    if TRAFFIC_AVAILABLE:
        threading.Thread(target=(traffic.run_debug if DEBUG_MODE else traffic.run),
                         args=(_pos_actual,), daemon=True).start()
    # JetPhotos ya no se levanta acá: arranca solo con la primera matrícula que no esté en
    # caché (ver _asegurar_servicio en server/jetphotos.py).
    if not DEBUG_MODE:
        threading.Thread(target=_cerrar_con_msfs, daemon=True).start()

    # host="0.0.0.0" => accesible desde el celular/iPad en la misma red (no solo localhost)
    # threaded=True: sin esto, Werkzeug atiende un request HTTP a la vez, en serie — con
    # /api/state pidiendo ahora 10 veces por segundo, cualquier otro pedido que tarde un
    # poco (ej. /api/navdata, una consulta geoespacial) bloqueaba toda la cola detrás,
    # telemetría incluida. Eso es lo que se veía como "el avión se actualiza 1 vez por
    # segundo" mientras la escena 3D (puramente del lado del navegador) rendía normal. Es
    # seguro: todo el estado compartido (state, acceso a SimConnect) ya pasa por
    # threading.Lock/RLock (ver lock/sim_lock en server/core.py), pensado desde el
    # principio para convivir con el hilo de telemetry_loop.
    app.run(host="0.0.0.0", debug=True, port=5001, use_reloader=False, threaded=True)
