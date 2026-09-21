"""Synthetic backend -- everything the console can show, without a robot.

Deliberately generates *plausible* data rather than zeros: a floor plan with
rooms and furniture that reveals as the robot walks, four camera feeds with
different characters (front / side / rear / night vision), motor temperatures
that rise while driving, incidents that accumulate, and a scenario that walks
through every alert state so an operator can see each one without staging it.

Nothing here can command hardware: no robot client, no DDS, no WebRTC.
"""
from __future__ import annotations

import io
import math
import random
import threading
import time
import uuid
from collections import deque

RES = 0.05
W = H = 220
ORIGIN_X = ORIGIN_Y = -5.5
REVEAL_RADIUS_M = 2.8

_now = time.time


# ---------------------------------------------------------------------------
# Floor plan
# ---------------------------------------------------------------------------

truth_floor = [0] * (W * H)
truth_walls = [0] * (W * H)
revealed = [False] * (W * H)


def _w2g(x, y):
    return int((x - ORIGIN_X) / RES), int((y - ORIGIN_Y) / RES)


def _fill(x0, y0, x1, y1, height_m):
    gx0, gy0 = _w2g(min(x0, x1), min(y0, y1))
    gx1, gy1 = _w2g(max(x0, x1), max(y0, y1))
    bucket = min(255, 30 + int(round(min(height_m, 2.5) / 2.5 * 225)))
    for gy in range(max(0, gy0), min(H, gy1 + 1)):
        for gx in range(max(0, gx0), min(W, gx1 + 1)):
            i = gy * W + gx
            truth_floor[i] = 100
            truth_walls[i] = max(truth_walls[i], bucket)


def _build():
    T = 0.12
    _fill(-5, -5, 5, -5 + T, 2.4)
    _fill(-5, 5 - T, 5, 5, 2.4)
    _fill(-5, -5, -5 + T, 5, 2.4)
    _fill(5 - T, -5, 5, 5, 2.4)
    _fill(-T / 2, -5, T / 2, -0.7, 2.4)          # partition + doorway
    _fill(-T / 2, 0.9, T / 2, 5, 2.4)
    _fill(0, 1.8, 2.8, 1.8 + T, 2.4)
    _fill(4.0, 1.8, 5, 1.8 + T, 2.4)
    _fill(-4.3, -4.3, -2.6, -2.9, 0.75)          # desk
    _fill(-4.4, 1.2, -3.0, 3.2, 0.45)            # sofa
    _fill(1.3, -4.0, 2.8, -2.4, 0.72)            # table
    _fill(3.4, -1.4, 4.4, 0.5, 1.85)             # shelf
    _fill(1.0, 2.8, 2.2, 4.0, 0.9)               # cabinet
    # A staircase: a run of cells in the high wall band, so stair mode is testable
    for k in range(14):
        y = 2.2 + k * 0.13
        _fill(-3.6, y, -1.6, y + 0.10, 0.9 + k * 0.10)


_build()

_map_version = 0
_map_lock = threading.Lock()


def _reveal(x, y):
    global _map_version
    r = int(REVEAL_RADIUS_M / RES)
    cgx, cgy = _w2g(x, y)
    changed = False
    for gy in range(max(0, cgy - r), min(H, cgy + r + 1)):
        for gx in range(max(0, cgx - r), min(W, cgx + r + 1)):
            if (gx - cgx) ** 2 + (gy - cgy) ** 2 > r * r:
                continue
            i = gy * W + gx
            if not revealed[i]:
                revealed[i] = True
                changed = True
    if changed:
        with _map_lock:
            _map_version += 1


def map_payload() -> dict:
    return {
        "resolution": RES, "origin_x": ORIGIN_X, "origin_y": ORIGIN_Y,
        "width": W, "height": H, "level_id": "ground",
        "floor": [truth_floor[i] if revealed[i] else -1 for i in range(W * H)],
        "walls": [truth_walls[i] if revealed[i] else 0 for i in range(W * H)],
        "version": _map_version,
    }


def map_version() -> int:
    with _map_lock:
        return _map_version


def coverage_pct() -> float:
    return 100.0 * sum(1 for r in revealed if r) / len(revealed)


# ---------------------------------------------------------------------------
# Event log
# ---------------------------------------------------------------------------

EVENTS: deque = deque(maxlen=400)
_ev_lock = threading.Lock()


def log(level: str, source: str, msg: str, **extra):
    rec = {"t": _now(), "level": level, "source": source, "msg": msg, **extra}
    with _ev_lock:
        EVENTS.append(rec)
    return rec


def events(limit: int = 120, level: str | None = None) -> list:
    with _ev_lock:
        items = list(EVENTS)
    if level and level != "all":
        rank = {"info": 0, "warn": 1, "error": 2}
        want = rank.get(level, 0)
        items = [e for e in items if rank.get(e["level"], 0) >= want]
    return items[-limit:][::-1]


# ---------------------------------------------------------------------------
# Robot
# ---------------------------------------------------------------------------

PATROL = [(-3.4, -3.4), (-3.4, 3.6), (-1.0, 3.6), (-1.0, 0.1),
          (2.2, 0.1), (3.9, -3.4), (-1.0, -3.8), (-1.0, 0.1)]

MODES = ["damp", "sit", "stand", "stand_up", "lay_down", "laydown", "balance", "moving", "wave", "heart"]


class DemoRobot:
    def __init__(self):
        self.lock = threading.RLock()
        self.x, self.y = PATROL[0]
        self.yaw = math.pi / 2
        self.vx = self.vy = self.vyaw = 0.0
        self.battery = 84.0
        # The demo starts live and already mapping: an operator opening the
        # console should see a working system, not an empty grid waiting for
        # a button they haven't found yet.
        self.armed = True
        self.mode = "stand"
        self.control_mode = "auto"          # auto | manual
        self.nav_state = "exploring"
        self.exploring = True
        self.nav_error = None
        self.nav_path: list = []
        self.goal = None
        self.wp = 1
        self.proximity_m = 2.0
        self.proximity_active = False
        self.estopped = False
        self.estop_t = 0.0
        self.motor_temps = [38.0] * 12
        self.last_manual_t = 0.0
        self.t0 = _now()
        self.distance_m = 0.0
        threading.Thread(target=self._loop, daemon=True, name="demo-robot").start()

    # -- commands ----------------------------------------------------
    def arm(self, value: bool):
        with self.lock:
            if value and self.estopped:
                self.estopped = False
            self.armed = value
            if not value:
                self.vx = self.vy = self.vyaw = 0.0
                self.goal = None
                self.exploring = False
                self.nav_state = "idle"
        log("warn" if value else "info", "core",
            "robot élesítve" if value else "robot lezárva")

    def estop(self):
        with self.lock:
            self.estopped = True
            self.estop_t = _now()
            self.armed = False
            self.goal = None
            self.exploring = False
            self.vx = self.vy = self.vyaw = 0.0
            self.nav_state = "idle"
            self.mode = "damp"
        log("error", "core", "VÉSZLEÁLLÍTÁS kiadva")

    def manual(self, vx, vy, vyaw):
        with self.lock:
            if not self.armed or self.estopped:
                return False, "robot nincs élesítve"
            self.control_mode = "manual"
            self.goal = None
            self.exploring = False
            self.vx, self.vy, self.vyaw = vx, vy, vyaw
            self.last_manual_t = _now()
            self.nav_state = "manual"
            return True, None

    def set_mode(self, mode):
        with self.lock:
            if mode not in MODES:
                return False, f"ismeretlen mód: {mode}"
            if mode != "damp" and not self.armed:
                return False, "robot nincs élesítve"
            self.mode = mode
        log("info", "core", f"mód: {mode}")
        return True, None

    def get_obstacle_avoid(self):
        with self.lock:
            return {"obstacle_avoid": getattr(self, "obstacle_avoid_enabled", True)}

    def set_obstacle_avoid(self, enable: bool):
        with self.lock:
            self.obstacle_avoid_enabled = enable
        log("info", "core", f"akadálykerülés: {enable}")
        return True, None

    def get_led(self):
        with self.lock:
            led = getattr(self, "led", {"r": 0, "g": 0, "b": 0})
            return {"r": led["r"], "g": led["g"], "b": led["b"], "audio_error": None}

    def set_led(self, r: int, g: int, b: int):
        with self.lock:
            self.led = {"r": max(0, min(255, int(r))), "g": max(0, min(255, int(g))), "b": max(0, min(255, int(b)))}
        log("info", "core", f"LED szín beállítva: RGB({r},{g},{b})")
        return True, None

    def get_led_presets(self):
        return {
            "off": {"r": 0, "g": 0, "b": 0},
            "white": {"r": 255, "g": 255, "b": 255},
            "red": {"r": 255, "g": 0, "b": 0},
            "green": {"r": 0, "g": 255, "b": 0},
            "blue": {"r": 0, "g": 0, "b": 255},
            "yellow": {"r": 255, "g": 255, "b": 0},
            "cyan": {"r": 0, "g": 255, "b": 255},
            "magenta": {"r": 255, "g": 0, "b": 255},
            "orange": {"r": 255, "g": 128, "b": 0},
            "purple": {"r": 128, "g": 0, "b": 255},
            "pink": {"r": 255, "g": 105, "b": 180},
            "warm_white": {"r": 255, "g": 200, "b": 120},
        }

    def set_led_preset(self, name: str):
        presets = self.get_led_presets()
        if name not in presets:
            return False, f"ismeretlen preset: {name}"
        p = presets[name]
        return self.set_led(p["r"], p["g"], p["b"])

    def goto(self, x, y):
        with self.lock:
            if not self.armed or self.estopped:
                return False, "robot nincs élesítve"
            self.control_mode = "auto"
            # Exploration and point-navigation both drive the robot; only one
            # of them may own it at a time (mirrors live_backend).
            self.exploring = False
            self.goal = (x, y)
            self.nav_state = "moving"
            self.nav_error = None
            self.nav_path = [{"x": self.x, "y": self.y}, {"x": x, "y": y}]
        log("info", "navigation", f"cél kijelölve: {x:.2f}, {y:.2f}")
        return True, None

    def cancel_nav(self):
        with self.lock:
            self.goal = None
            self.nav_path = []
            self.nav_state = "idle"
            self.vx = self.vy = self.vyaw = 0.0
        log("info", "navigation", "navigáció megszakítva")

    def set_explore(self, on: bool):
        with self.lock:
            if on and (not self.armed or self.estopped):
                return False, "robot nincs élesítve"
            self.exploring = on
            self.control_mode = "auto"
            self.goal = None
            self.nav_path = []
            self.nav_state = "exploring" if on else "idle"
        log("info", "mapping", "térképezés indítva" if on else "térképezés leállítva")
        return True, None

    # -- state -------------------------------------------------------
    def snapshot(self) -> dict:
        with self.lock:
            return {
                "pose": {"x": round(self.x, 3), "y": round(self.y, 3), "z": 0.0,
                          "yaw": round(self.yaw, 4), "level_id": "ground"},
                "velocity": {"vx": round(self.vx, 3), "vy": round(self.vy, 3),
                              "vyaw": round(self.vyaw, 3)},
                "battery": {"percent": round(self.battery, 1),
                             "voltage": round(22.0 + 0.06 * self.battery, 2),
                             "current": round(1.4 + 0.5 * random.random(), 2)},
                "imu": {"roll": round(0.02 * math.sin(_now() * 1.3), 4),
                         "pitch": round(0.02 * math.sin(_now() * 0.9), 4),
                         "yaw": round(self.yaw, 4), "accel_z": 9.81},
                "armed": self.armed,
                "estopped": self.estopped,
                "mode": self.mode,
                "control_mode": self.control_mode,
                "nav": {"state": self.nav_state, "error": self.nav_error,
                         "goal": ({"x": self.goal[0], "y": self.goal[1]} if self.goal else None),
                         "path": self.nav_path},
                "exploring": self.exploring,
                "coverage_pct": round(coverage_pct(), 1),
                "proximity": {"active": self.proximity_active,
                               "min_distance_m": round(self.proximity_m, 2)},
                "motor_temps": [round(t, 1) for t in self.motor_temps],
                "max_motor_temp": round(max(self.motor_temps), 1),
                "link": {"tracked": True, "healthy": True, "latency_ms": round(8 + 6 * random.random(), 1)},
                "uptime_s": round(_now() - self.t0, 1),
                "distance_m": round(self.distance_m, 2),
                "demo": True,
                "pillars_expected": [],
                "t": _now(),
            }

    # -- simulation --------------------------------------------------
    def _scenario(self, phase):
        if 0.58 <= phase < 0.66:
            self.proximity_m = 0.35 + 0.25 * abs(math.sin(phase * 140))
            if not self.proximity_active:
                log("warn", "core", "közelségi riasztás: tárgy 0.4 m-en belül")
            self.proximity_active = True
        else:
            self.proximity_m = 1.5 + 0.9 * abs(math.sin(phase * 25))
            self.proximity_active = False
        if 0.80 <= phase < 0.90:
            if self.battery > 17.5:
                log("warn", "blackbox", "alacsony akkumulátorszint")
            self.battery = min(self.battery, 17.0)
        elif 0.90 <= phase < 0.96:
            if self.battery > 8.0:
                log("error", "blackbox", "KRITIKUS akkumulátorszint")
                blackbox.trigger("battery_critical")
            self.battery = min(self.battery, 7.5)
        elif phase >= 0.96:
            self.battery = 84.0

    def _loop(self):
        last = _now()
        while True:
            time.sleep(0.05)
            now = _now()
            dt = now - last
            last = now
            phase = ((now - self.t0) % 120.0) / 120.0

            with self.lock:
                self._scenario(phase)

                if self.estopped and (now - self.estop_t) > 15:
                    self.estopped = False
                    self.armed = True
                    self.mode = "stand"
                    log("info", "core", "demó: állapot helyreállítva vészleállítás után")

                # manual deadman
                if self.control_mode == "manual" and (now - self.last_manual_t) > 0.6:
                    self.vx = self.vy = self.vyaw = 0.0

                driving = False
                if self.armed and not self.estopped:
                    if self.control_mode == "manual":
                        driving = abs(self.vx) + abs(self.vyaw) > 0.01
                    else:
                        target = self.goal if self.goal else (
                            PATROL[self.wp] if self.exploring else None)
                        if target:
                            dx, dy = target[0] - self.x, target[1] - self.y
                            d = math.hypot(dx, dy)
                            if d < 0.15:
                                if self.goal:
                                    self.goal = None
                                    self.nav_path = []
                                    self.nav_state = "done"
                                    log("info", "navigation", "cél elérve")
                                else:
                                    self.wp = (self.wp + 1) % len(PATROL)
                            else:
                                ty = math.atan2(dy, dx)
                                err = (ty - self.yaw + math.pi) % (2 * math.pi) - math.pi
                                self.vyaw = max(-1.2, min(1.2, err * 2.2))
                                self.vx = 0.5 * max(0.15, 1.0 - abs(err) / math.pi)
                                driving = True

                if driving:
                    self.yaw += self.vyaw * dt
                    step = self.vx * dt
                    self.x += step * math.cos(self.yaw) - self.vy * dt * math.sin(self.yaw)
                    self.y += step * math.sin(self.yaw) + self.vy * dt * math.cos(self.yaw)
                    self.distance_m += abs(step)
                    self.battery = max(0.0, self.battery - 0.014 * dt)
                    for i in range(12):
                        self.motor_temps[i] = min(78.0, self.motor_temps[i] + 0.09 * dt)
                    self.mode = "moving"
                else:
                    for i in range(12):
                        self.motor_temps[i] = max(37.0, self.motor_temps[i] - 0.16 * dt)
                    if self.mode == "moving":
                        self.mode = "stand"

                self.x = max(-4.8, min(4.8, self.x))
                self.y = max(-4.8, min(4.8, self.y))
                _reveal(self.x, self.y)


# ---------------------------------------------------------------------------
# Cameras
# ---------------------------------------------------------------------------

CAMERAS = [
    {"id": "front", "label": "Elülső (robot)", "kind": "robot_client", "tint": "normal"},
    {"id": "usb0", "label": "Oldalsó (USB)", "kind": "usb", "tint": "normal"},
    {"id": "usb1", "label": "Hátsó (USB)", "kind": "usb", "tint": "normal"},
    {"id": "usb2", "label": "Éjjellátó (USB)", "kind": "usb", "tint": "night"},
    {"id": "thermal", "label": "Hőkamera", "kind": "thermal", "tint": "thermal"},
    # Not a camera in the optical sense, but the operator wants to flip
    # between RGB / thermal / LiDAR in the same tile grid, so it is exposed
    # as one more selectable feed.
    {"id": "lidar", "label": "LiDAR nézet", "kind": "lidar", "tint": "lidar"},
]

_recording: dict[str, dict] = {}


def _raycast_scan(x0: float, y0: float, yaw: float, n: int = 220,
                  fov: float = 2 * math.pi, max_r: float = 6.0):
    """Cast n rays over the true floor plan -- gives a scan that actually
    matches the rooms, instead of a decorative circle."""
    out = []
    step = RES * 0.8
    for i in range(n):
        a = yaw - fov / 2 + fov * (i / max(1, n - 1))
        ca, sa = math.cos(a), math.sin(a)
        r = 0.15
        while r < max_r:
            gx, gy = _w2g(x0 + ca * r, y0 + sa * r)
            if not (0 <= gx < W and 0 <= gy < H):
                break
            if truth_floor[gy * W + gx] == 100:
                break
            r += step
        out.append((a, min(r, max_r), r < max_r))
    return out


def _render_lidar(quality: int) -> bytes:
    """Top-down scan view, robot-centred, north-up along the heading."""
    from PIL import Image, ImageDraw

    w = h = 420
    img = Image.new("RGB", (w, h), (8, 12, 18))
    d = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    max_r = 6.0
    ppm = (min(w, h) / 2 - 18) / max_r

    for ring in (1, 2, 3, 4, 5, 6):
        rr = ring * ppm
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(28, 44, 62))
        d.text((cx + 4, cy - rr + 2), f"{ring}m", fill=(60, 82, 104))
    d.line([(cx, 0), (cx, h)], fill=(24, 38, 54))
    d.line([(0, cy), (w, cy)], fill=(24, 38, 54))

    s = robot.snapshot()
    pose = s["pose"]
    scan = _raycast_scan(pose["x"], pose["y"], pose["yaw"])
    nearest = max_r
    for a, r, hit in scan:
        if not hit:
            continue
        rel = a - pose["yaw"]                 # robot frame, heading up
        px = cx + math.sin(rel) * r * ppm
        py = cy - math.cos(rel) * r * ppm
        near = r < 0.8
        col = (255, 90, 90) if near else (90, 220, 255)
        d.ellipse([px - 2, py - 2, px + 2, py + 2], fill=col)
        nearest = min(nearest, r)

    d.polygon([(cx, cy - 9), (cx - 6, cy + 7), (cx + 6, cy + 7)], fill=(77, 184, 255))
    d.rectangle([0, 0, w, 24], fill=(0, 0, 0))
    d.text((8, 7), "LiDAR nezet  [lidar]", fill=(90, 220, 255))
    d.text((w - 118, 7), time.strftime("%H:%M:%S"), fill=(90, 220, 255))
    d.rectangle([0, h - 22, w, h], fill=(0, 0, 0))
    d.text((8, h - 17), f"legkozelebbi: {nearest:.2f} m   pontok: {len(scan)}",
           fill=(255, 90, 90) if nearest < 0.8 else (90, 220, 255))
    d.text((w - 60, 30), "DEMO", fill=(255, 184, 77))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(max(30, min(95, quality))))
    return buf.getvalue()


def camera_frame(cam_id: str, quality: int = 75) -> bytes:
    """Render a synthetic frame. Each camera looks distinct so the grid is
    readable at a glance instead of five copies of the same placeholder."""
    from PIL import Image, ImageDraw

    cam = next((c for c in CAMERAS if c["id"] == cam_id), None)
    if cam is None:
        raise KeyError(cam_id)
    if cam["kind"] == "lidar":
        return _render_lidar(quality)

    w, h = 480, 360
    t = _now()
    s = robot.snapshot()
    tint = cam["tint"]

    if tint == "night":
        bg = (6, 22, 10)
        fg = (120, 255, 150)
    elif tint == "thermal":
        bg = (20, 0, 40)
        fg = (255, 200, 60)
    else:
        bg = (18, 22, 28)
        fg = (150, 210, 240)

    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)

    # A moving "corridor" so the feed obviously isn't a still image
    off = (t * 40 + hash(cam_id) % 100) % 80
    for k in range(-1, 8):
        yy = int(k * 80 + off)
        d.line([(0, yy), (w, yy)], fill=tuple(int(c * 0.45) for c in fg), width=1)
    horizon = h // 2 + int(14 * math.sin(t * 0.7 + len(cam_id)))
    d.line([(0, horizon), (w, horizon)], fill=fg, width=2)
    for k in range(5):
        xx = int((k * 120 + off * 1.7) % (w + 120)) - 60
        d.rectangle([xx, horizon - 40 - k * 6, xx + 46, horizon], outline=fg, width=2)

    if tint == "thermal":
        for k in range(3):
            cx = int((t * 30 + k * 160) % w)
            cy = horizon - 20
            for r in range(34, 0, -6):
                shade = (255, max(0, 220 - r * 5), 40)
                d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade)

    d.rectangle([0, 0, w, 24], fill=(0, 0, 0))
    d.text((8, 7), f"{cam['label']}  [{cam_id}]", fill=fg)
    d.text((w - 118, 7), time.strftime("%H:%M:%S"), fill=fg)
    d.rectangle([0, h - 22, w, h], fill=(0, 0, 0))
    d.text((8, h - 17),
           f"pose {s['pose']['x']:+.2f},{s['pose']['y']:+.2f}  yaw {math.degrees(s['pose']['yaw']):+.0f}deg",
           fill=fg)
    if cam_id in _recording:
        d.ellipse([w - 30, h - 18, w - 18, h - 6], fill=(255, 60, 60))
        d.text((w - 74, h - 17), "REC", fill=(255, 120, 120))
    d.text((w - 60, 30), "DEMO", fill=(255, 184, 77))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(max(30, min(95, quality))))
    return buf.getvalue()


def lidar_cloud(source: str, limit: int = 6000) -> dict:
    """Synthetic clouds matching the live hub's shape: the built-in Go2 lidar
    as a sparse forward scan, Hesai as a denser full-surround sweep."""
    s = robot.snapshot()
    pose = s["pose"]
    dense = source == "hesai"
    n = min(limit, 4200 if dense else 1600)
    scan = _raycast_scan(pose["x"], pose["y"], pose["yaw"],
                         n=n // (7 if dense else 3),
                         fov=2 * math.pi if dense else math.radians(200))
    pts = []
    layers = 7 if dense else 3
    for a, r, hit in scan:
        if not hit:
            continue
        for k in range(layers):
            z = -0.25 + k * (1.9 / max(1, layers - 1))
            jitter = 1.0 - 0.012 * k
            pts.append([round(math.cos(a - pose["yaw"]) * r * jitter, 4),
                        round(math.sin(a - pose["yaw"]) * r * jitter, 4),
                        round(z, 4)])
    return {"source": source, "points": pts[:limit], "count": min(len(pts), limit),
            "raw_count": len(pts), "error": None, "t": _now()}


def get_objects() -> dict:
    """Synthetic tracked objects for demonstration and testing."""
    s = robot.snapshot()
    pose = s["pose"]
    t = _now()
    angle = t * 0.4
    px = pose["x"] + 1.8 * math.cos(angle * 0.5) + 1.2
    py = pose["y"] + 1.2 * math.sin(angle * 0.5) - 0.4
    obj = {
        "id": 7,
        "cls": "person",
        "x": round(px, 3),
        "y": round(py, 3),
        "confidence": 0.94,
        "last_seen": t,
        "age_s": 0.05,
    }
    return {"objects": [obj], "count": 1, "perception_error": None, "t": t}


def camera_list() -> list:
    return [{**c, "available": True, "recording": c["id"] in _recording,
             "frames": _recording.get(c["id"], {}).get("frames", 0)} for c in CAMERAS]


def record(cam_id: str, on: bool) -> dict:
    if on:
        _recording[cam_id] = {"started": _now(), "frames": 0}
        log("info", "multicam", f"felvétel indítva: {cam_id}")
    else:
        info = _recording.pop(cam_id, None)
        log("info", "multicam", f"felvétel leállítva: {cam_id}",
            frames=(info or {}).get("frames", 0))
    return {"cam_id": cam_id, "recording": on}


# ---------------------------------------------------------------------------
# Sensors: capture gallery
# ---------------------------------------------------------------------------

CAPTURES: deque = deque(maxlen=60)


def capture(kind: str, cam_id: str = "front") -> dict:
    cid = uuid.uuid4().hex[:8]
    item = {"id": cid, "kind": kind, "t": _now(), "cam_id": cam_id}
    if kind == "photo":
        item["url"] = f"/api/captures/{cid}.jpg"
        _capture_blobs[cid] = camera_frame(cam_id)
        item["bytes"] = len(_capture_blobs[cid])
    elif kind == "lidar_scan":
        n = int(1200 + 2000 * random.random())
        item["point_count"] = n
        item["url"] = f"/api/captures/{cid}.json"
    elif kind == "thermal":
        _capture_blobs[cid] = camera_frame("thermal")
        item["url"] = f"/api/captures/{cid}.jpg"
        item["bytes"] = len(_capture_blobs[cid])
    CAPTURES.appendleft(item)
    log("info", "sensors", f"{kind} rögzítve", capture_id=cid)
    return item


_capture_blobs: dict[str, bytes] = {}


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

SOUNDS = [
    {"id": "proximity_warning", "label": "Közelségi figyelmeztetés", "duration_s": 0.35},
    {"id": "task_complete", "label": "Feladat kész", "duration_s": 0.6},
    {"id": "low_battery", "label": "Alacsony akku", "duration_s": 0.8},
    {"id": "incident", "label": "Incidens", "duration_s": 1.0},
    {"id": "test", "label": "Teszthang", "duration_s": 0.3},
]

AUDIO_RULES = [
    {"id": "r1", "event": "mc.core.proximity_alert", "sound": "proximity_warning", "enabled": True},
    {"id": "r2", "event": "mc.orchestration.task_event:succeeded", "sound": "task_complete", "enabled": True},
    {"id": "r3", "event": "mc.core.anomaly:battery_low", "sound": "low_battery", "enabled": True},
    {"id": "r4", "event": "mc.blackbox.incident", "sound": "incident", "enabled": False},
]

AUDIO_HISTORY: deque = deque(maxlen=40)


def play(sound_id: str) -> dict:
    snd = next((s for s in SOUNDS if s["id"] == sound_id), None)
    rec = {"t": _now(), "sound": sound_id, "played": snd is not None,
           "label": snd["label"] if snd else "ismeretlen"}
    AUDIO_HISTORY.appendleft(rec)
    log("info", "audio", f"hang lejátszva: {rec['label']}")
    return rec


# ---------------------------------------------------------------------------
# Missions
# ---------------------------------------------------------------------------

STEP_TYPES = [
    {"type": "goto", "label": "Menj ide", "fields": [
        {"key": "x", "label": "X", "kind": "number"},
        {"key": "y", "label": "Y", "kind": "number"}]},
    {"type": "call_api", "label": "API hívás + várakozás", "fields": [
        {"key": "url", "label": "URL", "kind": "text"},
        {"key": "method", "label": "Metódus", "kind": "select", "options": ["GET", "POST", "PUT"]},
        {"key": "body", "label": "Törzs (JSON)", "kind": "textarea"},
        {"key": "wait_for", "label": "Mire vár", "kind": "select",
         "options": ["response", "status:200", "body.done==true"]}]},
    {"type": "sensor", "label": "Szenzor-parancs", "fields": [
        {"key": "kind", "label": "Típus", "kind": "select",
         "options": ["photo", "lidar_scan", "thermal"]}]},
    {"type": "play_sound", "label": "Hang lejátszása", "fields": [
        {"key": "sound", "label": "Hang", "kind": "select",
         "options": [s["id"] for s in SOUNDS]}]},
    {"type": "wait", "label": "Várakozás", "fields": [
        {"key": "seconds", "label": "Másodperc", "kind": "number"}]},
    {"type": "mqtt_publish", "label": "MQTT üzenet", "fields": [
        {"key": "topic", "label": "Topic", "kind": "text"},
        {"key": "payload", "label": "Payload", "kind": "textarea"}]},
    {"type": "ws_send", "label": "WebSocket üzenet", "fields": [
        {"key": "url", "label": "WS URL", "kind": "text"},
        {"key": "payload", "label": "Payload", "kind": "textarea"}]},
]

MISSIONS: dict[str, dict] = {}
_mission_lock = threading.Lock()


def create_mission(name: str, steps: list) -> dict:
    mid = uuid.uuid4().hex[:8]
    m = {"id": mid, "name": name or f"Küldetés {mid}", "steps": steps,
         "status": "pending", "created_at": _now(),
         "results": [{"index": i, "status": "pending", "detail": None} for i in range(len(steps))]}
    with _mission_lock:
        MISSIONS[mid] = m
    log("info", "orchestration", f"küldetés létrehozva: {m['name']}", mission_id=mid)
    return m


def run_mission(mid: str) -> bool:
    with _mission_lock:
        m = MISSIONS.get(mid)
    if not m or m["status"] == "running":
        return False
    threading.Thread(target=_run_mission, args=(m,), daemon=True).start()
    return True


def _run_mission(m: dict):
    m["status"] = "running"
    log("info", "orchestration", f"küldetés indul: {m['name']}", mission_id=m["id"])
    for i, step in enumerate(m["steps"]):
        if m.get("cancel"):
            m["status"] = "cancelled"
            log("warn", "orchestration", "küldetés megszakítva", mission_id=m["id"])
            return
        r = m["results"][i]
        r["status"] = "running"
        stype = step.get("type")
        log("info", "orchestration", f"lépés {i + 1}/{len(m['steps'])}: {stype}",
            mission_id=m["id"])

        if stype == "goto":
            robot.goto(float(step.get("x", 0)), float(step.get("y", 0)))
            deadline = _now() + 40
            while _now() < deadline:
                time.sleep(0.4)
                if robot.snapshot()["nav"]["state"] == "done":
                    break
            r["detail"] = "cél elérve"
        elif stype == "sensor":
            capture(step.get("kind", "photo"))
            r["detail"] = f"{step.get('kind')} rögzítve"
            time.sleep(0.6)
        elif stype == "play_sound":
            play(step.get("sound", "test"))
            r["detail"] = "lejátszva"
            time.sleep(0.4)
        elif stype == "wait":
            secs = float(step.get("seconds", 1))
            time.sleep(min(secs, 20))
            r["detail"] = f"{secs}s várakozás kész"
        elif stype in ("call_api", "mqtt_publish", "ws_send"):
            # The demo does not reach the network; it simulates the round trip
            # so the waiting-for-response chain is visible in the UI.
            time.sleep(1.4)
            r["detail"] = "válasz megérkezett (demó, szimulált)"
        else:
            r["status"] = "failed"
            r["detail"] = f"ismeretlen lépés: {stype}"
            m["status"] = "failed"
            log("error", "orchestration", r["detail"], mission_id=m["id"])
            return
        r["status"] = "succeeded"

    m["status"] = "succeeded"
    log("info", "orchestration", f"küldetés kész: {m['name']}", mission_id=m["id"])
    play("task_complete")


# ---------------------------------------------------------------------------
# Blackbox
# ---------------------------------------------------------------------------

class Blackbox:
    def __init__(self):
        self.incidents: deque = deque(maxlen=50)
        self.buffer_mb = 12.4
        self.frames = 148
        threading.Thread(target=self._loop, daemon=True, name="demo-blackbox").start()

    def trigger(self, reason: str) -> dict:
        s = robot.snapshot()
        inc = {
            "id": time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "_" + reason,
            "reason": reason, "created_at": _now(),
            "pose": s["pose"], "battery": s["battery"]["percent"],
            "frame_count": random.randint(4, 12),
            "log_line_count": random.randint(20, 60),
        }
        self.incidents.appendleft(inc)
        log("error", "blackbox", f"incidens rögzítve: {reason}", incident_id=inc["id"])
        return inc

    def status(self) -> dict:
        return {
            "total_mb": round(self.buffer_mb, 2),
            "frame_count": self.frames,
            "incident_count": len(self.incidents),
            "oldest_ts": _now() - 600,
            "newest_ts": _now(),
        }

    def timeline(self, incident_id: str) -> dict:
        inc = next((i for i in self.incidents if i["id"] == incident_id), None)
        if not inc:
            return {}
        t0 = inc["created_at"] - 30
        return {
            "incident": inc,
            "samples": [
                {"t": t0 + k, "battery": max(0, inc["battery"] - 0.02 * (30 - k)),
                 "accel_z": 9.81 + (3.4 if k == 28 else 0.1 * math.sin(k)),
                 "x": inc["pose"]["x"] - 0.02 * (30 - k),
                 "y": inc["pose"]["y"] - 0.01 * (30 - k)}
                for k in range(31)
            ],
            "frames": [{"t": t0 + k * 5, "url": "/api/blackbox/frame"} for k in range(7)],
        }

    def _loop(self):
        while True:
            time.sleep(3)
            self.buffer_mb = min(198.0, self.buffer_mb + 0.09)
            self.frames += 1
            if self.buffer_mb > 195:
                self.buffer_mb = 120.0
                log("info", "blackbox", "puffer nyesve (retenciós limit)")


# ---------------------------------------------------------------------------
# Remote / Tailscale
# ---------------------------------------------------------------------------

REMOTE = {
    "tailscale": {"connected": False, "hostname": "go2-mission-control",
                   "ip": None, "tags": ["tag:go2-mission-control"],
                   "note": "demó: nincs valódi tailnet-kapcsolat"},
    "last_ship": None,
    "ship_count": 0,
}


def ship_now() -> dict:
    REMOTE["last_ship"] = _now()
    REMOTE["ship_count"] += 1
    log("info", "remote", "log-összegzés elküldve (demó: szimulált)")
    return dict(REMOTE)


robot = DemoRobot()
blackbox = Blackbox()

log("info", "console", "demó backend elindult")
blackbox.trigger("startup_selftest")


def start_background():
    """Symmetry with live_backend; the demo needs no deferred startup."""
    return None
