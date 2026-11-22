"""
traffic.py — Tráfico IA alrededor del avión (AIG, FSLTL o el tráfico propio de MSFS).

Por qué existe este archivo
----------------------------
AIG Traffic Controller no dibuja aviones en un mundo propio: los INYECTA dentro de MSFS
como objetos de SimConnect. Así que el mismo tráfico que se ve en el mapa de AIG TC se le
puede pedir directo al simulador con SimConnect_RequestDataOnSimObjectType (todos los
aviones dentro de un radio), sin depender de la API interna de AIG (un servicio WCF sin
documentar en localhost:8733 que podría cambiar en cualquier versión). De paso esto anda
igual con cualquier otro inyector de tráfico.

Por qué es una conexión aparte (y no la de app.py)
---------------------------------------------------
El dispatcher de python-simconnect asocia cada respuesta SIMOBJECT_DATA_BYTYPE a UN objeto
por request id. Esta consulta devuelve un mensaje por avión con el mismo request id, así
que con la librería las respuestas se pisarían entre sí. Igual que live_airways.py, este
módulo abre su propia conexión con ctypes. No toca sim_lock ni el hilo de telemetría:
si algo falla acá, el error queda en STATUS y el resto de la app sigue igual.

Límite de SimConnect: el radio máximo de RequestDataOnSimObjectType es 200 km (~108 NM).
Siempre se pide el máximo y el radio que elige el usuario se aplica después, en
snapshot(): así cambiar el radio en la UI no obliga a esperar la siguiente vuelta.
"""

import ctypes
import math
import os
import re
import threading
import time

from server import aig_fp
from server.geo import _haversine_nm
from server.live_airways import (w, HRESULT, SimConnectDLL, _WINDOWS, _RECV, _RECV_EXCEPTION,
                                 RECV_ID_OPEN, RECV_ID_QUIT, RECV_ID_EXCEPTION)


# ---------------------------------------------------------------------------
# Estado público (lo devuelve /api/traffic junto con los aviones)
# ---------------------------------------------------------------------------
STATUS = {
    "conectado": False,
    "dll_path": None,
    "aviones_en_sim": 0,          # cuántos devolvió la última vuelta (radio máximo, sin filtrar)
    "ultima_lectura": None,
    "ruta_desactivada": False,    # True si el sim rechazó AI TRAFFIC FROM/TOAIRPORT (ver _armar_definicion)
    "en_pausa": False,            # True = nadie pidió /api/traffic hace rato: no se consulta al sim
    "ultimo_error": None,
}

RADIO_MAX_M = 200000                          # tope de SimConnect para pedidos por tipo
RADIO_MAX_NM = RADIO_MAX_M / 1852.0
INTERVALO = 2.0                               # segundos entre pedidos; el frontend interpola entre medio

RECV_ID_SIMOBJECT_DATA_BYTYPE = 9
SIMOBJECT_TYPE_AIRCRAFT = 2
USER_OBJECT_ID = 1                            # en las respuestas BYTYPE el avión propio es el objeto 1
SIMCONNECT_UNUSED = 0xFFFFFFFF

DATATYPE_FLOAT64 = 4
DATATYPE_STRING8 = 5
DATATYPE_STRING32 = 6
DATATYPE_STRING64 = 7
DATATYPE_STRING128 = 8

# (nombre python, SimVar, unidades). Los números van primero y los strings después: el
# struct se arma en este mismo orden y con pack 1, así que el orden ES el layout de bytes.
NUMEROS = [
    ("lat", "PLANE LATITUDE", "degrees"),
    ("lon", "PLANE LONGITUDE", "degrees"),
    ("alt", "PLANE ALTITUDE", "feet"),
    # Con la unidad explícita SimConnect convierte a grados; los radianes "raros" de
    # telemetry_loop vienen de que la librería pide esa SimVar sin unidad.
    ("hdg", "PLANE HEADING DEGREES TRUE", "degrees"),
    ("gs", "GROUND VELOCITY", "knots"),
    ("vs", "VERTICAL SPEED", "feet per minute"),
    ("on_ground", "SIM ON GROUND", "bool"),
    # Para dibujar la misma silueta que el avión propio (ver mePlaneSVG en geo-utils.js)
    ("eng_type", "ENGINE TYPE", "enum"),          # 0 pistón · 1 jet · 3 helicóptero · 5 turbohélice
    ("eng_count", "NUMBER OF ENGINES", "number"),
    # ¿Motor 1 encendido? Un avión en la puerta con motores andando (listo para el pushback)
    # cuenta como "activo" aunque no se mueva. Ver _publicar / MEMORIA_ACTIVO.
    ("eng_on", "GENERAL ENG COMBUSTION:1", "bool"),
]
# (nombre python, SimVar, tipo SimConnect, bytes)
TEXTOS = [
    ("atc_id", "ATC ID", DATATYPE_STRING32, 32),          # matrícula
    ("airline", "ATC AIRLINE", DATATYPE_STRING64, 64),
    ("flight", "ATC FLIGHT NUMBER", DATATYPE_STRING8, 8),
    ("model", "ATC MODEL", DATATYPE_STRING32, 32),
    ("title", "TITLE", DATATYPE_STRING128, 128),
]
# Origen/destino del horario IA. Van aparte porque son las únicas SimVars "de IA" de la
# definición: si algún build del sim las rechaza, se rearma la definición sin ellas en vez
# de perder todo el tráfico (ver _Client.run_round).
TEXTOS_RUTA = [
    ("from", "AI TRAFFIC FROMAIRPORT", DATATYPE_STRING8, 8),
    ("to", "AI TRAFFIC TOAIRPORT", DATATYPE_STRING8, 8),
]


class _RECV_SIMOBJECT_DATA(_RECV):
    _pack_ = 1
    _fields_ = [
        ("dwRequestID", w.DWORD),
        ("dwObjectID", w.DWORD),
        ("dwDefineID", w.DWORD),
        ("dwFlags", w.DWORD),
        ("dwentrynumber", w.DWORD),   # 1..dwoutof
        ("dwoutof", w.DWORD),         # 0 = no hay ningún avión en el radio
        ("dwDefineCount", w.DWORD),
    ]


_lock = threading.Lock()
_aviones = {}        # object id -> dict, reemplazado entero en cada vuelta (nunca mutado)


def _texto(raw):
    s = raw.decode("utf-8", "ignore").split("\x00", 1)[0].strip()
    # Las SimVars de ATC a veces devuelven la clave de traducción en vez del texto
    # ("TT:ATCCOM.AC_MODEL_B738.0.text"): para el modelo se rescata el código, el resto se descarta.
    if s.startswith("TT:"):
        m = re.search(r"AC_MODEL[_ ]?([A-Z0-9]+)", s)
        return m.group(1) if m else ""
    # "$$:" marca un texto literal (no traducible) en el ATC de MSFS: con AIG llega así
    # el modelo ("$$:A320"), y se veía tal cual en la ficha.
    if s.startswith("$$:"):
        s = s[3:].strip()
    return s


# ---------------------------------------------------------------------------
# Ficha: de lo crudo de SimConnect/AIG a lo que muestra la tarjeta del avión
# ---------------------------------------------------------------------------
# AIG pone el CALLSIGN en "ATC ID" (AVA9341), que en MSFS normalmente es la matrícula.
# Con el prefijo ICAO del callsign se saca la aerolínea y el código IATA (AV 9341).
# Solo aerolíneas confirmadas; las que falten se muestran con lo que mande el sim.
AEROLINEAS = {
    "AVA": ("AV", "Avianca"), "TPA": ("QT", "Avianca Cargo"), "LAN": ("LA", "LATAM Airlines"),
    "ARE": ("4C", "LATAM Colombia"), "LPE": ("LP", "LATAM Perú"), "LNE": ("XL", "LATAM Ecuador"),
    "TAM": ("JJ", "LATAM Brasil"), "CMP": ("CM", "Copa Airlines"), "RPB": ("P5", "Wingo"),
    "EFY": ("VE", "EasyFly"), "NSE": ("9R", "SATENA"), "JAT": ("JA", "JetSMART"),
    "SKU": ("H2", "Sky Airline"), "ARG": ("AR", "Aerolíneas Argentinas"), "AMX": ("AM", "Aeroméxico"),
    "VOI": ("Y4", "Volaris"), "VIV": ("VB", "Viva Aerobus"), "GLO": ("G3", "GOL"), "AZU": ("AD", "Azul"),
    "DWI": ("DM", "Arajet"), "AAL": ("AA", "American Airlines"), "UAL": ("UA", "United Airlines"),
    "DAL": ("DL", "Delta Air Lines"), "JBU": ("B6", "JetBlue"), "NKS": ("NK", "Spirit"),
    "SWA": ("WN", "Southwest"), "ASA": ("AS", "Alaska Airlines"), "ACA": ("AC", "Air Canada"),
    "WJA": ("WS", "WestJet"), "IBE": ("IB", "Iberia"), "AEA": ("UX", "Air Europa"),
    "PUE": ("PU", "Plus Ultra"), "AFR": ("AF", "Air France"), "KLM": ("KL", "KLM"),
    "DLH": ("LH", "Lufthansa"), "BAW": ("BA", "British Airways"), "THY": ("TK", "Turkish Airlines"),
    "UAE": ("EK", "Emirates"), "QTR": ("QR", "Qatar Airways"), "FDX": ("FX", "FedEx"), "UPS": ("5X", "UPS"),
}

TIPOS = {
    "A318": "Airbus A318", "A319": "Airbus A319", "A320": "Airbus A320", "A321": "Airbus A321",
    "A19N": "Airbus A319neo", "A20N": "Airbus A320neo", "A21N": "Airbus A321neo",
    "BCS1": "Airbus A220-100", "BCS3": "Airbus A220-300",
    "A332": "Airbus A330-200", "A333": "Airbus A330-300", "A339": "Airbus A330-900neo",
    "A359": "Airbus A350-900", "A35K": "Airbus A350-1000", "A388": "Airbus A380-800",
    "B737": "Boeing 737-700", "B738": "Boeing 737-800", "B739": "Boeing 737-900",
    "B38M": "Boeing 737 MAX 8", "B39M": "Boeing 737 MAX 9", "B752": "Boeing 757-200",
    "B763": "Boeing 767-300", "B772": "Boeing 777-200", "B77L": "Boeing 777-200LR",
    "B77W": "Boeing 777-300ER", "B788": "Boeing 787-8", "B789": "Boeing 787-9", "B78X": "Boeing 787-10",
    "B744": "Boeing 747-400", "B748": "Boeing 747-8", "MD11": "McDonnell Douglas MD-11",
    "E170": "Embraer E170", "E175": "Embraer E175", "E190": "Embraer E190", "E195": "Embraer E195",
    "E290": "Embraer E190-E2", "E295": "Embraer E195-E2",
    "AT43": "ATR 42-300", "AT45": "ATR 42-500", "AT46": "ATR 42-600",
    "AT72": "ATR 72", "AT75": "ATR 72-500", "AT76": "ATR 72-600",
    "DH8D": "De Havilland Dash 8-400", "CRJ2": "Bombardier CRJ200", "CRJ7": "Bombardier CRJ700",
    "CRJ9": "Bombardier CRJ900", "C208": "Cessna 208 Caravan", "B190": "Beechcraft 1900",
}
_TURBOHELICES = ("AT4", "AT7", "DH8", "C208", "B190")

_RE_CALLSIGN = re.compile(r"^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$")
_RE_MATRICULA = re.compile(r"\b([A-Z]{1,2}-[A-Z0-9]{3,7}|N\d{2,5}[A-Z]{0,2})\b")   # 3..7: HP-1849CMP (Copa)
_RE_TIPO_TITULO = re.compile(
    r"(Airbus\s+A\d{3}\S*|Boeing\s+\d{3}\S*|ATR\s*\d{2}\S*|Embraer\s+\S+|Bombardier\s+\S+|"
    r"De\s+Havilland\s+\S+(?:\s+\S+)?|Cessna\s+\S+|A3\d\d(?:neo|-\d{3})?|7[0-8]7(?:-\d+)?|E1[79]\d|CRJ\d+|Q400)",
    re.IGNORECASE)


def _ficha(a):
    """Campos limpios para la UI. No reemplaza los crudos: se agregan al lado."""
    m = _RE_CALLSIGN.match(a["atc_id"])
    if m:
        icao, num, callsign, matricula = m.group(1), m.group(2), a["atc_id"], ""
    else:
        icao, num, callsign, matricula = "", "", "", a["atc_id"]
    if not matricula:
        mm = _RE_MATRICULA.search(a["title"])
        matricula = mm.group(1) if mm else ""
    # Sin callsign (AIG a veces manda la matrícula en ATC ID y el número de vuelo suelto):
    # la aerolínea sale de los flight plans de AIG, ver server/aig_fp.py.
    fp = aig_fp.buscar(matricula, a["flight"]) if not icao and matricula else None
    if fp:
        icao = fp["icao"]
        if fp["vuelo"]:
            num, callsign = fp["vuelo"], fp["icao"] + fp["vuelo"]
    iata, nombre = AEROLINEAS.get(icao, (None, None))
    if fp and not iata:
        # AIG escribe algunas con minúscula ("avianca Express")
        iata, nombre = fp["iata"] or None, (fp["nombre"][:1].upper() + fp["nombre"][1:]) or None
    aerolinea = nombre or a["airline"].title()
    if iata and num:
        vuelo = iata + " " + num
    else:
        vuelo = callsign or ("%s %s" % (a["airline"].title(), a["flight"])).strip()

    codigo = a["model"].upper() if re.fullmatch(r"[A-Z][A-Z0-9]{2,3}", a["model"].upper()) else ""
    tipo = TIPOS.get(codigo)
    if not tipo:
        mt = _RE_TIPO_TITULO.search(a["title"])
        tipo = mt.group(1) if mt else (codigo or a["model"])

    et, n = int(a["eng_type"]), int(a["eng_count"])
    if et == 1:
        forma = "quad" if n >= 4 else "jet"
    elif et == 5 or codigo.startswith(_TURBOHELICES):
        forma = "prop"
    elif et == 3:
        forma = "heli"
    elif et == 0:
        forma = "piston"
    else:
        forma = "jet"

    gs, vs = a["gs"], a["vs"]
    if a["on_ground"]:
        fase = "Estacionado" if gs < 2 else ("Rodando" if gs < 40 else "En pista")
    elif vs > 300:
        fase = "Ascenso"
    elif vs < -300:
        fase = "Descenso"
    else:
        fase = "Crucero" if a["alt"] > 10000 else "Nivelado"

    parado = a["on_ground"] and gs < 2
    # En tierra y sin callsign, el "vuelo" es el que trae su librea (todos los de AIG salían
    # "AVIANCA AV-148", también rodando): ahí la etiqueta y la tarjeta usan la matrícula.
    sin_vuelo = a["on_ground"] and not callsign
    if sin_vuelo:
        vuelo = ""
    return {
        "callsign": callsign, "aerolinea": aerolinea, "aerolinea_icao": icao, "vuelo": vuelo,
        "aerolinea_iata": iata or "",   # el frontend lo usa para el logo (pics.avs.io/<IATA>.png)
        "matricula": matricula, "tipo": tipo, "tipo_codigo": codigo, "forma": forma, "fase": fase,
        # En la puerta el número de vuelo no dice nada (en AIG, los estacionados comparten el
        # de su librea y todos salían "AVIANCA AV-148"): ahí la etiqueta es la matrícula.
        "etiqueta": (matricula or callsign or codigo) if (parado or sin_vuelo) else (callsign or vuelo or matricula),
    }


_apt_idx = {"n": -1, "d": {}}


def _aeropuerto(icao):
    """Nombre/ciudad/posición de un ICAO, desde los aeropuertos de OurAirports ya cargados.
    El índice se rearma solo si la lista cambió (load_navdata corre en paralelo al arrancar)."""
    if not icao:
        return None
    from server.navdata import NAV
    lista = NAV["airports"]
    if _apt_idx["n"] != len(lista):
        _apt_idx["d"] = {x["icao"].upper(): x for x in lista}
        _apt_idx["n"] = len(lista)
    x = _apt_idx["d"].get(icao.upper())
    if not x:
        return {"icao": icao}
    return {"icao": icao, "name": x["name"], "city": x.get("city", ""), "lat": x["lat"], "lon": x["lon"]}




# ---------------------------------------------------------------------------
# DLL: alcanza el que trae python-simconnect (RequestDataOnSimObjectType existe en todas
# las versiones de SimConnect, no hace falta el del SDK como en live_airways.py)
# ---------------------------------------------------------------------------
def _find_dll():
    try:
        import SimConnect as _sc
        p = os.path.join(os.path.dirname(_sc.__file__), "SimConnect.dll")
        if os.path.isfile(p):
            return p
    except Exception:
        pass
    from server.live_airways import find_modern_dll
    from server.core import DATA_DIR
    return find_modern_dll(DATA_DIR)


class _Client:
    DEFINE_ID = 1

    def __init__(self, dll_path):
        self.dll = SimConnectDLL(dll_path)
        self._bind()
        self.h = w.HANDLE()
        self.DispatchProc = ctypes.WINFUNCTYPE(None, ctypes.POINTER(_RECV), w.DWORD, ctypes.c_void_p)
        self._cb = self.DispatchProc(self._on_msg)
        self._open_evt = threading.Event()
        self._round_evt = threading.Event()
        self._quit = False
        self._exc = None
        self._req_id = 0
        self._buf = {}
        self.con_ruta = not STATUS["ruta_desactivada"]

    def _bind(self):
        d = self.dll
        d.SimConnect_Open.restype = HRESULT
        d.SimConnect_Open.argtypes = [ctypes.POINTER(w.HANDLE), w.LPCSTR, w.HWND, w.DWORD, w.HANDLE, w.DWORD]
        d.SimConnect_Close.restype = HRESULT
        d.SimConnect_Close.argtypes = [w.HANDLE]
        d.SimConnect_CallDispatch.restype = HRESULT
        d.SimConnect_CallDispatch.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_void_p]
        d.SimConnect_AddToDataDefinition.restype = HRESULT
        d.SimConnect_AddToDataDefinition.argtypes = [w.HANDLE, w.DWORD, w.LPCSTR, w.LPCSTR,
                                                     w.DWORD, ctypes.c_float, w.DWORD]
        d.SimConnect_ClearDataDefinition.restype = HRESULT
        d.SimConnect_ClearDataDefinition.argtypes = [w.HANDLE, w.DWORD]
        d.SimConnect_RequestDataOnSimObjectType.restype = HRESULT
        d.SimConnect_RequestDataOnSimObjectType.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD, w.DWORD]

    # -- ciclo de vida -------------------------------------------------
    def open(self, timeout=8.0):
        err = self.dll.SimConnect_Open(ctypes.byref(self.h), w.LPCSTR(b"MSFS Live Tracker - Trafico"),
                                        None, 0, 0, 0)
        if err != 0:
            raise ConnectionError("SimConnect_Open devolvió HRESULT=%s" % (err,))
        deadline = time.time() + timeout
        while time.time() < deadline and not self._open_evt.is_set():
            self._pump_once()
            time.sleep(0.02)
        if not self._open_evt.is_set():
            raise ConnectionError("no llegó el mensaje OPEN (¿MSFS no está corriendo?)")

    def close(self):
        try:
            self.dll.SimConnect_Close(self.h)
        except Exception:
            pass

    def _pump_once(self):
        try:
            self.dll.SimConnect_CallDispatch(self.h, self._cb, None)
        except OSError:
            pass

    # -- definición ------------------------------------------------------
    def armar_definicion(self):
        add = self.dll.SimConnect_AddToDataDefinition
        # Solo al rearmar: limpiar una definición que todavía no existe dispara una
        # excepción asíncrona que después se confundiría con un error de la primera vuelta.
        if getattr(self, "Struct", None) is not None:
            self.dll.SimConnect_ClearDataDefinition(self.h, self.DEFINE_ID)
        campos = []
        for attr, simvar, unidad in NUMEROS:
            if add(self.h, self.DEFINE_ID, simvar.encode("ascii"), unidad.encode("ascii"),
                   DATATYPE_FLOAT64, 0.0, SIMCONNECT_UNUSED) != 0:
                raise RuntimeError("el DLL rechazó '%s'" % simvar)
            campos.append((attr, ctypes.c_double))
        for attr, simvar, tipo, n in TEXTOS + (TEXTOS_RUTA if self.con_ruta else []):
            if add(self.h, self.DEFINE_ID, simvar.encode("ascii"), None,
                   tipo, 0.0, SIMCONNECT_UNUSED) != 0:
                raise RuntimeError("el DLL rechazó '%s'" % simvar)
            campos.append((attr, ctypes.c_char * n))
        self.Struct = type("TrafficStruct", (ctypes.Structure,), {"_pack_": 1, "_fields_": campos})

    # -- mensajes ----------------------------------------------------------
    def _on_msg(self, pData, cbData, pContext):
        try:
            dwID = ctypes.cast(pData, ctypes.POINTER(_RECV)).contents.dwID
            if dwID == RECV_ID_OPEN:
                self._open_evt.set()
            elif dwID == RECV_ID_QUIT:
                self._quit = True
            elif dwID == RECV_ID_EXCEPTION:
                exc = ctypes.cast(pData, ctypes.POINTER(_RECV_EXCEPTION)).contents
                self._exc = "excepción SimConnect #%d (índice %d)" % (int(exc.dwException), int(exc.dwIndex))
            elif dwID == RECV_ID_SIMOBJECT_DATA_BYTYPE:
                self._handle_data(pData)
        except Exception as e:
            STATUS["ultimo_error"] = "dispatch: %r" % (e,)

    def _handle_data(self, pData):
        hdr = ctypes.cast(pData, ctypes.POINTER(_RECV_SIMOBJECT_DATA)).contents
        if hdr.dwRequestID != self._req_id:
            return            # respuesta atrasada de una vuelta anterior
        if hdr.dwoutof == 0:
            self._round_evt.set()
            return
        if hdr.dwObjectID != USER_OBJECT_ID:
            addr = ctypes.addressof(hdr) + ctypes.sizeof(_RECV_SIMOBJECT_DATA)
            d = ctypes.cast(addr, ctypes.POINTER(self.Struct)).contents
            a = {"id": int(hdr.dwObjectID)}
            for attr, _ in d._fields_:
                v = getattr(d, attr)
                a[attr] = _texto(v) if isinstance(v, bytes) else float(v)
            a["on_ground"] = a["on_ground"] >= 0.5
            self._buf[a["id"]] = a
        if hdr.dwentrynumber >= hdr.dwoutof:
            self._round_evt.set()

    # -- una vuelta: pedir todos los aviones y esperar a que lleguen ------
    def run_round(self, radio_m=RADIO_MAX_M, timeout=1.5):
        self._req_id = self._req_id % 1000000 + 1
        self._buf = {}
        self._exc = None
        self._round_evt.clear()
        hr = self.dll.SimConnect_RequestDataOnSimObjectType(
            self.h, self._req_id, self.DEFINE_ID, int(radio_m), SIMOBJECT_TYPE_AIRCRAFT)
        if hr != 0:
            raise ConnectionError("RequestDataOnSimObjectType devolvió HRESULT=%s" % (hr,))
        deadline = time.time() + timeout
        while time.time() < deadline and not self._round_evt.is_set() and not self._quit:
            self._pump_once()
            time.sleep(0.01)
        if self._exc and not self._round_evt.is_set() and self.con_ruta:
            # Lo único "dudoso" de la definición son las SimVars de horario IA: sin ellas
            # se pierde el origen/destino en el popup, pero no el tráfico.
            STATUS["ruta_desactivada"] = True
            STATUS["ultimo_error"] = self._exc + " — se reintenta sin origen/destino"
            self.con_ruta = False
            self.armar_definicion()
            return None
        if self._exc:
            STATUS["ultimo_error"] = self._exc
        return self._buf if self._round_evt.is_set() else None


# "Activo" = lo que mostraría un radar de verdad: en el aire, moviéndose (rodaje, pushback)
# o con motores encendidos. Un estacionado apagado no transmite nada en la vida real, y con
# AIG en un hub son la mayoría: por defecto el mapa los esconde (botón "P" para verlos).
# MEMORIA_ACTIVO: quien estuvo activo sigue visible un rato aunque se detenga y apague (p. ej.
# esperando en el punto de espera, o recién llegado a la puerta) para que no parpadee.
MEMORIA_ACTIVO = 180
_ultimo_activo = {}     # object id -> time.time() de la última vez que se lo vio activo


def _publicar(aviones):
    global _aviones
    ahora = time.time()
    for a in aviones.values():
        try:
            a.update(_ficha(a))
        except Exception as e:      # un avión con datos raros no tumba la vuelta entera
            STATUS["ultimo_error"] = "ficha: %r" % (e,)
            a.setdefault("etiqueta", a.get("atc_id", ""))
            a.setdefault("forma", "jet")
        if not a.get("on_ground") or a.get("gs", 0) >= 2 or a.get("eng_on", 0) >= 0.5:
            _ultimo_activo[a["id"]] = ahora
        a["activo"] = ahora - _ultimo_activo.get(a["id"], -1e9) < MEMORIA_ACTIVO
    # Los ids que SimConnect ya no informa (el avión se borró) se olvidan al rato: sin esto el
    # dict crecería toda la sesión. No se borra en la vuelta vacía de una pausa: así al volver
    # se conserva la memoria de quién estaba activo.
    for oid in [k for k, t in _ultimo_activo.items() if ahora - t > 2 * MEMORIA_ACTIVO]:
        del _ultimo_activo[oid]
    with _lock:
        _aviones = aviones
    STATUS["aviones_en_sim"] = len(aviones)
    STATUS["ultima_lectura"] = time.time()


# Quién está mirando: lo actualiza snapshot() (o sea, cada GET /api/traffic del navegador).
# run() lo usa para no pedirle NADA al sim si no hay nadie mirando, y para pedir solo el
# radio que la UI necesita: en un hub de AIG hay cientos de objetos en 200 km, y cada uno es
# trabajo extra para MSFS en cada vuelta aunque después se descarte.
_demanda = {"t": 0.0, "radio_nm": 60.0}
SIN_PUBLICO = 15        # s sin pedidos => pausa (pestaña cerrada o toggle "Tráfico IA" apagado)
MARGEN_NM = 5           # algo más que el radio de la UI, para que no "aparezcan" en el borde


def snapshot(lat, lon, radio_nm, limite=400):
    """Aviones dentro de `radio_nm` del punto (lat, lon), del más cercano al más lejano.
    El radio se recorta a RADIO_MAX_NM: más allá de eso SimConnect no informa nada."""
    _demanda["t"] = time.time()
    _demanda["radio_nm"] = radio_nm
    if lat is None or lon is None:
        return []
    radio_nm = min(radio_nm, RADIO_MAX_NM)
    with _lock:
        aviones = list(_aviones.values())
    out = []
    for a in aviones:
        d = _haversine_nm(lat, lon, a["lat"], a["lon"])
        if d <= radio_nm:
            b = dict(a)
            b["dist_nm"] = round(d, 1)
            out.append(b)
    out.sort(key=lambda a: a["dist_nm"])
    out = out[:limite]
    for b in out:
        b["origen"] = _aeropuerto(b.get("from"))
        b["destino"] = _aeropuerto(b.get("to"))
        o, d = b["origen"], b["destino"]
        if o and d and "lat" in o and "lat" in d and not (b["on_ground"] and b["gs"] < 2):
            hecho = _haversine_nm(o["lat"], o["lon"], b["lat"], b["lon"])
            falta = _haversine_nm(b["lat"], b["lon"], d["lat"], d["lon"])
            b["progreso"] = round(hecho / (hecho + falta), 3) if hecho + falta > 0 else None
            b["falta_nm"] = round(falta, 1)
    return out


def run(get_pos):
    """Hilo principal (target de threading.Thread, igual que live_airways.run). Se queda
    reintentando para siempre: MSFS puede abrirse después que la app, o cerrarse a mitad."""
    if not _WINDOWS:
        STATUS["ultimo_error"] = "no es Windows: esta función solo existe con MSFS"
        return
    while True:
        dll_path = STATUS["dll_path"] or _find_dll()
        if not dll_path:
            STATUS["ultimo_error"] = "no se encontró SimConnect.dll"
            time.sleep(60)
            continue
        STATUS["dll_path"] = dll_path

        client = None
        try:
            client = _Client(dll_path)
            client.open()
            client.armar_definicion()
            STATUS["conectado"] = True
            STATUS["ultimo_error"] = None
            while not client._quit:
                t0 = time.time()
                lat, _lon = get_pos()
                if time.time() - _demanda["t"] > SIN_PUBLICO:
                    # Nadie mirando: cero pedidos al sim. Se sigue bombeando el dispatch para
                    # enterarse si MSFS se cierra (mensaje QUIT) mientras tanto.
                    STATUS["en_pausa"] = True
                    if _aviones:
                        _publicar({})
                    client._pump_once()
                    time.sleep(1)
                    continue
                STATUS["en_pausa"] = False
                if lat is None:
                    # Menú principal / pantalla de carga: no hay tráfico que pedir.
                    _publicar({})
                else:
                    radio_m = min(RADIO_MAX_M, max(5.0, _demanda["radio_nm"] + MARGEN_NM) * 1852)
                    aviones = client.run_round(radio_m)
                    if aviones is not None:
                        _publicar(aviones)
                time.sleep(max(0.2, INTERVALO - (time.time() - t0)))
        except Exception as e:
            STATUS["ultimo_error"] = str(e) or repr(e)
        finally:
            STATUS["conectado"] = False
            _publicar({})
            if client is not None:
                client.close()
        time.sleep(10)


# ---------------------------------------------------------------------------
# Modo --debug: tráfico de mentira alrededor del avión, para probar la capa sin MSFS
# ---------------------------------------------------------------------------
# Imita el formato REAL que manda AIG (visto con MSFS): callsign en ATC ID, aerolínea
# vacía, modelo con "$$:" y la matrícula solo dentro del título. Así _ficha() se prueba
# con lo mismo que va a recibir de verdad.
_DEBUG_FLOTA = [
    # (callsign, vuelo, modelo, título, motores (tipo, n), radio NM, alt ft, kt, sentido, desde, hacia)
    ("AVA9341", "9341", "$$:A320", "AIG Airbus A320-200 CFM Avianca N724AV", (1, 2), 6, 4500, 180, 1, "SKRG", "SKBO"),
    ("ARE4041", "4041", "$$:A320", "AIG Airbus A320-200 LATAM Colombia CC-BAZ", (1, 2), 14, 11000, 250, -1, "SKBO", "SKRG"),
    ("CMP182", "182", "$$:B738", "AIG Boeing 737-800 Copa Airlines HP-1849CMP", (1, 2), 28, 23000, 380, 1, "MPTO", "SKRG"),
    ("AVA52", "52", "$$:B788", "AIG Boeing 787-8 Avianca N792AV", (1, 2), 45, 37000, 470, -1, "SKBO", "KMIA"),
    ("RPB7221", "7221", "$$:B738", "AIG Boeing 737-800 Wingo HP-1373", (1, 2), 70, 35000, 450, 1, "SKRG", "SKSP"),
    ("AAL921", "921", "$$:B738", "AIG Boeing 737-800 American Airlines N905NN", (1, 2), 95, 39000, 460, -1, "KMIA", "SKBO"),
    ("NSE8402", "8402", "$$:AT76", "AIG ATR 72-600 SATENA HK-5320", (5, 2), 20, 15000, 260, 1, "SKRG", "SKUI"),
    ("EFY9156", "9156", "$$:42", "AIG ATR 42-500 EasyFly HK-4842", (5, 2), 35, 14000, 200, -1, "SKMD", "SKIB"),
]


def run_debug(get_pos):
    """Reemplazo de run() para --debug: aviones dando vueltas en círculos alrededor de la
    posición del avión propio, a distintas distancias (para probar el radio) y dos
    estacionados en la pista (para probar el estilo "en tierra")."""
    STATUS["conectado"] = True
    STATUS["dll_path"] = "DEBUG"
    t0 = time.time()
    while True:
        lat, lon = get_pos()
        if lat is None:
            time.sleep(1)
            continue
        t = time.time() - t0
        aviones = {}
        for i, (cs, flight, model, title, (et, ne), r_nm, alt, kt, sentido, de, a) in enumerate(_DEBUG_FLOTA):
            # velocidad angular = v/r; el rumbo es tangente al círculo
            ang = (i * 51 + sentido * math.degrees(kt * t / 3600.0 / r_nm)) % 360
            dlat = r_nm / 60.0 * math.cos(math.radians(ang))
            dlon = r_nm / 60.0 * math.sin(math.radians(ang)) / max(0.2, math.cos(math.radians(lat)))
            hdg = (ang + 90 * sentido) % 360
            vs = 1800.0 if i % 3 == 0 else (-1200.0 if i % 3 == 1 else 0.0)
            aviones[100 + i] = {"id": 100 + i, "lat": lat + dlat, "lon": lon + dlon, "alt": float(alt),
                                "hdg": hdg, "gs": float(kt), "vs": vs, "on_ground": False,
                                "eng_type": float(et), "eng_count": float(ne), "eng_on": 1.0,
                                "atc_id": cs, "airline": "", "flight": flight,
                                "model": _texto(model.encode()),   # mismo camino que lo real

                                "title": title, "from": de, "to": a}
        # En tierra, como los manda AIG (matrícula en ATC ID, datos de ATC de la librea). Los
        # tres casos del filtro "activo": apagado en la puerta (oculto por defecto), en la
        # puerta con motores encendidos (visible) y rodando (visible).
        en_tierra = [("HK-5274", "A20N", 0.0, 0.0), ("N781AV", "A319", 0.0, 0.0),
                     ("HK-5368", "A320", 1.0, 0.0), ("N537AV", "A20N", 1.0, 14.0)]
        for j, (reg, model, motor, kt) in enumerate(en_tierra):
            aviones[200 + j] = {"id": 200 + j, "lat": lat + 0.004 * (j + 1), "lon": lon + 0.003,
                                "alt": 0.0, "hdg": 90.0, "gs": kt, "vs": 0.0, "on_ground": True,
                                "eng_type": 1.0, "eng_count": 2.0, "eng_on": motor,
                                "atc_id": reg, "airline": "AVIANCA", "flight": "AV-148", "model": model,
                                "title": "AIG Airbus " + model + " Avianca " + reg, "from": "", "to": ""}
        _publicar(aviones)
        time.sleep(INTERVALO)
