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

## Fase 3 — Python: extraer `server/` (más riesgo, un módulo a la vez)

Seguir los cortes que ya marcan los comentarios `# ---` en `app.py`. Cada bullet es un módulo; se prueba antes de seguir con el siguiente:

- [ ] `server/simconnect_bridge.py` — conexión SimConnect, `telemetry_loop`, `teleport_aircraft`, `set_autopilot`, `set_aircraft`, `set_sim_time`.
- [ ] `server/flight_history.py` — `load_current_flight`, `save_current_flight`, `archive_flight_to_history`, `read_history`/`write_history`.
- [ ] `server/weather.py` — `fetch_nearest_metar`, `_update_weather`.
- [ ] `server/navdata.py` — `load_navdata`, aeropuertos/VOR, `nearest_airport`, `_vors_near`.
- [ ] `server/routing.py` — `generate_route`, `generate_route_auto`, `route_by_airways`, `parse_route_string`.
- [ ] `server/msfs_plan.py` — `read_msfs_plan`, `_parse_world_position`, `_find_pln`.
- [ ] `server/simbridge.py` — `find_simbridge_exe`, `simbridge_status`, `build_coroute_xml`.
- [ ] `server/routes.py` — todos los `@app.route`, delgados, llamando a los módulos de arriba.
- [ ] `app.py` queda solo con la creación de la app Flask, registro de rutas y arranque de threads — con `state`, `lock`, `route` re-exportados igual que hoy para no romper `demo_medellin.py`.
- [ ] Después de CADA módulo extraído: arrancar la app real y confirmar que un vuelo se ve y se comporta igual — no esperar a tener todo dividido para probar.

## Fase final — Confirmación

- [ ] `iniciar.bat` arranca sin errores; la app se ve y funciona idéntica a antes de la reorganización.
- [ ] `demo_medellin.py` sigue funcionando sin cambios.
- [ ] Commit de la reorganización separado de cualquier fix funcional (ver `CODESTYLE.md`).
