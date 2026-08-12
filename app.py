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

# python-simconnect NO es seguro entre hilos: el loop de telemetría y las peticiones web
# tocan el mismo handle de la DLL y los mismos contadores internos de IDs. Sin este
# candado, un evento (una avería, las luces) se podía perder o llegar tarde porque se
# pisaba con una lectura. Es un candado aparte de `lock`, que solo cuida el dict `state`.

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


if __name__ == "__main__":
    load_current_flight()
    threading.Thread(target=telemetry_loop, daemon=True).start()
    threading.Thread(target=load_navdata, daemon=True).start()
    if LIVE_AIRWAYS_AVAILABLE:
        threading.Thread(target=live_airways.run, args=(AWY, _pos_actual, DATA_DIR), daemon=True).start()

    # host="0.0.0.0" => accesible desde el celular/iPad en la misma red (no solo localhost)
    app.run(host="0.0.0.0", debug=True, port=5001, use_reloader=False)
