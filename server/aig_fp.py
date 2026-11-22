"""
aig_fp.py — De qué aerolínea es un avión de AIG, leído de sus propios flight plans.

Por qué existe este archivo
----------------------------
traffic.py saca la aerolínea del callsign que AIG pone en "ATC ID" (AVA9341 -> Avianca).
Pero AIG no siempre lo pone: desde que el tráfico de MSFS quedó en "IA desconectada"
(2026-11-01) manda la MATRÍCULA en ATC ID y el número de vuelo suelto en ATC FLIGHT NUMBER
("N742AV" + "9533"), y la ATC AIRLINE de la librea muchas veces viene vacía. Sin prefijo
ICAO la ficha se quedaba sin aerolínea, sin logo y sin vuelo.

Los flight plans de AIG sí lo dicen: cada .aigfp es un ZIP con un Flightplan.aigxml que
lista <Registration id="N742AV"> con sus <Leg ... flightnumber="9533">, y FPDatabase.xml
(que AIGTC rearma en cada arranque) dice de qué aerolínea es cada archivo (ICAO, IATA,
nombre). Se indexa matrícula + número de vuelo -> aerolínea.

Solo se leen los archivos que están en la carpeta AIGFP: son los que AIGTC cargó (con
tools/aig_modo.py en modo Colombia, unos 70). Se vuelve a indexar si la carpeta cambia.
Nunca bloquea: mientras indexa, buscar() devuelve None y la ficha queda como antes.
"""

import os
import re
import threading
import time
import xml.etree.ElementTree as ET
import zipfile

STATUS = {"carpeta": None, "archivos": 0, "matriculas": 0, "indexado": None, "ultimo_error": None}

REVISAR_CADA = 30       # s entre chequeos de si la carpeta cambió (stat + listdir, barato)

_RE_REG = re.compile(r'<Registration id="([^"]+)"[^>]*>(.*?)</Registration>', re.S)
_RE_VUELO = re.compile(r'flightnumber="([^"]*)"')

_por_vuelo = {}         # (matrícula, número) -> (icao, iata, nombre); reemplazados enteros
_por_reg = {}           # matrícula -> (icao, iata, nombre), o None si vuela para varias
_hilo = []


def _carpeta():
    from server.simbridge import _community_dirs
    for com in _community_dirs():
        d = os.path.join(com, "aig-aitraffic-oci", "Traffic Files", "AIGFP")
        if os.path.isdir(d):
            return d
    return None


def _firma(d):
    """Cambia si AIGTC rearma su base o tools/aig_modo.py mueve archivos."""
    try:
        db = os.path.join(d, "FPDatabase.xml")
        return (tuple(sorted(f for f in os.listdir(d) if f.endswith(".aigfp"))),
                os.path.getmtime(db) if os.path.exists(db) else 0)
    except OSError:
        return None


def _aerolineas(d):
    """archivo .aigfp -> (icao, iata, nombre), de FPDatabase.xml."""
    out = {}
    try:
        for x in ET.parse(os.path.join(d, "FPDatabase.xml")).getroot().iter("Airline"):
            out[x.get("file")] = ((x.findtext("ICAO") or "").strip(), (x.findtext("IATA") or "").strip(),
                                  (x.findtext("Name") or "").strip())
    except (OSError, ET.ParseError) as e:
        # AIGTC la reescribe al arrancar: si se leyó a medias, la próxima vuelta la toma entera
        STATUS["ultimo_error"] = "FPDatabase.xml: %r" % (e,)
    return out


def _indexar(d):
    global _por_vuelo, _por_reg
    aerolineas = _aerolineas(d)
    por_vuelo, por_reg, n = {}, {}, 0
    for f in os.listdir(d):
        info = aerolineas.get(f)
        if not f.endswith(".aigfp") or not info or not info[0]:
            continue        # aviación general sin ICAO, o archivo que FPDatabase aún no tiene
        try:
            xml = zipfile.ZipFile(os.path.join(d, f)).read("Flightplan.aigxml").decode("utf-8-sig", "ignore")
        except (OSError, KeyError, zipfile.BadZipFile):
            continue
        n += 1
        for reg, legs in _RE_REG.findall(xml):
            reg = reg.upper()
            for num in set(_RE_VUELO.findall(legs)):
                por_vuelo[(reg, num)] = info
            if reg in por_reg and por_reg[reg] != info:
                por_reg[reg] = None     # la misma matrícula en dos aerolíneas: solo vale con vuelo
            elif reg not in por_reg:
                por_reg[reg] = info
    _por_vuelo, _por_reg = por_vuelo, por_reg
    STATUS.update(archivos=n, matriculas=len(por_reg), indexado=time.strftime("%H:%M:%S"))


def _run():
    firma = None
    while True:
        try:
            d = STATUS["carpeta"] or _carpeta()
            STATUS["carpeta"] = d
            if d:
                f = _firma(d)
                if f and f != firma:
                    _indexar(d)
                    firma = f
        except Exception as e:
            STATUS["ultimo_error"] = repr(e)
        time.sleep(REVISAR_CADA)


def buscar(matricula, vuelo=""):
    """{"icao", "iata", "nombre", "vuelo"} o None. "vuelo" solo viene lleno si ese número
    de vuelo está en el horario de esa matrícula (ahí se puede armar el callsign); si no,
    la aerolínea sale de la matrícula sola, siempre que vuele para una sola."""
    if not _hilo:
        _hilo.append(threading.Thread(target=_run, daemon=True, name="aig_fp"))
        _hilo[0].start()
    reg = (matricula or "").upper()
    if not reg:
        return None
    num = re.sub(r"\D", "", vuelo or "")
    hit = _por_vuelo.get((reg, num)) if num else None
    if not hit:
        hit, num = _por_reg.get(reg), ""
    if not hit:
        return None
    return {"icao": hit[0], "iata": hit[1], "nombre": hit[2], "vuelo": num}
