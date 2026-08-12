# Code Style — MSFS Live Tracker

Documenta las convenciones que el proyecto YA usa (para no perderlas al mover código), más los ajustes puntuales para la reorganización en subcarpetas.

## Ya vigente en el proyecto (no cambia)

- Comentarios en **español**, explicando el "por qué" — casi todo comentario largo en `app.py` e `index.html` cuenta una decisión de diseño o un bug ya resuelto, no describe lo obvio. Ese estilo es intencional y vale oro para retomar el código meses después: no traducir, resumir de más, ni "limpiar" al mover.
- Python: 4 espacios de indentación, `snake_case`, secciones delimitadas con comentarios `# ---------------------------------------------------------------------------` seguidos de un título — este patrón ya existe en `app.py` y define los cortes naturales para dividirlo en módulos (ver `ROADMAP.md`, Fase 3).
- JS: 2 espacios de indentación, `camelCase`, punto y coma siempre.
- Sin frameworks de build: JS y CSS se sirven directo (por CDN o estático), sin paso de compilación.
- `<script>` clásicos, no `type="module"`: todo el JS comparte el mismo scope global de la página, y varias partes dependen de eso (variables `let`/`const` de nivel superior usadas entre secciones que hoy están una debajo de la otra en el mismo archivo).

## Reglas nuevas para esta reorganización

- Cada archivo nuevo bajo `server/` o `static/js/` mantiene el mismo estilo de comentarios (español, explican decisiones) — no perder contexto al mover código de un lado a otro.
- Al extraer una sección de `app.py` a `server/algo.py`, el comentario de sección `# ---` original se convierte en el docstring o comentario de cabecera del nuevo archivo.
- `static/js/*.js` se referencia con `<script src="/static/js/archivo.js"></script>`, en el mismo orden en que aparecía dentro del `<script>` original — el orden importa porque el scope es compartido.
- Ningún archivo nuevo de `server/` puede romper `demo_medellin.py`: `app.state`, `app.lock`, `app.route` y `app.app` (la instancia Flask) tienen que seguir siendo accesibles exactamente igual desde `app.py` después de dividirlo (re-exportar si hace falta).
- Cambios estructurales (mover código de lugar) y cambios de comportamiento (arreglar un bug) van en commits separados — no mezclar un refactor con una corrección funcional en el mismo commit, para poder revertir uno sin el otro.
