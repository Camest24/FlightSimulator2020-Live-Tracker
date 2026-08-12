"""Calculos geograficos puros: distancias, rumbos y desvio lateral respecto a una derrota.

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import math


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
def _haversine_nm(lat1, lon1, lat2, lon2):
    R_NM = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(a))


def _flat_distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _bearing(lat1, lon1, lat2, lon2):
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = (math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
         - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1)))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _cross_track_nm(lat1, lon1, lat2, lon2, lat3, lon3):
    """Distancia perpendicular del punto 3 a la línea recta que va del 1 al 2.
    Es la medida de 'cuánto te desviás del rumbo directo'."""
    R = 3440.065
    d13 = _haversine_nm(lat1, lon1, lat3, lon3) / R
    if d13 <= 0:
        return 0.0
    b13 = math.radians(_bearing(lat1, lon1, lat3, lon3))
    b12 = math.radians(_bearing(lat1, lon1, lat2, lon2))
    s = math.sin(d13) * math.sin(b13 - b12)
    return abs(math.asin(max(-1.0, min(1.0, s))) * R)
