# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MSFS Live Tracker: app web local (Flask + MapLibre) que muestra en vivo el vuelo de Microsoft Flight Simulator 2020 sobre un mapa satelital. Windows, Python 3.9+, puerto 5001.

## Comandos

```
python app.py                    # app real, lee telemetría por SimConnect (o iniciar.bat)
python app.py --debug            # avión estático en SKRG, nunca toca SimConnect (iniciar-debug.bat)
python tools/demo_medellin.py    # vuelo falso en círculos sobre Medellín, con reloader (iniciar-demo.bat)
python tools/medir_telemetria.py [ref]   # telemetry_loop actual vs otro commit, con SimConnect falso
```

- No hay tests, linter ni paso de build. Para verificar un cambio: arrancar en `--debug` o con la demo y abrir http://localhost:5001.
- Cambios en `static/` o `templates/` se ven recargando el navegador. Cambios en Python requieren reiniciar el server (la demo se reinicia sola).
- Diagnóstico en vivo: `/api/live_airways_status`, `/api/simbridge_status`.
- Los `.bat` matan cualquier proceso que siga escuchando en :5001 antes de arrancar.
- `iniciar-con-msfs.pyw` lo lanza MSFS al abrir (vía `exe.xml`, con `pythonw`): arranca `python.exe app.py` sin ventana (`CREATE_NO_WINDOW`; bajo pythonw directo Werkzeug falla con WinError 6) y con `MSFS_LIVE_QUIET=1`. La salida va a `data/msfs-live.log`.

## Arquitectura

**Hilos del backend** (arrancan en el `__main__` de `app.py`): `telemetry_loop` (o `_debug_telemetry_loop` con `--debug`), `load_navdata` (descarga/carga OurAirports en `data/`), opcional `server/live_airways.run` (segunda conexión SimConnect con un `SimConnect.dll` moderno del SDK para pedir aerovías en vivo) y `server/traffic.run` (tercera conexión, tráfico IA por `RequestDataOnSimObjectType`; con `--debug` usa `run_debug`, que genera aviones falsos). Las conexiones extra son ctypes propias porque el dispatcher de python-simconnect no soporta respuestas de varios objetos con el mismo request id. Flask corre con `threaded=True`; todo acceso a estado compartido pasa por `lock` y todo acceso a SimConnect por `sim_lock`.

**Conexión con el simulador**: `telemetry_loop` en `app.py` crea `SimConnect()` + `AircraftRequests` + `AircraftEvents`, lee SimVars ~4 Hz y vuelca en `state`. Se reconecta tras 5 fallos seguidos; lat/lon en `None` (menú, pantalla de carga) NO cuenta como desconexión. Rumbo y banqueo llegan en radianes pese al nombre de la SimVar. **Cada `aq.get` espera ~1 frame del sim**: solo las 7 variables de movimiento se esperan en cada vuelta; el resto va en `SIMVARS_CADA_1S/3S/10S` y se lee sin esperar (`_leer_sin_esperar`). Una variable nueva va en esas listas salvo que mueva el avión en el mapa, o la posición vuelve a actualizarse más lento. Las escrituras al sim (teleport, AP, hora, eventos) pasan por `trigger_event`/`teleport_aircraft`/`set_autopilot`/etc. en `app.py`.

**Regla clave de `server/core.py`** (leer su cabecera antes de mover código): ahí vive solo lo que se muta in situ (`state`, `route`, locks, rutas de archivos). Las variables que se reasignan con `global` (`sim_aq`, `sim_events`, `sim_raw`, `prev_sim_clock`, `fue_al_aire`...) y las funciones que las tocan se quedan en `app.py` a propósito: moverlas a otro módulo rompe en silencio (el otro módulo ve `None` para siempre).

**Contrato con la demo**: `tools/demo_medellin.py` hace `import app` y usa `app.state`, `app.lock`, `app.route` y `app.app`. Cualquier refactor de Python debe mantener esos atributos accesibles desde `app.py` (re-exportar si hace falta).

**Frontend**: `templates/index.html` (solo markup) + `static/css/main.css` + 10 scripts clásicos en `static/js/` cargados en orden fijo (map-setup → plane-3d → cesium-3d → geo-utils → flight-progress → flightplan → telemetry → graph-panel → tools-ui → traffic). Comparten el scope global: nada de `type="module"` ni bundler, y el orden de carga importa. Librerías por CDN: MapLibre 4.7.1, Three.js 0.128.0, Chart.js 4.4.1.

**Tráfico IA** (detalle, decisiones y pendientes en `docs/TRAFFIC-UPDATE.md`): `static/js/traffic.js` pide `/api/traffic?radius=<aptRadius>` cada 2 s y extrapola posiciones a 4 Hz. El radio es el mismo de aeropuertos, recortado a ~108 NM (200 km, tope de SimConnect); `server/traffic.py` pide solo ese radio y se pausa si nadie consulta en 15 s. Estacionados apagados ocultos por defecto (`activo`, botón "P"). Fotos: `server/jetphotos.py` (JetPhotos, con permiso de uso universitario no comercial: una consulta a la vez y caché larga) y Wikimedia Commons de respaldo. AIG Traffic Controller y la app se lanzan con MSFS desde `%APPDATA%\Microsoft Flight Simulator\exe.xml`; la app se cierra sola al cerrar MSFS (`_cerrar_con_msfs`).

**Polling**: el frontend pide `/api/state` 10 veces/seg (`poll()` en `tools-ui.js`). Ese endpoint excluye la ruta a propósito (hasta 6000 puntos); la ruta va aparte por `/api/route` ~1 vez/seg. No volver a meterla en `/api/state`.

**Persistencia**: `data/current_flight.json` (vuelo actual, autosave) y `data/flights_history.json`. El vuelo se archiva solo tras despegar, aterrizar y quedar detenido ~45 s (`_revisar_fin_de_vuelo`). `design/` son mockups viejos, no forman parte de la app.

## Convenciones (de `docs/CODESTYLE.md`)

- Comentarios en **español** que explican el *por qué* (decisiones, bugs ya resueltos). No traducirlos, resumirlos ni "limpiarlos" al mover código.
- Python: 4 espacios, `snake_case`, secciones con `# ----...` + título. JS: 2 espacios, `camelCase`, punto y coma siempre.
- Refactors estructurales y cambios de comportamiento van en commits separados.
- `docs/SPECS.md`, `docs/ROADMAP.md` y `docs/ROADMAP-web.md` tienen el contexto de la reorganización y lo pendiente.

## graft

El repo está indexado por graft (`.mcp.json` levanta el MCP con `npx @nanonets/graft mcp`). Las consultas en español con `graft ask` son léxicas y rinden poco: usar nombres de símbolos o términos del código (p. ej. `graft ask "SimConnect connect loop"`, `graft grep "telemetry_loop"`).
