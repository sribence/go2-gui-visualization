"""KISS-ICP pure-LiDAR odometry and 3D map accumulation for the console.

WHY THIS EXISTS
---------------
Until now the 3D view showed a single LiDAR frame: a cloud that redraws from
scratch several times a second and never becomes a map. The reason was not
the viewer -- it was that there was no pose. `sportmodestate` only publishes
while the robot is in sport mode, so with the robot standing on the dock
there is no position at all, and without a position consecutive frames
cannot be placed in a common coordinate system.

KISS-ICP removes that dependency entirely: it derives the 6-DoF trajectory
from the geometry of the point clouds themselves. No leg odometry, no IMU
integration, no sport mode. That is what turns our point cloud into a map.

WHERE IT RUNS
-------------
Here, on the operator PC -- deliberately not on the dock:
  * the Jetson has no internet, so `kiss_icp` cannot be pip-installed there;
  * the dock then stays exactly as it is, so nothing about this can change
    what the robot does. This module only ever reads.

The cost is bandwidth (a Hesai frame is ~18k points), which is why the hub
serves a binary float32 endpoint and we fall back to JSON only for an older
hub.

PARAMETERS
----------
The defaults come from the benchmark runs on the recorded walks
(docker/mapping/, walk_kicsi / walk_seta1), where KISS-ICP gave the tightest
wall reconstruction of the candidates. They are exposed in the settings
registry so they can be retuned without editing code.
"""
from __future__ import annotations

import math
import os
import struct
import threading
import time
from collections import deque

import numpy as np
import requests

SOURCE = os.environ.get("SLAM_SOURCE", "hesai")
HTTP_TIMEOUT = float(os.environ.get("SLAM_HTTP_TIMEOUT", "3.0"))

# Benchmarked defaults (Hesai PandarXT-16, 16 rings, indoor).
DEFAULTS = {
    "voxel_size": 0.15,     # KISS-ICP registration voxel
    "max_range": 12.0,
    "min_range": 0.35,
    "z_min": -0.60,         # sensor frame: below this is mostly the floor slab
    "z_max": 2.00,
    "map_voxel": 0.04,      # accumulated map resolution
    "map_max_voxels": 800000,
    "rate_hz": 5.0,
}

TRAJ_MAX = 4000

# Packing world voxel indices into one int keeps the global map a set of
# ints instead of a dict of lists: far less memory for the same map, and
# the centroid is recoverable from the key, so nothing is lost.
_BIAS = 1 << 20
_SHIFT = 21


def _pack(ix, iy, iz):
    return (ix + _BIAS) | ((iy + _BIAS) << _SHIFT) | ((iz + _BIAS) << (2 * _SHIFT))


def _unpack(keys: np.ndarray):
    mask = (1 << _SHIFT) - 1
    ix = (keys & mask) - _BIAS
    iy = ((keys >> _SHIFT) & mask) - _BIAS
    iz = ((keys >> (2 * _SHIFT)) & mask) - _BIAS
    return ix, iy, iz


def _rot_to_rpy(R):
    sy = math.hypot(R[0, 0], R[1, 0])
    if sy < 1e-6:
        return math.atan2(-R[1, 2], R[1, 1]), math.atan2(-R[2, 0], sy), 0.0
    return (math.atan2(R[2, 1], R[2, 2]),
            math.atan2(-R[2, 0], sy),
            math.atan2(R[1, 0], R[0, 0]))


class SlamEngine:
    """One background thread: fetch a scan, register it, accumulate the map.

    Everything the API serves is read under `lock` from pre-computed state,
    so a slow or stalled robot link degrades the freshness of the map and
    nothing else.
    """

    def __init__(self, core_url: str, settings=None):
        self.core = core_url.rstrip("/")
        self.settings = settings
        self.lock = threading.Lock()

        self._odo = None
        self._import_error = None
        self._cfg = dict(DEFAULTS)

        self.running = False          # operator switch
        self._started = False

        self.pose = None              # dict or None -- never a fake origin
        self.traj: deque = deque(maxlen=TRAJ_MAX)
        self.voxels: set = set()
        self.map_version = 0
        self.map_full = False

        self.frames = 0
        self.skipped = 0
        self.fps = 0.0
        self.last_points = 0
        self.last_ms = 0.0
        self.last_error = None
        self.last_frame_t = 0.0
        self.binary = None            # whether the hub serves the fast endpoint
        self.started_t = 0.0
        self._sig = None
        self._cloud_cache = None
        self._cloud_cache_ver = -1
        self._sess = None

    # -- configuration -------------------------------------------------
    def cfg(self, key):
        """Console settings win, falling back to the benchmarked default."""
        if self.settings is not None:
            try:
                v = self.settings.get("slam." + key, None)
                if v is not None:
                    return v
            except Exception:
                pass
        return self._cfg[key]

    def _build_odometry(self):
        from kiss_icp.kiss_icp import KissICP
        from kiss_icp.config import KISSConfig

        c = KISSConfig()
        c.mapping.voxel_size = float(self.cfg("voxel_size"))
        c.data.max_range = float(self.cfg("max_range"))
        c.data.min_range = float(self.cfg("min_range"))
        # Deskew needs per-point timestamps, which the bridge does not give
        # us; with them absent, motion compensation would be guessing.
        c.data.deskew = False
        return KissICP(c)

    # -- lifecycle -----------------------------------------------------
    def start_background(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._loop, daemon=True, name="slam").start()

    def set_running(self, on: bool):
        if on and self._import_error:
            return False, self._import_error
        with self.lock:
            self.running = bool(on)
            if on and not self.started_t:
                self.started_t = time.time()
        return True, None

    def reset(self):
        """Drop the map and the trajectory and re-seed the odometry.

        Needed whenever the robot has been carried, the link dropped for a
        while, or the operator simply wants a clean run: KISS-ICP has no way
        to recover from a jump it never observed, and a map stitched across
        one is worse than no map.
        """
        with self.lock:
            self._odo = None
            self.pose = None
            self.traj.clear()
            self.voxels = set()
            self.map_version += 1
            self.map_full = False
            self.frames = 0
            self.skipped = 0
            self.fps = 0.0
            self.started_t = time.time()
            self._sig = None
            self._cloud_cache = None
            self._cloud_cache_ver = -1
            self.last_error = None

    # -- scan input ----------------------------------------------------
    def _session(self) -> requests.Session:
        if self._sess is None:
            self._sess = requests.Session()
        return self._sess

    def _fetch(self):
        """Newest scan as an (N,3) float32 array, in the sensor frame.

        Prefers the binary endpoint of the hub: the same frame is ~216 kB
        packed against ~1.2 MB of JSON, and at 5 Hz that difference is the
        whole difference between real time and not.
        """
        s = self._session()
        if self.binary is not False:
            try:
                r = s.get(self.core + "/lidar_bin/" + SOURCE, timeout=HTTP_TIMEOUT)
                if r.status_code in (404, 405):
                    self.binary = False
                else:
                    r.raise_for_status()
                    self.binary = True
                    return self._parse_bin(r.content)
            except requests.HTTPError:
                self.binary = False

        r = s.get(self.core + "/lidar/" + SOURCE, params={"max": 200000},
                  timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        pts = r.json().get("points") or []
        if not pts:
            return None
        return np.asarray(pts, dtype=np.float32)[:, :3]

    @staticmethod
    def _parse_bin(buf: bytes):
        # header: magic "PC3D", uint32 count, then count * 3 * float32 LE
        if len(buf) < 8 or buf[:4] != b"PC3D":
            raise ValueError("ismeretlen binaris pontfelho-formatum")
        (n,) = struct.unpack_from("<I", buf, 4)
        if n == 0:
            return None
        arr = np.frombuffer(buf, dtype="<f4", count=n * 3, offset=8)
        return arr.reshape(n, 3)

    def _is_new(self, pts: np.ndarray) -> bool:
        """The hub caches each scan for ~0.2 s, so polling faster hands back
        the same frame. Registering a duplicate would tell the odometry the
        robot stood perfectly still, which is a lie that biases the adaptive
        threshold."""
        sig = (pts.shape[0], float(pts[0, 0]), float(pts[0, 1]),
               float(pts[pts.shape[0] // 2, 2]))
        if sig == self._sig:
            return False
        self._sig = sig
        return True

    # -- main loop -----------------------------------------------------
    def _loop(self):
        try:
            import kiss_icp  # noqa: F401
        except Exception as exc:
            self._import_error = ("a kiss_icp csomag nem erheto el: " + str(exc)[:120]
                                  + " -- telepites: pip install kiss-icp")
            return

        while True:
            if not self.running:
                time.sleep(0.2)
                continue
            period = 1.0 / max(0.5, float(self.cfg("rate_hz")))
            t_start = time.time()
            try:
                pts = self._fetch()
            except Exception as exc:
                with self.lock:
                    self.last_error = str(exc)[:160]
                time.sleep(max(period, 0.5))
                continue

            if pts is None or pts.shape[0] < 50:
                with self.lock:
                    self.skipped += 1
                time.sleep(period)
                continue
            if not self._is_new(pts):
                time.sleep(period * 0.35)
                continue

            try:
                self._register(pts)
                with self.lock:
                    self.last_error = None
            except Exception as exc:
                with self.lock:
                    self.last_error = "regisztracio: " + str(exc)[:140]

            time.sleep(max(0.0, period - (time.time() - t_start)))

    def _register(self, pts: np.ndarray):
        min_r = float(self.cfg("min_range"))
        max_r = float(self.cfg("max_range"))
        z_min = float(self.cfg("z_min"))
        z_max = float(self.cfg("z_max"))

        d = np.hypot(pts[:, 0], pts[:, 1])
        keep = (d >= min_r) & (d <= max_r) & (pts[:, 2] > z_min) & (pts[:, 2] < z_max)
        frame = np.ascontiguousarray(pts[keep], dtype=np.float64)
        if frame.shape[0] < 50:
            with self.lock:
                self.skipped += 1
            return

        t0 = time.time()
        if self._odo is None:
            self._odo = self._build_odometry()
        # KISS-ICP wants per-point timestamps; with deskew off they only
        # have to exist.
        self._odo.register_frame(frame, np.zeros(frame.shape[0]))
        P = self._odo.last_pose
        roll, pitch, yaw = _rot_to_rpy(P[:3, :3])

        world = frame @ P[:3, :3].T + P[:3, 3]
        self._accumulate(world)

        took = time.time() - t0
        now = time.time()
        with self.lock:
            self.pose = {"x": float(P[0, 3]), "y": float(P[1, 3]), "z": float(P[2, 3]),
                         "roll": roll, "pitch": pitch, "yaw": yaw,
                         "level_id": "slam", "source": "kiss-icp", "t": now}
            self.traj.append([round(float(P[0, 3]), 3), round(float(P[1, 3]), 3),
                              round(float(P[2, 3]), 3)])
            self.frames += 1
            self.last_points = int(frame.shape[0])
            self.last_ms = round(took * 1000, 1)
            dt = now - self.last_frame_t if self.last_frame_t else 0.0
            self.last_frame_t = now
            if dt > 0:
                # Smoothed: one slow HTTP round trip should not make the rate
                # readout jump around.
                self.fps = (self.fps * 0.8 + (1.0 / dt) * 0.2) if self.fps else 1.0 / dt

    def _accumulate(self, world: np.ndarray):
        res = float(self.cfg("map_voxel"))
        cap = int(self.cfg("map_max_voxels"))
        idx = np.floor(world / res).astype(np.int64)
        keys = _pack(idx[:, 0], idx[:, 1], idx[:, 2])
        with self.lock:
            before = len(self.voxels)
            if before >= cap:
                self.map_full = True
                return
            self.voxels.update(keys.tolist())
            if len(self.voxels) != before:
                self.map_version += 1

    # -- read side -----------------------------------------------------
    def status(self) -> dict:
        with self.lock:
            return {
                "available": self._import_error is None,
                "error": self._import_error or self.last_error,
                "running": self.running,
                "engine": "KISS-ICP",
                "source": SOURCE,
                "binary_feed": self.binary,
                "frames": self.frames,
                "skipped": self.skipped,
                "fps": round(self.fps, 2),
                "last_points": self.last_points,
                "last_ms": self.last_ms,
                "map_voxels": len(self.voxels),
                "map_full": self.map_full,
                "map_version": self.map_version,
                "pose": self.pose,
                "traj_len": len(self.traj),
                "age_s": (round(time.time() - self.last_frame_t, 2)
                          if self.last_frame_t else None),
                "uptime_s": (round(time.time() - self.started_t, 1)
                             if self.started_t else None),
                "config": {k: self.cfg(k) for k in
                           ("voxel_size", "max_range", "min_range",
                            "map_voxel", "rate_hz")},
            }

    def cloud(self, limit: int = 120000) -> dict:
        """The accumulated map as points, thinned to a browser-sized budget."""
        with self.lock:
            ver = self.map_version
            res = float(self.cfg("map_voxel"))
            if self._cloud_cache is not None and self._cloud_cache_ver == ver:
                keys = self._cloud_cache
            else:
                keys = np.fromiter(self.voxels, dtype=np.int64, count=len(self.voxels))
                self._cloud_cache = keys
                self._cloud_cache_ver = ver
            total = int(len(keys))
            traj = list(self.traj)

        if total == 0:
            return {"points": [], "count": 0, "total": 0, "version": ver,
                    "resolution": res, "trajectory": traj}
        if total > limit:
            keys = keys[np.linspace(0, total - 1, limit).astype(np.int64)]
        ix, iy, iz = _unpack(keys)
        pts = np.stack([(ix + 0.5) * res, (iy + 0.5) * res, (iz + 0.5) * res], axis=1)
        return {"points": np.round(pts, 3).tolist(), "count": int(len(keys)),
                "total": total, "version": ver, "resolution": res,
                "trajectory": traj}

    def grid(self, wall_lo=0.15, wall_hi=1.70, floor_z=0.12, res=0.05) -> dict:
        """2D occupancy projected from the 3D map.

        Derived only from what was actually measured: a cell is occupied if
        something was seen standing in it, free if the floor was seen there
        and nothing above it, and unknown otherwise. Nothing is inferred
        into free space, so the navigation layer cannot be fooled into
        driving through a region we never looked at.
        """
        with self.lock:
            keys = np.fromiter(self.voxels, dtype=np.int64, count=len(self.voxels))
            vres = float(self.cfg("map_voxel"))
            ver = self.map_version
        empty = {"resolution": res, "origin_x": 0.0, "origin_y": 0.0, "width": 0,
                 "height": 0, "level_id": "slam", "floor": [], "walls": [],
                 "version": ver}
        if len(keys) == 0:
            return empty
        ix, iy, iz = _unpack(keys)
        x = (ix + 0.5) * vres
        y = (iy + 0.5) * vres
        z = (iz + 0.5) * vres

        gx = np.floor(x / res).astype(np.int64)
        gy = np.floor(y / res).astype(np.int64)
        x0, x1 = int(gx.min()), int(gx.max())
        y0, y1 = int(gy.min()), int(gy.max())
        W, H = x1 - x0 + 1, y1 - y0 + 1
        if W * H > 4000000:
            return dict(empty, error="a terkep tul nagy ehhez a felbontashoz")
        lin = (gy - y0) * W + (gx - x0)

        occ = np.zeros(W * H, dtype=bool)
        flr = np.zeros(W * H, dtype=bool)
        hgt = np.zeros(W * H, dtype=np.int32)
        is_wall = (z >= wall_lo) & (z <= wall_hi)
        np.logical_or.at(occ, lin[is_wall], True)
        np.logical_or.at(flr, lin[z < floor_z], True)
        if bool(is_wall.any()):
            np.maximum.at(hgt, lin[is_wall], (z[is_wall] * 100).astype(np.int32))

        floor = np.full(W * H, -1, dtype=np.int16)
        floor[flr] = 0
        floor[occ] = 100
        walls = np.where(occ, np.clip(hgt, 1, 255), 0).astype(np.int16)
        return {"resolution": res, "origin_x": x0 * res, "origin_y": y0 * res,
                "width": W, "height": H, "level_id": "slam",
                "floor": floor.tolist(), "walls": walls.tolist(), "version": ver}
