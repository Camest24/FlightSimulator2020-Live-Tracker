"""SimBridge / FlyByWire: ubicar el ejecutable y la carpeta de company routes, y armar el XML.

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import json
import os
import urllib.request

from .core import DATA_DIR


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
