"""Parameter registry -- the single place every tunable is declared.

The console's Inspector panels are generated from this, so adding a knob is
one entry here and nothing in the frontend. That is the direct answer to the
main gap in the previous UI: every capability had tunable parameters, but
they lived in environment variables where no operator could reach them.

Each Param carries enough metadata for the UI to render the right control
(slider / toggle / select / text) without any per-field frontend code.
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, asdict, field
from typing import Any, Optional

STATE_PATH = os.environ.get(
    "CONSOLE_SETTINGS_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "settings.json"),
)


@dataclass
class Param:
    key: str
    label: str
    kind: str                     # "slider" | "toggle" | "select" | "text" | "number"
    default: Any
    module: str                   # which console module's inspector shows it
    group: str = "general"
    unit: str = ""
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    options: Optional[list] = None
    help: str = ""
    danger: bool = False          # rendered with a warning accent; safety-relevant

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------

PARAMS: list[Param] = [
    # -- Manual control ---------------------------------------------------
    Param("manual.max_vx", "Max előre/hátra sebesség", "slider", 0.6, "manual", "Sebességkorlátok",
          "m/s", 0.1, 1.5, 0.05, danger=True,
          help="A kézi irányítás felső határa. A core ettől függetlenül is levágja."),
    Param("manual.max_vy", "Max oldalirányú sebesség", "slider", 0.3, "manual", "Sebességkorlátok",
          "m/s", 0.1, 1.0, 0.05, danger=True),
    Param("manual.max_vyaw", "Max fordulási sebesség", "slider", 0.9, "manual", "Sebességkorlátok",
          "rad/s", 0.1, 2.0, 0.05, danger=True),
    Param("manual.deadzone", "Joystick holtsáv", "slider", 0.08, "manual", "Bemenet",
          "", 0.0, 0.4, 0.01,
          help="Ez alatti kitérítést nullának veszünk, hogy a kéz remegése ne mozgassa."),
    Param("manual.accel_limit", "Gyorsulás-korlát", "slider", 2.0, "manual", "Bemenet",
          "m/s²", 0.2, 8.0, 0.1,
          help="Simítja a parancsot, hogy egy hirtelen kitérítés ne rántsa meg a robotot."),
    Param("manual.deadman_s", "Deadman időzítés", "slider", 0.5, "manual", "Biztonság",
          "s", 0.2, 3.0, 0.1, danger=True,
          help="Ha ennyi ideig nem érkezik új parancs, a robot megáll."),
    Param("manual.gamepad", "Gamepad engedélyezése", "toggle", True, "manual", "Bemenet"),

    # -- Mapping ----------------------------------------------------------
    Param("mapping.resolution", "Térkép-rács", "select", 0.05, "map", "Térképezés",
          "m/cella", options=[0.02, 0.05, 0.10, 0.20],
          help="Kisebb érték részletesebb, de négyzetesen több memória és CPU."),
    Param("mapping.explore_speed", "Bolyongási sebesség", "slider", 0.35, "map", "Térképezés",
          "m/s", 0.05, 0.8, 0.05),
    Param("mapping.waypoint_tol", "Waypoint-tűrés", "slider", 0.12, "map", "Térképezés",
          "m", 0.05, 0.5, 0.01),
    Param("mapping.floor_z_max", "Padló-réteg felső z", "slider", 0.55, "map", "Rétegek",
          "m", 0.1, 1.5, 0.05,
          help="Az ennél alacsonyabb találat számít padlót blokkoló akadálynak."),
    Param("mapping.wall_z_max", "Fal-réteg max magasság", "slider", 2.5, "map", "Rétegek",
          "m", 1.0, 4.0, 0.1),
    Param("mapping.wall_decay", "Fal-réteg lebomlás", "slider", 0.0, "map", "Rétegek",
          "1/s", 0.0, 0.5, 0.01,
          help="0 = soha nem felejt. Nagyobb érték kell, ha mozgó tárgyak (emberek) vannak."),

    # -- Navigation -------------------------------------------------------
    Param("nav.robot_radius", "Robot sugara", "slider", 0.25, "map", "Útvonaltervezés",
          "m", 0.1, 0.8, 0.05, danger=True,
          help="Ennyivel fújja fel az akadályokat a tervező. Kisebb érték = szűkebb átjárók, nagyobb ütközéskockázat."),
    Param("nav.forward_speed", "Navigációs sebesség", "slider", 0.4, "map", "Útvonaltervezés",
          "m/s", 0.05, 1.0, 0.05),
    Param("nav.yaw_kp", "Kanyarodás erőssége", "slider", 1.4, "map", "Útvonaltervezés",
          "", 0.2, 4.0, 0.1),
    Param("nav.safety_stop_m", "Vészfék távolság", "slider", 0.45, "map", "Biztonság",
          "m", 0.15, 1.5, 0.05, danger=True,
          help="Ennél közelebbi akadálynál a robot megáll, függetlenül a tervezett útvonaltól."),
    Param("nav.safety_cone", "Vészfék látószöge", "slider", 0.6, "map", "Biztonság",
          "rad", 0.1, 1.6, 0.05, danger=True),
    Param("nav.stairs_enabled", "Lépcső-mód", "toggle", False, "map", "Lépcső", danger=True,
          help="Bekapcsolva a tervező áthaladhat a lépcsőnek minősített cellákon. Csak élőben validált sávokkal használd."),
    Param("nav.stair_wall_min", "Lépcső-sáv alja", "slider", 150, "map", "Lépcső",
          "bucket", 0, 255, 1),
    Param("nav.stair_wall_max", "Lépcső-sáv teteje", "slider", 200, "map", "Lépcső",
          "bucket", 0, 255, 1),
    Param("nav.stair_speed", "Lépcsőn haladási sebesség", "slider", 0.12, "map", "Lépcső",
          "m/s", 0.05, 0.4, 0.01),

    # -- SLAM (KISS-ICP) --------------------------------------------------
    # These are the knobs that decide whether the map is sharp or smeared.
    # The defaults are the ones that won the benchmark on the recorded walks;
    # changing them takes effect on the next scan, but the map already built
    # keeps its old resolution until it is reset.
    Param("slam.voxel_size", "Illesztési voxel", "slider", 0.15, "live3d", "SLAM",
          "m", 0.05, 0.50, 0.01,
          help="A KISS-ICP ennyire ritkítja a pontfelhőt illesztés előtt. "
               "Kisebb érték pontosabb, de lassabb és zajérzékenyebb; a 16 "
               "csatornás Hesai-hoz 0,15 m bizonyult a legjobbnak."),
    Param("slam.max_range", "Maximális hatótáv", "slider", 12.0, "live3d", "SLAM",
          "m", 2.0, 40.0, 0.5,
          help="Ezen túli pontokat eldobjuk. Beltéren a távoli, ritka "
               "visszaverődések inkább rontják az illesztést."),
    Param("slam.min_range", "Minimális hatótáv", "slider", 0.35, "live3d", "SLAM",
          "m", 0.1, 2.0, 0.05,
          help="Ez alatt a robot saját teste látszik, ami minden képkockán "
               "ugyanott van, és elhúzná az illesztést."),
    Param("slam.map_voxel", "Térkép felbontása", "slider", 0.04, "live3d", "SLAM",
          "m", 0.01, 0.20, 0.01,
          help="A halmozott 3D térkép rácsa. Finomabb rács szebb, de gyorsabban "
               "fogy a pontkeret."),
    Param("slam.rate_hz", "Ütem", "slider", 5.0, "live3d", "SLAM",
          "Hz", 1.0, 15.0, 0.5,
          help="Hányszor kérjünk új pásztázást másodpercenként. A LiDAR-híd "
               "kb. 5 Hz-et ad, efölött ismétlődő képkockákat kapnánk."),
    Param("slam.map_max_voxels", "Méret-korlát", "slider", 800000, "live3d", "SLAM",
          "voxel", 50000, 3000000, 50000,
          help="A határ elérésekor a térkép nem nő tovább. Így egy hosszú "
               "munkamenet nem eszi meg a gép memóriáját észrevétlenül."),

    # -- Cameras ----------------------------------------------------------
    Param("cam.stream_fps", "Stream képkockasebesség", "slider", 10, "cameras", "Élő kép",
          "fps", 1, 30, 1),
    Param("cam.jpeg_quality", "JPEG minőség", "slider", 75, "cameras", "Élő kép",
          "%", 30, 95, 5),
    Param("cam.grid", "Rács elrendezés", "select", "2x2", "cameras", "Élő kép",
          options=["1x1", "2x1", "2x2", "3x3"]),
    Param("cam.record_fps", "Felvételi képkockasebesség", "slider", 2, "cameras", "Felvétel",
          "fps", 0.2, 15, 0.2,
          help="Alacsonyan tartva a feketedoboz-puffer sokkal hosszabb időt fed le."),
    Param("cam.record_on_incident", "Automatikus felvétel incidensnél", "toggle", True,
          "cameras", "Felvétel"),
    Param("cam.depth_palette", "Mélységkép színezése", "select", "turbo", "cameras",
          "Élő kép", options=["nincs", "turbo", "inferno", "jet"],
          help="A RealSense mélységképe szürkeárnyalatos. A színezés a böngészőben "
               "történik, így a robotot nem terheli."),

    # -- Sensors ----------------------------------------------------------
    Param("sensor.lidar_max_points", "LiDAR pontszám-korlát", "slider", 5000, "sensors", "LiDAR",
          "pont", 500, 20000, 500),
    Param("sensor.autosave", "Felvételek automatikus mentése", "toggle", True, "sensors", "Mentés"),
    Param("sensor.photo_cam", "Fotó forráskamera", "select", "front", "sensors", "Fotó",
          options=["front", "usb0", "usb1", "usb2"]),

    # -- Missions ---------------------------------------------------------
    Param("mission.step_timeout_s", "Alapértelmezett lépés-időkorlát", "slider", 120,
          "missions", "Végrehajtás", "s", 5, 900, 5),
    Param("mission.retry_count", "Újrapróbálkozások lépésenként", "slider", 0, "missions",
          "Végrehajtás", "", 0, 5, 1),
    Param("mission.stop_on_error", "Hibánál álljon le a küldetés", "toggle", True, "missions",
          "Végrehajtás"),
    Param("mission.mqtt_submit_topic", "MQTT beküldési topic", "text",
          "missioncontrol/task/submit", "missions", "Protokollok"),
    Param("mission.mqtt_events_topic", "MQTT esemény-topic", "text",
          "missioncontrol/task/events", "missions", "Protokollok"),
    Param("mission.allowed_hosts", "Engedélyezett API-hostok", "text", "", "missions",
          "Protokollok", danger=True,
          help="Vesszővel elválasztva. Üresen minden publikus host engedett; belső címek mindig tiltottak."),

    # -- Audio ------------------------------------------------------------
    Param("audio.volume", "Hangerő", "slider", 70, "audio", "Lejátszás", "%", 0, 100, 5),
    Param("audio.proximity_threshold", "Közelségi riasztás küszöb", "slider", 0.8, "audio",
          "Kiváltó események", "m", 0.2, 3.0, 0.1, danger=True,
          help="Ennél közelebbi tárgy/személy váltja ki a figyelmeztető hangot."),
    Param("audio.cooldown_s", "Ismétlés-tiltás", "slider", 5, "audio", "Kiváltó események",
          "s", 1, 60, 1),
    Param("audio.on_lowbatt", "Hang alacsony akkunál", "toggle", True, "audio", "Kiváltó események"),
    Param("audio.on_incident", "Hang incidensnél", "toggle", True, "audio", "Kiváltó események"),
    Param("audio.on_task_complete", "Hang küldetés végén", "toggle", True, "audio", "Kiváltó események"),

    # -- Blackbox ---------------------------------------------------------
    Param("bb.retention_s", "Megőrzési idő", "slider", 600, "blackbox", "Puffer",
          "s", 60, 7200, 30,
          help="Ennél régebbi telemetria és képkocka automatikusan törlődik."),
    Param("bb.max_mb", "Puffer maximális mérete", "slider", 200, "blackbox", "Puffer",
          "MB", 20, 4000, 20),
    Param("bb.record_interval_s", "Telemetria mintavétel", "slider", 1.0, "blackbox", "Puffer",
          "s", 0.1, 10, 0.1),
    Param("bb.frame_interval_s", "Képkocka mentés", "slider", 5.0, "blackbox", "Puffer",
          "s", 0.5, 60, 0.5),
    Param("bb.incident_window_s", "Incidens-ablak", "slider", 30, "blackbox", "Incidens",
          "s", 5, 300, 5,
          help="Incidenskor ennyi másodpercnyi előzményt ment ki tartósan."),
    Param("bb.batt_low_pct", "Alacsony akku küszöb", "slider", 20, "blackbox", "Anomália",
          "%", 5, 50, 1, danger=True),
    Param("bb.batt_crit_pct", "Kritikus akku küszöb", "slider", 10, "blackbox", "Anomália",
          "%", 3, 30, 1, danger=True),
    Param("bb.accel_jump", "Ütközés-érzékenység", "slider", 3.0, "blackbox", "Anomália",
          "m/s²", 0.5, 15.0, 0.5),
    Param("bb.temp_warn_c", "Motorhőmérséklet figyelmeztetés", "slider", 65, "blackbox",
          "Anomália", "°C", 40, 100, 1),

    # -- Remote -----------------------------------------------------------
    Param("remote.ship_interval_s", "Log-küldés gyakorisága", "slider", 300, "remote",
          "Log-küldés", "s", 30, 3600, 30),
    Param("remote.ship_endpoint", "Távoli végpont", "text", "", "remote", "Log-küldés"),
    Param("remote.ship_incidents", "Incidensek küldése", "toggle", True, "remote", "Log-küldés"),
    Param("remote.ship_telemetry", "Telemetria-összegzés küldése", "toggle", True, "remote",
          "Log-küldés"),

    # -- System -----------------------------------------------------------
    Param("sys.ui_refresh_hz", "Felület frissítési gyakorisága", "slider", 4, "settings",
          "Felület", "Hz", 1, 20, 1),
    Param("sys.command_timeout_s", "Parancs-watchdog", "slider", 0.5, "settings", "Biztonság",
          "s", 0.2, 3.0, 0.1, danger=True),
    Param("sys.language", "Nyelv", "select", "hu", "settings", "Felület",
          options=["hu", "en"]),
    Param("sys.theme", "Téma", "select", "dark", "settings", "Felület",
          options=["dark", "light"]),
    Param("sys.confirm_motion", "Mozgásparancs megerősítése", "toggle", True, "settings",
          "Biztonság", danger=True,
          help="Kikapcsolva a térképre kattintás azonnal indít. Csak tapasztalt operátornak."),
]

BY_KEY = {p.key: p for p in PARAMS}

# Named presets -- one click swaps a whole set of knobs.
PROFILES: dict[str, dict] = {
    "indoor_slow": {
        "label": "Beltéri lassú",
        "values": {"manual.max_vx": 0.3, "manual.max_vy": 0.15, "manual.max_vyaw": 0.5,
                    "nav.forward_speed": 0.2, "nav.safety_stop_m": 0.6,
                    "nav.robot_radius": 0.32, "mapping.explore_speed": 0.2},
    },
    "demo": {
        "label": "Bemutató",
        "values": {"manual.max_vx": 0.5, "manual.max_vy": 0.25, "manual.max_vyaw": 0.8,
                    "nav.forward_speed": 0.35, "nav.safety_stop_m": 0.5,
                    "cam.stream_fps": 15, "sys.confirm_motion": True},
    },
    "field": {
        "label": "Terepi",
        "values": {"manual.max_vx": 0.9, "manual.max_vy": 0.4, "manual.max_vyaw": 1.2,
                    "nav.forward_speed": 0.6, "nav.safety_stop_m": 0.4,
                    "mapping.resolution": 0.1, "cam.record_fps": 1},
    },
}


class Settings:
    """Current values, persisted to disk so a restart keeps the operator's tuning."""

    def __init__(self):
        self._lock = threading.Lock()
        self._values = {p.key: p.default for p in PARAMS}
        self._load()

    def _load(self) -> None:
        try:
            with open(STATE_PATH, encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, json.JSONDecodeError):
            return
        for k, v in stored.items():
            if k in BY_KEY:
                self._values[k] = v

    def _save(self) -> None:
        try:
            with open(STATE_PATH, "w", encoding="utf-8") as f:
                json.dump(self._values, f, indent=2, ensure_ascii=False)
        except OSError:
            pass

    def all(self) -> dict:
        with self._lock:
            return dict(self._values)

    def get(self, key: str, fallback=None):
        with self._lock:
            return self._values.get(key, fallback)

    def set(self, key: str, value) -> tuple[bool, str]:
        p = BY_KEY.get(key)
        if p is None:
            return False, f"unknown parameter: {key}"
        if p.kind == "toggle":
            value = bool(value)
        elif p.kind in ("slider", "number"):
            try:
                value = float(value)
            except (TypeError, ValueError):
                return False, f"{key} must be numeric"
            if p.min is not None and value < p.min:
                return False, f"{key} below minimum ({p.min})"
            if p.max is not None and value > p.max:
                return False, f"{key} above maximum ({p.max})"
            if p.step and float(p.step).is_integer() and float(p.min or 0).is_integer():
                value = round(value)
        elif p.kind == "select":
            if p.options and value not in p.options:
                return False, f"{key} must be one of {p.options}"
        else:
            value = str(value)
        with self._lock:
            self._values[key] = value
            self._save()
        return True, ""

    def apply_profile(self, name: str) -> tuple[bool, str]:
        prof = PROFILES.get(name)
        if not prof:
            return False, f"unknown profile: {name}"
        for k, v in prof["values"].items():
            self.set(k, v)
        return True, ""

    def reset(self) -> None:
        with self._lock:
            self._values = {p.key: p.default for p in PARAMS}
            self._save()


def schema() -> dict:
    """What the frontend renders inspectors from."""
    return {
        "params": [p.to_dict() for p in PARAMS],
        "profiles": {k: v["label"] for k, v in PROFILES.items()},
    }
