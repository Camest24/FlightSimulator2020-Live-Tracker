"""
Mide telemetry_loop contra un SimConnect FALSO y lo compara con otra versión de app.py del
historial de git. Sirve para ver, sin MSFS, si un cambio en telemetry_loop hace que la
posición del avión se actualice más lento o le pide más cosas al sim.

Uso (desde la raíz del proyecto):
    python tools/medir_telemetria.py            compara contra HEAD~1
    python tools/medir_telemetria.py main       compara contra otra rama/commit

Cómo mide: cada lectura que python-simconnect ESPERA (get_data) tarda un "frame" (25 ms,
~40 FPS); las que se piden sin esperar (request_data, ver _leer_sin_esperar en app.py) no.
Cuenta pedidos por segundo y cuántas veces por segundo se lee la posición.

No toca data/: se apagan el guardado del vuelo, el clima y el fin de vuelo. Los números
varían entre corridas (Windows no duerme menos de ~15 ms): comparar, no leerlos absolutos.
"""
import collections
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import time

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
FRAME = 0.025
DURACION = 6.0

from SimConnect import RequestList


def _deff(self):
    # Sin sim no hay definiciones de datos: se dan por hechas
    self.defined = True
    return True


RequestList.Request._deff_test = _deff


def medir(ruta, nombre):
    cuenta = collections.Counter()

    class SimFalso:
        paused = False

        def request_data(self, req):        # pedido sin esperar: la respuesta "llega" sola
            cuenta[req.definitions[0][0].decode()] += 1
            req.outData = 1.0

        def get_data(self, req):            # pedido que espera ~1 frame
            cuenta[req.definitions[0][0].decode()] += 1
            time.sleep(FRAME)
            req.outData = 1.0
            return True

    spec = importlib.util.spec_from_file_location(nombre, ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.SIMCONNECT_AVAILABLE = True
    mod.SimConnect = SimFalso
    mod.AircraftEvents = lambda sm: None
    for f in ("save_current_flight", "_update_weather", "_revisar_fin_de_vuelo"):
        setattr(mod, f, lambda *a, **k: None)
    threading.Thread(target=mod.telemetry_loop, daemon=True).start()
    time.sleep(DURACION)
    return (sum(cuenta.values()) / DURACION, cuenta.get("PLANE LATITUDE", 0) / DURACION, len(cuenta))


def main():
    ref = sys.argv[1] if len(sys.argv) > 1 else "HEAD~1"
    viejo = subprocess.run(["git", "show", ref + ":app.py"], cwd=RAIZ, capture_output=True, check=True).stdout
    with tempfile.NamedTemporaryFile("wb", suffix=".py", delete=False) as f:
        f.write(viejo)
        ruta_vieja = f.name
    try:
        for etiqueta, ruta in ((ref, ruta_vieja), ("actual", os.path.join(RAIZ, "app.py"))):
            pps, hz, distintas = medir(ruta, "app_medido_" + str(abs(hash(etiqueta))))
            print("%-10s %5.1f pedidos/s al sim · posición %4.1f veces/s · %d variables distintas"
                  % (etiqueta, pps, hz, distintas))
    finally:
        os.remove(ruta_vieja)


if __name__ == "__main__":
    main()
