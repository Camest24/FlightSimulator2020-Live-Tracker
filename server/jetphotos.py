"""
jetphotos.py — Foto del avión de tráfico desde JetPhotos, vía roowus/Jetphotos-API.

Por qué existe este archivo
----------------------------
JetPhotos no tiene API oficial. tools/jetphotos-api es la API no oficial de roowus (MIT,
Node + wrangler/workerd) que lee su buscador y devuelve JSON. Se corre en LOCAL
(127.0.0.1:8787) y este módulo le habla desde el servidor Flask: el navegador nunca la
toca (así el puerto 8787 no hace falta exponerlo en la red).

Uso con permiso de JetPhotos para el proyecto de la universidad, SIN fines comerciales.
Por eso se la trata con cuidado: una sola consulta a la vez, caché larga (también de las
matrículas sin foto) y siempre crédito al fotógrafo + enlace a la página de la foto.

Dos mañas de la API que ya se probaron:
- keywords-type=registration + keywords-contain=0 NO filtra: devuelve las fotos más
  recientes del sitio, sean de quien sean. keywords-type=all sí filtra, así que se pide
  así y se descarta todo lo que no tenga la matrícula EXACTA (si no, saldría una foto de
  otro avión como si fuera este).
- A veces el parser devuelve entradas basura (registration="photos"): el filtro exacto
  también las saca.

Si el servicio no está levantado (sin Node, sin npm install, bloqueado por Cloudflare) NADA
se rompe: buscar() devuelve None y el frontend cae a Wikimedia Commons.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from server.core import BASE_DIR

# ---------------------------------------------------------------------------
# Configuración y estado público (lo devuelve /api/jetphoto_status)
# ---------------------------------------------------------------------------
API_URL = os.environ.get("JETPHOTOS_API_URL", "http://127.0.0.1:8787")
API_DIR = os.path.join(BASE_DIR, "tools", "jetphotos-api")
PUERTO = 8787
# La caché se guarda en disco: la app se cierra con MSFS, y AIG repite los mismos aviones
# de una sesión a otra. Así una matrícula ya vista no vuelve a consultar a JetPhotos.
TTL_FOTO = 30 * 86400         # la foto de una matrícula no cambia de un día para otro
TTL_SIN_FOTO = 3 * 86400      # "no hay foto": alguien puede subir una; se reintenta cada pocos días
TTL_FALLO = 300               # error de red / Cloudflare: reintentar pronto (y NO se guarda en disco)
CACHE_FILE = os.path.join(BASE_DIR, "data", "jetphotos_cache.json")
TIMEOUT = 45                  # la primera consulta en frío tardó ~23 s; JetPhotos a veces es lento

STATUS = {
    "servicio": False,        # ¿responde /health?
    "lanzado_por_app": False,
    "consultas": 0,
    "con_foto": 0,
    "ultimo_error": None,
    "cache_disco": CACHE_FILE,
}

_cache = {}                   # matrícula normalizada -> (vence, foto o None, guardar_en_disco)
_cache_lock = threading.Lock()
_pedido_lock = threading.Lock()   # una consulta a la vez: es un sitio ajeno, no se lo martilla
_proc = None


def _norm(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _cargar_cache():
    """Lee la caché del disco al importar el módulo, descartando lo vencido. Si el archivo
    no existe o está roto, se empieza vacía: es solo una caché."""
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            datos = json.load(f)
        ahora = time.time()
        for clave, (vence, foto) in datos.items():
            if vence > ahora:
                _cache[clave] = (vence, foto, True)
    except Exception:
        pass


def _guardar_cache():
    """Escribe a un temporal y lo renombra: si la app se cierra a mitad (os._exit al cerrar
    MSFS) queda el archivo viejo entero, nunca uno a medio escribir. Llamar con _cache_lock."""
    try:
        datos = {k: [v[0], v[1]] for k, v in _cache.items() if v[2]}
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(datos, f, ensure_ascii=False)
        os.replace(tmp, CACHE_FILE)
    except Exception:
        pass


_cargar_cache()


# ---------------------------------------------------------------------------
# Ciclo de vida del servicio Node
# ---------------------------------------------------------------------------
def _vivo():
    try:
        with urllib.request.urlopen(API_URL + "/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def iniciar_servicio():
    """Levanta `npm run dev` (solo 127.0.0.1) si hay Node, están las dependencias y el
    puerto está libre. Si ya hay algo respondiendo en el puerto se reusa. Nunca lanza."""
    global _proc
    try:
        if _vivo():
            STATUS["servicio"] = True
            return
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        if not npm:
            STATUS["ultimo_error"] = "no hay Node/npm: sin fotos de JetPhotos (se usa Wikimedia)"
            return
        if not os.path.isdir(os.path.join(API_DIR, "node_modules")):
            STATUS["ultimo_error"] = "falta 'npm install' en tools/jetphotos-api"
            return
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        # Fuera del "job" de Steam: la app la lanza MSFS, y Steam se queda en "Deteniendo"
        # hasta que muere todo lo que cuelga del juego. Si la app se cae (o se mata a la
        # fuerza) sin llamar a detener_servicio, node/workerd quedaban huérfanos ahí adentro
        # y MSFS no se podía volver a abrir (pasó el 2026-11-01). Si el job no deja salir,
        # CreateProcess da acceso denegado y se lanza como antes.
        breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0)
        try:
            _proc = subprocess.Popen([npm, "run", "dev"], cwd=API_DIR, creationflags=flags | breakaway,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        except OSError:
            _proc = subprocess.Popen([npm, "run", "dev"], cwd=API_DIR, creationflags=flags,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        STATUS["lanzado_por_app"] = True
        for _ in range(60):                       # wrangler tarda unos segundos en estar listo
            if _vivo():
                STATUS["servicio"] = True
                return
            time.sleep(0.5)
        STATUS["ultimo_error"] = "el servicio JetPhotos no respondió en 30 s"
    except Exception as e:
        STATUS["ultimo_error"] = "iniciar_servicio: %r" % (e,)


REINTENTO_ARRANQUE = 300      # s entre intentos de levantar el servicio si falló (sin Node, etc.)
_ultimo_arranque = [0.0]


def _asegurar_servicio():
    """Arranque perezoso: el servicio (node + workerd, ~100 MB de RAM con MSFS corriendo al
    lado) se levanta recién cuando hace falta consultar una matrícula que NO está en la caché.
    Con la caché en disco, en una sesión normal muchas veces no hace falta nunca. Llamar con
    _pedido_lock tomado (así dos pedidos no lo lanzan dos veces)."""
    if STATUS["servicio"]:
        return True
    if time.time() - _ultimo_arranque[0] < REINTENTO_ARRANQUE:
        return False
    _ultimo_arranque[0] = time.time()
    iniciar_servicio()
    return STATUS["servicio"]


def detener_servicio():
    """Cierra el servicio si lo lanzó la app. os._exit no corre atexit, por eso app.py lo
    llama a mano antes de cerrar. Matar el árbol de npm NO alcanza: wrangler deja workerd.exe
    vivo escuchando en el puerto (y sin el padre ya no responde), así que además se mata lo
    que siga escuchando en :8787 — solo si lo lanzamos nosotros, nunca uno ajeno."""
    if not STATUS["lanzado_por_app"]:
        return
    try:
        if _proc is not None and _proc.poll() is None:
            subprocess.run(["taskkill", "/PID", str(_proc.pid), "/T", "/F"],
                           capture_output=True, timeout=10)
        salida = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                                text=True, timeout=10).stdout
        for linea in salida.splitlines():
            c = linea.split()
            if len(c) >= 5 and c[3] == "LISTENING" and c[1].endswith(":%d" % PUERTO):
                subprocess.run(["taskkill", "/PID", c[4], "/T", "/F"],
                               capture_output=True, timeout=10)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Búsqueda
# ---------------------------------------------------------------------------
def _consultar(matricula):
    q = urllib.parse.urlencode({"keywords": matricula, "keywords-type": "all",
                                "keywords-contain": "3", "sort-order": "1"})
    with urllib.request.urlopen(API_URL + "/?" + q, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def buscar(matricula):
    """Mejor foto de JetPhotos de esa matrícula, o None. Resultado cacheado."""
    clave = _norm(matricula)
    if len(clave) < 3:
        return None
    ahora = time.time()
    with _cache_lock:
        hit = _cache.get(clave)
        if hit and hit[0] > ahora:
            return hit[1]
    with _pedido_lock:
        with _cache_lock:                         # otro hilo pudo resolverla mientras esperábamos
            hit = _cache.get(clave)
            if hit and hit[0] > time.time():
                return hit[1]
        if not _asegurar_servicio():
            # Sin servicio no se sabe si hay foto: se recuerda poco y no va al disco
            with _cache_lock:
                _cache[clave] = (time.time() + TTL_FALLO, None, False)
            return None
        foto, ttl, guardar = None, TTL_SIN_FOTO, True
        try:
            STATUS["consultas"] += 1
            d = _consultar(matricula)
            STATUS["servicio"] = True
            for p in d.get("photos") or []:
                if _norm(p.get("registration")) == clave and p.get("thumbnailUrl"):
                    foto = {
                        "src": p["thumbnailUrl"],
                        "full": p.get("imageUrl"),
                        "link": p.get("photoPageUrl") or p.get("registrationUrl"),
                        "autor": p.get("photographer") or "",
                        "tipo": p.get("aircraftType") or "",
                        "aerolinea": p.get("airline") or "",
                        "lugar": p.get("location") or "",
                        "fecha": p.get("photoDate") or "",
                        "fuente": "JetPhotos",
                    }
                    STATUS["con_foto"] += 1
                    ttl = TTL_FOTO
                    break
            STATUS["ultimo_error"] = None
        except (urllib.error.URLError, OSError, ValueError) as e:
            STATUS["servicio"] = False
            STATUS["ultimo_error"] = "consulta: %r" % (e,)
            ttl, guardar = TTL_FALLO, False
        with _cache_lock:
            _cache[clave] = (time.time() + ttl, foto, guardar)
            if guardar:
                _guardar_cache()
        return foto
