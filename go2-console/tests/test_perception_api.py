import sys
import os
from fastapi.testclient import TestClient

# Add server directory to path
server_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if server_dir not in sys.path:
    sys.path.insert(0, server_dir)

from server.app import app

client = TestClient(app)


def test_perception_status_endpoint():
    response = client.get("/api/perception/status")
    assert response.status_code == 200
    data = response.json()
    assert "source" in data
    assert "model_loaded" in data
    assert "loop_fps" in data
    assert "infer_ms" in data


def test_perception_persons_endpoint():
    response = client.get("/api/perception/persons")
    assert response.status_code == 200
    data = response.json()
    assert "persons" in data
    assert "target_id" in data
    assert "target_mode" in data
    assert isinstance(data["persons"], list)


def test_objects_endpoint():
    response = client.get("/api/objects")
    assert response.status_code == 200
    data = response.json()
    assert "objects" in data
    assert "count" in data
    assert isinstance(data["objects"], list)


def test_perception_target_lock_endpoint():
    response = client.post("/api/perception/target", json={"track_id": 2})
    assert response.status_code == 200
    assert response.json() == {"target_lock": 2}

    # Verify updated state
    resp_persons = client.get("/api/perception/persons")
    assert resp_persons.json()["target_id"] == 2

    # Unlock auto mode
    response_unlock = client.post("/api/perception/target", json={"track_id": None})
    assert response_unlock.status_code == 200
    assert response_unlock.json() == {"target_lock": None}


def test_perception_follow_endpoints():
    # Test GET follow state
    res_get = client.get("/api/perception/follow")
    assert res_get.status_code == 200
    data = res_get.json()
    assert "mode" in data
    assert "target_distance_m" in data
    assert "dry_run" in data
    assert "audio_alert" in data

    # Test POST follow settings update
    res_post = client.post("/api/perception/follow", json={
        "mode": "user_follow",
        "target_distance_m": 2.5,
        "audio_alert": True,
        "dry_run": True
    })
    assert res_post.status_code == 200
    data_post = res_post.json()
    assert data_post["mode"] == "user_follow"
    assert data_post["target_distance_m"] == 2.5
    assert data_post["audio_alert"] is True

    # Test follow lock and release
    res_lock = client.post("/api/perception/follow/lock", json={"track_id": 3})
    assert res_lock.status_code == 200
    assert res_lock.json()["target_lock"] == 3

    res_rel = client.post("/api/perception/follow/release")
    assert res_rel.status_code == 200
    assert res_rel.json()["mode"] == "off"

    # Test gesture action
    res_gest = client.post("/api/perception/follow/gesture", json={"gesture": "wave"})
    assert res_gest.status_code == 200
    assert res_gest.json()["gesture"] == "wave"

    # Test re-enable follow
    res_enable = client.post("/api/perception/follow/enable")
    assert res_enable.status_code == 200
    assert res_enable.json()["enabled"] is True


def test_estop_endpoint():
    res_estop = client.post("/api/estop")
    assert res_estop.status_code == 200
    assert res_estop.json()["estop"] is True


def test_perception_models_endpoint():
    res = client.get("/api/perception/models")
    assert res.status_code == 200
    data = res.json()
    assert "current" in data
    assert "available" in data
    assert "imgsz_options" in data
    assert "switch" in data

    res_post = client.post("/api/perception/model", json={"id": "yolov8s", "imgsz": 480, "format": "engine"})
    assert res_post.status_code == 200
    data_post = res_post.json()
    assert "switch" in data_post


def test_perception_power_endpoint():
    res = client.get("/api/perception/system/power")
    assert res.status_code == 200
    data = res.json()
    assert "mode" in data
    assert "cpu_online" in data
    assert "gpu_load_pct" in data


def test_led_endpoints():
    # GET /api/led
    res_get = client.get("/api/led")
    assert res_get.status_code == 200

    # POST /api/led
    res_post = client.post("/api/led", json={"r": 128, "g": 0, "b": 255})
    assert res_post.status_code == 200
    assert res_post.json()["r"] == 128
    assert res_post.json()["g"] == 0
    assert res_post.json()["b"] == 255

    # GET /api/led/presets
    res_presets = client.get("/api/led/presets")
    assert res_presets.status_code == 200
    assert "purple" in res_presets.json()

    # POST /api/led/preset/purple
    res_preset_post = client.post("/api/led/preset/purple")
    assert res_preset_post.status_code == 200
    assert res_preset_post.json()["preset"] == "purple"


