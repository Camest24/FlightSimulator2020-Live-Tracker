"""Generador de rutas: encadena VOR reales entre origen y destino, y parsea rutas escritas a mano.

Extraido de app.py sin cambiarle una linea: mismas funciones, mismo comportamiento.
"""
import heapq
import re

from .geo import _haversine_nm, _bearing, _cross_track_nm
from .navdata import NAV, _vor_key, _vors_near


def generate_route(lat1, lon1, lat2, lon2, max_leg=300.0, close_nm=None,
                   corridor_nm=None, xtk_weight=2.5):
    """Búsqueda A* sobre la red de VOR. Devuelve la lista de puntos intermedios
    o None si no encontró camino con ese salto máximo.

    close_nm: qué tan cerca del destino hay que llegar para dar la ruta por terminada.
    Sin esto, la búsqueda cortaba apenas entraba en el radio de un salto y dejaba un
    tramo final larguísimo en línea recta."""
    import heapq

    if close_nm is None:
        close_nm = min(max_leg, 90.0)
    direct_nm = _haversine_nm(lat1, lon1, lat2, lon2)
    if corridor_nm is None:            # pasillo alrededor de la recta origen-destino
        corridor_nm = max(60.0, direct_nm * 0.18)
    LEG_PENALTY = 30.0                 # castigo por salto: prefiere rutas con menos puntos
    BEARING_WEIGHT = 1.2               # millas equivalentes por cada grado fuera de rumbo
    start = "@ORIGEN"
    best_g = {start: 0.0}
    came = {}                          # clave -> (clave_padre, lat, lon, ident)
    visited = set()
    heap = [(_haversine_nm(lat1, lon1, lat2, lon2), 0.0, start, lat1, lon1)]
    steps = 0

    while heap and steps < 40000:
        steps += 1
        _f, g, key, la, lo = heapq.heappop(heap)
        if key in visited:
            continue
        visited.add(key)

        if key != start and _haversine_nm(la, lo, lat2, lon2) <= close_nm:
            path = []                  # llegamos a tiro del destino: reconstruimos
            k = key
            while k != start:
                pk, plat, plon, ident = came[k]
                path.append({"id": ident, "lat": round(plat, 6), "lon": round(plon, 6)})
                k = pk
            path.reverse()
            return path

        for d, v in _vors_near(la, lo, max_leg):
            if d < 1:
                continue
            vk = _vor_key(v)
            if vk in visited:
                continue
            # Fuera del pasillo ni lo consideramos: así no manda a Barranquilla
            # cuando el destino está al norte.
            xtk = _cross_track_nm(lat1, lon1, lat2, lon2, v["lat"], v["lon"])
            if xtk > corridor_nm:
                continue
            # Cuánto se aparta este salto del rumbo directo al destino. Sin esto la
            # ruta arranca para el lado equivocado aunque el total dé parecido.
            diff = abs((_bearing(la, lo, v["lat"], v["lon"])
                        - _bearing(la, lo, lat2, lon2) + 180.0) % 360.0 - 180.0)
            if diff > 75.0:            # prácticamente ir para atrás
                continue
            ng = g + d + LEG_PENALTY + xtk_weight * xtk + BEARING_WEIGHT * diff
            if ng < best_g.get(vk, float("inf")):
                best_g[vk] = ng
                came[vk] = (key, v["lat"], v["lon"], v["id"])
                h = _haversine_nm(v["lat"], v["lon"], lat2, lon2)
                heapq.heappush(heap, (ng + h, ng, vk, v["lat"], v["lon"]))

    return None


def _path_len(lat1, lon1, wps, lat2, lon2):
    pts = [(lat1, lon1)] + [(w["lat"], w["lon"]) for w in wps] + [(lat2, lon2)]
    return sum(_haversine_nm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
               for i in range(len(pts) - 1))


def generate_route_auto(lat1, lon1, lat2, lon2, tolerance=1.15):
    """Prueba saltos cortos primero (muchos VOR, útil sobre tierra) y va agrandando
    hasta que el desvío sea aceptable. Sobre el mar no hay radioayudas, así que ahí
    termina eligiendo saltos largos por su cuenta."""
    direct = _haversine_nm(lat1, lon1, lat2, lon2)
    cands = []
    # Cada intento afloja dos cosas a la vez: cuánto puede medir un salto y cuán cerca
    # del destino hay que llegar antes de rendirse (sobre el mar hay que aflojar mucho).
    # Cada intento afloja el salto, la cercanía exigida al destino y el ancho del pasillo.
    # Se prueba primero lo más ceñido a la recta; solo si no hay camino se abre la mano.
    base = max(60.0, direct * 0.12)
    cap = max(150.0, direct * 0.30)          # tope al pasillo: nunca serpentea demasiado
    for max_leg, close_nm, corr in ((150.0, 60.0, base), (250.0, 90.0, base * 1.4),
                                    (350.0, 150.0, base * 2.0), (450.0, 300.0, base * 3.0),
                                    (600.0, 600.0, base * 5.0)):
        wps = generate_route(lat1, lon1, lat2, lon2, max_leg, close_nm, min(corr, cap))
        if wps is None:
            continue
        cands.append((_path_len(lat1, lon1, wps, lat2, lon2), wps, max_leg))

    if not cands:
        return None, 0.0, None

    def worst_turn(wps):
        """El giro más feo de la ruta respecto al rumbo directo. Sirve para descartar
        rutas que dan un volantazo al principio aunque el total cierre parecido."""
        worst, pla, plo = 0.0, lat1, lon1
        for w in wps:
            b_leg = _bearing(pla, plo, w["lat"], w["lon"])
            b_goal = _bearing(pla, plo, lat2, lon2)
            worst = max(worst, abs((b_leg - b_goal + 180.0) % 360.0 - 180.0))
            pla, plo = w["lat"], w["lon"]
        return worst

    straight = [c for c in cands if worst_turn(c[1]) <= 35.0]
    if straight:
        cands = straight
    # Entre las variantes que no se desvían más del 8%, preferimos la que MÁS puntos
    # tenga: queremos una ruta con referencias para volar, no una recta pelada.
    # Si ninguna entra en ese margen, nos quedamos con la más corta.
    budget = direct * tolerance
    good = [c for c in cands if c[0] <= budget]
    total, wps, leg = max(good, key=lambda c: (len(c[1]), -c[0])) if good \
        else min(cands, key=lambda c: c[0])

    # Limpieza final: si la ruta tiene varios puntos, sacamos los que estén pegados al
    # aeropuerto de salida o de llegada (no aportan nada, ya estás ahí). Si quedaría
    # vacía, la dejamos como está: en vuelos cortos ese VOR es la única referencia.
    if len(wps) > 1:
        trimmed = [w for w in wps
                   if _haversine_nm(lat1, lon1, w["lat"], w["lon"]) >= 12
                   and _haversine_nm(lat2, lon2, w["lat"], w["lon"]) >= 12]
        if trimmed:
            wps = trimmed
            total = _path_len(lat1, lon1, wps, lat2, lon2)
    return wps, total, leg


# ---------------------------------------------------------------------------
# Interpretar una ruta escrita, del estilo "SKRG DCT RNG UA321 ISVON DCT SKCL"
# ---------------------------------------------------------------------------
# Es el formato que devuelven RouteFinder, SkyVector, SimBrief y compañía. Resolvemos
# cada palabra contra las tres bases que tenemos: aeropuertos, radioayudas e
# intersecciones. Las aerovías (UA321) no las podemos expandir: no hay fuente gratis con
# sus puntos intermedios, así que las anotamos y seguimos de largo.
_AIRWAY_RE = re.compile(r"^[A-Z]{1,3}\d{1,4}[A-Z]?$")   # UA321, J50, V16, UM789...


_SKIP = {"DCT", "SID", "STAR", "IFR", "VFR", "DIRECT"}


def _resolve_token(tok, ref):
    """Busca un identificador en las tres bases. 'ref' es el último punto resuelto, y
    sirve para desempatar cuando el nombre existe en varios países."""
    cands = []
    for a in NAV["airports"]:
        if a["icao"].upper() == tok:
            cands.append({"id": a["icao"], "lat": a["lat"], "lon": a["lon"], "kind": "apt",
                          "name": a.get("name") or a["icao"]})
    for v in NAV["vors"]:
        if (v["id"] or "").upper() == tok:
            cands.append({"id": v["id"], "lat": v["lat"], "lon": v["lon"], "kind": "vor",
                          "name": v.get("name") or v["id"]})
    for w in NAV["waypoints"].get(tok, ()):
        cands.append({"id": w["id"], "lat": w["lat"], "lon": w["lon"], "kind": "wpt",
                      "name": w["id"]})
    if not cands:
        return None
    if ref is None or len(cands) == 1:
        return cands[0]
    return min(cands, key=lambda c: _haversine_nm(ref["lat"], ref["lon"], c["lat"], c["lon"]))


def parse_route_string(text):
    toks = [t.strip().upper() for t in re.split(r"[\s,]+", text or "") if t.strip()]
    puntos, aerovias, desconocidos = [], [], []
    ref = None
    for t in toks:
        if t in _SKIP:
            continue
        if _AIRWAY_RE.match(t) and t not in NAV["waypoints"]:
            aerovias.append(t)          # es una aerovía: no tenemos sus puntos intermedios
            continue
        p = _resolve_token(t, ref)
        if p:
            if not puntos or puntos[-1]["id"] != p["id"]:
                puntos.append(p)
                ref = p
        else:
            desconocidos.append(t)
    return puntos, aerovias, desconocidos


def _resumen_aerovias(pts):
    """Compacta la lista de puntos en 'por qué aerovías va', sin repetir."""
    out = []
    for p in pts:
        v = p.get("via")
        if v and (not out or out[-1] != v):
            out.append(v)
    return out


def _comprimir(pts, lat2, lon2, max_pts=28):
    """Quita solo los puntos que no aportan: los que caen prácticamente sobre la recta
    entre su anterior y su siguiente. Los cambios de aerovía y cualquier giro real se
    conservan, para que la ruta se vea completa y no como cuatro puntos sueltos."""
    # Un plan real lista TODOS los puntos de la aerovía, así que por defecto no tocamos
    # nada. Solo entramos a podar si la lista se vuelve inmanejable.
    if len(pts) <= max_pts:
        return pts
    # Son demasiados: nos quedamos con los cambios de aerovía (que nunca se pierden) y
    # repartimos el resto de forma pareja a lo largo de la ruta. Así queda una lista
    # legible que sigue representando el trazado completo, sin colapsar a cuatro puntos.
    claves = {0, len(pts) - 1}
    for i in range(1, len(pts) - 1):
        if pts[i].get("via") != pts[i - 1].get("via"):
            claves.add(i)
    libres = max_pts - len(claves)
    if libres > 0:
        resto = [i for i in range(1, len(pts) - 1) if i not in claves]
        if resto:
            paso = max(1, len(resto) / float(libres))
            for j in range(libres):
                idx = int(j * paso)
                if idx < len(resto):
                    claves.add(resto[idx])
    return [pts[i] for i in sorted(claves)]
