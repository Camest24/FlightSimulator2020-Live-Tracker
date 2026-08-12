# Roadmap — Reorganización en subcarpetas

Iniciativa puntual: dividir el proyecto en varias subcarpetas para que agregar features y corregir bugs sea más simple. Ver `SPECS.md` para el alcance completo. No reemplaza a `ROADMAP-web.md` (features mobile/PWA) — ese sigue su propio camino, en paralelo.

## Ya completado

- [x] `live_airways.py` ya extraído de `app.py` como módulo aparte — usar como referencia del patrón a seguir.
- [x] `data/` ya separado del código (cache de aeropuertos/VOR, historial, vuelo actual).
- [x] `iniciar.bat` e `iniciar-demo.bat` ya matan cualquier proceso viejo en el puerto 5001 antes de arrancar — quita el riesgo de "servidor viejo" mientras se itera durante esta reorganización.

## Fase 0 — Limpieza de raíz (riesgo cero, primero) ✅

- [x] Crear carpeta `design/` y mover ahí `mockup.html`, `maqueta-efb.html`, `vista-previa-espera.html`, `vista-previa-nuevo-diseno.html` (prototipos viejos). Verificado antes de mover: la única llamada a `render_template` en todo el proyecto es `render_template("index.html")` (app.py:1128) — ninguno de los mockups se servía desde una ruta activa.
- [x] `design/README.md` explicando qué es cada maqueta y que no forman parte de la app.
- [x] Verificado después de mover: `app.py`, `demo_medellin.py` y `live_airways.py` compilan, y no queda ninguna referencia a los archivos movidos.

## Fase 1 — CSS a estático (riesgo bajo) ✅

- [x] Movido el bloque `<style>` de `index.html` (líneas 17–571, 553 líneas de CSS) a `static/css/main.css`, tal cual, sin retocar reglas.
- [x] Reemplazado por `<link rel="stylesheet" href="/static/css/main.css">`.
- [x] Verificado: `index.html` pasó de 3557 a 3003 líneas, no quedan bloques `<style>`, llaves balanceadas (368/368), los 5 bloques `<script>` intactos, y un smoke test de Flask confirma que `/` sirve el link y `/static/css/main.css` responde 200 con `text/css`.
- Nota: `_no_cache` (app.py) aplica a TODAS las respuestas, incluidos los estáticos — así que un F5 ya trae el CSS fresco sin reiniciar el servidor.

## Fase 2 — JS a estático, dividido por responsabilidad ✅

Extraído el `<script>` grande (2708 líneas) a 8 archivos en `static/js/`, cortando por los marcadores de sección `// ----` que ya existían. Orden de carga = orden original de escritura: **no reordenar los `<script src>` del HTML.**

- [x] `map-setup.js` (38) — estilo del mapa, capas de etiquetas, creación de la instancia MapLibre.
- [x] `plane-3d.js` (336) — capa custom 3D: modelo del avión, estela con altitud real, anclaje al terreno.
- [x] `geo-utils.js` (116) — distancias, rumbos, proyección de puntos.
- [x] `flight-progress.js` (660) — ETA, barra estilo FR24, guía y tabla de descenso, próximo punto.
- [x] `flightplan.js` (515) — menú al mantener pulsado, plan de MSFS, generador por VOR, sim rate.
- [x] `telemetry.js` (513) — odómetro, `poll()`, buffer de interpolación, y la cámara de seguimiento (`planeFrame`/`chaseCenterFor` viven acá porque corren en el mismo bucle por frame).
- [x] `graph-panel.js` (175) — gráfico de velocidad/altitud, ventana visible, controles.
- [x] `tools-ui.js` (355) — company route, buscador, panel de estado, averías, historial, wake lock, tamaño de paneles.
- [x] `index.html` pasó de 3003 a 303 líneas (solo queda inline el script de escala de UI, que debe correr antes de pintar).
- [x] Verificado: los 8 archivos parsean como scripts válidos; el diff contra git confirma que no se perdió ninguna línea de código (las 21 diferencias son cambios previos sin commitear: `maxPitch:80`, `flags.terrain3d`, `finiteNum` en `buf.push`, `altColor` refactorizado); smoke test de Flask confirma HTTP 200 en los 8 más `main.css`.
- [x] Verificado el riesgo de hoisting: al dividir en varios `<script>`, las `function` ya no se hoistean entre archivos. Se analizaron las 241 declaraciones de nivel superior — ninguna sentencia que corra **en carga** llama a algo declarado en un archivo posterior (las 3 coincidencias son llamadas dentro de callbacks, que corren después de que cargó todo).
- [ ] Pendiente: probar en vivo (Terreno 3D, cámara, ruta, historial) — requiere reiniciar el servidor una vez, porque cambió `index.html` (plantilla Jinja2 cacheada). De ahí en adelante, los cambios de JS se ven con solo F5.

## Fase 3 — Python: extraer `server/` ✅ (con dos desvíos respecto al plan original)

`app.py` pasó de 2210 a 1163 líneas. Ninguna línea de lógica modificada: solo movidas de lugar.

- [x] `server/core.py` (70) — `state`, `route`, `lock`, `sim_lock`, `MAX_ROUTE_POINTS` y rutas de archivo. Existe para que los módulos de `server/` accedan al estado sin importar `app.py` (import circular).
- [x] `server/geo.py` (41) — `_haversine_nm`, `_flat_distance`, `_bearing`, `_cross_track_nm`.
- [x] `server/weather.py` (38) — `fetch_nearest_metar`.
- [x] `server/flight_store.py` (118) — vuelo actual e historial en disco.
- [x] `server/msfs_plan.py` (135) — `read_msfs_plan`, `_parse_world_position`, `_find_pln`.
- [x] `server/routing.py` (233) — `generate_route`, `generate_route_auto`, `parse_route_string`.
- [x] `server/simbridge.py` (271) — `find_simbridge_exe`, `simbridge_status`, `build_coroute_xml`.
- [x] `server/navdata.py` (366) — aeropuertos, pistas, VOR, waypoints **y aerovías**.

### Desvío 1: `navdata` y `airways` van juntas, no separadas

`load_navdata()` llama a `load_airways()`/`load_waypoints()`, y esas leen `NAV`. Separarlas creaba un import circular real. Un solo módulo es más simple que romper el ciclo artificialmente.

### Desvío 2: el núcleo del simulador y las rutas HTTP se quedan en `app.py` — a propósito

Diez variables de módulo (`sim_aq`, `sim_events`, `prev_sim_clock`, `prev_wall_clock`, `last_save`, `last_pos_t`, `last_weather_fetch`, `fue_al_aire`, `quieto_desde`, `vuelo_archivado`) se **reasignan** con `global`. Mover a otro módulo una función que hace `global sim_aq` rebindea el nombre **en ese módulo**: el resto del programa seguiría viendo `None` para siempre, sin error ni traza. Un análisis del AST identificó las 11 funciones atadas a ese estado — `telemetry_loop`, `teleport_aircraft`, `set_autopilot`, `set_aircraft`, `set_sim_time`, `trigger_event`, `api_gear`, `_gear_down`, `_engines_idle`, `_revisar_fin_de_vuelo`, `api_reset` — y todas quedan juntas.

Los `@app.route` también se quedan: `app = Flask(__name__)` vive en `app.py` porque de ahí sale la resolución de `templates/` y `static/`; moverlo requeriría blueprints, que están fuera de alcance (ver `SPECS.md`).

**Si algún día se quiere terminar de dividir esto**, no alcanza con mover funciones: hay que convertir esas 10 variables a atributos de un objeto o módulo compartido (`core.sim_aq = ...` en vez de `global sim_aq`). Es mecánico, pero ya no es un refactor "sin cambiar una línea".

### Verificación (automatizada, contra una foto tomada antes de empezar)

- [x] 23 rutas HTTP idénticas, antes y después.
- [x] Las 75 funciones de nivel superior siguen accesibles como `app.<nombre>` (re-exportadas).
- [x] Funciones puras (`_haversine_nm`, `_bearing`, `_cross_track_nm`, `_xml_esc`, `_parse_world_position`…) devuelven exactamente los mismos valores.
- [x] `demo_medellin.py` importa y comparte el **mismo objeto** `state`.
- [x] `GET /` y `GET /api/state` responden 200.
- [x] Ningún módulo de `server/` importa `app.py` (sin ciclos) ni declara `global` sobre estado compartido.
- [ ] **Pendiente: probar con MSFS de verdad.** La verificación de arriba corre sin SimConnect, así que no ejercita teleporte, luces, autopiloto ni el `telemetry_loop`. Si algo falla ahí, revertir solo esta fase: `git revert <sha de la Fase 3>`.

## Fase final — Confirmación

- [ ] `iniciar.bat` arranca sin errores con MSFS abierto; un vuelo real se ve y se comporta igual.
- [x] `demo_medellin.py` sigue funcionando sin cambios.
- [x] Commits de la reorganización separados de los fixes funcionales (ver `CODESTYLE.md`).
