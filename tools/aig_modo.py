"""
Modo de tráfico AIG: antes de que arranque AIG Traffic Controller (AIGTC), deja en su
carpeta de flight plans solo lo que se va a ver. Con el tráfico de todo el mundo (1942
archivos) AIGTC tarda 6-10 min en cargar EN CADA ARRANQUE: rearma su base de flight
plans siempre ("Clear FP-Database" en su log), no hay caché ni opción para evitarlo.

Modos:
  colombia   solo las aerolíneas que despegan o aterrizan en AEROPUERTOS_COLOMBIA
  todo       devuelve todo a su sitio (usarlo ANTES de abrir AIG Manager: si ve faltantes,
             los vuelve a bajar)

Uso:
  python tools/aig_modo.py estado
  python tools/aig_modo.py --simulacro colombia     dice qué movería, sin tocar nada
  python tools/aig_modo.py colombia | todo
  python tools/aig_modo.py instalar-tarea           una vez: tarea que abre AIGTC elevado sin aviso
  pythonw tools/aig_modo.py --abrir-msfs            el acceso directo del escritorio: pregunta
                                                    (Colombia salvo tecla M), mueve, abre AIGTC y MSFS
  pythonw tools/aig_modo.py --preguntar             lo mismo pero lo lanza MSFS desde exe.xml (si
                                                    MSFS se abrió desde Steam); no abre MSFS

Los archivos que sobran se MUEVEN (nunca se borran) a APARTADOS, fuera de Community: AIG
Manager limpia la carpeta de su paquete al actualizar y se los llevaría. Todo queda en D:
(en C: no hay espacio) y en el mismo disco mover es un rename, instantáneo.
"""
import json
import os
import re
import subprocess
import sys
import time
import zipfile

AIGFP = r"D:\FS2020\Community\aig-aitraffic-oci\Traffic Files\AIGFP"
AIGTC = r"D:\AIG_TrafficController\AIGTech - Traffic Controller.exe"
MSFS_STEAM = "steam://rungameid/1250410"      # MSFS 2020 versión Steam
TAREA = "MSFS Live - AIG Traffic Controller"  # tarea programada que lo abre elevado sin aviso
APARTADOS = r"D:\AIG_apartados"
APARTADOS_FP = os.path.join(APARTADOS, "AIGFP")
INDICE = os.path.join(APARTADOS, "indice.json")
ESTADO = os.path.join(APARTADOS, "estado.json")
LOG = os.path.join(APARTADOS, "aig_modo.log")

# Con estos cuatro entra todo lo que vuela en el país (decisión del usuario).
AEROPUERTOS_COLOMBIA = {"SKRG", "SKBO", "SKCG", "SKCL"}
MODOS = ("colombia", "todo")
ESPERA_PREGUNTA = 20        # s sin responder => Colombia

# Las aerolíneas traen una ruta por archivo ("AIGFP_Direct_CFX5-CYHU_IFR_FL240.aigroute"):
# los aeropuertos salen del nombre sin descomprimir. Los paquetes de aviación general
# (GA-P/GA-C) traen un único Flightplan.aigxml con la lista <Airport id="...">.
_RE_RUTA = re.compile(r"_([A-Z0-9]{3,4})-([A-Z0-9]{3,4})_")
_RE_XML = re.compile(rb'<Airport id="([A-Z0-9]{3,4})"')


def log(msg):
    linea = "%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        print(linea)
    except Exception:       # bajo pythonw no hay consola
        pass
    os.makedirs(APARTADOS, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(linea + "\n")


# ---------------------------------------------------------------------------
# Índice: archivo -> aeropuertos que toca
# ---------------------------------------------------------------------------
def _aeropuertos(ruta):
    z = zipfile.ZipFile(ruta)
    apts = set()
    for n in z.namelist():
        m = _RE_RUTA.search(n)
        if m:
            apts.update(m.groups())
        elif n.lower().endswith(".aigxml"):
            apts.update(a.decode() for a in _RE_XML.findall(z.read(n)))
    return apts


def _archivos():
    """nombre -> carpeta donde está ahora (AIGFP o APARTADOS_FP)."""
    out = {}
    for carpeta in (APARTADOS_FP, AIGFP):       # si está en las dos, manda la de AIGFP
        if os.path.isdir(carpeta):
            for f in os.listdir(carpeta):
                if f.lower().endswith(".aigfp"):
                    out[f] = carpeta
    return out


def indice(archivos):
    """Cacheado por nombre + tamaño + fecha: armarlo de cero toma unos segundos."""
    try:
        with open(INDICE, encoding="utf-8") as f:
            viejo = json.load(f)
    except (OSError, ValueError):
        viejo = {}
    nuevo, cambios = {}, 0
    for nombre, carpeta in archivos.items():
        st = os.stat(os.path.join(carpeta, nombre))
        clave = "%d-%d" % (st.st_size, int(st.st_mtime))
        v = viejo.get(nombre)
        if v and v["clave"] == clave:
            nuevo[nombre] = v
            continue
        try:
            apts = sorted(_aeropuertos(os.path.join(carpeta, nombre)))
        except Exception as e:
            log("no se pudo leer %s (%r): se deja en AIGFP siempre" % (nombre, e))
            apts = None
        nuevo[nombre] = {"clave": clave, "apts": apts}
        cambios += 1
    if cambios or len(nuevo) != len(viejo):
        os.makedirs(APARTADOS, exist_ok=True)
        with open(INDICE, "w", encoding="utf-8") as f:
            json.dump(nuevo, f)
    return nuevo


def se_queda(modo, info):
    if modo == "todo" or info["apts"] is None:     # ilegible: mejor de más que de menos
        return True
    return bool(AEROPUERTOS_COLOMBIA.intersection(info["apts"]))


# ---------------------------------------------------------------------------
# Aplicar un modo
# ---------------------------------------------------------------------------
def _corriendo(nombre_exe):
    try:
        # En CSV: en tabla tasklist corta el nombre a 25 caracteres ("AIGTech - Traffic
        # Control") y no se encontraba a AIGTC abierto; así se movieron archivos con él cargado.
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq " + nombre_exe, "/NH", "/FO", "CSV"],
                             capture_output=True, text=True,
                             creationflags=subprocess.CREATE_NO_WINDOW).stdout
    except OSError:
        return False
    return nombre_exe.lower() in out.lower()


def aplicar(modo, simulacro=False):
    """Mueve lo que haga falta. Devuelve (archivos en AIGFP al final, movidos)."""
    if not os.path.isdir(AIGFP):
        raise SystemExit("no existe la carpeta de AIG: " + AIGFP)
    # Con AIGTC abierto no se toca nada: ya cargó (o está cargando) esos archivos.
    if not simulacro and _corriendo("AIGTech - Traffic Controller.exe"):
        log("AIG Traffic Controller ya está abierto: no se mueve nada")
        return None, 0
    if modo != "todo" and _corriendo("AIGTech - AI Manager.exe"):
        log("AIG Manager está abierto: se usa 'todo' para que no crea que faltan archivos")
        modo = "todo"

    archivos = _archivos()
    idx = indice(archivos)
    mover = []          # (nombre, desde, hacia)
    for nombre, carpeta in archivos.items():
        destino = AIGFP if se_queda(modo, idx[nombre]) else APARTADOS_FP
        if carpeta != destino:
            mover.append((nombre, carpeta, destino))

    quedan = sum(1 for n in archivos if se_queda(modo, idx[n]))
    if simulacro:
        return quedan, mover

    os.makedirs(APARTADOS_FP, exist_ok=True)
    hechos = 0
    for nombre, desde, hacia in mover:
        a = os.path.join(hacia, nombre)
        if os.path.exists(a):
            # Pasa si AIG Manager volvió a bajar uno que estaba apartado: no se pisa nada.
            log("ya existe %s en %s: se deja como está" % (nombre, hacia))
            continue
        try:
            os.rename(os.path.join(desde, nombre), a)
            hechos += 1
        except OSError as e:
            log("no se pudo mover %s: %r" % (nombre, e))
    with open(ESTADO, "w", encoding="utf-8") as f:
        json.dump({"modo": modo, "cuando": time.strftime("%Y-%m-%d %H:%M:%S")}, f)
    log("modo %s: %d archivos en AIGFP, %d movidos" % (modo, quedan, hechos))
    return quedan, hechos


def ultimo_modo():
    try:
        with open(ESTADO, encoding="utf-8") as f:
            m = json.load(f).get("modo")
        return m if m in MODOS else "todo"
    except (OSError, ValueError):
        return "todo"


# ---------------------------------------------------------------------------
# Lo que lanza MSFS: preguntar, aplicar y abrir AIGTC
# ---------------------------------------------------------------------------
def _area_monitor_secundario():
    """(izq, arriba, der, abajo) del área de trabajo del primer monitor que no es el
    principal, o None si hay uno solo. En píxeles reales: llamar con el proceso ya DPI-aware."""
    import ctypes
    from ctypes import wintypes as w

    class _MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", w.DWORD), ("rcMonitor", w.RECT), ("rcWork", w.RECT), ("dwFlags", w.DWORD)]

    areas = []

    def cb(hmon, hdc, rc, lp):
        mi = _MONITORINFO()
        mi.cbSize = ctypes.sizeof(_MONITORINFO)
        ctypes.windll.user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
        if not mi.dwFlags & 1:          # MONITORINFOF_PRIMARY
            r = mi.rcWork
            areas.append((r.left, r.top, r.right, r.bottom))
        return True

    proc = ctypes.WINFUNCTYPE(ctypes.c_int, w.HMONITOR, w.HDC, ctypes.POINTER(w.RECT), w.LPARAM)
    ctypes.windll.user32.EnumDisplayMonitors(None, None, proc(cb), 0)
    return areas[0] if areas else None


def _ventana():
    """Muestra el aviso y devuelve el modo elegido."""
    import ctypes
    import tkinter as tk

    # Sin esto Tk y Windows miden en escalas distintas (monitor al 125%) y la ventana
    # caería corrida respecto al área que devuelve _area_monitor_secundario.
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

    # Colombia por defecto (pedido del usuario): no hace falta tocar nada; el tráfico
    # mundial es la excepción y se pide con la tecla M o el botón.
    elegido = {"modo": "colombia"}
    v = tk.Tk()
    v.title("Tráfico AIG")
    # Encima de todo: MSFS arranca en pantalla completa y la taparía.
    v.attributes("-topmost", True)
    v.resizable(False, False)
    tk.Label(v, text="Tráfico AIG: Colombia", font=("Segoe UI", 16, "bold")).pack(padx=30, pady=(20, 4))
    tk.Label(v, text="Presiona M para tráfico MUNDIAL (AIG tarda 6-10 min en cargar)",
             font=("Segoe UI", 11), justify="center").pack(padx=30)
    cuenta = tk.Label(v, font=("Segoe UI", 9), fg="#666")
    cuenta.pack(pady=(8, 0))
    botones = tk.Frame(v)
    botones.pack(padx=30, pady=16)

    def elegir(m):
        elegido["modo"] = m
        v.destroy()

    tk.Button(botones, text="Mundial (M)", width=16, font=("Segoe UI", 12),
              command=lambda: elegir("todo")).pack(side="left", padx=8)
    tk.Button(botones, text="Colombia ya (Enter)", width=16, font=("Segoe UI", 12),
              command=lambda: elegir("colombia")).pack(side="left", padx=8)
    v.bind("<KeyPress-m>", lambda e: elegir("todo"))
    v.bind("<KeyPress-M>", lambda e: elegir("todo"))
    v.bind("<Return>", lambda e: elegir("colombia"))

    fin = time.time() + ESPERA_PREGUNTA

    def tic():
        falta = int(fin - time.time())
        if falta <= 0:
            v.destroy()
            return
        cuenta.config(text="Sigue con Colombia en %d s" % falta)
        v.after(500, tic)

    v.update_idletasks()
    # En el monitor secundario: MSFS corre a pantalla completa en el principal y ahí no se
    # vería. Con un solo monitor, centrada en el principal.
    izq, arriba, der, abajo = _area_monitor_secundario() or (
        0, 0, v.winfo_screenwidth(), v.winfo_screenheight())
    x = izq + (der - izq - v.winfo_reqwidth()) // 2
    y = arriba + (abajo - arriba - v.winfo_reqheight()) // 3
    v.geometry("+%d+%d" % (x, y))
    # Sin foco la tecla M le llegaría a MSFS y no a esta ventana.
    v.focus_force()
    tic()
    v.mainloop()

    return elegido["modo"]


def preguntar(abrir_msfs=False):
    """abrir_msfs=False: lo lanza MSFS desde exe.xml (~1:45 min después de arrancar).
    abrir_msfs=True: el acceso directo del escritorio; pregunta apenas se abre y después
    abre AIGTC y MSFS juntos. AIGTC espera a MSFS solo (probado), así carga en paralelo."""
    if not abrir_msfs and _corriendo("AIGTech - Traffic Controller.exe"):
        # Ya lo abrió el acceso directo: la pregunta ya se hizo.
        log("--- MSFS arrancó con AIG ya abierto: no se pregunta")
        return
    modo = _ventana()
    log("--- %s: modo elegido %s" % ("acceso directo" if abrir_msfs else "MSFS arrancó", modo))
    try:
        aplicar(modo)
    except Exception as e:      # pase lo que pase, AIGTC tiene que abrir
        log("error aplicando el modo: %r" % (e,))
    abrir_aigtc()
    if abrir_msfs:
        os.startfile(MSFS_STEAM)
        log("MSFS lanzado por Steam")


def _aigtc_minimizado():
    """AIGTC guarda al cerrarse si su ventana quedó minimizada y así vuelve a abrir: se
    fuerza en cada arranque para que no aparezca encima (antes de abrirlo, no con él
    abierto: al cerrarse reescribe el archivo)."""
    import glob
    patron = os.path.join(os.environ.get("LOCALAPPDATA", ""), "AIGTech",
                          "AIGTech_-_Traffic_Control_Url_*", "*", "user.config")
    for ruta in glob.glob(patron):
        try:
            with open(ruta, encoding="utf-8") as f:
                s = f.read()
            nuevo = re.sub(r'(name="AIGTC_UI_WINDOW_MINIMIZED"[^>]*>\s*<value>)False(</value>)',
                           r"\1True\2", s)
            if nuevo != s:
                with open(ruta, "w", encoding="utf-8") as f:
                    f.write(nuevo)
        except OSError as e:
            log("no se pudo dejar AIGTC minimizado (%s): %r" % (ruta, e))


def abrir_aigtc():
    if _corriendo("AIGTech - Traffic Controller.exe"):
        return
    _aigtc_minimizado()
    # AIGTC SÍ necesita ser administrador. Probado 2026-11-01 sin elevar (RunAsInvoker): no
    # puede reescribir su caché en C:\ProgramData\AIGTech\Cache (la creó elevado) ni abrir
    # su servicio WCF en http://+:8733 (URL ACL). Para que no pida permiso en cada arranque,
    # una tarea programada con "privilegios más altos" (ver instalar_tarea) lo abre elevado
    # sin aviso. Sin la tarea: ShellExecute, que eleva pidiendo permiso (Popen daría 740).
    r = subprocess.run(["schtasks", "/Run", "/TN", TAREA], capture_output=True, text=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    if r.returncode == 0:
        log("AIG Traffic Controller lanzado por la tarea programada (elevado, sin aviso)")
        return
    log("sin tarea programada (%s): se abre pidiendo permisos" % (r.stderr.strip() or r.returncode))
    os.startfile(AIGTC, cwd=os.path.dirname(AIGTC))


def instalar_tarea():
    """Crea (una vez) la tarea que abre AIGTC elevado sin aviso. Crearla con privilegios
    más altos sí pide permiso de administrador: ese es el único aviso."""
    ps = ("$a = New-ScheduledTaskAction -Execute '{exe}' -WorkingDirectory '{dir}'; "
          "$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest; "
          "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries "
          "-ExecutionTimeLimit 0 -MultipleInstances IgnoreNew; "
          "Register-ScheduledTask -TaskName '{tn}' -Action $a -Principal $p -Settings $s -Force"
          ).format(exe=AIGTC, dir=os.path.dirname(AIGTC), tn=TAREA)
    import ctypes
    # runas: ShellExecute con elevación (el aviso de Windows sale una vez, para crearla)
    ctypes.windll.shell32.ShellExecuteW(None, "runas", "powershell.exe",
                                        '-NoProfile -WindowStyle Hidden -Command "%s"' % ps, None, 0)


def main(args):
    simulacro = "--simulacro" in args
    args = [a for a in args if a != "--simulacro"]
    if args in (["--preguntar"], ["--abrir-msfs"]):
        abrir_msfs = args == ["--abrir-msfs"]
        try:
            preguntar(abrir_msfs)
        except Exception as e:
            log("%s falló: %r" % (args[0], e))
            abrir_aigtc()
            if abrir_msfs:
                os.startfile(MSFS_STEAM)
        return
    if args == ["instalar-tarea"]:
        instalar_tarea()
        return
    if args == ["estado"]:
        archivos = _archivos()
        en_aigfp = sum(1 for c in archivos.values() if c == AIGFP)
        print("modo: %s | %d en AIGFP, %d apartados" % (ultimo_modo(), en_aigfp, len(archivos) - en_aigfp))
        return
    if len(args) != 1 or args[0] not in MODOS:
        raise SystemExit(__doc__)
    modo = args[0]
    if simulacro:
        quedan, mover = aplicar(modo, simulacro=True)
        idx = indice(_archivos())
        print("modo %s: quedarían %d archivos en AIGFP; se moverían %d" % (modo, quedan, len(mover)))
        for nombre in sorted(n for n, i in idx.items() if modo != "todo" and se_queda(modo, i)):
            print("  queda  " + nombre)
        return
    aplicar(modo)


if __name__ == "__main__":
    main(sys.argv[1:])
