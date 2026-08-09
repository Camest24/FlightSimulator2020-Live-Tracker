# MSFS Live Tracker — Plan de ruta (versión web / móvil / PWA)

Objetivo: que el tracker se abra en el celular o iPad como una app instalable, se
conecte solo a la PC que corre MSFS, y se vea fluido.

Arquitectura (no cambia): **Celular/iPad → (wifi) → PC con `app.py` → SimConnect → MSFS.**
El celular nunca habla con MSFS directo; solo abre la web que sirve la PC.

---

## Fase 0 — Confirmar la causa de los microcortes (test rápido, sin código)
- Abrir el tracker en el celular (`http://IP-DE-LA-PC:5001`) mientras se vuela en la PC.
- Si en el celular se ve **fluido** → la causa era la GPU compartida con el juego.
  El camino iPad/PWA es el correcto.
- Si en el celular **también** tartamudea → la causa es el código (recentrado por
  cuadro / poll), y se prioriza la Fase 2.
- **Decisión:** define si el foco va a "dispositivo aparte" o a "optimizar código".

## Fase 1 — Layout móvil (responsive)
- Panel de datos como hoja deslizable desde abajo (bottom sheet), colapsable.
- Botones y toggles más grandes para el dedo.
- Selector de capas a pantalla completa en móvil.
- Media queries: escritorio queda igual, móvil se reorganiza.
- **Entregable:** la interfaz se usa cómoda en celular y iPad.

## Fase 2 — Optimización de animación (sirve en todos los dispositivos)
- Reemplazar el recentrado por cuadro por `easeTo` de MapLibre (lineal, 1x por seg).
- Girar el ícono con transición CSS (hilo del compositor, aguanta bajones de fps).
- **Entregable:** movimiento más liviano y estable, incluso en la misma PC.

## Fase 3 — Pantalla de detección de conexión
- Landing que muestra dos estados: "Conectado al PC ✓" y "MSFS detectado ✓".
- Botón **"MSFS detectado — Abrir mapa"** cuando hay vuelo activo.
- Modo espera lindo mientras no haya conexión.
- **Entregable:** el flujo que pediste (abrís la API en la PC → aparece el botón).

## Fase 4 — Volverlo instalable (PWA)
- `manifest.json` (nombre, colores, modo standalone) + ícono.
- Service worker mínimo (pantalla completa + carga rápida).
- **Entregable:** "Agregar a inicio" en Safari/Chrome; abre como app nativa.

## Fase 5 — Detalles para volar con el celular
- Wake Lock: que no se apague la pantalla a mitad de vuelo.
- Recordar la dirección de la PC (no tipear IP cada vez).
- Reconexión automática si el wifi parpadea.
- QR al arrancar `app.py`: la PC muestra un código; el celular lo escanea y entra directo.
- **Entregable:** experiencia "abro y funciona", sin fricción.

## Fase 6 — (Opcional) Acceso fuera de casa
- Túnel tipo Tailscale para que el hermano vea la ruta desde otra red.
- Nota de seguridad (no exponer el puerto abierto a internet sin protección).
- Solo si se necesita; dentro de la misma casa no hace falta.

---

### Orden recomendado
Fase 0 (test) → 1 (móvil) → 2 (animación) → 3 (detección) → 4 (PWA) → 5 (detalles) → 6 (opcional).

Las fases 1-4 son el corazón: convierten esto en "app de celular" instalable y fluida.
