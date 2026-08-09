"""
live_airways.py — Aerovías en vivo vía la Facility Data API de SimConnect.

Por qué existe este archivo
----------------------------
El archivo estático que usamos hasta ahora (earth_awy.dat, ciclo 2012) no cambia nunca.
Herramientas como Little Navmap sí muestran aerovías al día porque leen la navdata que
MSFS tiene cargada en ese momento (la que trae el sim + lo que haya instalado el usuario,
por ejemplo un ciclo de Navigraph). Ese dato "en vivo" también se puede pedir por
SimConnect, con una API más nueva (Facility Data) que la que usa `python-simconnect`.

El problema confirmado: el SimConnect.dll que trae la librería (python-simconnect) es
viejo y NO exporta las funciones que hacen falta (SimConnect_AddToFacilityDefinition,
SimConnect_RequestFacilityData_EX1). Lo confirmamos buscando esos nombres dentro del
propio archivo .dll: no están. Por eso este módulo abre una SEGUNDA conexión a
SimConnect, totalmente independiente de la que ya usa app.py, cargando un DLL más
moderno que el usuario tiene que tener en su máquina (por ejemplo instalando el MSFS SDK,
que es gratis). Ver find_modern_dll() más abajo para cómo se busca ese DLL.

Si no se encuentra un DLL moderno, o MSFS no está corriendo, este módulo no hace nada
y la app sigue funcionando exactamente como antes (con el archivo estático). Nunca debería
poder romper el resto de la aplicación: cualquier error se guarda en STATUS y se ignora.

Qué tan probado está esto
--------------------------
Los valores numéricos del enum SIMCONNECT_RECV_ID y las firmas de las funciones están
sacados de la documentación oficial de Microsoft (docs.flightsimulator.com). El único
punto document ado como ambiguo es el nombre real del campo de latitud/longitud del punto
ANTERIOR dentro de un ROUTE (la tabla de Microsoft repite "NEXT_LATITUDE"/"NEXT_LONGITUDE"
donde debería decir "PREV_LATITUDE"/"PREV_LONGITUDE" — ver _build_definition() abajo,
que prueba un nombre y si falla reintenta con el otro). El resto del parseo (offsets de
bytes, structs) está armado a mano siguiendo la documentación pero **no pudo probarse
contra un MSFS real** porque este entorno no tiene Windows ni el simulador. Por diseño,
cualquier fallo de parseo queda registrado en STATUS y esa aerovía en particular
simplemente no se agrega — nunca debería tumbar el hilo ni la app.
"""

import ctypes
import math
import os
import threading
import time

try:
    SimConnectDLL = ctypes.WinDLL
    _WINDOWS = True
except AttributeError:
    SimConnectDLL = None
    _WINDOWS = False


# DWORD de Windows es SIEMPRE de 32 bits (el modelo LLP64 de Windows define "unsigned
# long" como 4 bytes incluso en 64 bits). ctypes.wintypes.DWORD es un alias de c_ulong,
# cuyo tamaño en realidad sigue el "unsigned long" de la plataforma donde corre Python:
# en Windows da 4 bytes (coincide), pero en Linux (LP64) "unsigned long" son 8 bytes.
# Como este archivo se probó en un sandbox Linux antes de poder probarlo en Windows, se
# usan tipos de ancho explícito acá en vez de ctypes.wintypes, para que el tamaño de los
# structs sea el mismo (y verificable) en cualquier plataforma.
DWORD = ctypes.c_uint32
HANDLE = ctypes.c_void_p
HWND = ctypes.c_void_p
LPCSTR = ctypes.c_char_p
HRESULT = ctypes.c_long   # HRESULT es un entero de 32 bits con signo en la API de Windows


class _w:
    """Espacio de nombres mínimo, mismo rol que ctypes.wintypes pero con anchos fijos."""
    DWORD = DWORD
    HANDLE = HANDLE
    HWND = HWND
    LPCSTR = LPCSTR


w = _w


# ---------------------------------------------------------------------------
# Estado público (para poder mostrarlo en un endpoint de diagnóstico)
# ---------------------------------------------------------------------------
STATUS = {
    "windows": _WINDOWS,
    "dll_encontrado": False,
    "dll_path": None,
    "candidatos_descartados": [],
    "conectado": False,
    "definicion_lista": False,
    "prev_lat_lon_campo": None,   # qué nombre de campo terminó funcionando (ver _build_definition)
    "waypoints_pedidos": 0,
    "waypoints_resueltos": 0,
    "aristas_vivas": 0,
    "ultima_lista_candidatos": None,   # cuántos waypoints devolvió la última RequestFacilitiesList
    "ultima_lista_cercanos": None,     # cuántos de esos quedaron dentro del radio de búsqueda
    "ultimo_error": None,
    "ultima_actualizacion": None,
}


# ---------------------------------------------------------------------------
# Constantes SimConnect (sacadas de la documentación oficial del SDK)
# ---------------------------------------------------------------------------
RECV_ID_EXCEPTION = 1
RECV_ID_OPEN = 2
RECV_ID_QUIT = 3
RECV_ID_WAYPOINT_LIST = 21
RECV_ID_FACILITY_DATA = 29
RECV_ID_FACILITY_DATA_END = 30

FACILITY_LIST_TYPE_WAYPOINT = 1

FACILITY_DATA_TYPE_WAYPOINT = 21
FACILITY_DATA_TYPE_ROUTE = 22


# ---------------------------------------------------------------------------
# Structs (todas empaquetadas a 1 byte: así es como Microsoft define estas
# estructuras en el header oficial — #pragma pack(push, 1))
# ---------------------------------------------------------------------------
class _RECV(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("dwSize", w.DWORD), ("dwVersion", w.DWORD), ("dwID", w.DWORD)]


class _RECV_EXCEPTION(_RECV):
    _pack_ = 1
    _fields_ = [("dwException", w.DWORD), ("dwSendID", w.DWORD), ("dwIndex", w.DWORD)]


class _RECV_FACILITIES_LIST(_RECV):
    _pack_ = 1
    _fields_ = [
        ("dwRequestID", w.DWORD),
        ("dwArraySize", w.DWORD),
        ("dwEntryNumber", w.DWORD),
        ("dwOutOf", w.DWORD),
    ]


class _FACILITY_WAYPOINT_ITEM(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("Icao", ctypes.c_char * 9),
        ("Latitude", ctypes.c_double),
        ("Longitude", ctypes.c_double),
        ("Altitude", ctypes.c_double),
        ("fMagVar", ctypes.c_float),
    ]


class _RECV_FACILITY_DATA(_RECV):
    _pack_ = 1
    _fields_ = [
        ("UserRequestId", w.DWORD),
        ("UniqueRequestId", w.DWORD),
        ("ParentUniqueRequestId", w.DWORD),
        ("Type", w.DWORD),
        ("IsListItem", ctypes.c_bool),
        ("ItemIndex", w.DWORD),
        ("ListSize", w.DWORD),
    ]


# Campos de la definición WAYPOINT (padre) y ROUTE (hijo), en el orden exacto en que
# se los vamos a pedir al DLL con AddToFacilityDefinition. El nombre python (primer
# elemento) es el que usamos nosotros para leerlo; el nombre del medio es el string
# literal que hay que mandarle al DLL; el tipo ctypes define cuántos bytes ocupa.
WAYPOINT_SCHEMA = [
    ("lat", "LATITUDE", ctypes.c_double),
    ("lon", "LONGITUDE", ctypes.c_double),
    ("alt", "ALTITUDE", ctypes.c_double),
    ("wtype", "TYPE", ctypes.c_int32),
    ("magvar", "MAGVAR", ctypes.c_float),
    ("n_routes", "N_ROUTES", ctypes.c_int32),
    ("icao", "ICAO", ctypes.c_char * 8),
    ("region", "REGION", ctypes.c_char * 8),
    ("terminal", "IS_TERMINAL_WPT", ctypes.c_int32),
]

# El par (prev_lat, prev_lon) es el campo ambiguo: probamos "PREV_LATITUDE"/"PREV_LONGITUDE"
# primero (lo lógico) y si el DLL lo rechaza, reintentamos con "NEXT_LATITUDE"/"NEXT_LONGITUDE"
# en esa misma posición (que es lo que literalmente aparece en la tabla de Microsoft, aunque
# repetido). Da igual cuál de los dos nombres termine aceptando el DLL: el struct que
# arma _build_definition() queda con el mismo tamaño y en la misma posición, así que el
# parseo de bytes no cambia.
ROUTE_SCHEMA = [
    ("name", "NAME", ctypes.c_char * 32),
    ("rtype", "TYPE", ctypes.c_int32),
    ("next_icao", "NEXT_ICAO", ctypes.c_char * 8),
    ("next_region", "NEXT_REGION", ctypes.c_char * 8),
    ("next_type", "NEXT_TYPE", ctypes.c_int32),
    ("next_lat", "NEXT_LATITUDE", ctypes.c_double),
    ("next_lon", "NEXT_LONGITUDE", ctypes.c_double),
    ("next_alt", "NEXT_ALTITUDE", ctypes.c_float),
    ("prev_icao", "PREV_ICAO", ctypes.c_char * 8),
    ("prev_region", "PREV_REGION", ctypes.c_char * 8),
    ("prev_type", "PREV_TYPE", ctypes.c_int32),
    ("prev_lat", "PREV_LATITUDE", ctypes.c_double),   # <- campo ambiguo, ver arriba
    ("prev_lon", "PREV_LONGITUDE", ctypes.c_double),  # <- campo ambiguo, ver arriba
    ("prev_alt", "PREV_ALTITUDE", ctypes.c_float),
]


def _haversine_nm(lat1, lon1, lat2, lon2):
    R_NM = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(a))


def _awy_key(ident, lat, lon):
    return "%s@%.2f,%.2f" % (ident, lat, lon)


# ---------------------------------------------------------------------------
# Búsqueda del DLL moderno
# ---------------------------------------------------------------------------
def _dll_guesses():
    out = []
    for var in ("MSFS_SDK", "MSFS2024_SDK", "MSFS2020_SDK"):
        base = os.environ.get(var)
        if base:
            out.append(os.path.join(base, "SimConnect SDK", "lib", "SimConnect.dll"))
    for drive in ("C:\\", "D:\\", "E:\\"):
        for folder in ("MSFS SDK", "MSFS 2024 SDK", "MSFS2020 SDK"):
            out.append(os.path.join(drive, folder, "SimConnect SDK", "lib", "SimConnect.dll"))
    pf = os.environ.get("ProgramFiles", "C:\\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    out.append(os.path.join(pf, "MSFS SDK", "SimConnect SDK", "lib", "SimConnect.dll"))
    out.append(os.path.join(pf86, "Microsoft Flight Simulator SDK", "SimConnect SDK", "lib", "SimConnect.dll"))
    return out


def _validar_dll(path):
    """Carga el DLL candidato y confirma que exporta lo que necesitamos. No deja nada
    conectado: solo lo carga, mira, y listo (Windows permite tener el mismo DLL cargado
    más de una vez en el proceso sin problema)."""
    try:
        dll = SimConnectDLL(path)
    except Exception as e:
        return False, "no se pudo cargar: %r" % (e,)
    try:
        _ = dll.SimConnect_AddToFacilityDefinition
        _ = dll.SimConnect_RequestFacilityData_EX1
    except AttributeError:
        return False, "este DLL no tiene las funciones de datos de instalaciones (es una versión vieja)"
    return True, ""


def find_modern_dll(data_dir):
    """Primero mira data/simconnect_dll_path.txt (una línea con la ruta completa al
    SimConnect.dll moderno — la forma confiable de indicarlo), y si no está, prueba
    ubicaciones habituales del MSFS SDK. Ver README para instrucciones de instalación."""
    hint_file = os.path.join(data_dir, "simconnect_dll_path.txt")
    cands = []
    if os.path.exists(hint_file):
        try:
            with open(hint_file, "r", encoding="utf-8") as f:
                p = f.read().strip()
            if p:
                cands.append(p)
        except Exception:
            pass
    cands += _dll_guesses()
    for p in cands:
        if not p or not os.path.isfile(p):
            continue
        ok, why = _validar_dll(p)
        if ok:
            return p
        STATUS["candidatos_descartados"].append({"ruta": p, "motivo": why})
    return None


# ---------------------------------------------------------------------------
# Cliente SimConnect (segunda conexión, independiente de la de app.py)
# ---------------------------------------------------------------------------
class _Client:
    def __init__(self, dll_path):
        self.dll = SimConnectDLL(dll_path)
        self._bind()
        self.h = w.HANDLE()
        self.DispatchProc = ctypes.WINFUNCTYPE(None, ctypes.POINTER(_RECV), w.DWORD, ctypes.c_void_p)
        self._cb = self.DispatchProc(self._on_msg)
        self._open_evt = threading.Event()
        self._req_done_evt = threading.Event()
        self._quit = False
        self._current_wp = None      # waypoint que se está armando con los mensajes que van llegando
        self._wp_list_buf = []       # candidatos ICAO recolectados de RequestFacilitiesList
        self._on_waypoint_resolved = None   # callback(icao, lat, lon, routes) — lo setea run()

    def _bind(self):
        d = self.dll
        d.SimConnect_Open.restype = HRESULT
        d.SimConnect_Open.argtypes = [ctypes.POINTER(w.HANDLE), w.LPCSTR, w.HWND, w.DWORD, w.HANDLE, w.DWORD]
        d.SimConnect_Close.restype = HRESULT
        d.SimConnect_Close.argtypes = [w.HANDLE]
        d.SimConnect_CallDispatch.restype = HRESULT
        d.SimConnect_CallDispatch.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_void_p]
        d.SimConnect_AddToFacilityDefinition.restype = HRESULT
        d.SimConnect_AddToFacilityDefinition.argtypes = [w.HANDLE, w.DWORD, w.LPCSTR]
        d.SimConnect_RequestFacilityData_EX1.restype = HRESULT
        d.SimConnect_RequestFacilityData_EX1.argtypes = [
            w.HANDLE, w.DWORD, w.DWORD, w.LPCSTR, w.LPCSTR, ctypes.c_char,
        ]
        d.SimConnect_SubscribeToFacilities.restype = HRESULT
        d.SimConnect_SubscribeToFacilities.argtypes = [w.HANDLE, w.DWORD, w.DWORD]
        d.SimConnect_RequestFacilitiesList.restype = HRESULT
        d.SimConnect_RequestFacilitiesList.argtypes = [w.HANDLE, w.DWORD, w.DWORD]

    # -- ciclo de vida -------------------------------------------------
    def open(self, timeout=8.0):
        self._open_evt.clear()
        err = self.dll.SimConnect_Open(ctypes.byref(self.h), w.LPCSTR(b"MSFS Live Tracker - Aerovias"),
                                        None, 0, 0, 0)
        if err != 0:
            raise ConnectionError("SimConnect_Open devolvió HRESULT=%s" % (err,))
        # el mensaje OPEN llega por el dispatch, no como respuesta directa de la llamada
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

    def pump_until(self, evt, timeout):
        evt.clear()
        deadline = time.time() + timeout
        while time.time() < deadline:
            self._pump_once()
            if evt.is_set():
                return True
            time.sleep(0.02)
        return False

    # -- manejo de mensajes ---------------------------------------------
    def _on_msg(self, pData, cbData, pContext):
        try:
            base = ctypes.cast(pData, ctypes.POINTER(_RECV)).contents
            dwID = base.dwID
            if dwID == RECV_ID_OPEN:
                self._open_evt.set()
            elif dwID == RECV_ID_QUIT:
                self._quit = True
            elif dwID == RECV_ID_EXCEPTION:
                exc = ctypes.cast(pData, ctypes.POINTER(_RECV_EXCEPTION)).contents
                STATUS["ultimo_error"] = "excepción SimConnect #%d" % (int(exc.dwException),)
                self._req_done_evt.set()
            elif dwID == RECV_ID_WAYPOINT_LIST:
                self._handle_waypoint_list(pData)
            elif dwID == RECV_ID_FACILITY_DATA:
                self._handle_facility_data(pData)
            elif dwID == RECV_ID_FACILITY_DATA_END:
                self._req_done_evt.set()
        except Exception as e:
            STATUS["ultimo_error"] = "dispatch: %r" % (e,)

    def _handle_waypoint_list(self, pData):
        hdr = ctypes.cast(pData, ctypes.POINTER(_RECV_FACILITIES_LIST)).contents
        base_addr = ctypes.addressof(hdr) + ctypes.sizeof(_RECV_FACILITIES_LIST)
        item_size = ctypes.sizeof(_FACILITY_WAYPOINT_ITEM)
        for i in range(hdr.dwArraySize):
            item = ctypes.cast(base_addr + i * item_size, ctypes.POINTER(_FACILITY_WAYPOINT_ITEM)).contents
            icao = item.Icao.decode("ascii", "ignore").strip("\x00").strip()
            if icao:
                self._wp_list_buf.append((icao, float(item.Latitude), float(item.Longitude)))

    def _handle_facility_data(self, pData):
        hdr = ctypes.cast(pData, ctypes.POINTER(_RECV_FACILITY_DATA)).contents
        data_addr = ctypes.addressof(hdr) + ctypes.sizeof(_RECV_FACILITY_DATA)
        if hdr.Type == FACILITY_DATA_TYPE_WAYPOINT:
            wp = ctypes.cast(data_addr, ctypes.POINTER(self.WaypointStruct)).contents
            self._current_wp = {
                "icao": wp.icao.decode("ascii", "ignore").strip("\x00").strip(),
                "lat": float(wp.lat), "lon": float(wp.lon), "routes": [],
            }
        elif hdr.Type == FACILITY_DATA_TYPE_ROUTE and self._current_wp is not None:
            rt = ctypes.cast(data_addr, ctypes.POINTER(self.RouteStruct)).contents
            name = rt.name.decode("ascii", "ignore").strip("\x00").strip() or "DCT"
            next_icao = rt.next_icao.decode("ascii", "ignore").strip("\x00").strip()
            prev_icao = rt.prev_icao.decode("ascii", "ignore").strip("\x00").strip()
            if next_icao:
                self._current_wp["routes"].append((next_icao, float(rt.next_lat), float(rt.next_lon), name))
            if prev_icao:
                self._current_wp["routes"].append((prev_icao, float(rt.prev_lat), float(rt.prev_lon), name))

    # -- construcción de la definición (con reintento del campo ambiguo) --
    def build_definition(self, define_id=1):
        add = self.dll.SimConnect_AddToFacilityDefinition

        def put(nombre):
            hr = add(self.h, define_id, w.LPCSTR(nombre.encode("ascii")))
            return hr == 0

        if not put("OPEN WAYPOINT"):
            raise RuntimeError("el DLL rechazó 'OPEN WAYPOINT'")
        for _, campo, _ in WAYPOINT_SCHEMA:
            if not put(campo):
                raise RuntimeError("el DLL rechazó el campo WAYPOINT '%s'" % campo)

        if not put("OPEN ROUTE"):
            raise RuntimeError("el DLL rechazó 'OPEN ROUTE'")
        prev_field_used = "PREV_LATITUDE/PREV_LONGITUDE"
        for attr, campo, _ in ROUTE_SCHEMA:
            if attr in ("prev_lat", "prev_lon"):
                if not put(campo):
                    # la tabla de Microsoft tiene un típo acá (ver docstring del módulo):
                    # reintentamos con el nombre que literalmente aparece en la doc.
                    alt = "NEXT_LATITUDE" if attr == "prev_lat" else "NEXT_LONGITUDE"
                    if not put(alt):
                        raise RuntimeError("el DLL rechazó tanto '%s' como '%s'" % (campo, alt))
                    prev_field_used = "NEXT_LATITUDE/NEXT_LONGITUDE (fallback)"
            else:
                if not put(campo):
                    raise RuntimeError("el DLL rechazó el campo ROUTE '%s'" % campo)
        if not put("CLOSE ROUTE"):
            raise RuntimeError("el DLL rechazó 'CLOSE ROUTE'")
        if not put("CLOSE WAYPOINT"):
            raise RuntimeError("el DLL rechazó 'CLOSE WAYPOINT'")

        STATUS["prev_lat_lon_campo"] = prev_field_used

        self.WaypointStruct = type(
            "WaypointStruct", (ctypes.Structure,),
            {"_pack_": 1, "_fields_": [(attr, tipo) for attr, _, tipo in WAYPOINT_SCHEMA]},
        )
        self.RouteStruct = type(
            "RouteStruct", (ctypes.Structure,),
            {"_pack_": 1, "_fields_": [(attr, tipo) for attr, _, tipo in ROUTE_SCHEMA]},
        )
        self.define_id = define_id

    # -- pedidos ----------------------------------------------------------
    def refresh_nearby_waypoints(self, timeout=3.0):
        """Pide la lista de waypoints que MSFS tiene cargados cerca de la vista actual
        (que sigue al avión). Devuelve una lista de (icao, lat, lon)."""
        self._wp_list_buf = []
        req_id = 900001
        self.dll.SimConnect_SubscribeToFacilities(self.h, FACILITY_LIST_TYPE_WAYPOINT, req_id)
        self.dll.SimConnect_RequestFacilitiesList(self.h, FACILITY_LIST_TYPE_WAYPOINT, req_id)
        deadline = time.time() + timeout
        while time.time() < deadline:
            self._pump_once()
            time.sleep(0.02)
        return list(self._wp_list_buf)

    def request_waypoint(self, icao, request_id, timeout=4.0):
        """Pide el detalle (posición + aerovías) de un ICAO puntual. Serializado: solo
        hay un pedido en vuelo a la vez, así no hace falta llevar la cuenta de a qué
        pedido pertenece cada mensaje que va llegando (todo lo que llega entre el pedido
        y su FACILITY_DATA_END es de este ICAO)."""
        self._current_wp = None
        hr = self.dll.SimConnect_RequestFacilityData_EX1(
            self.h, self.define_id, request_id,
            w.LPCSTR(icao.encode("ascii")), w.LPCSTR(b""), ctypes.c_char(b"W"),
        )
        if hr != 0:
            return None
        self.pump_until(self._req_done_evt, timeout)
        return self._current_wp


# ---------------------------------------------------------------------------
# Fusión con la red de aerovías que ya usa la app (AWY: graph/pos/cells)
# ---------------------------------------------------------------------------
_merge_lock = threading.Lock()


def _append_edge(graph, a, b, d, name):
    lst = graph.setdefault(a, [])
    for nk, _dd, _aw in lst:
        if nk == b:
            return
    lst.append((b, d, name or "DCT"))


def _merge_waypoint(awy, icao, lat, lon, routes):
    with _merge_lock:
        key_self = _awy_key(icao, lat, lon)
        awy["pos"].setdefault(key_self, (icao, lat, lon))
        cell = (int(math.floor(lat)), int(math.floor(lon)))
        cell_list = awy["cells"].setdefault(cell, [])
        if key_self not in cell_list:
            cell_list.append(key_self)

        nuevas = 0
        for nb_icao, nb_lat, nb_lon, awy_name in routes:
            if not nb_icao or nb_lat is None or nb_lon is None:
                continue
            key_nb = _awy_key(nb_icao, nb_lat, nb_lon)
            awy["pos"].setdefault(key_nb, (nb_icao, nb_lat, nb_lon))
            nb_cell = (int(math.floor(nb_lat)), int(math.floor(nb_lon)))
            nb_list = awy["cells"].setdefault(nb_cell, [])
            if key_nb not in nb_list:
                nb_list.append(key_nb)
            d = _haversine_nm(lat, lon, nb_lat, nb_lon)
            if d <= 0 or d > 600:
                continue
            before = len(awy["graph"].get(key_self, ()))
            _append_edge(awy["graph"], key_self, key_nb, d, awy_name)
            _append_edge(awy["graph"], key_nb, key_self, d, awy_name)
            if len(awy["graph"].get(key_self, ())) > before:
                nuevas += 1
        awy["ready"] = True
        STATUS["aristas_vivas"] += nuevas


# ---------------------------------------------------------------------------
# Hilo principal
# ---------------------------------------------------------------------------
def run(awy, get_pos, data_dir):
    """Punto de entrada: se llama como target de un threading.Thread (igual que
    telemetry_loop / load_navdata en app.py). `get_pos()` debe devolver (lat, lon) o
    (None, None) si todavía no hay posición del avión. `awy` es el mismo dict AWY que
    ya usa route_by_airways()/_awy_near(): este hilo solo AGREGA entradas ahí adentro,
    nunca lo reemplaza ni lo vacía, así que si esto no funciona la app sigue exactamente
    igual que antes (con el archivo estático)."""
    if not _WINDOWS:
        STATUS["ultimo_error"] = "no es Windows: esta función solo existe con MSFS"
        return

    fetched_at = {}   # icao -> último timestamp en que se pidió (para no repetir)
    TTL = 900          # no volver a pedir el mismo ICAO antes de 15 min
    RADIO_NM = 200
    LOTE_MAX = 50

    while True:
        dll_path = STATUS["dll_path"]
        if not dll_path:
            dll_path = find_modern_dll(data_dir)
            if not dll_path:
                STATUS["dll_encontrado"] = False
                time.sleep(60)
                continue
            STATUS["dll_encontrado"] = True
            STATUS["dll_path"] = dll_path

        client = None
        try:
            client = _Client(dll_path)
            client.open(timeout=8.0)
            STATUS["conectado"] = True
            client.build_definition()
            STATUS["definicion_lista"] = True

            next_refresh = 0
            req_id = 1
            while not client._quit:
                lat, lon = get_pos()
                if lat is None:
                    time.sleep(2)
                    continue

                if time.time() >= next_refresh:
                    candidatos = client.refresh_nearby_waypoints(timeout=6.0)
                    next_refresh = time.time() + 180
                    STATUS["ultima_lista_candidatos"] = len(candidatos)

                    cercanos = []
                    for icao, wlat, wlon in candidatos:
                        d = _haversine_nm(lat, lon, wlat, wlon)
                        if d <= RADIO_NM:
                            cercanos.append((d, icao))
                    cercanos.sort()
                    STATUS["ultima_lista_cercanos"] = len(cercanos)

                    now = time.time()
                    pedir = []
                    vistos = set()
                    for _d, icao in cercanos:
                        if icao in vistos:
                            continue
                        vistos.add(icao)
                        if now - fetched_at.get(icao, 0) < TTL:
                            continue
                        pedir.append(icao)
                        if len(pedir) >= LOTE_MAX:
                            break

                    for icao in pedir:
                        if client._quit:
                            break
                        req_id += 1
                        fetched_at[icao] = time.time()
                        STATUS["waypoints_pedidos"] += 1
                        try:
                            wp = client.request_waypoint(icao, req_id, timeout=4.0)
                        except Exception as e:
                            STATUS["ultimo_error"] = "pidiendo %s: %r" % (icao, e)
                            wp = None
                        if wp and wp.get("icao"):
                            _merge_waypoint(awy, wp["icao"], wp["lat"], wp["lon"], wp["routes"])
                            STATUS["waypoints_resueltos"] += 1
                            STATUS["ultima_actualizacion"] = time.time()
                        time.sleep(0.15)   # no martillar la conexión

                client._pump_once()
                time.sleep(0.5)

        except Exception as e:
            STATUS["ultimo_error"] = repr(e)
        finally:
            STATUS["conectado"] = False
            STATUS["definicion_lista"] = False
            if client is not None:
                client.close()
            time.sleep(10)
