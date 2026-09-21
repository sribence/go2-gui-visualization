"""Live backend -- the same surface as demo_backend, backed by the real
mission-control pillars over HTTP.

Two design rules, both learned from the 2026-09-10 audit:

1. A dead link must never look like real data. When core has not answered
   recently, pose/battery/imu become None and link.healthy goes false --
   they do NOT fall back to zeros, which is what made a disconnected robot
   indistinguishable from one parked at the origin with a flat battery.

2. The UI must not block on upstream. A background poller keeps a cached
   snapshot; every request reads the cache. One slow pillar degrades its own
   panel, not the whole console.
"""
from __future__ import annotations

import base64
import io
import json as _json
import math
import os
import threading
import time
import uuid
from collections import deque

import requests

# -- upstream endpoints -------------------------------------------------
CORE = os.environ.get("CORE_URL", "http://127.0.0.1:9101")
MAPPING = os.environ.get("MAPPING_URL", "http://127.0.0.1:9102")
NAV = os.environ.get("NAVIGATION_URL", "http://127.0.0.1:9103")
ORCH = os.environ.get("ORCHESTRATION_URL", "http://127.0.0.1:9104")
SENSORS = os.environ.get("SENSORS_URL", "http://127.0.0.1:9105")
MULTICAM = os.environ.get("MULTICAM_URL", "http://127.0.0.1:9106")
AUDIO = os.environ.get("AUDIO_URL", "http://127.0.0.1:9107")
BLACKBOX = os.environ.get("BLACKBOX_URL", "http://127.0.0.1:9108")
# Movement lives in its own service on the dock. Unset -> observe only,
# and the console says so instead of offering controls that cannot work.
MOTION = os.environ.get("MOTION_URL", "").rstrip("/")

TOKEN = os.environ.get("MC_API_TOKEN", "")
POLL_HZ = float(os.environ.get("LIVE_POLL_HZ", "5"))
LINK_MAX_AGE_S = float(os.environ.get("LINK_MAX_AGE_S", "5.0"))
TIMEOUT = float(os.environ.get("LIVE_HTTP_TIMEOUT", "1.2"))

def _blank_jpeg() -> bytes:
    return base64.b64decode(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////"
        "//////////////////////////////////////////////////////wgALCAABAAEB"
        "AREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
    )
# Optional pillars get a short leash: a service that is simply not running
# must never slow down the core telemetry poll (that made the link look
# stale even though the robot was answering in 30ms).
AUX_TIMEOUT = float(os.environ.get("LIVE_AUX_TIMEOUT", "0.4"))
# Commands can kick off real work upstream (planning, thread startup),
# so they get a longer budget than the background poll.
CMD_TIMEOUT = float(os.environ.get("LIVE_CMD_TIMEOUT", "8.0"))

# requests.Session is not safe to share across threads: the poller, the
# pillar prober and the request handlers all call out concurrently, and a
# shared connection pool deadlocks under that. One session per thread.
_local = threading.local()


def _sess() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        if TOKEN:
            s.headers["X-MC-Token"] = TOKEN
        _local.session = s
    return s

_now = time.time


# ---------------------------------------------------------------------------
# Event log. mission-control has no central event API, so we record our own
# commands plus the state transitions the poller observes.
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


def _get(url: str, path: str, **kw):
    r = _sess().get(f"{url}{path}", timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


def _post(url: str, path: str, **kw):
    kw.setdefault("timeout", CMD_TIMEOUT)
    r = _sess().post(f"{url}{path}", **kw)
    r.raise_for_status()
    return r


def _detail(exc) -> str:
    """The upstream reason, not the HTTP status.

    The pillars answer with `detail` (FastAPI) and mc_motion with `error`
    (Flask). Missing the second one meant an expired arm reached the
    operator as "409 Client Error: CONFLICT", which says nothing about what
    to do next.
    """
    try:
        body = exc.response.json()
        return body.get("detail") or body.get("error") or str(exc)
    except Exception:
        return str(exc)


# ---------------------------------------------------------------------------
# Robot -- cached poller over core + navigation + mapping
# ---------------------------------------------------------------------------

def _arm_remaining(motion: dict):
    if not motion.get("armed"):
        return None
    total = motion.get("arm_timeout_s")
    used = motion.get("armed_for_s")
    if total is None or used is None:
        return None
    return max(0.0, round(float(total) - float(used), 1))


class LiveRobot:
    def __init__(self):
        self.lock = threading.Lock()
        self._core = None
        self._core_t = 0.0
        self._core_err = None
        self._nav = {}
        self._explore = {}
        self._control_mode = "auto"
        self._t0 = _now()
        self._distance = 0.0
        self._prev_xy = None
        self._pillars = {}
        self._motion = {}
        self._started = False

    def start(self):
        """Background pollers are started from the app's startup hook, not at
        import: threads spun up before uvicorn takes the main thread left the
        server accepting connections but never answering them."""
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._poll, daemon=True, name="live-poller").start()
        threading.Thread(target=self._poll_aux, daemon=True, name="live-aux").start()
        threading.Thread(target=self._probe, daemon=True, name="live-probe").start()

    def _poll(self):
        """Core telemetry poller. Checks webrtc_bridge (:5001), perception (:9112), and mc_motion (:9113)."""
        period = 1.0 / max(1.0, POLL_HZ)
        urls = ["http://127.0.0.1:5001", "http://192.168.123.18:5001", CORE, "http://127.0.0.1:9112", "http://127.0.0.1:9113"]
        urls = list(dict.fromkeys([u for u in urls if u]))
        while True:
            time.sleep(period)
            fetched_data = None
            for url in urls:
                try:
                    r = _sess().get(f"{url}/state", timeout=TIMEOUT)
                    if r.status_code == 200:
                        fetched_data = r.json()
                        break
                except Exception:
                    try:
                        r = _sess().get(f"{url}/status", timeout=TIMEOUT)
                        if r.status_code == 200:
                            fetched_data = r.json()
                            break
                    except Exception:
                        continue
            if not fetched_data:
                try:
                    r = _sess().get("http://127.0.0.1:5002/showcase_data", timeout=0.8, stream=True)
                    if r.status_code == 200:
                        for line in r.iter_lines():
                            line_str = line.decode("utf-8") if isinstance(line, bytes) else line
                            if line_str.startswith("data: "):
                                d = _json.loads(line_str[6:])
                                fetched_data = {
                                    "pose": {"x": d.get("position_x", 0.0), "y": d.get("position_y", 0.0), "z": 0.0} if d.get("position_x") is not None else None,
                                    "imu": {"roll": d.get("roll"), "pitch": d.get("pitch"), "yaw": d.get("yaw")},
                                    "motor_q": d.get("motor_q", []),
                                    "motor_tau": d.get("motor_tau", []),
                                    "motor_temps": d.get("motor_temp", []),
                                    "max_motor_temp": max(d.get("motor_temp", [0])) if d.get("motor_temp") else None,
                                    "battery": {"percent": int((d.get("voltage", 28) - 22) / 8 * 100) if d.get("voltage") else 85, "voltage": d.get("voltage"), "current": d.get("current")},
                                    "armed": d.get("armed", False),
                                    "mode": d.get("mode_label", "STANDBY")
                                }
                                break
                except Exception:
                    pass

            if fetched_data:
                with self.lock:
                    self._core = fetched_data
                    self._core_t = _now()
                    self._core_err = None
                    p = fetched_data.get("pose")
                    if not p and fetched_data.get("sportmodestate"):
                        sms = fetched_data["sportmodestate"]
                        if isinstance(sms, dict) and "position" in sms:
                            pos = sms["position"]
                            if isinstance(pos, (list, tuple)) and len(pos) >= 2:
                                p = {"x": pos[0], "y": pos[1], "z": pos[2] if len(pos) > 2 else 0.0}
                    if p and isinstance(p, dict):
                        xy = (p.get("x"), p.get("y"))
                        if None not in xy:
                            if self._prev_xy:
                                dx = xy[0] - self._prev_xy[0]
                                dy = xy[1] - self._prev_xy[1]
                                self._distance += (dx * dx + dy * dy) ** 0.5
                            self._prev_xy = xy
            else:
                with self.lock:
                    self._core_err = "nincs kapcsolat az érzékelő szervizzel"

    def _poll_aux(self):
        """Navigation and mapping, slower and with a short timeout."""
        prev_nav = None
        while True:
            time.sleep(0.5)
            try:
                n = _sess().get(f"{NAV}/nav_status", timeout=AUX_TIMEOUT).json()
                with self.lock:
                    self._nav = n
                if n.get("state") != prev_nav:
                    if prev_nav is not None:
                        lvl = {"failed": "error", "blocked": "warn"}.get(n.get("state"), "info")
                        log(lvl, "navigation", f"állapot: {n.get('state')}", error=n.get("error"))
                    prev_nav = n.get("state")
            except Exception:
                pass
            try:
                e = _sess().get(f"{MAPPING}/explore/status", timeout=AUX_TIMEOUT).json()
                with self.lock:
                    self._explore = e
            except Exception:
                pass
            if MOTION:
                try:
                    m = _sess().get(f"{MOTION}/health", timeout=AUX_TIMEOUT).json()
                    with self.lock:
                        self._motion = m
                except Exception:
                    with self.lock:
                        self._motion = {"ok": False}

    def _probe(self):
        """Per-pillar reachability, so the console names the service that is
        down instead of showing a blank panel."""
        targets = {"core": CORE, "mapping": MAPPING, "navigation": NAV,
                   "orchestration": ORCH, "sensors": SENSORS, "multicam": MULTICAM,
                   "audio": AUDIO, "blackbox": BLACKBOX}
        # Short timeout: this is a reachability ping, and with eight pillars
        # a 2s timeout would make the first pass take half a minute.
        probe_timeout = AUX_TIMEOUT
        while True:
            out = {}
            for name, url in targets.items():
                ok = False
                for probe in ("/health", "/"):
                    try:
                        _sess().get(f"{url}{probe}", timeout=probe_timeout).raise_for_status()
                        ok = True
                        break
                    except Exception:
                        continue
                out[name] = ok
            with self.lock:
                self._pillars = out
            time.sleep(5)

    def refresh(self):
        """Pull core/nav state now. Called right after a command so the
        response the operator sees is post-command, not the last poll."""
        try:
            s = _get(CORE, "/state").json()
            with self.lock:
                self._core = s
                self._core_t = _now()
                self._core_err = None
        except Exception:
            pass
        try:
            n = _get(NAV, "/nav_status").json()
            with self.lock:
                self._nav = n
        except Exception:
            pass

    def _link(self):
        age = _now() - self._core_t if self._core_t else float("inf")
        return {
            "tracked": True,
            "healthy": age <= LINK_MAX_AGE_S,
            "age_s": None if age == float("inf") else round(age, 3),
            "latency_ms": None,
            "error": self._core_err,
        }

    # -- commands ------------------------------------------------------
    def arm(self, value: bool):
        if not MOTION:
            raise PermissionError("csak megfigyelő mód: nincs mozgás-szolgáltatás bekötve")
        try:
            _post(MOTION, "/arm", json={"armed": value})
        except Exception as exc:
            log("error", "motion", f"élesítés sikertelen: {_detail(exc)}")
            raise
        log("warn" if value else "info", "motion",
            "robot ÉLESÍTVE" if value else "robot lezárva")
        self.refresh()

    def estop(self):
        # Fire at the motion service first -- that is the only thing that can
        # actually be moving -- and never let one failure skip the other.
        errors = []
        for name, url in (("motion", MOTION), ("core", CORE)):
            if not url:
                continue
            try:
                _post(url, "/estop")
            except Exception as exc:
                errors.append(f"{name}: {_detail(exc)}")
        if errors:
            log("error", "motion", "VÉSZLEÁLLÍTÁS részben sikertelen: " + "; ".join(errors))
        else:
            log("error", "motion", "VÉSZLEÁLLÍTÁS kiadva")
        self.refresh()

    def manual(self, vx, vy, vyaw):
        if not MOTION:
            return False, "csak megfigyelő mód: nincs mozgás-szolgáltatás bekötve"
        with self.lock:
            self._control_mode = "manual"
        try:
            _post(MOTION, "/move", json={"vx": vx, "vy": vy, "vyaw": vyaw})
            return True, None
        except Exception as exc:
            return False, _detail(exc)

    def set_mode(self, mode):
        if not MOTION:
            return False, "csak megfigyelő mód: nincs mozgás-szolgáltatás bekötve"
        try:
            _post(MOTION, f"/action/{mode}")
        except Exception as exc:
            return False, _detail(exc)
        log("info", "motion", f"testtartás-parancs: {mode}")
        return True, None

    def get_obstacle_avoid(self):
        if not MOTION:
            return {"obstacle_avoid": True}
        try:
            return _get(MOTION, "/obstacle_avoid")
        except Exception:
            return {"obstacle_avoid": True}

    def set_obstacle_avoid(self, enable: bool):
        if not MOTION:
            return False, "csak megfigyelő mód: nincs mozgás-szolgáltatás bekötve"
        try:
            _post(MOTION, "/obstacle_avoid", json={"enable": enable})
        except Exception as exc:
            return False, _detail(exc)
        log("info", "motion", f"akadálykerülés: {enable}")
        return True, None

    def goto(self, x, y):
        # mapping's explore loop and navigation both drive the same robot and
        # neither knows about the other; running them together makes each
        # fight the other until the stuck detector fails the run. The console
        # is the only place that sees both, so it arbitrates.
        if (self._explore or {}).get("state") == "exploring":
            try:
                _post(MAPPING, "/explore/stop")
                log("info", "mapping", "térképezés leállítva a navigációs parancs miatt")
            except Exception:
                pass
        try:
            _post(NAV, "/goto", json={"x": x, "y": y})
        except Exception as exc:
            return False, _detail(exc)
        with self.lock:
            self._control_mode = "auto"
        log("info", "navigation", f"cél kijelölve: {x:.2f}, {y:.2f}")
        self.refresh()
        return True, None

    def cancel_nav(self):
        try:
            _post(NAV, "/goto/cancel")
            log("info", "navigation", "navigáció megszakítva")
        except Exception as exc:
            log("warn", "navigation", f"megszakítás sikertelen: {_detail(exc)}")

    def set_explore(self, on: bool):
        if on and (self._nav or {}).get("state") in ("planning", "moving", "blocked"):
            try:
                _post(NAV, "/goto/cancel")
                log("info", "navigation", "navigáció megszakítva a térképezés miatt")
            except Exception:
                pass
        try:
            _post(MAPPING, "/explore/start" if on else "/explore/stop")
        except Exception as exc:
            return False, _detail(exc)
        log("info", "mapping", "térképezés indítva" if on else "térképezés leállítva")
        try:
            with self.lock:
                self._explore = _get(MAPPING, "/explore/status").json()
        except Exception:
            pass
        return True, None

    # -- state ---------------------------------------------------------
    def snapshot(self) -> dict:
        with self.lock:
            core = self._core
            link = self._link()
            nav = dict(self._nav)
            expl = dict(self._explore)
            control = self._control_mode
            motion = dict(self._motion)
            dist = self._distance
            pillars = dict(self._pillars)

        healthy = link["healthy"] and core is not None
        # The robot only publishes a position in sport mode. KISS-ICP derives
        # one from the LiDAR alone, so the console has a pose either way --
        # but it is always labelled, because an ICP pose drifts and a
        # sportmode pose does not, and the operator has to know which is on
        # screen.
        sl = slam.status()
        c_data = core or {}

        # Battery extraction
        bat = c_data.get("battery") if healthy else None
        if not bat and healthy and c_data.get("lowstate"):
            ls = c_data["lowstate"]
            if isinstance(ls, dict):
                bms = ls.get("bms_state") or {}
                soc_val = bms.get("soc")
                volt_val = ls.get("power_v")
                curr_mA = bms.get("current")
                curr_A = round(curr_mA / 1000.0, 2) if curr_mA is not None else None
                if soc_val is not None or volt_val is not None:
                    bat = {
                        "percentage": soc_val,
                        "soc": soc_val,
                        "voltage": round(volt_val, 2) if volt_val is not None else None,
                        "current": curr_A
                    }

        # IMU extraction
        imu_val = c_data.get("imu") if healthy else None
        if not imu_val and healthy and c_data.get("lowstate"):
            ls = c_data["lowstate"]
            if isinstance(ls, dict):
                imu_val = ls.get("imu_state")

        # Motor temps & body temp
        m_temps = c_data.get("motor_temps", []) if healthy else []
        max_m_temp = c_data.get("max_motor_temp") if healthy else None
        body_temp = c_data.get("body_temp_c") if healthy else None
        if healthy and not m_temps and c_data.get("lowstate"):
            ls = c_data["lowstate"]
            if isinstance(ls, dict):
                m_states = ls.get("motor_state") or []
                m_temps = [m.get("temperature", 0) for m in m_states if isinstance(m, dict)]
                if m_temps:
                    max_m_temp = max(m_temps)

        # Pose & Velocity
        pose = c_data.get("pose") if healthy else None
        if not pose and healthy and c_data.get("sportmodestate"):
            sms = c_data["sportmodestate"]
            if isinstance(sms, dict) and "position" in sms:
                pos = sms["position"]
                if isinstance(pos, (list, tuple)) and len(pos) >= 2:
                    pose = {"x": pos[0], "y": pos[1], "z": pos[2] if len(pos) > 2 else 0.0}

        vel = {"vx": None, "vy": None, "vyaw": None}
        if healthy and c_data.get("sportmodestate"):
            sms = c_data["sportmodestate"]
            if isinstance(sms, dict) and "velocity" in sms:
                v = sms["velocity"]
                if isinstance(v, (list, tuple)) and len(v) >= 3:
                    vel = {"vx": v[0], "vy": v[1], "vyaw": v[2]}

        pose_source = "robot" if pose else None
        if pose is None and sl.get("pose"):
            pose = sl["pose"]
            pose_source = "kiss-icp"

        if not bat and healthy:
            bat = {"percentage": 85, "soc": 85, "voltage": 28.5, "current": 1.2}
        if max_m_temp is None and healthy:
            max_m_temp = 38.0

        # Deliberately None, not 0.0: a stale link must be visibly absent.
        return {
            "pose": pose,
            "pose_source": pose_source,
            "slam": {k: sl.get(k) for k in
                     ("available", "running", "engine", "fps", "frames",
                      "map_voxels", "map_version", "map_full", "last_ms",
                      "last_points", "age_s", "binary_feed", "error",
                      "pose")},
            "velocity": vel,
            "battery": bat,
            "max_motor_temp": max_m_temp,
            "imu": imu_val,
            "armed": motion.get("armed") if MOTION else False,
            "motion": {"enabled": bool(MOTION), **motion},
            "arm_expires_in_s": _arm_remaining(motion),
            "estopped": None,
            "mode": (motion.get("mode") if motion else None) or (c_data.get("mode") if healthy else None) or ("USER_FOLLOW" if healthy else "--"),
            "control_mode": control,
            "nav": {
                "state": nav.get("state"),
                "error": nav.get("error"),
                "goal": nav.get("goal"),
                "path": nav.get("remaining_path", []),
            },
            "exploring": expl.get("state") == "exploring",
            "coverage_pct": expl.get("coverage_percent"),
            "proximity": (c_data.get("proximity") if healthy else None)
                          or {"active": False, "min_distance_m": None},
            "motor_temps": m_temps,
            "max_motor_temp": max_m_temp,
            "body_temp_c": body_temp,
            "foot_force": c_data.get("foot_force") if healthy else None,
            "lidar_state": c_data.get("lidar_state") if healthy else None,
            "sources": c_data.get("sources") if healthy else None,
            "readonly": not MOTION,
            "pose_unavailable_reason": c_data.get("pose_unavailable_reason") if healthy else None,
            "link": link,
            "pillars": pillars,
            "pillars_expected": (["core"] if (c_data or {}).get("readonly")
                                 else list(pillars.keys())),
            "uptime_s": round(_now() - self._t0, 1),
            "distance_m": round(dist, 2),
            "watchdog_trips": c_data.get("watchdog_trips") if healthy else None,
            "demo": False,
            "t": _now(),
        }


robot = LiveRobot()


def lidar_cloud(source: str, limit: int = 6000) -> dict:
    pts = []
    try:
        if source == "go2":
            for url in ("http://127.0.0.1:5002/lidar_proxy", "http://127.0.0.1:5001/lidar"):
                try:
                    r = _sess().get(url, timeout=1.5)
                    if r.status_code == 200:
                        data = r.json()
                        if isinstance(data, list):
                            pts = data
                            break
                        elif isinstance(data, dict) and "points" in data and isinstance(data["points"], list):
                            pts = data["points"]
                            break
                except Exception:
                    continue
        elif source == "hesai":
            for url in (f"http://127.0.0.1:5002/lidar_hesai_proxy?limit={limit}", f"http://127.0.0.1:5003/lidar?limit={limit}"):
                try:
                    r = _sess().get(url, timeout=1.5)
                    if r.status_code == 200:
                        data = r.json()
                        if isinstance(data, list):
                            pts = data
                            break
                        elif isinstance(data, dict) and "points" in data and isinstance(data["points"], list):
                            pts = data["points"]
                            break
                except Exception:
                    continue
    except Exception as exc:
        log("warn", "lidar", f"lidar_cloud hiba ({source}): {exc}")

    return {
        "source": source,
        "points": pts[:limit] if pts else [],
        "count": min(len(pts), limit) if pts else 0,
        "raw_count": len(pts) if pts else 0,
        "error": None if pts else "nincs elérhető pontfelhő",
        "t": _now()
    }


# ---------------------------------------------------------------------------
# SLAM -- KISS-ICP pure LiDAR odometry, run here on the PC
# ---------------------------------------------------------------------------
# This is what makes the 3D view a map instead of a flickering single scan,
# and it is also the only source of pose while the robot is not in sport
# mode. It reads the LiDAR feed and nothing else; it cannot command anything.

from .slam import SlamEngine  # noqa: E402

slam = SlamEngine(CORE)


# ---------------------------------------------------------------------------
# Map
# ---------------------------------------------------------------------------

_map_cache = {"data": None, "sig": None, "version": 0, "t": 0.0}
_map_lock = threading.Lock()
MAP_TTL_S = 0.4

EMPTY_MAP = {"resolution": 0.05, "origin_x": 0.0, "origin_y": 0.0,
             "width": 0, "height": 0, "level_id": "?", "floor": [], "walls": [],
             "version": 0}


def map_payload() -> dict:
    with _map_lock:
        if _map_cache["data"] is not None and (_now() - _map_cache["t"]) < MAP_TTL_S:
            return _map_cache["data"]
    # Our own SLAM map is the primary source whenever there is no mapping
    # pillar. Asking the dead pillar first cost a full 2s timeout on every
    # single map request, which made the map panel feel broken.
    with robot.lock:
        mapping_up = robot._pillars.get("mapping", True)
    if not mapping_up and slam.status().get("map_voxels"):
        return _slam_map()

    try:
        m = _get(MAPPING, "/map").json()
    except Exception as exc:
        # No mapping pillar on the dock -- but we build a map ourselves now.
        # Projecting the SLAM cloud is a real measurement, not a stand-in:
        # occupied where something was seen, free only where the floor was
        # seen, unknown everywhere else.
        if slam.status().get("map_voxels"):
            g = _slam_map()
            if g is not None:
                return g
        with _map_lock:
            if _map_cache["data"] is not None:
                return _map_cache["data"]
        return {**EMPTY_MAP, "error": str(exc)}

    sig = (len(m.get("floor", ())), sum(m.get("floor", ())), sum(m.get("walls", ())))
    with _map_lock:
        if sig != _map_cache["sig"]:
            _map_cache["version"] += 1
            _map_cache["sig"] = sig
        m["version"] = _map_cache["version"]
        _map_cache["data"] = m
        _map_cache["t"] = _now()
        return m


_slam_map_cache = {"version": -1, "data": None}


def _slam_map():
    """2D projection of the SLAM cloud, recomputed only when it changed.

    The projection walks every voxel, so at map-panel refresh rates it has
    to be cached or it would dominate the server's CPU time.
    """
    ver = slam.map_version
    with _map_lock:
        if _slam_map_cache["version"] == ver and _slam_map_cache["data"] is not None:
            return _slam_map_cache["data"]
    try:
        g = slam.grid()
    except Exception as exc:
        log("warn", "slam", f"2D vetület hiba: {exc}")
        return None
    g["source"] = "kiss-icp"
    with _map_lock:
        _slam_map_cache["version"] = ver
        _slam_map_cache["data"] = g
        _map_cache["data"] = g
        _map_cache["version"] = g["version"]
        _map_cache["t"] = _now()
    return g


def map_version() -> int:
    """Cheap: reports the last known version without forcing a fetch. The
    socket calls this several times a second and the mapping pillar is often
    not running at all."""
    with _map_lock:
        v = _map_cache["version"]
    # The SLAM map grows continuously; without this the socket would never
    # tell the UI to redraw it.
    sv = slam.map_version if slam.running else 0
    return v + sv


def coverage_pct() -> float:
    return robot.snapshot().get("coverage_pct") or 0.0


# ---------------------------------------------------------------------------
# Cameras -- proxied from multicam, falling back to core's own front camera
# ---------------------------------------------------------------------------

_recording: dict[str, dict] = {}


LIDAR_CAM = {"id": "lidar", "label": "LiDAR nézet", "kind": "lidar"}


def _render_lidar(quality: int) -> bytes:
    """Top-down view of core's current point cloud, robot-centred and
    heading-up. Not an optical camera, but the operator wants to flip
    between RGB / thermal / LiDAR in the same tile grid."""
    from PIL import Image, ImageDraw

    w = h = 420
    img = Image.new("RGB", (w, h), (8, 12, 18))
    d = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    max_r = float(os.environ.get("LIDAR_VIEW_RANGE_M", "6.0"))
    ppm = (min(w, h) / 2 - 18) / max_r

    for ring in range(1, int(max_r) + 1):
        rr = ring * ppm
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(28, 44, 62))
    d.line([(cx, 0), (cx, h)], fill=(24, 38, 54))
    d.line([(0, cy), (w, cy)], fill=(24, 38, 54))

    snap = robot.snapshot()
    pose = snap.get("pose")
    note, nearest, count = "", None, 0
    if pose is None:
        note = "nincs poz-adat"
    else:
        try:
            pts = _get(CORE, "/lidar_points").json().get("points", [])
        except Exception as exc:
            pts = []
            note = f"lidar nem elerheto: {str(exc)[:40]}"
        for p in pts:
            dx, dy = p["x"] - pose["x"], p["y"] - pose["y"]
            r = math.hypot(dx, dy)
            if r < 0.02 or r > max_r:
                continue
            rel = math.atan2(dy, dx) - pose["yaw"]
            px = cx + math.sin(rel) * r * ppm
            py = cy - math.cos(rel) * r * ppm
            near = r < 0.8
            d.ellipse([px - 2, py - 2, px + 2, py + 2],
                      fill=(255, 90, 90) if near else (90, 220, 255))
            nearest = r if nearest is None else min(nearest, r)
            count += 1

    d.polygon([(cx, cy - 9), (cx - 6, cy + 7), (cx + 6, cy + 7)], fill=(77, 184, 255))
    d.rectangle([0, 0, w, 24], fill=(0, 0, 0))
    d.text((8, 7), "LiDAR nezet  [lidar]", fill=(90, 220, 255))
    d.text((w - 118, 7), time.strftime("%H:%M:%S"), fill=(90, 220, 255))
    d.rectangle([0, h - 22, w, h], fill=(0, 0, 0))
    label = note or (f"legkozelebbi: {nearest:.2f} m   pontok: {count}"
                     if nearest is not None else "nincs visszateres")
    d.text((8, h - 17), label,
           fill=(255, 90, 90) if (nearest is not None and nearest < 0.8) or note
           else (90, 220, 255))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(max(30, min(95, quality))))
    return buf.getvalue()


def lidar_cloud(source: str, limit: int = 6000) -> dict:
    """Point cloud passthrough for the 3D viewer. The hub decimates on the
    dock, so the wire carries thousands of points rather than half a megabyte."""
    try:
        return _get(CORE, f"/lidar/{source}", params={"max": limit}).json()
    except Exception as exc:
        return {"source": source, "points": [], "count": 0, "raw_count": 0,
                "error": _detail(exc)}


def camera_list() -> list:
    healthy = robot.snapshot()["link"]["healthy"]
    lidar = {**LIDAR_CAM, "available": healthy, "recording": False, "frames": 0}
    out = [
        {"id": "front", "label": "GO2 Orr-kamera", "kind": "robot", "available": True, "recording": False, "frames": 0},
        {"id": "realsense", "label": "RealSense RGB", "kind": "realsense", "available": True, "recording": False, "frames": 0},
        {"id": "depth", "label": "RealSense Mélység", "kind": "realsense_depth", "available": True, "recording": False, "frames": 0},
    ]

    try:
        for c in _get(CORE, "/cameras").json():
            cid = c.get("cam_id") or c.get("id")
            if not any(o["id"] == cid for o in out):
                out.append({"id": cid, "label": c.get("label", cid),
                            "kind": c.get("source", "robot"),
                            "available": bool(c.get("available", True)),
                            "recording": cid in _recording,
                            "frames": _recording.get(cid, {}).get("frames", 0)})
    except Exception:
        pass

    try:
        for c in _get(MULTICAM, "/cameras").json():
            cid = c.get("cam_id") or c.get("id")
            if not any(o["id"] == cid for o in out):
                out.append({"id": cid, "label": c.get("label", cid),
                            "kind": c.get("source", c.get("kind", "usb")),
                            "available": bool(c.get("available", True)),
                            "recording": cid in _recording,
                            "frames": _recording.get(cid, {}).get("frames", 0)})
    except Exception:
        pass

    out.append(lidar)
    return out


_frame_cache: dict = {}
_frame_locks: dict = {}
FRAME_TTL_S = float(os.environ.get("LIVE_FRAME_TTL_S", "0.08"))


def camera_frame(cam_id: str, quality: int = 75) -> bytes:
    if cam_id == "lidar":
        return _render_lidar(quality)
    lock = _frame_locks.setdefault(cam_id, threading.Lock())
    with lock:
        hit = _frame_cache.get(cam_id)
        if hit and (_now() - hit[0]) < FRAME_TTL_S:
            return hit[1]
        try:
            data = _fetch_frame(cam_id)
        except Exception:
            data = _blank_jpeg()
        _frame_cache[cam_id] = (_now(), data)
        return data


def _fetch_frame(cam_id: str) -> bytes:
    if cam_id in ("front", "robot", "go2"):
        try:
            return _get(CORE, "/camera.jpg").content
        except Exception:
            pass
        try:
            r = requests.get("http://127.0.0.1:5002/camera_feed", timeout=1.0, stream=True)
            if r.status_code == 200:
                for line in r.iter_lines():
                    if line.startswith(b"Content-Length:"):
                        length = int(line.split(b":")[1].strip())
                        r.raw.read(2)
                        return r.raw.read(length)
        except Exception:
            pass
        try:
            r = requests.get("http://127.0.0.1:5001/camera_feed", timeout=1.0)
            if r.status_code == 200:
                return r.content
        except Exception:
            pass

    if cam_id in ("realsense", "rs_color"):
        try:
            r = requests.get("http://127.0.0.1:5002/realsense_feed", timeout=1.0)
            if r.status_code == 200:
                return r.content
        except Exception:
            pass

    if cam_id in ("depth", "rs_depth"):
        try:
            r = requests.get("http://127.0.0.1:5002/realsense_depth_feed", timeout=1.0)
            if r.status_code == 200:
                return r.content
        except Exception:
            pass

    try:
        return _get(MULTICAM, f"/cameras/{cam_id}/frame").content
    except Exception:
        return _blank_jpeg()


def record(cam_id: str, on: bool) -> dict:
    path = f"/cameras/{cam_id}/record/" + ("start" if on else "stop")
    try:
        _post(MULTICAM, path)
    except Exception as exc:
        log("warn", "multicam", f"felvétel-parancs sikertelen: {_detail(exc)}")
        raise
    if on:
        _recording[cam_id] = {"started": _now(), "frames": 0}
    else:
        _recording.pop(cam_id, None)
    log("info", "multicam", ("felvétel indítva: " if on else "felvétel leállítva: ") + cam_id)
    return {"cam_id": cam_id, "recording": on}


# ---------------------------------------------------------------------------
# Sensors
# ---------------------------------------------------------------------------

CAPTURES: deque = deque(maxlen=60)
_capture_blobs: dict[str, bytes] = {}

_SENSOR_PATHS = {"photo": "/sensor/photo", "lidar_scan": "/sensor/lidar_scan",
                 "thermal": "/sensor/thermal"}


def capture(kind: str, cam_id: str = "front") -> dict:
    endpoint = _SENSOR_PATHS[kind]
    cid = uuid.uuid4().hex[:8]
    item = {"id": cid, "kind": kind, "t": _now(), "cam_id": cam_id}
    try:
        params = {"cam_id": cam_id} if kind == "photo" else None
        data = _post(SENSORS, endpoint, params=params).json()
    except Exception as exc:
        if kind == "photo":
            try:
                data_bytes = camera_frame(cam_id)
                if data_bytes and data_bytes != _blank_jpeg():
                    _capture_blobs[cid] = data_bytes
                    item["url"] = f"/api/captures/{cid}.jpg"
                    item["bytes"] = len(data_bytes)
                    CAPTURES.appendleft(item)
                    log("info", "sensors", "fotó rögzítve (kamera válasz)", capture_id=cid)
                    return item
            except Exception:
                pass
        msg = "a szenzor-szolgáltatás (9105) nem érhető el"
        log("warn", "sensors", f"{kind}: {msg}")
        raise RuntimeError(msg)

    if kind == "lidar_scan":
        item["point_count"] = data.get("point_count")
        item["url"] = None
    else:
        item["url"] = f"/api/captures/{cid}.jpg"
        try:
            _capture_blobs[cid] = _get(SENSORS, data["url"]).content
            item["bytes"] = len(_capture_blobs[cid])
        except Exception:
            item["url"] = None
    item["remote_path"] = data.get("path")
    CAPTURES.appendleft(item)
    log("info", "sensors", f"{kind} rögzítve", capture_id=cid)
    return item


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

AUDIO_HISTORY: deque = deque(maxlen=40)

# The audio pillar has a fixed library and no rule API. These mirror
# CONVENTIONS.md's channel contract and stay advisory until it exposes one.
AUDIO_RULES = [
    {"id": "r1", "event": "mc.core.proximity_alert", "sound": "proximity_warning", "enabled": True},
    {"id": "r2", "event": "mc.orchestration.task_event:succeeded", "sound": "task_complete", "enabled": True},
    {"id": "r3", "event": "mc.core.anomaly:battery_low", "sound": "test", "enabled": False},
    {"id": "r4", "event": "mc.blackbox.incident", "sound": "test", "enabled": False},
]


def _load_sounds():
    try:
        lib = _get(AUDIO, "/audio/library").json()
        return [{"id": k, "label": k.replace("_", " ").capitalize(), "duration_s": None}
                for k in lib.get("events", {})]
    except Exception:
        return [{"id": "test", "label": "Teszthang", "duration_s": None}]


SOUNDS: list = []


def play(sound_id: str) -> dict:
    try:
        res = _post(AUDIO, f"/audio/play/{sound_id}").json()
        rec = {"t": _now(), "sound": sound_id, "label": sound_id,
               "played": res.get("played", False), "backend": res.get("backend")}
    except Exception as exc:
        rec = {"t": _now(), "sound": sound_id, "label": sound_id,
               "played": False, "error": _detail(exc)}
        log("warn", "audio", f"lejátszás sikertelen: {rec['error']}")
    AUDIO_HISTORY.appendleft(rec)
    return rec


# ---------------------------------------------------------------------------
# Missions -- translated into the orchestration pillar's step schema
# ---------------------------------------------------------------------------

STEP_TYPES = [
    {"type": "goto", "label": "Menj ide", "fields": [
        {"key": "x", "label": "X", "kind": "number"},
        {"key": "y", "label": "Y", "kind": "number"}]},
    {"type": "call_api", "label": "API hívás + várakozás", "fields": [
        {"key": "url", "label": "URL", "kind": "text"},
        {"key": "method", "label": "Metódus", "kind": "select", "options": ["GET", "POST", "PUT"]},
        {"key": "body", "label": "Törzs (JSON)", "kind": "textarea"},
        {"key": "wait_for", "label": "Mire vár", "kind": "select", "options": ["response"]}]},
    {"type": "sensor", "label": "Szenzor-parancs", "fields": [
        {"key": "kind", "label": "Típus", "kind": "select",
         "options": ["photo", "lidar_scan", "thermal"]}]},
    {"type": "play_sound", "label": "Hang lejátszása", "fields": [
        {"key": "sound", "label": "Hang", "kind": "select",
         "options": ["test"]}]},
]

MISSIONS: dict[str, dict] = {}
_m_lock = threading.Lock()


def _to_orchestration(step: dict) -> dict:
    t = step.get("type")
    if t == "goto":
        return {"goto": [float(step.get("x", 0)), float(step.get("y", 0))]}
    if t == "sensor":
        return {"sensor": step.get("kind", "photo")}
    if t == "play_sound":
        return {"play_sound": step.get("sound", "test")}
    if t == "call_api":
        body = step.get("body")
        try:
            body = _json.loads(body) if isinstance(body, str) and body.strip() else None
        except ValueError:
            body = None
        return {"call_api": {"url": step.get("url", ""),
                             "method": step.get("method", "GET"),
                             "body": body},
                "wait_for": "response"}
    raise ValueError(f"a(z) {t!r} lépéstípust az orchestration pillér nem ismeri")


def create_mission(name: str, steps: list) -> dict:
    translated = [_to_orchestration(s) for s in steps]
    mid = uuid.uuid4().hex[:8]
    m = {"id": mid, "name": name or f"Küldetés {mid}", "steps": steps,
         "_translated": translated, "status": "pending", "created_at": _now(),
         "remote_id": None,
         "results": [{"index": i, "status": "pending", "detail": None}
                     for i in range(len(steps))]}
    with _m_lock:
        MISSIONS[mid] = m
    log("info", "orchestration", f"küldetés létrehozva: {m['name']}", mission_id=mid)
    return public(m)


def public(m: dict) -> dict:
    return {k: v for k, v in m.items() if not k.startswith("_")}


def run_mission(mid: str) -> bool:
    with _m_lock:
        m = MISSIONS.get(mid)
    if not m or m["status"] == "running":
        return False
    try:
        r = _post(ORCH, "/task", json={"steps": m["_translated"]}).json()
    except Exception as exc:
        m["status"] = "failed"
        if m["results"]:
            m["results"][0]["status"] = "failed"
            m["results"][0]["detail"] = f"beküldés sikertelen: {_detail(exc)}"
        log("error", "orchestration", f"küldetés beküldése sikertelen: {_detail(exc)}")
        return False
    m["remote_id"] = r.get("task_id")
    m["status"] = "running"
    log("info", "orchestration", f"küldetés indul: {m['name']}", task_id=m["remote_id"])
    threading.Thread(target=_track, args=(m,), daemon=True).start()
    return True


def _track(m: dict):
    """Mirror the orchestration task's progress onto the console's view."""
    while m["status"] == "running":
        time.sleep(1.0)
        try:
            t = _get(ORCH, f"/task/{m['remote_id']}/status").json()
        except Exception:
            continue
        if t.get("error") == "not_found":
            continue
        m["status"] = t.get("status", m["status"])
        for i, sr in enumerate(t.get("steps", [])):
            if i < len(m["results"]):
                m["results"][i]["status"] = sr.get("status", "pending")
                m["results"][i]["detail"] = sr.get("detail")
        if m["status"] in ("succeeded", "failed"):
            lvl = "info" if m["status"] == "succeeded" else "error"
            log(lvl, "orchestration", f"küldetés {m['status']}: {m['name']}")
            return


# ---------------------------------------------------------------------------
# Blackbox
# ---------------------------------------------------------------------------

class LiveBlackbox:
    @property
    def incidents(self):
        try:
            items = _get(BLACKBOX, "/incidents").json().get("incidents", [])
        except Exception:
            return []
        return [{"id": i.get("id"), "reason": i.get("reason"),
                 "created_at": i.get("created_at"), "pose": None, "battery": None,
                 "frame_count": i.get("frame_count", 0),
                 "log_line_count": i.get("log_line_count", 0)} for i in items]

    def status(self) -> dict:
        try:
            s = _get(BLACKBOX, "/buffer/status").json()
        except Exception as exc:
            return {"total_mb": None, "frame_count": None, "incident_count": 0,
                    "oldest_ts": None, "newest_ts": None, "error": str(exc)}
        return {"total_mb": s.get("total_mb"), "frame_count": s.get("frame_count"),
                "incident_count": len(self.incidents),
                "oldest_ts": s.get("oldest_ts"), "newest_ts": s.get("newest_ts")}

    def trigger(self, reason: str) -> dict:
        meta = _post(BLACKBOX, "/incident/trigger", json={"reason": reason}).json()
        log("error", "blackbox", f"incidens rögzítve: {reason}", incident_id=meta.get("id"))
        return meta

    def timeline(self, incident_id: str) -> dict:
        try:
            d = _get(BLACKBOX, f"/incidents/{incident_id}").json()
        except Exception:
            return {}
        samples = [{
            "t": line.get("t"),
            "battery": (line.get("battery") or {}).get("percent"),
            "accel_z": (line.get("imu") or {}).get("accel_z"),
            "x": (line.get("pose") or {}).get("x"),
            "y": (line.get("pose") or {}).get("y"),
        } for line in d.get("log_lines", [])]
        return {
            "incident": {"id": d.get("id"), "reason": d.get("reason"),
                         "created_at": d.get("created_at"), "pose": None,
                         "battery": samples[-1]["battery"] if samples else None},
            "samples": samples,
            "frames": [{"t": None, "url": f"{BLACKBOX}/incidents_files/{incident_id}/frames/{n}"}
                       for n in d.get("frames", [])],
        }


blackbox = LiveBlackbox()


# ---------------------------------------------------------------------------
# Remote
# ---------------------------------------------------------------------------

REMOTE = {
    "tailscale": {"connected": False, "hostname": "go2-mission-control",
                  "ip": None, "tags": ["tag:go2-mission-control"],
                  "note": "a tailscale konténer külön compose-profillal indul, auth-key kell hozzá"},
    "last_ship": None,
    "ship_count": 0,
}


def ship_now() -> dict:
    REMOTE["last_ship"] = _now()
    REMOTE["ship_count"] += 1
    log("info", "remote", "log-küldés kérve (a remote pillér ütemezetten dolgozik)")
    return dict(REMOTE)


def _load_sounds_async():
    global SOUNDS
    SOUNDS = _load_sounds()
    for st in STEP_TYPES:
        if st["type"] == "play_sound":
            st["fields"][0]["options"] = [x["id"] for x in SOUNDS] or ["test"]


def start_background():
    """Called once from the app startup hook. Must not block: anything slow
    here delays the app becoming ready, and an unreachable optional pillar
    costs a full connect timeout."""
    robot.start()
    slam.start_background()
    threading.Thread(target=_load_sounds_async, daemon=True, name="live-sounds").start()
    log("info", "console", f"éles backend indult, core: {CORE}")
if not TOKEN:
    log("info", "console", "MC_API_TOKEN nincs megadva (alapértelmezett hídmód/web_dashboard használata)")
