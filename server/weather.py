"""Clima real: busca el METAR de la estacion mas cercana.

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import json
import urllib.request
import urllib.parse

from .geo import _flat_distance


# ---------------------------------------------------------------------------
# Clima real (METAR)
# ---------------------------------------------------------------------------
def fetch_nearest_metar(lat, lon):
    d = 1.0
    url = (
        "https://aviationweather.gov/api/data/metar"
        f"?bbox={lat - d},{lon - d},{lat + d},{lon + d}&format=json"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "msfs-tracker/1.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            stations = json.loads(resp.read().decode("utf-8"))
        if not stations:
            return None
        best = min(
            stations,
            key=lambda s: _flat_distance((lat, lon), (s.get("lat", 0), s.get("lon", 0))),
        )
        return {
            "station": best.get("icaoId"),
            "temp_c": best.get("temp"),
            "wind_kt": best.get("wspd"),
            "wind_dir": best.get("wdir"),
        }
    except Exception:
        return None
