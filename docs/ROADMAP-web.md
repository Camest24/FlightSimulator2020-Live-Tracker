# MSFS Live Tracker — Roadmap (web / mobile / PWA version)

Goal: get the tracker to open on a phone or iPad as an installable app, connect on its
own to the PC running MSFS, and feel smooth.

Architecture (unchanged): **Phone/iPad → (wifi) → PC running `app.py` → SimConnect →
MSFS.** The phone never talks to MSFS directly; it only opens the web page served by
the PC.

---

## Phase 0 — Confirm the cause of the micro-stutters (quick test, no code)
- Open the tracker on the phone (`http://PC-IP:5001`) while flying on the PC.
- If it looks **smooth** on the phone → the cause was the GPU shared with the game.
  The iPad/PWA path is the right one.
- If the phone **also** stutters → the cause is in the code (per-frame recentering /
  polling), and Phase 2 becomes the priority.
- **Decision:** determines whether the focus goes to "separate device" or "optimize
  code".

## Phase 1 — Mobile layout (responsive)
- Data panel as a bottom sheet, collapsible.
- Bigger buttons and toggles for touch.
- Full-screen layer selector on mobile.
- Media queries: desktop stays the same, mobile reorganizes.
- **Deliverable:** the interface is comfortable to use on phone and iPad.

## Phase 2 — Animation optimization (helps on every device)
- Replace per-frame recentering with MapLibre's `easeTo` (linear, 1x per second).
- Rotate the icon with a CSS transition (compositor thread, holds up under fps drops).
- **Deliverable:** lighter, more stable movement, even on the same PC.

## Phase 3 — Connection detection screen
- Landing page showing two states: "Connected to PC ✓" and "MSFS detected ✓".
- **"MSFS detected — Open map"** button when there's an active flight.
- A nice waiting mode while there's no connection.
- **Deliverable:** the flow you asked for (open the API on the PC → the button
  appears).

## Phase 4 — Make it installable (PWA)
- `manifest.json` (name, colors, standalone mode) + icon.
- Minimal service worker (full screen + fast load).
- **Deliverable:** "Add to Home Screen" on Safari/Chrome; opens like a native app.

## Phase 5 — Details for flying with your phone
- Wake Lock: keep the screen from turning off mid-flight.
- Remember the PC's address (no typing the IP every time).
- Automatic reconnection if wifi blips.
- QR code on `app.py` startup: the PC shows a code; the phone scans it and connects
  directly.
- **Deliverable:** an "open it and it works" experience, no friction.

## Phase 6 — (Optional) Access from outside the house
- Tailscale-style tunnel so a family member can see the route from another network.
- Security note (don't expose the open port to the internet without protection).
- Only if needed; not required within the same house.

---

### Recommended order
Phase 0 (test) → 1 (mobile) → 2 (animation) → 3 (detection) → 4 (PWA) → 5 (details) →
6 (optional).

Phases 1-4 are the core: they turn this into an installable, smooth "phone app".
