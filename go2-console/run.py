"""Go2 Console launcher.

    python run.py                 # synthetic demo backend
    python run.py --live          # talk to the mission-control pillars
    python run.py --port 9300

Live mode needs the pillars running and MC_API_TOKEN set to the same value
core was started with, otherwise every write returns 503 by design.
"""
from __future__ import annotations

import argparse
import os
import socket


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9200)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--live", action="store_true",
                    help="a mission-control pillérekhez köt, szintetikus adat helyett")
    args = ap.parse_args()

    if args.live:
        os.environ["CONSOLE_BACKEND"] = "live"

    ip = lan_ip()
    print("\n" + "=" * 64)
    mode = ("ÉLES — a mission-control pillérekhez kötve" if args.live
            else "DEMÓ — szintetikus adatok, robot nélkül")
    print("  GO2 CONSOLE")
    print(f"  {mode}")
    print("=" * 64)
    print(f"  Ezen a gépen : http://localhost:{args.port}/")
    print(f"  Telefon/WiFi : http://{ip}:{args.port}/")
    print("=" * 64)
    print("  Szóköz vagy Esc = E-STOP, bármelyik modulban.\n")
    # Imported here so CONSOLE_BACKEND is already set when the app
    # module picks its backend at import time.
    from server.app import serve
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
