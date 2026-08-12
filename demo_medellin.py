"""
Demo sin MSFS: un avión da vueltas sobre Medellín a ~10.000 ft, variando su altitud
(sube y baja entre 7.500 y 12.500 ft mientras circula), para poder probar en vivo los
arreglos de terreno 3D (modelo pegado al piso, estela por altitud, cámara sin temblor)
sin tener que volar de verdad.

Uso:
    python demo_medellin.py
    (o doble clic en iniciar-demo.bat)

Después abrí http://localhost:5001 en el navegador y activá "Terreno 3D" en el menú
de capas (el mismo botón de siempre). Dejalo correr un par de vueltas completas (cada
vuelta son 4 min) para ver el tramo de la estela subiendo y bajando de altura.

Reutiliza el Flask app y el `state`/`route` de app.py tal cual — por eso todo lo demás
de la interfaz (combustible, luces, AP, etc.) también se ve poblado con datos de
mentira, coherentes entre sí, en vez de quedar en blanco.
"""
import math
import threading
import time

from flask import jsonify, request

import app as appmod

# Centro del círculo: el valle de Medellín, cerca del centro de la ciudad.
CENTER_LAT = 6.2442
CENTER_LON = -75.5812
RADIUS_NM = 8.0             # radio del círculo
LAP_SECONDS = 240.0         # tiempo por vuelta completa (4 min) -> rumbo cambia todo el tiempo
ALT_CENTER_FT = 10000.0     # altitud media pedida
ALT_AMPLITUDE_FT = 2500.0   # sube/baja entre 7.500 y 12.500 ft
ALT_PERIOD_SECONDS = 150.0  # tiempo por ciclo completo de subida+bajada
TICK_S = 0.25               # 4 lecturas/seg, igual que el telemetry_loop real
KT_GS = 180.0
NM_PER_DEG_LAT = 60.0

# ---- Pausa (exclusiva de esta demo, no existe en app.py) ------------------------------
# Congela el "reloj" de la simulación (t) en vez de tocar lat/lon/alt directamente: como
# TODO en fake_telemetry se deriva de t (posición, rumbo, altitud, distancia acumulada,
# hora local), basta con dejar de avanzarlo para que el avión quede clavado en el aire tal
# cual estaba, sin necesidad de ramas especiales en cada cálculo.
demo_paused = False
pause_lock = threading.Lock()
pause_started_at = None     # time.time() de cuando arrancó la pausa actual
paused_total = 0.0          # segundos ya descontados por pausas anteriores

DEMO_CONTROLS_HTML = """
<div id="demo-pause-widget" style="position:fixed;bottom:16px;right:16px;z-index:99999;font-family:system-ui,sans-serif;">
  <button id="demo-pause-btn" style="background:#1e293b;color:#fbbf24;border:1px solid #fbbf24;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);">&#9208; Pausar demo</button>
</div>
<script>
(function(){
  var btn=document.getElementById('demo-pause-btn');
  function setLabel(paused){ btn.textContent = paused ? '\\u25B6 Reanudar demo' : '\\u23F8 Pausar demo'; }
  btn.onclick=function(){
    btn.disabled=true;
    fetch('/api/demo_pause',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
      setLabel(d.paused);
    }).finally(function(){ btn.disabled=false; });
  };
})();
</script>
"""


@appmod.app.after_request
def _inject_demo_controls(resp):
    # Solo toca la respuesta de "/": el resto de las rutas (API, estáticos) queda intacto.
    # Así el botón vive enteramente acá, sin tocar templates/index.html.
    if request.path == "/" and (resp.content_type or "").startswith("text/html"):
        html = resp.get_data(as_text=True)
        if "</body>" in html:
            resp.set_data(html.replace("</body>", DEMO_CONTROLS_HTML + "</body>"))
    return resp


@appmod.app.route("/api/demo_pause", methods=["POST"])
def demo_pause_toggle():
    global demo_paused, pause_started_at, paused_total
    with pause_lock:
        now = time.time()
        if demo_paused:
            paused_total += now - pause_started_at
            pause_started_at = None
            demo_paused = False
        else:
            pause_started_at = now
            demo_paused = True
        return jsonify({"paused": demo_paused})


def _circle_point(t):
    """Posición sobre el círculo (lat, lon) y rumbo de avance, en el instante t (seg)."""
    ang = (t / LAP_SECONDS) * 2 * math.pi
    dlat = (RADIUS_NM / NM_PER_DEG_LAT) * math.cos(ang)
    dlon = (RADIUS_NM / (NM_PER_DEG_LAT * math.cos(math.radians(CENTER_LAT)))) * math.sin(ang)
    lat = CENTER_LAT + dlat
    lon = CENTER_LON + dlon
    dang = 2 * math.pi / LAP_SECONDS
    dlat_dt = -(RADIUS_NM / NM_PER_DEG_LAT) * math.sin(ang) * dang
    dlon_dt = (RADIUS_NM / (NM_PER_DEG_LAT * math.cos(math.radians(CENTER_LAT)))) * math.cos(ang) * dang
    hdg = math.degrees(math.atan2(dlon_dt * math.cos(math.radians(CENTER_LAT)), dlat_dt)) % 360
    return lat, lon, hdg


def _altitude(t):
    ang = (t / ALT_PERIOD_SECONDS) * 2 * math.pi
    return ALT_CENTER_FT + ALT_AMPLITUDE_FT * math.sin(ang)


def fake_telemetry():
    t0 = time.time()
    prev_alt = None
    prev_t = None
    with appmod.lock:
        appmod.state["flight_start"] = t0
        appmod.state["elapsed_min"] = 0
        appmod.route.clear()
        appmod.state["distance_nm"] = 0.0
        appmod.state["max_alt"] = 0

    while True:
        now = time.time()
        with pause_lock:
            paused = demo_paused
            # Reloj de la sim: en pausa queda clavado en el instante en que empezó (no en
            # "now"), así el avión no salta para adelante quieto en el aire mientras espera.
            clock_now = pause_started_at if paused else now
            t = clock_now - t0 - paused_total
        lat, lon, hdg = _circle_point(t)
        alt = _altitude(t)
        vs = 0.0
        if not paused and prev_alt is not None and prev_t is not None:
            dt = max(0.01, now - prev_t)
            vs = (alt - prev_alt) / dt * 60.0   # ft/min
        prev_alt, prev_t = alt, now

        with appmod.lock:
            s = appmod.state
            s["connected"] = True
            s["lat"] = lat
            s["lon"] = lon
            s["alt"] = alt
            s["heading"] = hdg
            s["gs"] = 0.0 if paused else KT_GS
            s["ias"] = 0.0 if paused else KT_GS - 10
            s["vs"] = vs
            s["pausado"] = paused
            s["on_ground"] = False
            s["gear_pct"] = 0.0
            s["flaps_pct"] = 0.0
            s["flaps_index"] = 0
            s["spoilers_pct"] = 0.0
            s["parking_brake"] = False
            s["eng_type"] = 1
            s["eng_count"] = 2
            s["aircraft"] = "Demo A320"
            s["mach"] = 0.32
            s["sim_rate"] = 1.0
            s["local_time"] = (t0 + t) % 86400
            s["reloj_sim"] = s["local_time"]
            s["magvar"] = -6.0
            s["fplan"] = None
            s["lights"] = {"landing": False, "beacon": True, "strobe": True, "nav": True, "taxi": False}
            s["ap"] = {"master": True, "hdg_lock": True, "alt_lock": True, "spd_lock": True,
                       "hdg": hdg, "alt": alt, "spd": KT_GS}
            s["fuel_gal"] = 500.0
            s["fuel_capacity"] = 1000.0
            s["fuel_flow_gph"] = 150.0
            s["endurance_min"] = (500.0 / 150.0) * 60.0
            s["max_alt"] = max(s["max_alt"], alt)
            s["elapsed_min"] = t / 60.0
            s["weather"] = None

            # En pausa lat/lon no cambian (t está clavado): no sumamos distancia ni
            # apilamos puntos de ruta duplicados en el buffer.
            if not paused:
                if appmod.route:
                    last = appmod.route[-1]
                    s["distance_nm"] += appmod._haversine_nm(last[0], last[1], lat, lon)
                appmod.route.append([lat, lon, alt])
                if len(appmod.route) > appmod.MAX_ROUTE_POINTS:
                    del appmod.route[: len(appmod.route) - appmod.MAX_ROUTE_POINTS]

        time.sleep(TICK_S)


if __name__ == "__main__":
    threading.Thread(target=fake_telemetry, daemon=True).start()
    threading.Thread(target=appmod.load_navdata, daemon=True).start()
    print("Demo: avion dando vueltas sobre Medellin, entre 7.500 y 12.500 ft.")
    print("Abri http://localhost:5001 y activa Terreno 3D en el menu de capas.")
    appmod.app.run(host="0.0.0.0", debug=False, port=5001, use_reloader=False)
