# MSFS Live Tracker

## Estado actual

- Proyecto funcional, en desarrollo activo hace varias semanas (Flask + MapLibre GL, single-page app). Corre local con `iniciar.bat`.
- `app.py` (2210 líneas): backend completo — bridge SimConnect, historial de vuelos, clima METAR, datos de navegación (aeropuertos/VOR de OurAirports), generador de rutas por aerovías, parser de plan de vuelo de MSFS, integración con SimBridge/CoRoute, y todos los endpoints `/api/*`. Ya tiene secciones bien delimitadas por comentarios `# ---`, pero vive entera en un solo archivo.
- `templates/index.html` (3556 líneas): todo el frontend en un solo archivo — ~554 líneas de CSS inline y ~2700 líneas de JS inline (mapa, cámara 3D de persecución, telemetría, plan de vuelo, historial, progreso). Al servirse con `render_template` (Jinja2, `debug=False`), cualquier cambio de JS/CSS requiere reiniciar el server entero para verse reflejado — esto causó confusión real y repetida durante el desarrollo (código "viejo" sirviéndose pese a haber sido editado).
- `live_airways.py` ya es un módulo aparte, extraído de `app.py` — es la prueba de que separar por responsabilidad funciona bien en este proyecto.
- `demo_medellin.py` depende de atributos de módulo de `app.py` (`appmod.state`, `appmod.lock`, `appmod.route`, `appmod.app`) — cualquier refactor del lado Python tiene que preservar esa superficie tal cual.
- Mockups viejos sueltos en la raíz (`mockup.html`, `maqueta-efb.html`, `vista-previa-espera.html`, `vista-previa-nuevo-diseno.html`), ya no en uso activo.
- Ya existe `ROADMAP-web.md` (features mobile/PWA) — sigue vigente y por separado; este documento no lo reemplaza.

## Objetivo de esta iniciativa

Reorganizar el proyecto en subcarpetas por responsabilidad, sin cambiar ningún comportamiento, para que:

1. Agregar una función nueva signifique tocar un archivo chico y previsible, no bucear en un archivo de miles de líneas.
2. Corregir un bug sea más rápido: menos scroll, menos contexto irrelevante por sesión (tuya o de un modelo).
3. El JS deje de sufrir el problema de caché de Jinja2 — al servirse como estático, cada cambio se ve con solo recargar la página, sin reiniciar el server.

## Alcance

- Dividir el `<script>` de `index.html` en varios archivos bajo `static/js/`.
- Dividir el `<style>` de `index.html` en `static/css/main.css`.
- Dividir `app.py` en un paquete `server/` por responsabilidad, siguiendo los cortes que ya marcan los comentarios `# ---` existentes.
- Mover los mockups viejos a `design/`.
- Cero cambios de comportamiento o funcionalidad — es puramente estructural.

## Fuera de alcance

- Cualquier feature nueva.
- Migrar a un framework de build (Webpack/Vite) o a JS modules (`type="module"`) — se mantienen `<script src>` clásicos para no cambiar cómo comparten variables globales hoy.
- Convertir Flask a blueprints formales (se puede evaluar después; no hace falta para el objetivo de esta iniciativa).

## Stack técnico (sin cambios)

- Backend: Python 3.9+, Flask, SimConnect (MSFS), requests.
- Frontend: HTML/CSS/JS vanilla, MapLibre GL JS 4.7.1, Three.js 0.128.0, Chart.js 4.4.1 — todo por CDN, sin bundler.

## Restricciones

- Tiene que seguir arrancando con `python app.py` / `iniciar.bat`, sin pasos de build adicionales.
- `demo_medellin.py` no puede dejar de funcionar (importa `app` como módulo y usa sus atributos).
- Nada de `type="module"` en los `<script>`: deben compartir el mismo scope global que hoy.

## Definición de "terminado"

- `index.html` con `<style>`/`<script>` inline reducidos a casi nada — todo lo demás en archivos separados.
- `app.py` reducido a la creación de la app Flask + registro de rutas; la lógica vive en `server/`.
- La app arranca igual (`iniciar.bat`), se ve y se comporta idéntica a hoy.
- Un cambio en, por ejemplo, la cámara 3D solo toca `static/js/plane-3d.js`, no un archivo de 3500 líneas.
