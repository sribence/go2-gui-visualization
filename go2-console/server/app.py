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
    return demo.play(sound_id)


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
