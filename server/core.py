"""Estado compartido del backend: rutas de archivos y los objetos que todos los modulos leen.

Vive aparte de app.py para que los modulos de server/ puedan usarlo sin importar app.py
(lo que crearia un import circular: app.py importa server/, server/ importaria app.py).

IMPORTANTE — lo que puede vivir aca y lo que no:

  SI  : contenedores que se mutan IN SITU (dict, list, Lock) y constantes. `state["lat"]=x`
        o `route.append(...)` desde cualquier modulo afecta al mismo objeto, porque todos
        tienen la misma referencia.

  NO  : variables que se REASIGNAN con `global` (sim_aq, prev_sim_clock, fue_al_aire, ...).
        Esas siguen en app.py a proposito. Un `global sim_aq` dentro de un modulo distinto
        rebindea el nombre en ESE modulo, no aca, asi que el resto del programa seguiria
        viendo el valor viejo (None) para siempre — un bug silencioso, sin error ni traza.
        Por eso las 11 funciones que tocan ese estado (telemetry_loop, teleport_aircraft,
        set_autopilot, set_aircraft, set_sim_time, trigger_event, api_gear, _gear_down,
        _engines_idle, _revisar_fin_de_vuelo, api_reset) quedan juntas en app.py.
"""
import os
import threading

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
