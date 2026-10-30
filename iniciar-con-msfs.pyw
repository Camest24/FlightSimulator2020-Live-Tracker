"""
Lanzador en segundo plano: lo ejecuta MSFS al arrancar (entrada en
%APPDATA%\\Microsoft Flight Simulator\\exe.xml, con pythonw.exe => sin ventana).

No corre app.py acá adentro: bajo pythonw, Werkzeug falla al arrancar el servidor
(socket.set_inheritable -> WinError 6, handle inválido). Por eso lanza un python.exe
normal con la consola oculta (CREATE_NO_WINDOW), que se comporta igual que iniciar.bat
pero sin ventana, y este lanzador termina enseguida.

Sin consola no hay dónde ver un error, así que toda la salida va a data/msfs-live.log.
Si la app ya estaba corriendo (por ejemplo abierta con iniciar.bat), esta segunda copia
no puede tomar el puerto 5001 y se cierra sola, dejando el motivo en ese mismo log.
"""
import os
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
log_path = os.path.join(BASE, "data", "msfs-live.log")

# Que el log no crezca para siempre: se empieza de cero si pasó de 1 MB.
modo = "w" if os.path.exists(log_path) and os.path.getsize(log_path) > 1_000_000 else "a"
log = open(log_path, modo, encoding="utf-8")
log.write("\n=== MSFS Live arrancado por MSFS: %s ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
log.flush()

python = os.path.join(os.path.dirname(sys.executable), "python.exe")
# MSFS_LIVE_QUIET: sin esto el log anota cada GET /api/state (10 por segundo, ~10 MB en
# un vuelo largo) y los errores de verdad quedan enterrados. Ver el final de app.py.
env = dict(os.environ, MSFS_LIVE_QUIET="1")
subprocess.Popen([python, "-u", os.path.join(BASE, "app.py")], cwd=BASE, env=env,
                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                 creationflags=subprocess.CREATE_NO_WINDOW)
