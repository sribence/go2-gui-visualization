"""Offline check of the SLAM engine against a recorded walk.

Not a unit test of KISS-ICP (that is upstream's job) -- this checks our
wrapper: that a recorded walk produces a monotonically growing map, a
trajectory that actually moves, a 2D projection with real occupied cells,
and that the read side stays consistent with what was accumulated.

Run:  python tests/test_slam_offline.py <walk.jsonl> [frames]
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server.slam import SlamEngine  # noqa: E402

DEFAULT_SET = r"C:\Users\user\NERO_GO2\docker\mapping\walk_kicsi.jsonl"


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SET
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 150

    eng = SlamEngine("http://unused")
    t0 = time.time()
    used = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if used >= limit:
                break
            pts = json.loads(line).get("points") or []
            if not pts:
                continue
            eng._register(np.asarray(pts, dtype=np.float32)[:, :3])
            used += 1
    el = time.time() - t0

    st = eng.status()
    cloud = eng.cloud(limit=50000)
    grid = eng.grid()

    traj = np.asarray(cloud["trajectory"], dtype=float)
    span = traj.max(axis=0) - traj.min(axis=0) if len(traj) else np.zeros(3)
    occupied = sum(1 for v in grid["floor"] if v == 100)
    free = sum(1 for v in grid["floor"] if v == 0)

    print(f"adathalmaz      : {os.path.basename(path)}")
    print(f"feldolgozott    : {st['frames']} kepkocka {el:.1f}s alatt "
          f"({st['frames']/el:.1f} kepkocka/s, {st['last_ms']} ms/kepkocka)")
    print(f"terkep          : {st['map_voxels']} voxel @ {st['config']['map_voxel']} m")
    print(f"trajektoria     : {len(traj)} pont, elmozdulas x/y/z = "
          f"{span[0]:.2f} / {span[1]:.2f} / {span[2]:.2f} m")
    print(f"vegso poz.      : {st['pose']['x']:.2f}, {st['pose']['y']:.2f}, "
          f"{st['pose']['z']:.2f}  yaw={np.degrees(st['pose']['yaw']):.1f} fok")
    print(f"2D vetulet      : {grid['width']}x{grid['height']} cella, "
          f"{occupied} foglalt, {free} szabad, {grid['resolution']} m/cella")
    print(f"visszaadott pont: {cloud['count']} / {cloud['total']}")

    fails = []
    if st["frames"] < limit * 0.5:
        fails.append("tul keves kepkocka lett feldolgozva")
    if st["map_voxels"] < 1000:
        fails.append("a terkep ures maradt")
    if float(np.hypot(span[0], span[1])) < 0.20:
        fails.append("a trajektoria nem mozdult -- az odometria all")
    if occupied < 50:
        fails.append("a 2D vetuletben nincs foglalt cella")
    if cloud["count"] > 50000:
        fails.append("a pont-koltsegvetes nem ervenyesult")
    # Every returned point must sit inside the voxel grid it was built from.
    p = np.asarray(cloud["points"], dtype=float)
    if len(p) and not np.allclose(p, np.round(p, 3)):
        fails.append("a visszaadott pontok nem a voxelracsrol szarmaznak")

    print()
    if fails:
        for f_ in fails:
            print("  HIBA:", f_)
        sys.exit(1)
    print("Minden ellenorzes rendben.")


if __name__ == "__main__":
    main()
