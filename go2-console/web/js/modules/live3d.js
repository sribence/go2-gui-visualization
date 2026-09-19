/* Live 3D: point clouds, camera PiP and manual control on one surface.
 *
 * Modelled on what actually worked in the older showcase view: the value is
 * in flipping layers on and off *fast* while watching the robot, so every
 * toggle is one click and one keystroke, and nothing is buried in a menu.
 *
 * The manual bar is deliberately locked by default. The dock currently runs
 * a read-only sensor hub with no movement code path at all, so the controls
 * are shown disabled with the reason spelled out rather than hidden.
 */
const { api, el, clear, store, fmt, toast } = await import("../core.js" + (window.__V || ""));

let ui = {}, three = null, timer = null;
let opts = {
  go2: true, hesai: true, map: true, traj: true, freeze: false, follow: true,
  mapPoints: 60000,
  view: "tpv",          // tpv | fpv | free
  zoom: "near",         // near | far
  points: 4000,
  hz: 5,
};
let clouds = { go2: null, hesai: null };
let slam = { version: -1, total: 0, shown: 0, status: null, busy: false };
let camSource = "go2";
let unlocked = false;

/* Manual drive state. The sticks and the WASD hint used to be decorative:
 * the posture buttons posted commands but nothing ever sent a velocity, so
 * the robot would stand up on request and then refuse to walk. */
let drive = { vx: 0, vy: 0, vyaw: 0 };
let heldKeys = new Set();
let driveTimer = null;
let driveActive = false;   // was the last command non-zero
const DRIVE_HZ = 10;       // mc_motion stops the robot after 0.5s of silence

// Names must match mc_motion's /action/<name> endpoint.
const ACTIONS = [
  ["stand_up", "↑ Állj fel"], ["lay_down", "↓ Feküdj"], ["sit", "· Ülj le"],
  ["wave", "👋 Integess"], ["heart", "♥ Szív"],
];

export default {
  id: "live3d", icon: "🛰", short: "Élő 3D",
  title: "Élő 3D", subtitle: "pontfelhő · kamera · kézi vezérlés", flush: true,

  mount({ body, tools }) {
    clear(body);
    ui.wrap = el("div", { style: { position: "relative", width: "100%", height: "100%", background: "#05070b" } });
    ui.canvas = el("div", { style: { position: "absolute", inset: "0" } });

    // --- layer toggles, top left -------------------------------------
    ui.bar = el("div", {
      style: {
        position: "absolute", top: "10px", left: "10px", zIndex: "10",
        display: "flex", gap: "6px", flexWrap: "wrap", maxWidth: "calc(100% - 330px)",
      },
    });
    ui.bar.append(
      tog("follow", () => `⌖ Robot követése: ${opts.follow ? "BE" : "KI"}`, () => opts.follow),
      viewBtn("tpv", "👁 TPV"), viewBtn("fpv", "🐕 FPV"),
      zoomBtn("near", "🔍 Közel"), zoomBtn("far", "🔭 Távol"),
      tog("go2", () => `● Go2 LiDAR: ${opts.go2 ? "BE" : "KI"}`, () => opts.go2, "#4db8ff"),
      tog("hesai", () => `● Hesai LiDAR: ${opts.hesai ? "BE" : "KI"}`, () => opts.hesai, "#b07dff"),
      tog("map", () => `▦ Térkép: ${opts.map ? "BE" : "KI"}`, () => opts.map, "#5ce6a8"),
      tog("traj", () => `↝ Útvonal: ${opts.traj ? "BE" : "KI"}`, () => opts.traj, "#ffd166"),
      el("button.btn.sm", { id: "l3d-slam", text: "◐ SLAM", onclick: toggleSlam }),
      el("button.btn.sm", { id: "l3d-count", text: "⚙ Hesai pontszám", onclick: cyclePoints }),
      tog("freeze", () => `❄ Freeze: ${opts.freeze ? "BE" : "KI"}`, () => opts.freeze, "#ffb84d"),
      el("button.btn.sm", { text: "⟲ Reset", onclick: () => { three?.resetView(); toast("Nézet alaphelyzetbe"); } }),
    );

    // --- camera PiP, top right ---------------------------------------
    ui.pipImg = el("img", {
      style: { width: "100%", display: "block", background: "#000", aspectRatio: "4/3", objectFit: "cover" },
    });
    ui.pipTabs = el("div.camtoggles");
    ui.pip = el("div", {
      style: {
        position: "absolute", top: "10px", right: "10px", zIndex: "10", width: "330px",
        background: "rgba(10,13,18,.9)", border: "1px solid var(--line-2)",
        borderRadius: "8px", overflow: "hidden",
      },
    }, [
      el("div", { style: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 8px", borderBottom: "1px solid var(--line)" } }, [
        el("span", { text: "GO2 ORR-KAMERA", style: { fontSize: "11px", letterSpacing: ".06em", color: "var(--accent)" } }),
        el("span.spacer", { style: { flex: "1" } }),
        ui.pipTabs,
      ]),
      ui.pipImg,
      el("div", { id: "l3d-pipinfo", style: { padding: "5px 8px", fontSize: "10.5px", color: "var(--dim)" } }),
    ]);

    // --- manual bar, bottom ------------------------------------------
    ui.lock = el("button.btn", { id: "l3d-lock", onclick: toggleLock });
    ui.lockNote = el("div", { id: "l3d-locknote", style: { fontSize: "10.5px", color: "var(--dim)", marginTop: "4px" } });
    ui.driveOut = el("div", { id: "l3d-driveout", style: { fontSize: "10.5px", fontFamily: "var(--mono)", marginTop: "3px", minHeight: "13px" } });
    ui.stickL = stick("BAL KAR (WASD)");
    ui.stickR = stick("JOBB KAR (Q/E)");
    ui.actions = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: "5px" } });
    for (const [id, label] of ACTIONS) {
      ui.actions.appendChild(el("button.btn.sm", { text: label, "data-act": id, onclick: () => doAction(id, label) }));
    }

    ui.manual = el("div", {
      style: {
        position: "absolute", left: "10px", bottom: "10px", zIndex: "10",
        display: "flex", gap: "18px", alignItems: "center",
        background: "rgba(10,13,18,.9)", border: "1px solid var(--line-2)",
        borderRadius: "10px", padding: "10px 14px",
      },
    }, [
      el("div", {}, [
        el("div", { text: "🎮 KÉZI VEZÉRLÉS", style: { fontSize: "10.5px", letterSpacing: ".07em", color: "var(--purple)", marginBottom: "6px" } }),
        ui.lock, ui.lockNote, ui.driveOut,
      ]),
      ui.stickL.node, ui.stickR.node, ui.actions,
    ]);

    ui.stats = el("div", {
      id: "l3d-stats",
      style: {
        position: "absolute", right: "10px", bottom: "10px", zIndex: "10",
        background: "rgba(10,13,18,.88)", border: "1px solid var(--line)",
        borderRadius: "8px", padding: "8px 11px", fontSize: "11px",
        fontFamily: "var(--mono)", minWidth: "190px",
      },
    });

    ui.wrap.append(ui.canvas, ui.bar, ui.pip, ui.manual, ui.stats);
    body.appendChild(ui.wrap);

    clear(tools);
    tools.append(el("span.pill", { id: "l3d-mode", text: "—" }));

    renderLock();
    loadCams();
    refreshBar();
  },

  onEnter() {
    if (!three) three = makeScene(ui.canvas);
    three.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onDriveKey);
    window.addEventListener("keyup", onDriveKey);
    window.addEventListener("blur", releaseAll);
    bindStick(ui.stickL, "left");
    bindStick(ui.stickR, "right");
    driveTimer = setInterval(pushDrive, Math.round(1000 / DRIVE_HZ));
    ui.pipImg.src = `/api/cameras/${camSource}/stream`;
    tick();
    timer = setInterval(tick, Math.round(1000 / opts.hz));
    this._unsub = store.subscribe(onState);
  },

  onLeave() {
    clearInterval(timer); timer = null;
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keydown", onDriveKey);
    window.removeEventListener("keyup", onDriveKey);
    window.removeEventListener("blur", releaseAll);
    clearInterval(driveTimer);
    // Leaving the module must not leave a velocity latched upstream.
    releaseAll();
    ui.pipImg.removeAttribute("src");
  },

  inspector() {
    const box = el("div.igroup", {}, [el("h4", { text: "Pontfelhő" })]);
    box.append(
      slider("Pontok / forrás", opts.points, 500, 20000, 500, "pont", (v) => {
        opts.points = v; refreshBar();
      }),
      slider("Frissítés", opts.hz, 1, 15, 1, "Hz", (v) => {
        opts.hz = v;
        clearInterval(timer);
        timer = setInterval(tick, Math.round(1000 / opts.hz));
      }),
      slider("Pontméret", three?.pointSize ?? 0.035, 0.01, 0.12, 0.005, "m", (v) => three?.setPointSize(v)),
    );
    const slamBox = el("div.igroup", {}, [el("h4", { text: "Térképezés (KISS-ICP)" })]);
    slamBox.append(
      collapsible("Mi ez?",
        "Tiszta LiDAR-odometria: a pozíciót a pontfelhők geometriájából "
        + "számolja, ezért sport mód és lábodometria nélkül is épül a térkép. "
        + "A finomhangolás a Beállítások → Élő 3D → SLAM alatt van."),
      slider("Térkép-pontok", opts.mapPoints, 10000, 300000, 10000, "pont", (v) => {
        opts.mapPoints = v;
        slam.version = -1;   // force a refetch at the new budget
      }),
      slider("Térkép pontméret", 0.03, 0.01, 0.10, 0.005, "m", (v) => three?.setMapPointSize(v)),
      el("div.param", {}, [
        el("button.btn.sm", { text: "⟲ Térkép törlése", onclick: resetSlam }),
      ]),
    );
    const help = el("div.igroup", {}, [
      el("h4", { text: "Billentyűk" }),
      el("div.param", {}, [el("div.help", {
        style: { borderLeft: "none", paddingLeft: "2px" },
        text: "1 Go2 · 2 Hesai · 3 Térkép · 4 Útvonal · F Freeze · "
            + "T TPV/FPV · R Reset · C követés · WASD/QE vezetés",
      })]),
    ]);
    return el("div", {}, [box, slamBox, help]);
  },
};

// ---------------------------------------------------------------------------
// Toggle helpers
// ---------------------------------------------------------------------------
function collapsible(title, text) {
  const body = el("div.help", { text });
  body.hidden = true;
  const wrap = el("div.param", {}, [
    el("div.prow", {}, [el("span.name", { text: title, title })]),
    body,
  ]);
  const qm = el("button.qm", { text: "?", onclick: () => {
    body.hidden = !body.hidden; qm.classList.toggle("on", !body.hidden);
  } });
  wrap.querySelector(".prow").appendChild(qm);
  return wrap;
}

function tog(key, label, get, color) {
  return el("button.btn.sm", {
    "data-tog": key, text: label(),
    onclick: () => { opts[key] = !opts[key]; refreshBar(); },
    style: color ? { color } : {},
  });
}
function viewBtn(v, label) {
  return el("button.btn.sm", {
    "data-view": v, text: label,
    onclick: () => { opts.view = v; refreshBar(); },
  });
}
function zoomBtn(z, label) {
  return el("button.btn.sm", {
    "data-zoom": z, text: label,
    onclick: () => { opts.zoom = z; three?.applyZoom(opts.zoom); refreshBar(); },
  });
}
function cyclePoints() {
  const steps = [1000, 2000, 4000, 8000, 16000];
  opts.points = steps[(steps.indexOf(opts.points) + 1) % steps.length] || 4000;
  refreshBar();
}

function refreshBar() {
  const b = ui.bar;
  if (!b) return;
  b.querySelector('[data-tog="follow"]').textContent = `⌖ Robot követése: ${opts.follow ? "BE" : "KI"}`;
  b.querySelector('[data-tog="go2"]').textContent = `● Go2 LiDAR: ${opts.go2 ? "BE" : "KI"}`;
  b.querySelector('[data-tog="hesai"]').textContent = `● Hesai LiDAR: ${opts.hesai ? "BE" : "KI"}`;
  b.querySelector('[data-tog="freeze"]').textContent = `❄ Freeze: ${opts.freeze ? "BE" : "KI"}`;
  b.querySelector('[data-tog="map"]').textContent = `▦ Térkép: ${opts.map ? "BE" : "KI"}`;
  b.querySelector('[data-tog="traj"]').textContent = `↝ Útvonal: ${opts.traj ? "BE" : "KI"}`;
  renderSlamBtn();
  document.getElementById("l3d-count").textContent = `⚙ Pontszám: ${opts.points}`;
  for (const k of ["follow", "go2", "hesai", "map", "traj", "freeze"]) {
    b.querySelector(`[data-tog="${k}"]`).classList.toggle("on", !!opts[k]);
  }
  b.querySelectorAll("[data-view]").forEach((n) => n.classList.toggle("on", n.dataset.view === opts.view));
  b.querySelectorAll("[data-zoom]").forEach((n) => n.classList.toggle("on", n.dataset.zoom === opts.zoom));
  three?.setLayer("go2", opts.go2);
  three?.setLayer("hesai", opts.hesai);
  three?.setLayer("map", opts.map);
  three?.setLayer("traj", opts.traj);
  three?.applyView();
  const pill = document.getElementById("l3d-mode");
  if (pill) pill.textContent = `${opts.view.toUpperCase()} · ${opts.follow ? "követés" : "szabad"}${opts.freeze ? " · FREEZE" : ""}`;
}

function onKey(e) {
  if (e.target.matches("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (k === "1") { opts.go2 = !opts.go2; refreshBar(); }
  else if (k === "2") { opts.hesai = !opts.hesai; refreshBar(); }
  else if (k === "3") { opts.map = !opts.map; refreshBar(); }
  else if (k === "4") { opts.traj = !opts.traj; refreshBar(); }
  else if (k === "f") { opts.freeze = !opts.freeze; refreshBar(); }
  else if (k === "t") { opts.view = opts.view === "tpv" ? "fpv" : "tpv"; refreshBar(); }
  else if (k === "c") { opts.follow = !opts.follow; refreshBar(); }
  else if (k === "r") three?.resetView();
}
function onResize() { three?.resize(); }

// ---------------------------------------------------------------------------
// Manual bar
// ---------------------------------------------------------------------------
function stick(label) {
  const knob = el("div.knob");
  const node = el("div", { style: { textAlign: "center" } }, [
    el("div", { style: { width: "84px", height: "84px", borderRadius: "50%", position: "relative", background: "radial-gradient(circle, var(--panel-2) 0%, var(--panel) 70%)", border: "1px solid var(--line-2)", opacity: ".55" } }, [knob]),
    el("div", { text: label, style: { fontSize: "9px", color: "var(--dim)", marginTop: "5px", letterSpacing: ".04em" } }),
  ]);
  Object.assign(knob.style, {
    position: "absolute", width: "30px", height: "30px", borderRadius: "50%",
    background: "var(--line-2)", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
  });
  return { node, knob };
}

/* --- manual drive ------------------------------------------------------
 *
 * mc_motion stops the robot if no command arrives within 0.5 s, so driving
 * is a continuous stream at 10 Hz, not one post per keypress. That watchdog
 * is the reason this has to be a loop: a single command would move the
 * robot for half a second and then stop, which reads as "broken" rather
 * than as the safety feature it is.
 */
const DRIVE_KEYS = {
  w: ["vx", 1], s: ["vx", -1],
  a: ["vy", 1], d: ["vy", -1],
  q: ["vyaw", 1], e: ["vyaw", -1],
};

function canDrive() {
  return unlocked && !store.state?.readonly;
}

function onDriveKey(e) {
  if (e.target.matches("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (!(k in DRIVE_KEYS)) return;
  e.preventDefault();
  if (e.type === "keydown") heldKeys.add(k); else heldKeys.delete(k);
}

function releaseAll() {
  heldKeys.clear();
  drive = { vx: 0, vy: 0, vyaw: 0 };
  resetKnob(ui.stickL); resetKnob(ui.stickR);
  if (driveActive) {
    driveActive = false;
    api.post("/api/manual", { vx: 0, vy: 0, vyaw: 0 }).catch(() => {});
  }
}

function resetKnob(st) {
  if (st?.knob) st.knob.style.transform = "translate(-50%, -50%)";
}

/* Pointer control for the two knobs. Left stick drives, right stick turns --
 * the same split as the keyboard, so the labels stay honest. */
function bindStick(st, which) {
  const R = 34;
  let dragging = false;
  const apply = (ev) => {
    const r = st.node.getBoundingClientRect();
    let dx = ev.clientX - (r.left + r.width / 2);
    let dy = ev.clientY - (r.top + r.height / 2 - 10);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    st.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    if (which === "left") { drive.vx = -dy / R; drive.vy = -dx / R; }
    else { drive.vyaw = -dx / R; }
  };
  st.node.addEventListener("pointerdown", (ev) => {
    if (!canDrive()) { toast("Előbb oldd fel a kézi vezérlést", "warn"); return; }
    dragging = true;
    st.node.setPointerCapture(ev.pointerId);
    apply(ev);
  });
  st.node.addEventListener("pointermove", (ev) => { if (dragging) apply(ev); });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    resetKnob(st);
    if (which === "left") { drive.vx = 0; drive.vy = 0; } else { drive.vyaw = 0; }
  };
  st.node.addEventListener("pointerup", stop);
  st.node.addEventListener("pointercancel", stop);
  st.node.addEventListener("pointerleave", stop);
}

function pushDrive() {
  const cmd = { ...drive };
  for (const k of heldKeys) {
    const [axis, sign] = DRIVE_KEYS[k];
    cmd[axis] = sign;
  }
  const moving = Math.abs(cmd.vx) + Math.abs(cmd.vy) + Math.abs(cmd.vyaw) > 0.01;

  if (!canDrive()) {
    if (driveActive) releaseAll();
    renderDriveReadout(null);
    return;
  }
  renderDriveReadout(cmd);
  // One trailing zero when the operator lets go: the watchdog would stop the
  // robot anyway, but half a second later.
  if (!moving && !driveActive) return;
  driveActive = moving;
  api.post("/api/manual", cmd).catch((e) => {
    if (moving) { toast(e.message, "warn"); releaseAll(); }
  });
}

function renderDriveReadout(cmd) {
  if (!ui.driveOut) return;
  if (!cmd) { ui.driveOut.textContent = ""; return; }
  // Shows what is actually being sent -- the missing readout is precisely
  // why "nothing is being sent at all" looked the same as "the robot will
  // not move".
  const on = Math.abs(cmd.vx) + Math.abs(cmd.vy) + Math.abs(cmd.vyaw) > 0.01;
  ui.driveOut.textContent = on
    ? `▶ küldés  vx ${cmd.vx.toFixed(2)}  vy ${cmd.vy.toFixed(2)}  vyaw ${cmd.vyaw.toFixed(2)}`
    : "· nincs parancs";
  ui.driveOut.style.color = on ? "var(--ok)" : "var(--dim)";
}

function renderLock() {
  const ro = store.state?.readonly;
  ui.lock.textContent = unlocked ? "🔓 Feloldva" : "🔒 Zárolva — kattints a feloldáshoz";
  ui.lock.className = "btn" + (unlocked ? " danger" : "");
  ui.lockNote.textContent = ro
    ? "A dokkon read-only szenzor-hub fut: mozgatás nem lehetséges."
    : "WASD · Q/E · Shift";
  const disabled = !unlocked || ro;
  ui.actions.querySelectorAll("button").forEach((b) => { b.disabled = disabled; });
  ui.stickL.node.style.opacity = disabled ? ".45" : "1";
  ui.stickR.node.style.opacity = disabled ? ".45" : "1";
}

function toggleLock() {
  if (store.state?.readonly && !unlocked) {
    toast("A dokkon read-only szenzor-hub fut — mozgatás nincs engedélyezve", "warn");
    return;
  }
  unlocked = !unlocked;
  if (!unlocked) releaseAll();
  renderLock();
}

function doAction(id, label) {
  if (store.state?.readonly) {
    toast("Read-only mód: a testtartás-parancsok nincsenek bekötve", "warn");
    return;
  }
  api.post("/api/mode", { mode: id })
    .then(() => toast(label))
    .catch((e) => toast(e.message, "warn"));
}

async function loadCams() {
  let cams = [];
  try { cams = await api.get("/api/cameras"); } catch (e) { /* keep empty */ }
  clear(ui.pipTabs);
  const wanted = cams.filter((c) => ["front", "go2", "thermal", "lidar"].includes(c.id)).slice(0, 3);
  for (const c of (wanted.length ? wanted : cams.slice(0, 3))) {
    ui.pipTabs.appendChild(el("span.camtoggle" + (c.id === camSource ? ".on" : ""), {
      text: c.label.split(" ")[0], title: c.label, "data-cam": c.id,
      onclick: () => {
        camSource = c.id;
        ui.pipImg.src = `/api/cameras/${c.id}/stream`;
        ui.pipTabs.querySelectorAll("[data-cam]").forEach((n) =>
          n.classList.toggle("on", n.dataset.cam === camSource));
      },
    }));
  }
  if (cams.length && !cams.some((c) => c.id === camSource)) camSource = cams[0].id;
  ui.pipImg.src = `/api/cameras/${camSource}/stream`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function tick() {
  if (opts.freeze) return;
  const jobs = [];
  if (opts.go2) jobs.push(fetchCloud("go2"));
  if (opts.hesai) jobs.push(fetchCloud("hesai"));
  if (opts.map || opts.traj) jobs.push(fetchMap());
  await Promise.all(jobs);
  renderStats();
}

/* The accumulated map can be a hundred thousand points, so it is only
 * refetched when the engine says it actually changed -- and never while a
 * previous fetch is still in flight, which is what would otherwise happen
 * the moment the map outgrows the tick interval. */
async function fetchMap() {
  if (slam.busy) return;
  const st = store.state?.slam;
  if (st && !st.running && slam.version >= 0) return;
  if (st && st.map_version === slam.version) return;
  // The map version ticks on every scan, but the map is cumulative: it
  // never needs the refresh rate of a live cloud, and at a hundred thousand
  // points that difference is megabytes a second.
  if (Date.now() - (slam.lastFetch || 0) < 1000) return;
  slam.lastFetch = Date.now();
  slam.busy = true;
  try {
    const d = await api.get(`/api/slam/cloud?max=${opts.mapPoints}`);
    slam.version = d.version;
    slam.total = d.total;
    slam.shown = d.count;
    three?.setMapCloud(d.points);
    three?.setTrajectory(d.trajectory || []);
  } catch (e) {
    slam.error = e.message;
  } finally {
    slam.busy = false;
  }
}

async function toggleSlam() {
  const on = !(store.state?.slam?.running);
  try {
    await api.post("/api/slam/run", { on });
    toast(on ? "SLAM elindítva — a térkép épülni kezd" : "SLAM leállítva");
  } catch (e) {
    toast(e.message, "warn");
  }
  renderSlamBtn();
}

async function resetSlam() {
  if (!confirm("Törli az eddig felépített térképet és az útvonalat?")) return;
  await api.post("/api/slam/reset", {});
  slam.version = -1;
  three?.setMapCloud([]);
  three?.setTrajectory([]);
  toast("Térkép törölve, az odometria újraindul");
}

function renderSlamBtn() {
  const b = document.getElementById("l3d-slam");
  if (!b) return;
  const st = store.state?.slam || {};
  if (st.available === false) {
    b.textContent = "◌ SLAM n/a";
    b.disabled = true;
    b.title = st.error || "a KISS-ICP motor nem elérhető";
    return;
  }
  b.disabled = false;
  b.textContent = st.running ? `◉ SLAM: FUT (${st.fps ?? 0} Hz)` : "◌ SLAM: ÁLL";
  b.classList.toggle("on", !!st.running);
  b.title = st.error || "KISS-ICP tiszta LiDAR-odometria be/ki";
}

async function fetchCloud(src) {
  try {
    const d = await api.get(`/api/lidar/${src}?max=${opts.points}`);
    clouds[src] = d;
    three?.setCloud(src, d.points);
  } catch (e) {
    clouds[src] = { count: 0, raw_count: 0, error: e.message };
  }
}

function onState(s) {
  three?.setRobot(s.pose, opts);
  // The map lives in world coordinates while the scene is robot-centric, so
  // a pose is what places one inside the other -- and it has to be the SLAM
  // pose specifically, because that is the frame the map was built in. The
  // robot's own sportmode pose is a different origin entirely.
  three?.setWorldPose(s.slam?.pose || null);
  renderSlamBtn();
  renderLock();
  renderStats(s);
}

function renderStats(s) {
  s = s || store.state || {};
  const box = ui.stats;
  if (!box) return;
  const rows = [
    ["Go2 LiDAR", opts.go2 ? `${clouds.go2?.count ?? 0} / ${clouds.go2?.raw_count ?? 0}` : "KI"],
    ["Hesai", opts.hesai ? `${clouds.hesai?.count ?? 0} / ${clouds.hesai?.raw_count ?? 0}` : "KI"],
    ["Térkép", opts.map ? `${slam.shown} / ${slam.total} voxel` : "KI"],
    ["SLAM", s.slam?.available === false ? "n/a"
             : s.slam?.running ? `${s.slam.fps ?? 0} Hz · ${s.slam.frames ?? 0} kép · ${s.slam.last_ms ?? 0} ms`
             : "áll"],
    ["Pozíció", s.pose ? `${fmt.n(s.pose.x)}, ${fmt.n(s.pose.y)}` : "n/a"],
    ["Pozíció forrása", s.pose_source === "kiss-icp" ? "KISS-ICP (LiDAR)"
                        : s.pose_source === "robot" ? "robot (sport mód)" : "nincs"],
    ["Irány", s.imu ? fmt.deg(s.imu.yaw) : "--"],
    ["Akku", s.battery?.percent != null ? `${s.battery.percent} %` : "--"],
    ["Motor max", s.max_motor_temp != null ? `${s.max_motor_temp} °C` : "n/a"],
  ];
  clear(box);
  for (const [k, v] of rows) {
    box.appendChild(el("div.kv", {}, [el("span.k", { text: k }), el("span.v", { text: String(v) })]));
  }
  if (!s.pose && s.pose_unavailable_reason) {
    box.appendChild(el("div", {
      text: s.pose_unavailable_reason,
      style: { fontSize: "10px", color: "var(--warn)", marginTop: "6px", maxWidth: "200px", lineHeight: "1.3" },
    }));
  }
}

/* Same compact row as the generated inspector: label, slider and a typable
 * value on one line. */
function slider(label, value, min, max, step, unit, onChange) {
  const dec = step < 1 ? (String(step).split(".")[1]?.length || 2) : 0;
  const txt = (v) => Number(v).toFixed(dec);
  const num = el("input.num", { type: "number", value: txt(value), min, max, step });
  const rng = el("input", {
    type: "range", min, max, step, value,
    oninput: (e) => { num.value = txt(e.target.value); },
    onchange: (e) => onChange(parseFloat(e.target.value)),
  });
  num.onchange = (e) => {
    let v = parseFloat(e.target.value);
    if (!isFinite(v)) { num.value = txt(value); return; }
    v = Math.max(min, Math.min(max, v));
    num.value = txt(v); rng.value = v;
    onChange(v);
  };
  return el("div.param", {}, [
    el("div.prow", {}, [
      el("span.name", { text: label, title: label }),
      rng, num, el("span.unit", { text: unit || "" }),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// three.js scene
// ---------------------------------------------------------------------------
function makeScene(host) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070b);
  scene.fog = new THREE.Fog(0x05070b, 18, 42);

  const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);

  const grid = new THREE.GridHelper(24, 24, 0x1d3348, 0x121e2c);
  scene.add(grid);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));

  // Robot body: the point clouds arrive in the robot frame, so the body sits
  // at the origin and the world moves around it.
  const robot = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.2, 0.31),
    new THREE.MeshStandardMaterial({ color: 0x2c3a4c, emissive: 0x0d1c28 }));
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.22, 10),
    new THREE.MeshBasicMaterial({ color: 0x4db8ff }));
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.42, 0, 0);
  robot.add(body, nose);
  scene.add(robot);

  // --- world group -------------------------------------------------
  // The live scans arrive in the robot frame and the robot sits at the
  // origin, but the SLAM map is in world coordinates. Rather than
  // transforming a hundred thousand points on the CPU every frame, the map
  // is uploaded once in world coordinates and this group carries the
  // inverse robot pose, so the GPU does the work.
  //
  // The two frames also differ in convention: the robot is z-up, three.js
  // is y-up. SWAP is that fixed change of basis, and the group transform is
  // SWAP * pose⁻¹ * SWAP⁻¹ so it applies to points already stored swapped.
  const SWAP = new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    0, 0, 0, 1);
  const SWAP_INV = SWAP.clone().invert();
  const world = new THREE.Group();
  scene.add(world);

  const layers = {};
  let pointSize = 0.035;

  function makeLayer(name, hueBase) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.PointsMaterial({ size: pointSize, vertexColors: true, sizeAttenuation: true });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    layers[name] = { pts, mat, hueBase };
    return layers[name];
  }
  makeLayer("go2", 0.55);      // cyan-blue end
  makeLayer("hesai", 0.08);    // amber-orange end

  // The accumulated map, in the world group. Its own colour family (green)
  // so a glance separates "what the robot sees now" from "what it has
  // mapped", which is the whole point of having both on screen.
  const mapGeo = new THREE.BufferGeometry();
  mapGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  mapGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
  const mapMat = new THREE.PointsMaterial({ size: 0.03, vertexColors: true, sizeAttenuation: true });
  const mapPts = new THREE.Points(mapGeo, mapMat);
  mapPts.frustumCulled = false;
  world.add(mapPts);
  layers.map = { pts: mapPts, mat: mapMat, hueBase: 0.38 };

  const trajMat = new THREE.LineBasicMaterial({ color: 0xffd166 });
  const trajLine = new THREE.Line(new THREE.BufferGeometry(), trajMat);
  trajLine.frustumCulled = false;
  world.add(trajLine);
  layers.traj = { pts: trajLine, mat: trajMat };

  let dist = 4.2, az = -Math.PI * 0.75, pol = Math.PI * 0.33;
  const DEFAULTS = { dist: 4.2, az: -Math.PI * 0.75, pol: Math.PI * 0.33 };

  function place() {
    if (opts.view === "fpv") {
      // Just above and behind the head, looking along the heading.
      camera.position.set(0.34, 0.30, 0);
      camera.lookAt(8, 0.05, 0);
      return;
    }
    camera.position.set(
      dist * Math.sin(pol) * Math.cos(az),
      dist * Math.cos(pol),
      dist * Math.sin(pol) * Math.sin(az));
    camera.lookAt(0, 0.15, 0);
  }

  let drag = false, last = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    drag = true; last = [e.clientX, e.clientY];
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointerup", () => { drag = false; });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!drag || opts.view === "fpv") return;
    az -= (e.clientX - last[0]) * 0.006;
    pol = Math.max(0.08, Math.min(Math.PI / 2 - 0.03, pol - (e.clientY - last[1]) * 0.006));
    last = [e.clientX, e.clientY];
    place();
  });
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    dist = Math.max(0.8, Math.min(60, dist * (e.deltaY > 0 ? 1.12 : 0.89)));
    place();
  }, { passive: false });

  (function loop() { requestAnimationFrame(loop); renderer.render(scene, camera); })();
  place();

  return {
    get pointSize() { return pointSize; },
    setPointSize(v) {
      pointSize = v;
      for (const [name, l] of Object.entries(layers)) {
        if (name !== "map" && name !== "traj") l.mat.size = v;
      }
    },
    setLayer(name, on) { if (layers[name]) layers[name].pts.visible = on; },
    setCloud(name, points) {
      const l = layers[name];
      if (!l) return;
      const n = points.length;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, y, z] = points[i];
        // three.js is y-up; the robot frame is z-up.
        pos[i * 3] = x; pos[i * 3 + 1] = z; pos[i * 3 + 2] = -y;
        // Height ramp, so structure reads without any lighting.
        const t = Math.max(0, Math.min(1, (z + 0.5) / 2.4));
        c.setHSL(l.hueBase - t * 0.12, 0.85, 0.35 + t * 0.35);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      l.pts.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      l.pts.geometry = geo;
      l.pts.frustumCulled = false;
    },
    setMapPointSize(v) { mapMat.size = v; },
    setMapCloud(points) {
      const n = points.length;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, y, z] = points[i];
        pos[i * 3] = x; pos[i * 3 + 1] = z; pos[i * 3 + 2] = -y;
        const t = Math.max(0, Math.min(1, (z + 0.5) / 2.4));
        c.setHSL(0.42 - t * 0.14, 0.7, 0.28 + t * 0.42);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      mapPts.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      mapPts.geometry = geo;
      mapPts.frustumCulled = false;
    },
    setTrajectory(pts) {
      const n = pts.length;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const [x, y, z] = pts[i];
        pos[i * 3] = x; pos[i * 3 + 1] = z; pos[i * 3 + 2] = -y;
      }
      trajLine.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      trajLine.geometry = g;
      trajLine.frustumCulled = false;
    },
    setWorldPose(pose) {
      if (!pose) { world.visible = false; return; }
      world.visible = true;
      const { x, y, z, roll = 0, pitch = 0, yaw = 0 } = pose;
      // R = Rz(yaw) * Ry(pitch) * Rx(roll), built explicitly: the Euler
      // order conventions of three.js and ROS do not agree, and a silently
      // wrong order would tilt the whole map.
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const P = new THREE.Matrix4().set(
        cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, x,
        sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, y,
        -sp, cp * sr, cp * cr, z,
        0, 0, 0, 1);
      const G = new THREE.Matrix4()
        .multiplyMatrices(SWAP, P.clone().invert())
        .multiply(SWAP_INV);
      world.matrixAutoUpdate = false;
      world.matrix.copy(G);
      world.matrixWorldNeedsUpdate = true;
    },
    setRobot(pose) {
      // Clouds are robot-relative, so the body stays at the origin; only the
      // roll/pitch read-out tilts it, which is what an operator expects to see.
      const s = store.state || {};
      if (s.imu) { robot.rotation.z = -(s.imu.pitch || 0); robot.rotation.x = s.imu.roll || 0; }
    },
    applyView() { place(); },
    applyZoom(z) { dist = z === "near" ? 2.6 : 11; place(); },
    resetView() { dist = DEFAULTS.dist; az = DEFAULTS.az; pol = DEFAULTS.pol; place(); },
    resize() {
      const r = host.getBoundingClientRect();
      renderer.setSize(r.width, r.height);
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
      place();
    },
  };
}
