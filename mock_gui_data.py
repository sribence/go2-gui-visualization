"""
Mock GUI Data Publisher for Unitree Go2 GUI & Visualization
Publishes mock WebSocket/ROSBridge events to test the Web Dashboard & 3D Digital Twin offline.
"""

import time
import json

def run_mock_gui_publisher():
    print("[MOCK GUI] Starting synthetic GUI server & mock state publisher...")
    step = 0
    try:
        while True:
            step += 1
            pose_data = {
                "type": "robot_pose",
                "x": step * 0.05,
                "y": 0.2 * (step % 5),
                "heading": (step * 5) % 360,
                "status": "ARMED"
            }
            print(f"[MOCK GUI] Emitting WebSocket state event #{step}: {json.dumps(pose_data)}")
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("[MOCK GUI] Publisher stopped.")

if __name__ == "__main__":
    run_mock_gui_publisher()
