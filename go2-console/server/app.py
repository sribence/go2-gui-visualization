"""Go2 Console -- aggregating API for the operator console.

One backend, one websocket, every module. In demo mode it is backed by
`demo_backend`; the same routes are the contract a live adapter has to
implement against the mission-control pillars.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .config import Settings, schema

# CONSOLE_BACKEND=demo (default) | live
# "live" talks to the mission-control pillars; "demo" is fully synthetic.
BACKEND_NAME = os.environ.get("CONSOLE_BACKEND", "demo").lower()
if BACKEND_NAME == "live":
    from . import live_backend as demo
else:
    from . import demo_backend as demo

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "web")

settings = Settings()
app = FastAPI(title="Go2 Console")


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    """Browsers cache ES modules hard. During development that means an edited
    module silently keeps running the old code, which is far more confusing
    than the cost of revalidating a few local files."""
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


# ---------------------------------------------------------------------------
# Shell
# ---------------------------------------------------------------------------
def _asset_version() -> str:
    """Newest mtime across the web assets -- changes whenever anything is
    edited, and stays stable between edits so caching still works."""
    newest = 0.0
    for root, _dirs, files in os.walk(WEB_DIR):
        for name in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, name)))
            except OSError:
                pass
    return f"?v={int(newest)}"


@app.get("/")
def index():
    with open(os.path.join(WEB_DIR, "index.html"), encoding="utf-8") as f:
        html = f.read().replace("__ASSET_V__", _asset_version())
    return Response(content=html, media_type="text/html",
                    headers={"Cache-Control": "no-store, must-revalidate"})


@app.on_event("startup")
def _startup():
    # The SLAM engine reads its tunables from the same registry the operator
    # edits, so a change in the Inspector takes effect on the next scan.
    if getattr(demo, "slam", None) is not None:
        demo.slam.settings = settings
    demo.start_background()


@app.get("/api/health")
def health():
    return {"ok": True, "mode": BACKEND_NAME, "t": time.time()}


# ---------------------------------------------------------------------------
# Settings registry -- the inspectors are generated from this
# ---------------------------------------------------------------------------
@app.get("/api/settings/schema")
def settings_schema():
    return schema()


@app.get("/api/settings")
def settings_values():
    return settings.all()


@app.post("/api/settings")
async def settings_update(request: Request):
    body = await request.json()
    applied, errors = {}, {}
    for key, value in (body or {}).items():
        ok, err = settings.set(key, value)
        (applied if ok else errors)[key] = value if ok else err
    if applied:
        demo.log("info", "settings", f"{len(applied)} paraméter módosítva",
                 keys=list(applied.keys()))
    return {"applied": applied, "errors": errors, "values": settings.all()}


@app.post("/api/settings/profile/{name}")
def settings_profile(name: str):
    ok, err = settings.apply_profile(name)
    if not ok:
        raise HTTPException(status_code=404, detail=err)
    demo.log("info", "settings", f"profil alkalmazva: {name}")
    return {"ok": True, "values": settings.all()}


@app.post("/api/settings/reset")
def settings_reset():
    settings.reset()
    demo.log("warn", "settings", "minden paraméter alapértelmezettre állítva")
    return {"ok": True, "values": settings.all()}


# ---------------------------------------------------------------------------
# Robot state and control
# ---------------------------------------------------------------------------
@app.get("/api/state")
def state():
    return demo.robot.snapshot()


@app.post("/api/estop")
def estop():
    demo.robot.estop()
    motion_url = os.environ.get("MOTION_URL", settings.get("motion.url", "http://192.168.123.18:9102")).rstrip("/")
    try:
        requests.post(f"{motion_url}/estop", timeout=2.0)
    except Exception:
        pass
    return {"estop": True, "armed": False}


@app.post("/api/arm")
async def arm(request: Request):
    body = await request.json()
    demo.robot.arm(bool(body.get("armed", True)))
    return demo.robot.snapshot()


@app.post("/api/mode")
async def mode(request: Request):
    body = await request.json()
    ok, err = demo.robot.set_mode(body.get("mode", ""))
    if not ok:
        raise HTTPException(status_code=409, detail=err)
    return demo.robot.snapshot()


@app.get("/api/obstacle_avoid")
def get_obstacle_avoid():
    if hasattr(demo.robot, "get_obstacle_avoid"):
        return demo.robot.get_obstacle_avoid()
    return {"obstacle_avoid": getattr(demo, "obstacle_avoid_enabled", True)}


@app.post("/api/obstacle_avoid")
async def obstacle_avoid(request: Request):
    body = await request.json()
    enable = bool(body.get("enable", True))
    if hasattr(demo.robot, "set_obstacle_avoid"):
        ok, err = demo.robot.set_obstacle_avoid(enable)
        if not ok:
            raise HTTPException(status_code=409, detail=err)
    demo.obstacle_avoid_enabled = enable
    return {"ok": True, "obstacle_avoid": enable}


@app.post("/api/manual")
async def manual(request: Request):
    body = await request.json()
    mx = float(settings.get("manual.max_vx", 0.6))
    my = float(settings.get("manual.max_vy", 0.3))
    mw = float(settings.get("manual.max_vyaw", 0.9))
    dz = float(settings.get("manual.deadzone", 0.08))

    def axis(v, limit):
        v = float(v or 0.0)
        if v != v or abs(v) < dz:
            return 0.0
        return max(-limit, min(limit, v * limit))

    ok, err = demo.robot.manual(axis(body.get("vx"), mx),
                                 axis(body.get("vy"), my),
                                 axis(body.get("vyaw"), mw))
    if not ok:
        raise HTTPException(status_code=409, detail=err)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Map / navigation
# ---------------------------------------------------------------------------
@app.get("/api/map")
def get_map():
    return JSONResponse(content=demo.map_payload())


@app.post("/api/goto")
async def goto(request: Request):
    body = await request.json()
    x, y = body.get("x"), body.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        raise HTTPException(status_code=400, detail="numeric x and y required")
    ok, err = demo.robot.goto(float(x), float(y))
    if not ok:
        raise HTTPException(status_code=409, detail=err)
    return {"ok": True}


@app.get("/api/lidar/{source}")
def lidar_cloud(source: str, max: int = 6000):
    if source not in ("go2", "hesai"):
        raise HTTPException(status_code=404, detail=f"unknown lidar source {source}")
    return JSONResponse(content=demo.lidar_cloud(source, max))


# ---------------------------------------------------------------------------
# SLAM -- KISS-ICP odometry and the accumulated 3D map
# ---------------------------------------------------------------------------
def _slam():
    eng = getattr(demo, "slam", None)
    if eng is None:
        raise HTTPException(status_code=501,
                            detail="a SLAM csak éles módban érhető el (CONSOLE_BACKEND=live)")
    return eng


@app.get("/api/slam")
def slam_status():
    return _slam().status()


@app.get("/api/slam/cloud")
def slam_cloud(max: int = 120000):
    """The accumulated map. Separate from /api/lidar/* on purpose: that one
    is the live scan, this one is everything seen so far."""
    return JSONResponse(content=_slam().cloud(limit=max))


@app.post("/api/slam/run")
async def slam_run(request: Request):
    body = await request.json()
    ok, err = _slam().set_running(bool(body.get("on", True)))
    if not ok:
        raise HTTPException(status_code=503, detail=err)
    return {"ok": True, "running": bool(body.get("on", True))}


@app.post("/api/slam/reset")
def slam_reset():
    _slam().reset()
    return {"ok": True}


@app.post("/api/goto/cancel")
def goto_cancel():
    demo.robot.cancel_nav()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Perception -- Person Tracking API Proxy / Demo Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/perception/status")
def perception_status():
    target_lock = getattr(demo, "perception_target_id", 1)
    return {
        "source": "rosbridge",
        "model_loaded": True,
        "loop_fps": 10.0,
        "infer_ms": 14.2,
        "result_age_s": 0.1,
        "last_error": None,
        "target_lock": target_lock,
        "extrinsics": {"pitch_deg": 0.0, "height_m": 0.5}
    }


@app.get("/api/perception/persons")
def perception_persons():
    target_id = getattr(demo, "perception_target_id", 1)
    target_mode = "locked" if target_id is not None else "nearest"
    return {
        "t": time.time(),
        "seq": 100,
        "source": "rosbridge",
        "infer_ms": 14.2,
        "image_size": [640, 480],
        "count": 2,
        "target_id": target_id,
        "target_mode": target_mode,
        "persons": [
            {
                "track_id": 1,
                "confidence": 0.88,
                "bbox": {"x1": 180, "y1": 50, "x2": 320, "y2": 400},
                "pixel": {"u": 250, "v": 220},
                "depth_ok": True,
                "depth_valid_ratio": 1.0,
                "position": {"x": 2.1, "y": 0.3, "z": 0.2},
                "velocity": {"vx": 0.0, "vy": 0.0},
                "distance_m": 2.12,
                "bearing_deg": -8.1,
                "age_s": 5.2,
                "hits": 50
            },
            {
                "track_id": 2,
                "confidence": 0.65,
                "bbox": {"x1": 400, "y1": 100, "x2": 480, "y2": 300},
                "pixel": {"u": 440, "v": 200},
                "depth_ok": False,
                "depth_valid_ratio": 0.0,
                "position": None,
                "velocity": None,
                "distance_m": None,
                "bearing_deg": 25.0,
                "age_s": 1.1,
                "hits": 12
            }
        ]
    }


@app.post("/api/perception/target")
async def perception_set_target(request: Request):
    body = await request.json()
    track_id = body.get("track_id")
    demo.perception_target_id = track_id
    return {"target_lock": track_id}


@app.get("/api/perception/follow")
def perception_follow_status():
    mode = settings.get("perception.follow_mode", "off")
    dist = float(settings.get("perception.target_distance", 2.0))
    audio = bool(settings.get("perception.audio_alert", True))
    dry = bool(settings.get("perception.dry_run", True))
    target_id = getattr(demo, "perception_target_id", 1)
    state = "TRACKING" if (mode != "off" and target_id is not None) else "IDLE"

    return {
        "mode": mode,
        "target_distance_m": dist,
        "audio_alert": audio,
        "dry_run": dry,
        "target_id": target_id,
        "state": state,
        "command": {"vx": 0.15 if state == "TRACKING" else 0.0, "vyaw": -0.05 if state == "TRACKING" else 0.0},
        "target_dist_cm": 212 if target_id else None,
        "last_gesture": getattr(demo, "perception_last_gesture", None)
    }


@app.post("/api/perception/follow")
async def perception_follow_update(request: Request):
    body = await request.json()
    if "mode" in body:
        settings.set("perception.follow_mode", body["mode"])
    if "target_distance_m" in body:
        settings.set("perception.target_distance", body["target_distance_m"])
    if "audio_alert" in body:
        settings.set("perception.audio_alert", body["audio_alert"])
    if "dry_run" in body:
        settings.set("perception.dry_run", body["dry_run"])
    return perception_follow_status()


@app.post("/api/perception/follow/lock")
async def perception_follow_lock(request: Request):
    body = await request.json()
    track_id = body.get("track_id")
    demo.perception_target_id = track_id
    return {"target_lock": track_id, "state": "LOCKED" if track_id else "AUTO"}


@app.post("/api/perception/follow/release")
def perception_follow_release():
    demo.perception_target_id = None
    settings.set("perception.follow_mode", "off")
    return {"target_lock": None, "mode": "off", "state": "IDLE"}


@app.post("/api/perception/follow/gesture")
async def perception_follow_gesture(request: Request):
    body = await request.json()
    gesture = body.get("gesture")
    demo.perception_last_gesture = gesture
    return {"ok": True, "gesture": gesture, "action": f"Executed gesture action for '{gesture}'"}


@app.post("/api/perception/follow/enable")
def perception_follow_enable():
    override_url = settings.get("perception.override_url", "http://192.168.123.18:9113").rstrip("/")
    try:
        r = requests.post(f"{override_url}/enable", timeout=2.0)
        return r.json()
    except Exception:
        settings.set("perception.follow_mode", "user_follow")
        return {"enabled": True, "mode": "user_follow", "message": "Follow re-enabled (override reset)"}


@app.get("/api/perception/executor/status")
def perception_executor_status():
    executor_url = settings.get("perception.executor_url", "http://192.168.123.18:9113").rstrip("/")
    try:
        r = requests.get(f"{executor_url}/status", timeout=2.0)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {
        "enabled": True,
        "moving": False,
        "reason": getattr(demo, "executor_reason", "tracking"),
        "last_cmd": {"vx": 0.0, "vyaw": 0.0},
        "limits": getattr(demo, "executor_limits", {"max_vx": 0.3, "max_vx_back": 0.15, "max_vyaw": 0.6}),
        "hard_caps": {"max_vx": 0.4, "max_vx_back": 0.2, "max_vyaw": 0.8},
        "events": []
    }


@app.get("/api/perception/executor/limits")
def get_perception_executor_limits():
    executor_url = settings.get("perception.executor_url", "http://192.168.123.18:9113").rstrip("/")
    try:
        r = requests.get(f"{executor_url}/limits", timeout=2.0)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {
        "limits": getattr(demo, "executor_limits", {"max_vx": 0.3, "max_vx_back": 0.15, "max_vyaw": 0.6}),
        "hard_caps": {"max_vx": 0.4, "max_vx_back": 0.2, "max_vyaw": 0.8}
    }


@app.post("/api/perception/executor/limits")
async def perception_executor_limits(request: Request):
    body = await request.json()
    executor_url = settings.get("perception.executor_url", "http://192.168.123.18:9113").rstrip("/")
    try:
        r = requests.post(f"{executor_url}/limits", json=body, timeout=2.0)
        if r.status_code == 200:
            return r.json()
        elif r.status_code == 422:
            raise HTTPException(status_code=422, detail=r.json().get("detail", "Limit Exceeded hard cap"))
    except HTTPException:
        raise
    except Exception:
        pass
    demo.executor_limits = body
    return {"limits": body, "hard_caps": {"max_vx": 0.4, "max_vx_back": 0.2, "max_vyaw": 0.8}}


@app.post("/api/perception/executor/enable")
def perception_executor_enable():
    executor_url = settings.get("perception.executor_url", "http://192.168.123.18:9113").rstrip("/")
    try:
        r = requests.post(f"{executor_url}/enable", timeout=2.0)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {"enabled": True, "message": "Follow executor enabled"}


@app.post("/api/perception/executor/disable")
def perception_executor_disable():
    executor_url = settings.get("perception.executor_url", "http://192.168.123.18:9113").rstrip("/")
    try:
        r = requests.post(f"{executor_url}/disable", timeout=2.0)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {"enabled": False, "message": "Follow executor disabled"}


@app.get("/api/perception/models")
def perception_models():
    target_url = settings.get("perception.url", "http://192.168.123.18:9112").rstrip("/")
    try:
        r = requests.get(f"{target_url}/models", timeout=2.0)
        if r.status_code == 200:
            return r.json()
        elif r.status_code == 404:
            raise HTTPException(status_code=404, detail="YOLO /models endpoint not implemented yet on server")
    except HTTPException:
        raise
    except Exception:
        pass

    current_model = getattr(demo, "perception_current_model", {"id": "yolov8n", "format": "engine", "imgsz": 640, "half": True})
    switch_state = getattr(demo, "perception_switch_state", {"state": "idle", "target": None, "error": None, "started_at": None, "progress_note": None})
    return {
        "current": current_model,
        "available": [
            {"id": "yolov8n", "params_m": 3.2, "engine_ready": {"640": True, "480": True, "320": False}},
            {"id": "yolov8s", "params_m": 11.2, "engine_ready": {"640": True, "480": False, "320": False}},
            {"id": "yolo11n", "params_m": 2.6, "engine_ready": {"640": False, "480": False, "320": False}},
            {"id": "yolo11s", "params_m": 9.4, "engine_ready": {"640": False, "480": False, "320": False}}
        ],
        "imgsz_options": [320, 416, 480, 640],
        "switch": switch_state
    }


@app.post("/api/perception/model")
async def perception_switch_model(request: Request):
    body = await request.json()
    target_url = settings.get("perception.url", "http://192.168.123.18:9112").rstrip("/")
    try:
        r = requests.post(f"{target_url}/model", json=body, timeout=2.0)
        if r.status_code in (200, 202):
            return r.json()
        elif r.status_code == 404:
            raise HTTPException(status_code=404, detail="YOLO /model switch endpoint not implemented yet on server")
        elif r.status_code in (409, 422):
            raise HTTPException(status_code=r.status_code, detail=r.json().get("detail", "Error switching model"))
    except HTTPException:
        raise
    except Exception:
        pass

    model_id = body.get("id", "yolov8n")
    imgsz = body.get("imgsz", 640)
    fmt_val = body.get("format", "engine")
    demo.perception_current_model = {"id": model_id, "format": fmt_val, "imgsz": imgsz, "half": True}
    demo.perception_switch_state = {"state": "idle", "target": None, "error": None, "started_at": None, "progress_note": None}
    return {"switch": {"state": "idle", "target": demo.perception_current_model}}


@app.get("/api/perception/system/power")
def perception_system_power():
    target_url = settings.get("perception.url", "http://192.168.123.18:9112").rstrip("/")
    try:
        r = requests.get(f"{target_url}/system/power", timeout=2.0)
        if r.status_code == 200:
            return r.json()
        elif r.status_code == 404:
            raise HTTPException(status_code=404, detail="Power mode endpoint not implemented yet on server")
    except HTTPException:
        raise
    except Exception:
        pass

    return {
        "mode": "MAXN",
        "cpu_online": 4,
        "cpu_total": 8,
        "cpu_freq_mhz": [1651, 1651, 1651, 1651, 0, 0, 0, 0],
        "gpu_load_pct": 45,
        "switch_supported": False
    }


@app.post("/api/perception/system/power")
async def perception_set_system_power(request: Request):
    body = await request.json()
    target_url = settings.get("perception.url", "http://192.168.123.18:9112").rstrip("/")
    try:
        r = requests.post(f"{target_url}/system/power", json=body, timeout=2.0)
        if r.status_code == 200:
            return r.json()
        elif r.status_code == 404:
            raise HTTPException(status_code=404, detail="Power mode switch not implemented yet")
    except HTTPException:
        raise
    except Exception:
        pass

    raise HTTPException(status_code=403, detail="Energiamód váltáshoz admin (sudo) jóváhagyás szükséges.")


@app.post("/api/explore")
async def explore(request: Request):
    body = await request.json()
    ok, err = demo.robot.set_explore(bool(body.get("on", True)))
    if not ok:
        raise HTTPException(status_code=409, detail=err)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Cameras
# ---------------------------------------------------------------------------
@app.get("/api/cameras")
def cameras():
    return demo.camera_list()


@app.get("/api/cameras/{cam_id}/frame")
def camera_frame(cam_id: str):
    try:
        jpeg = demo.camera_frame(cam_id, int(settings.get("cam.jpeg_quality", 75)))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown camera {cam_id}")
    return Response(content=jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/cameras/{cam_id}/stream")
def camera_stream(cam_id: str):
    if not any(c["id"] == cam_id for c in demo.camera_list()):
        raise HTTPException(status_code=404, detail=f"unknown camera {cam_id}")
    boundary = "frameboundary"

    def gen():
        while True:
            fps = max(1.0, float(settings.get("cam.stream_fps", 10)))
            start = time.time()
            jpeg = demo.camera_frame(cam_id, int(settings.get("cam.jpeg_quality", 75)))
            if cam_id in demo._recording:
                demo._recording[cam_id]["frames"] += 1
            yield (b"--" + boundary.encode() + b"\r\nContent-Type: image/jpeg\r\n"
                   b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
            time.sleep(max(0.0, 1.0 / fps - (time.time() - start)))

    return StreamingResponse(gen(), media_type=f"multipart/x-mixed-replace; boundary={boundary}")


@app.post("/api/cameras/{cam_id}/record")
async def camera_record(cam_id: str, request: Request):
    body = await request.json()
    return demo.record(cam_id, bool(body.get("on", True)))


# ---------------------------------------------------------------------------
# Sensors
# ---------------------------------------------------------------------------
@app.get("/api/captures")
def captures():
    return list(demo.CAPTURES)


@app.post("/api/capture/{kind}")
def do_capture(kind: str):
    if kind not in ("photo", "lidar_scan", "thermal"):
        raise HTTPException(status_code=400, detail=f"unknown capture kind {kind}")
    cam = settings.get("sensor.photo_cam", "front") if kind == "photo" else "front"
    try:
        return demo.capture(kind, cam)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/captures/{name}")
def capture_blob(name: str):
    cid = name.rsplit(".", 1)[0]
    blob = demo._capture_blobs.get(cid)
    if blob is None:
        raise HTTPException(status_code=404, detail="capture not found")
    return Response(content=blob, media_type="image/jpeg")


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------
@app.get("/api/audio")
def audio():
    return {"sounds": demo.SOUNDS, "rules": demo.AUDIO_RULES,
            "history": list(demo.AUDIO_HISTORY)}


@app.post("/api/audio/play/{sound_id}")
def audio_play(sound_id: str):
    bridge_url = settings.get("webrtc.bridge_url", "http://192.168.123.18:5001").rstrip("/")
    try:
        r = requests.post(f"{bridge_url}/audio/play/{sound_id}", timeout=5.0)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return demo.play(sound_id)


@app.post("/api/speak")
async def speak(request: Request):
    body = await request.json()
    text = body.get("text", "")
    bridge_url = settings.get("webrtc.bridge_url", "http://192.168.123.18:5001").rstrip("/")
    try:
        r = requests.post(f"{bridge_url}/api/speak", json={"text": text}, timeout=10.0)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {"status": "ok", "text": text, "message": "Speech request processed"}


@app.post("/api/audio/rule/{rule_id}")
async def audio_rule(rule_id: str, request: Request):
    body = await request.json()
    for r in demo.AUDIO_RULES:
        if r["id"] == rule_id:
            if "enabled" in body:
                r["enabled"] = bool(body["enabled"])
            if "sound" in body:
                r["sound"] = str(body["sound"])
            demo.log("info", "audio", f"szabály módosítva: {r['event']}")
            return r
    raise HTTPException(status_code=404, detail="rule not found")


# ---------------------------------------------------------------------------
# Missions
# ---------------------------------------------------------------------------
@app.get("/api/missions/step_types")
def step_types():
    return demo.STEP_TYPES


@app.get("/api/missions")
def missions():
    items = sorted(demo.MISSIONS.values(), key=lambda m: m["created_at"], reverse=True)
    return [{k: v for k, v in m.items() if not k.startswith("_")} for m in items]


@app.post("/api/missions")
async def mission_create(request: Request):
    body = await request.json()
    steps = body.get("steps") or []
    if not isinstance(steps, list) or not steps:
        raise HTTPException(status_code=400, detail="at least one step required")
    return demo.create_mission(body.get("name", ""), steps)


@app.post("/api/missions/{mid}/run")
def mission_run(mid: str):
    if not demo.run_mission(mid):
        raise HTTPException(status_code=409, detail="mission not found or already running")
    return {"ok": True}


@app.post("/api/missions/{mid}/cancel")
def mission_cancel(mid: str):
    m = demo.MISSIONS.get(mid)
    if not m:
        raise HTTPException(status_code=404, detail="mission not found")
    m["cancel"] = True
    return {"ok": True}


@app.delete("/api/missions/{mid}")
def mission_delete(mid: str):
    demo.MISSIONS.pop(mid, None)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Blackbox
# ---------------------------------------------------------------------------
@app.get("/api/blackbox")
def blackbox():
    return {"status": demo.blackbox.status(), "incidents": list(demo.blackbox.incidents)}


@app.post("/api/blackbox/trigger")
async def blackbox_trigger(request: Request):
    body = await request.json()
    return demo.blackbox.trigger(body.get("reason", "manual"))


@app.get("/api/blackbox/{incident_id}/timeline")
def blackbox_timeline(incident_id: str):
    tl = demo.blackbox.timeline(incident_id)
    if not tl:
        raise HTTPException(status_code=404, detail="incident not found")
    return tl


@app.get("/api/blackbox/frame")
def blackbox_frame():
    return Response(content=demo.camera_frame("front", 60), media_type="image/jpeg")


# ---------------------------------------------------------------------------
# Remote
# ---------------------------------------------------------------------------
@app.get("/api/remote")
def remote():
    return demo.REMOTE


@app.post("/api/remote/ship")
def remote_ship():
    return demo.ship_now()


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------
@app.get("/api/events")
def events(limit: int = 120, level: str = "all"):
    return demo.events(limit=limit, level=level)


# ---------------------------------------------------------------------------
# Live feed
# ---------------------------------------------------------------------------
def _live_payload(last_map: int) -> dict:
    """Everything the socket pushes. Runs in a worker thread: in live mode
    these reach out over HTTP, and doing that on the event loop froze the
    whole console whenever an upstream was slow or absent."""
    payload = demo.robot.snapshot()
    mv = demo.map_version()
    payload["map_version"] = mv
    payload["map_changed"] = mv != last_map
    payload["events"] = demo.events(limit=12)
    payload["blackbox"] = demo.blackbox.status()
    payload["backend"] = BACKEND_NAME
    return payload


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    last_map = -1
    try:
        while True:
            hz = max(1.0, float(settings.get("sys.ui_refresh_hz", 4)))
            payload = await run_in_threadpool(_live_payload, last_map)
            last_map = payload["map_version"]
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(1.0 / hz)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


def serve(host: str = "0.0.0.0", port: int = 9200):
    # Every MJPEG stream and every sync endpoint takes a slot here. The
    # default 40 is easily filled by a handful of camera tiles.
    try:
        import anyio.to_thread
        anyio.to_thread.current_default_thread_limiter().total_tokens = 200
    except Exception:
        pass
    demo.log("info", "console", f"konzol indul ({BACKEND_NAME} backend) a {port} porton")
    uvicorn.run(app, host=host, port=port, log_level="warning")
