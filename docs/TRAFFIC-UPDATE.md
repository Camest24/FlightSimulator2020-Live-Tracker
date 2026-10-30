# MSFS Live 2.0 — Traffic Update

Notas para retomar el trabajo: qué se hizo, por qué, qué vive fuera del repo y qué falta probar.
Estado al 2026-10-30, rama `traffic-update`:

- `95fae2b` perf(telemetria): leer sin esperar las SimVars que cambian lento
- `e969e48` feat: tráfico IA, fotos, arranque y cierre con MSFS
- commit de docs (este archivo, `CLAUDE.md`, `tools/medir_telemetria.py`)

Probado en `--debug`, con un SimConnect falso y con MSFS real **solo en una versión anterior** del
tráfico (antes de la tarjeta compacta, las fotos, el filtro de estacionados y la optimización de
telemetría). Ver [Pendiente de probar con MSFS](#pendiente-de-probar-con-msfs-real).

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `server/traffic.py` | 3ª conexión SimConnect (ctypes). Pide los aviones IA del radio cada 2 s, los limpia (`_ficha`), marca `activo` y los publica. Modo `--debug`: `run_debug` con flota falsa en formato AIG. |
| `server/jetphotos.py` | Foto por matrícula desde JetPhotos vía `tools/jetphotos-api` (127.0.0.1:8787). Arranque bajo demanda, una consulta a la vez, caché en `data/jetphotos_cache.json`. |
| `tools/jetphotos-api/` | Copia de roowus/Jetphotos-API (MIT, Node + wrangler). `npm install` lo hace `iniciar.bat`. |
| `app.py` | `/api/traffic`, `/api/jetphoto`, `/api/jetphoto_status`; `_cerrar_con_msfs`; telemetría por niveles (`SIMVARS_CADA_1S/3S/10S`, `_leer_sin_esperar`). |
| `static/js/traffic.js` | Capa del mapa, etiquetas HTML con logo, tarjeta, fotos (JetPhotos → Commons), botón "P". |
| `iniciar-con-msfs.pyw` | Lo lanza MSFS al abrir: `python.exe app.py` sin ventana, log en `data/msfs-live.log`. |
| `tools/medir_telemetria.py` | Mide `telemetry_loop` contra un SimConnect falso y lo compara con otro commit. |

## Flujo de datos

```
AIG Traffic Controller ──inyecta──▶ MSFS ──SimConnect (RequestDataOnSimObjectType, radio de la UI)──▶
server/traffic.py (_ficha + activo) ──/api/traffic cada 2 s──▶ traffic.js (extrapola a 4 Hz) ──▶ mapa

Foto al tocar un avión:
traffic.js fotoDe() ─▶ localStorage (exactas, 30 días)
                    └▶ /api/jetphoto ─▶ server/jetphotos.py ─▶ caché en disco ─▶ tools/jetphotos-api ─▶ JetPhotos
                    └▶ Wikimedia Commons (directo desde el navegador): matrícula, luego aerolínea + tipo
```

## Decisiones y por qué

- **Tráfico por SimConnect, no por la API de AIG.** AIG inyecta los aviones en MSFS, así que el
  simulador ya los tiene. AIG expone un servicio WCF en `localhost:8733/AIGTech/AIGTC/`, pero no está
  documentado y puede cambiar con cada versión. SimConnect funciona igual con FSLTL o el tráfico de MSFS.
- **Conexión ctypes propia** (como `live_airways.py`). El dispatcher de python-simconnect asocia cada
  respuesta a un único objeto por request id, y esta consulta devuelve uno por avión.
- **Radio**: el mismo de aeropuertos, con un tope de 200 km (~108 NM) que impone SimConnect.
  Se pide solo ese radio + 5 NM, y nada si nadie llamó a `/api/traffic` en 15 s.
- **Datos de AIG**: el callsign viene en `ATC ID` (que en MSFS suele ser la matrícula), el modelo
  con prefijo `$$:` y los estacionados con el vuelo de su librea ("AVIANCA AV-148"). `_ficha` lo
  limpia; las tablas `AEROLINEAS` y `TIPOS` traducen códigos.
- **Estacionados ocultos por defecto** (como un radar real): `activo` = en el aire, más de 2 kt o
  `GENERAL ENG COMBUSTION:1`. Si estuvo activo, sigue visible `MEMORIA_ACTIVO` (180 s).
- **Telemetría por niveles**: cada `aq.get` de python-simconnect espera ~1 frame. Solo las 7 variables
  de movimiento se esperan en cada vuelta; el resto se pide sin esperar cada 1/3/10 s. Usa partes
  internas de la librería (`find`, `_deff_test`, `request_data`, `outData`): **si se actualiza
  python-simconnect, revisar `_leer_sin_esperar`**. Se dejaron de leer flaps, spoilers, freno y
  piloto automático porque ninguna pantalla los usa.
- **Fotos**:
  - JetPhotos con permiso para uso universitario no comercial: una consulta a la vez, caché larga,
    crédito y enlace al fotógrafo.
  - Planespotters no sirve: no acepta pedidos desde el navegador (CORS) y prohíbe pasar por un
    servidor propio.
  - Wikimedia Commons es el respaldo, con licencias libres.
  - Si el tipo de la foto no coincide con el del simulador, la foto se marca como "Referencia"
    (`familiaAvion` / `chequearTipo`).
- **Arranque y cierre con MSFS**: el arranque usa `exe.xml`, el mecanismo oficial de MSFS, que no
  depende de la app. Al cerrar MSFS, la app guarda el vuelo, para JetPhotos (workerd queda huérfano
  si no se lo mata) y termina con `os._exit(0)`. `iniciar.bat` no pausa con el código 0.

## Fuera del repo (en esta PC)

- `%APPDATA%\Microsoft Flight Simulator\exe.xml`: entradas de **AIG Traffic Controller** y **MSFS Live
  Tracker** (`pythonw.exe` + `iniciar-con-msfs.pyw`). Respaldo del original: `exe.xml.bak-20261030`.
- `UserCfg.opt` de MSFS: estaba dañado (todo en ceros) y MSFS pedía reinstalar en C:. Se reparó con
  `InstalledPackagesPath "D:\FS2020"`. Respaldo: `UserCfg.opt.bak-rutaC-20261030`. Los ajustes
  gráficos pudieron volver a los de fábrica.
- Configuración de AIG (`D:\AIG_TrafficController\...exe.config`): vehículos de tierra apagados,
  radio reducido para MSFS y rango activo 50. Ya está pensada para no costar FPS.
- `data/msfs-live.log` y `data/jetphotos_cache.json`: ignorados por git.

## Cómo probar sin MSFS

- `iniciar-debug.bat`: avión propio en SKRG y flota falsa con 8 aviones en vuelo y 4 en tierra
  (2 apagados, 1 con motores encendidos y 1 rodando). Con el radio por defecto se ven 6 en vuelo.
- `/api/traffic?radius=60`: aviones + estado (`conectado`, `en_pausa`, `ruta_desactivada`, `ultimo_error`).
- `/api/jetphoto_status`: si el servicio está arriba, consultas, último error.
- `python tools/medir_telemetria.py [ref]`: compara la telemetría con otro commit.

## Pendiente de probar con MSFS real

1. **Telemetría**:
   - El avión propio se mueve más fluido.
   - El panel tiene datos: luces, combustible, autonomía, sim rate, mach y ETA.
   - El tiempo de vuelo avanza bien y se congela en pausa.
   - Los botones de luces responden en ~1 s.
2. **Tráfico**:
   - Si **no aparece ningún avión**, mirar `ultimo_error` en `/api/traffic`. La SimVar nueva
     `GENERAL ENG COMBUSTION:1` es la sospechosa: quitarla de `NUMEROS` en `server/traffic.py`.
   - Si los aviones aparecen recién al moverse (no al encender motores), MSFS no informa los
     motores de la IA: no es grave.
   - Si `ruta_desactivada` es `true`, AIG no da origen/destino: la tarjeta queda sin ruta.
3. **Fotos**:
   - ¿AIG pone la matrícula en el título del avión? Si no, solo habrá fotos "Referencia".
   - Con matrículas reales, ¿JetPhotos acierta el tipo?
4. **Cierre**: al cerrar MSFS se cierran la app y `workerd.exe` (puerto 8787 libre).

## Ideas para seguir

- Completar `AEROLINEAS` con las que salgan con AIG en Colombia. JEC (JetSMART Colombia) no
  está porque falta confirmar su código IATA.
- Galería de fotos en la tarjeta, o foto a pantalla completa.
- Filtros de tráfico: solo llegadas o salidas de un aeropuerto, solo en vuelo.
- Descartado por ahora (mucho esfuerzo para poca ganancia):
  - Telemetría en una sola definición periódica de SimConnect.
  - Separar los textos fijos del tráfico de la posición.
