"""Modulos del backend de MSFS Live Tracker.

Separados de app.py por responsabilidad. app.py conserva la instancia Flask, el estado
compartido del simulador y todas las rutas HTTP; aca vive la logica que no depende de
ese estado mutable (ver server/core.py y el comentario de cabecera de app.py).
"""
