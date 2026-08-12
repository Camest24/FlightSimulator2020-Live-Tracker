# MSFS Live Tracker

Local web app that shows your Microsoft Flight Simulator 2020 flight live on a real
satellite map, Flightradar24-style. Built for a second monitor, a tablet, or to share
the link with someone on your same network.

## What it does

**The map**

- Vector map (MapLibre) with real satellite imagery and place names in white with a halo.
- 4 layers: satellite with labels (default), satellite, street map, dark map.
- Real airports and runways (data from OurAirports): each runway is drawn with its real
  length and orientation. Click to see ICAO, name, elevation, and runway.
- Real VORs with their frequency.
- Configurable radius (20 to 200 NM) around the aircraft and the destination airport.
  Outside that radius, if you zoom into an area, what's there still shows up, with a
  smooth fade as you zoom out.
- The map follows the aircraft. Tapping the map releases tracking; the toolbar button
  re-engages it.
- Compass in the bottom right: rotates with the map, tapping it resets to north.

**Data panel**

- Altitude, speed (with mach), vertical speed, heading, distance, flight time, fuel
  with estimated range, and real weather (METAR).
- Sim Rate: shows the simulation speed and lets you raise or lower it from the app.
- Aircraft status: gear, flaps, spoilers, parking brake, and lights, all actionable.
- Speed and altitude chart, with markers for the waypoints you've passed.

**Routes**

- Direct route to any airport from its popup.
- Route generator: chains real VORs between your position and the destination, looking
  for the shortest path that doesn't stray from the direct heading.
- Long-press anywhere on the map to draw a route there.
- Waypoints: inserted where they deviate the route the least.
- The route label shows distance, time, and heading to follow.
- If you built a flight plan on the MSFS world map, the app detects it and adopts the
  destination on its own (only if the file is recent and you're at its departure
  airport).

**Flight progress**

Optional panel (button on the top right toolbar) with origin and destination, progress
bar, distance covered and remaining, heading to follow, estimated arrival, descent
guidance, and distance to the next waypoint.

Estimated arrival works even with the aircraft stopped: it assumes a typical cruise
speed based on the engine type and switches to the real calculation as soon as you pass
40 knots.

Descent guidance uses the 3:1 rule (3 miles per 1000 feet to lose) and takes the
destination airport's elevation into account.

**History**

The flight is saved automatically when it ends: once you've taken off, landed, and been
stopped for about 45 seconds, it moves to history with its track, distance, duration,
and max altitude. The trail stays on screen so you can look at it; it only clears when
you take off again. It's also saved by tapping "Reset route" (without duplicating it if
it was already auto-saved).

You can check it from the history button and delete flights one by one.

**Beta**

- Teleport to any airport, choosing runway and whether you want to depart or arrive.
- Manual adjustment of altitude, heading, bank angle, and speed.

## Project layout

```
app.py            Flask app, shared simulator state, and all HTTP routes
server/           backend logic, split by responsibility
  core.py           shared state (state, route, locks) — read its header before moving code
  geo.py            distances, bearings, cross-track error
  navdata.py        airports, runways, VORs, waypoints and airways
  routing.py        VOR route generator and route-string parsing
  flight_store.py   current flight and history, on disk
  weather.py        METAR lookup
  msfs_plan.py      reads the .PLN you built in the MSFS world map
  simbridge.py      SimBridge / FlyByWire company routes
  live_airways.py   optional second SimConnect link for live airways
templates/        index.html (markup only)
static/css/       main.css
static/js/        the app's JavaScript, split into 8 modules — load order matters
tools/            developer tools (demo_medellin.py: fake flight, no MSFS needed)
docs/             SPECS, ROADMAP, CODESTYLE
design/           old design mockups, not part of the app
data/             downloaded nav data and saved flights (created on first run)
```

Editing anything under `static/` or `templates/` only needs a browser refresh —
no server restart. Python changes still need one (the demo restarts itself).

## Requirements

1. Python 3.9+
2. MSFS 2020 running (SimConnect is enabled by default).
3. Internet connection for satellite imagery, weather, and the initial download of
   airport and VOR data.

## Installation and usage

Double-click `iniciar.bat` (installs dependencies and starts the app). Or manually:

```
pip install -r requirements.txt
python app.py
```

Opens at http://localhost:5001

The first run downloads airport, runway, and VOR data (OurAirports) and saves it in
`data/` so it doesn't need to be downloaded again.

## Viewing it on another screen or device

From another computer or your phone: `http://YOUR-LOCAL-IP:5001`. Find your IP with
`ipconfig`, looking for "IPv4 Address".

## Live airways (optional)

The route generator uses a fixed airways file by default (2012 cycle). There's an
option for the app to request them live from MSFS while you fly, so they reflect what
the simulator has loaded at that moment (for example, if you have a Navigraph cycle
installed, those updated airways).

This needs a newer `SimConnect.dll` than the one the app ships with by default, since
the bundled one doesn't have the required functions. To enable it:

1. Install the **MSFS SDK** (free, from the simulator's own "Help" menu or from its
   website). By default it lands in
   `C:\MSFS SDK\SimConnect SDK\lib\SimConnect.dll` — the app already looks there on
   its own.
2. If your SDK ended up in a different folder, create the file
   `data/simconnect_dll_path.txt` with a single line: the full path to that
   `SimConnect.dll`.
3. Restart the app with MSFS running. You can check whether it kicked in at
   `http://localhost:5001/api/live_airways_status`.

If you don't do any of this, the app keeps working exactly as always (with the fixed
file) — this is an optional addition, not a requirement.

## Notes

- Airports and VORs are toggled from the layers button, top right.
- The current flight auto-saves to `data/current_flight.json`; history is kept in
  `data/flights_history.json`.
- The trail is capped at 6000 points: once it's exceeded, the older half is thinned
  out. An 8-hour flight would be over 100,000 points and the browser would crawl.
- Flights with fewer than 5 points or without real distance (teleports) aren't saved
  to history.
