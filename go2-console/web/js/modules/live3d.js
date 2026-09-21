/* Live 3D: point clouds, camera PiP and manual control on one surface.
 *
 * Modelled on what actually worked in the older showcase view: official Go2 DAE
 * mesh rendering, 2D occupancy grid floor map texture, Hesai LiDAR multi-frame
 * persistence, and fast layer toggles.
 */
const { api, el, clear, store, fmt, toast } = await import("../core.js" + (window.__V || ""));

let ui = {}, three = null, timer = null;
let opts = {
  go2: true, hesai: true, map: true, traj: true, mapFloor: true, freeze: false, follow: true,
  mapPoints: 60000,
  view: "tpv",          // tpv | fpv
  zoom: "near",         // near | far
  points: 4000,
  hz: 5,
  persistSec: 3.5,
};
let clouds = { go2: null, hesai: null };
let slam = { version: -1, total: 0, shown: 0, status: null, busy: false };
let camSource = "go2";
let unlocked = false;
let lastGridVersion = -1;

/* Manual drive state. */
let drive = { vx: 0, vy: 0, vyaw: 0 };
let heldKeys = new Set();
let driveTimer = null;
let driveActive = false;
const DRIVE_HZ = 10;

// Names match mc_motion's /action/<name> endpoint.
const ACTIONS = [
  ["stand_up", "↑ Állj fel"], ["lay_down", "↓ Feküdj"], ["sit", "· Ülj le"],
  ["wave", "👋 Integess"], ["heart", "♥ Szív"],
];

export default {
  id: "live3d", icon: "🛰", short: "Élő 3D",
  title: "Élő 3D", subtitle: "pontfelhő · 3D robottest · élő 2D térkép · kézi vezérlés", flush: true,

  mount({ body, tools }) {
    clear(body);
    ui.wrap = el("div", { style: { position: "relative", width: "100%", height: "100%", background: "#05070b" } });
    ui.canvas = el("div", { style: { position: "absolute", inset: "0" } });

    // --- layer toggles, top left -------------------------------------
    ui.bar = el("div", {
      style: {
        position: "absolute", top: "10px", left: "10px", zIndex: "10",
        display: "flex", gap: "6px", flexWrap: "wrap", maxWidth: "calc(100% - 340px)",
      },
    });
    ui.bar.append(
      tog("follow", () => `⌖ Robot követése: ${opts.follow ? "BE" : "KI"}`, () => opts.follow),
      viewBtn("tpv", "👁 TPV"), viewBtn("fpv", "🐕 FPV"),
      zoomBtn("near", "🔍 Közel"), zoomBtn("far", "🔭 Távol"),
      tog("go2", () => `● Go2 LiDAR: ${opts.go2 ? "BE" : "KI"}`, () => opts.go2, "#4db8ff"),
      tog("hesai", () => `● Hesai LiDAR: ${opts.hesai ? "BE" : "KI"}`, () => opts.hesai, "#b07dff"),
      tog("mapFloor", () => `▦ Padló térkép: ${opts.mapFloor ? "BE" : "KI"}`, () => opts.mapFloor, "#5ce6a8"),
      tog("map", () => `░ SLAM pontok: ${opts.map ? "BE" : "KI"}`, () => opts.map, "#7bffb0"),
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
    releaseAll();
    ui.pipImg.removeAttribute("src");
  },

  inspector() {
    const box = el("div.igroup", {}, [el("h4", { text: "Pontfelhő és Megjelenítés" })]);
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
      slider("Hesai megmaradás", opts.persistSec, 0.5, 10.0, 0.5, "s", (v) => { opts.persistSec = v; }),
    );
    const slamBox = el("div.igroup", {}, [el("h4", { text: "Térképezés (KISS-ICP & 2D Grid)" })]);
    slamBox.append(
      collapsible("Mi ez?",
        "3D LiDAR-odometria és 2D beágyazott Occupancy Grid padló-térkép. "
        + "A zöld falakat és szabad tereket közvetlenül a robot alatt jeleníti meg."),
      slider("Térkép-pontok", opts.mapPoints, 10000, 300000, 10000, "pont", (v) => {
        opts.mapPoints = v;
        slam.version = -1;
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
        text: "1 Go2 · 2 Hesai · 3 Padló térkép · 4 Útvonal · F Freeze · "
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
  b.querySelector('[data-tog="mapFloor"]').textContent = `▦ Padló térkép: ${opts.mapFloor ? "BE" : "KI"}`;
  b.querySelector('[data-tog="map"]').textContent = `░ SLAM pontok: ${opts.map ? "BE" : "KI"}`;
  b.querySelector('[data-tog="freeze"]').textContent = `❄ Freeze: ${opts.freeze ? "BE" : "KI"}`;
  b.querySelector('[data-tog="traj"]').textContent = `↝ Útvonal: ${opts.traj ? "BE" : "KI"}`;
  renderSlamBtn();
  document.getElementById("l3d-count").textContent = `⚙ Pontszám: ${opts.points}`;
  for (const k of ["follow", "go2", "hesai", "mapFloor", "map", "traj", "freeze"]) {
    const btn = b.querySelector(`[data-tog="${k}"]`);
    if (btn) btn.classList.toggle("on", !!opts[k]);
  }
  b.querySelectorAll("[data-view]").forEach((n) => n.classList.toggle("on", n.dataset.view === opts.view));
  b.querySelectorAll("[data-zoom]").forEach((n) => n.classList.toggle("on", n.dataset.zoom === opts.zoom));
  three?.setLayer("go2", opts.go2);
  three?.setLayer("hesai", opts.hesai);
  three?.setLayer("mapFloor", opts.mapFloor);
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
  else if (k === "3") { opts.mapFloor = !opts.mapFloor; refreshBar(); }
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
  if (!moving && !driveActive) return;
  driveActive = moving;
  api.post("/api/manual", cmd).catch((e) => {
    if (moving) { toast(e.message, "warn"); releaseAll(); }
  });
}

function renderDriveReadout(cmd) {
  if (!ui.driveOut) return;
  if (!cmd) { ui.driveOut.textContent = ""; return; }
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
  if (opts.mapFloor) jobs.push(fetchGridMap());
  jobs.push(fetchObjects());
  await Promise.all(jobs);
  renderStats();
}

async function fetchObjects() {
  try {
    const res = await api.get("/api/objects");
    if (res && Array.isArray(res.objects)) {
      three?.setObjects(res.objects);
    }
  } catch (e) {}
}

async function fetchGridMap() {
  const st = store.state;
  if (st && st.map_version === lastGridVersion && lastGridVersion >= 0) return;
  try {
    const d = await api.get("/api/map");
    if (d && (d.data || d.floor || d.width)) {
      lastGridVersion = st?.map_version ?? 0;
      three?.setLiveMapFloor(d);
    }
  } catch (e) {
    /* keep quiet */
  }
}

async function fetchMap() {
  if (slam.busy) return;
  const st = store.state?.slam;
  if (st && !st.running && slam.version >= 0) return;
  if (st && st.map_version === slam.version) return;
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
    ["Padló 2D térkép", opts.mapFloor ? (lastGridVersion >= 0 ? "aktív" : "betöltés") : "KI"],
    ["SLAM 3D", opts.map ? `${slam.shown} / ${slam.total} voxel` : "KI"],
    ["SLAM állapot", s.slam?.available === false ? "n/a"
                     : s.slam?.running ? `${s.slam.fps ?? 0} Hz · ${s.slam.frames ?? 0} kép`
                     : "áll"],
    ["Pozíció", s.pose ? `${fmt.n(s.pose.x)}, ${fmt.n(s.pose.y)}` : "n/a"],
    ["Irány", s.imu ? fmt.deg(s.imu.yaw) : "--"],
    ["Akku", s.battery?.percent != null ? `${s.battery.percent} %` : "--"],
  ];
  clear(box);
  for (const [k, v] of rows) {
    box.appendChild(el("div.kv", {}, [el("span.k", { text: k }), el("span.v", { text: String(v) })]));
  }
}

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
// three.js scene with DAE mesh avatar & 2D Occupancy Grid floor plane
// ---------------------------------------------------------------------------
function makeScene(host) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070b);
  scene.fog = new THREE.Fog(0x05070b, 18, 42);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);

  const grid = new THREE.GridHelper(24, 24, 0x1d3348, 0x121e2c);
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0x557788, 1.2));
  const keyLight = new THREE.DirectionalLight(0x22e5ff, 1.4);
  keyLight.position.set(1, 2, 1);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x7bffb0, 0.6);
  rimLight.position.set(-1, 1, -1);
  scene.add(rimLight);

  // --- Robot avatar group -------------------------------------------
  const BODY = { x: 0.3762, y: 0.114, z: 0.0935 };
  const THIGH_LEN = 0.213, CALF_LEN = 0.213;
  const LEGS = [
    { name: "FR", x:  0.1934, z: -0.0465, thighZ: -0.0955 },
    { name: "FL", x:  0.1934, z:  0.0465, thighZ:  0.0955 },
    { name: "RR", x: -0.1934, z: -0.0465, thighZ: -0.0955 },
    { name: "RL", x: -0.1934, z:  0.0465, thighZ:  0.0955 },
  ];

  const robotGroup = new THREE.Group();
  robotGroup.position.y = THIGH_LEN + CALF_LEN * 0.55;
  scene.add(robotGroup);

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x263340, emissive: 0x0a1218, metalness: 0.6, roughness: 0.3 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x22e5ff, emissive: 0x0a3540, metalness: 0.4, roughness: 0.35 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x7bffb0, emissive: 0x114422, metalness: 0.5, roughness: 0.3 });

  // Fallback procedural box
  const proceduralBody = new THREE.Mesh(new THREE.BoxGeometry(BODY.x, BODY.y, BODY.z), bodyMat);
  robotGroup.add(proceduralBody);

  function makeTextSprite(text, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.font = "bold 28px monospace";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(text, 64, 34);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.25, 0.09, 1);
    return sprite;
  }

  const frontLabel = makeTextSprite("ELÜL", "#22e5ff");
  frontLabel.position.set(BODY.x / 2 + 0.14, 0.06, 0);
  robotGroup.add(frontLabel);

  const frontArrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.025, 0.07, 12),
    new THREE.MeshStandardMaterial({ color: 0x22e5ff, emissive: 0x0a3540 })
  );
  frontArrow.position.set(BODY.x / 2 + 0.03, 0, 0);
  frontArrow.rotation.z = -Math.PI / 2;
  robotGroup.add(frontArrow);

  const legPivots = [];
  for (const leg of LEGS) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(leg.x, 0, leg.z);
    robotGroup.add(hipPivot);

    const hipMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 16), jointMat);
    hipMesh.rotation.z = Math.PI / 2;
    hipPivot.add(hipMesh);

    const legLabel = makeTextSprite(leg.name, "#7bffb0");
    legLabel.position.set(leg.x, 0.09, leg.z * 1.6);
    robotGroup.add(legLabel);

    const thighPivot = new THREE.Group();
    thighPivot.position.set(0, 0, leg.thighZ);
    hipPivot.add(thighPivot);

    const thighMesh = new THREE.Mesh(new THREE.BoxGeometry(0.032, THIGH_LEN, 0.032), accentMat);
    thighMesh.position.set(0, -THIGH_LEN / 2, 0);
    thighPivot.add(thighMesh);

    const calfPivot = new THREE.Group();
    calfPivot.position.set(0, -THIGH_LEN, 0);
    thighPivot.add(calfPivot);

    const calfMesh = new THREE.Mesh(new THREE.BoxGeometry(0.024, CALF_LEN, 0.024), bodyMat);
    calfMesh.position.set(0, -CALF_LEN / 2, 0);
    calfPivot.add(calfMesh);

    const footMesh = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 12), jointMat);
    footMesh.position.set(0, -CALF_LEN, 0);
    calfPivot.add(footMesh);

    legPivots.push({ hip: hipPivot, thigh: thighPivot, calf: calfPivot, foot: footMesh });
  }

  // Attempt DAE mesh loading
  if (window.THREE && window.THREE.ColladaLoader) {
    const REAL_MESH_BASE = "/static/go2_description/meshes/";
    const daeLoader = new THREE.ColladaLoader();
    const loadDae = (name) => new Promise((resolve, reject) => {
      daeLoader.load(REAL_MESH_BASE + name, (c) => resolve(c.scene), undefined, reject);
    });
    const preparePart = (sc, material) => {
      const wrap = new THREE.Group();
      sc.traverse((child) => {
        if (child.isMesh) {
          child.material = material;
          child.material.side = THREE.DoubleSide;
        }
      });
      wrap.add(sc);
      return wrap;
    };
    const HIP_EULER = { FR: [Math.PI, 0, 0], FL: [0, 0, 0], RR: [Math.PI, Math.PI, 0], RL: [0, Math.PI, 0] };

    Promise.all([
      loadDae("base.dae"), loadDae("hip.dae"),
      loadDae("thigh.dae"), loadDae("thigh_mirror.dae"),
      loadDae("calf.dae"), loadDae("calf_mirror.dae"),
      loadDae("foot.dae"),
    ]).then(([baseTpl, hipTpl, thighTpl, thighMirrorTpl, calfTpl, calfMirrorTpl, footTpl]) => {
      proceduralBody.visible = false;
      const realBody = preparePart(baseTpl, bodyMat);
      robotGroup.add(realBody);

      LEGS.forEach((leg, i) => {
        const lp = legPivots[i];
        const isRight = leg.name[1] === "R";

        lp.hip.children.find((c) => c.isMesh).visible = false;
        const realHip = preparePart(hipTpl.clone(true), jointMat.clone());
        const e = HIP_EULER[leg.name];
        realHip.rotation.set(e[0], e[1], e[2]);
        lp.hip.add(realHip);

        const procThigh = lp.thigh.children.find((c) => c.isMesh);
        if (procThigh) procThigh.visible = false;
        const realThigh = preparePart((isRight ? thighMirrorTpl : thighTpl).clone(true), accentMat);
        lp.thigh.add(realThigh);

        const procCalf = lp.calf.children.find((c) => c.isMesh);
        if (procCalf) procCalf.visible = false;
        const realCalf = preparePart((isRight ? calfMirrorTpl : calfTpl).clone(true), bodyMat);
        lp.calf.add(realCalf);

        lp.foot.visible = false;
        const realFoot = preparePart(footTpl.clone(true), jointMat.clone());
        realFoot.position.copy(lp.foot.position);
        lp.foot.parent.add(realFoot);
      });
    }).catch(() => {
      /* procedural fallback remains visible */
    });
  }

  // --- Live 2D Occupancy Grid Ground Plane ---
  const liveMapFloorGeom = new THREE.PlaneGeometry(1, 1);
  const liveMapFloorMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false });
  const liveMapFloorMesh = new THREE.Mesh(liveMapFloorGeom, liveMapFloorMat);
  liveMapFloorMesh.rotation.x = -Math.PI / 2;
  liveMapFloorMesh.position.y = -0.02;
  liveMapFloorMesh.visible = false;
  liveMapFloorMesh.renderOrder = -1;
  scene.add(liveMapFloorMesh);

  function updateLiveMapFloor(d) {
    if (!d) { liveMapFloorMesh.visible = false; return; }
    const W = d.width, H = d.height;
    const data = d.data || d.floor;
    if (!W || !H || !data) { liveMapFloorMesh.visible = false; return; }

    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const octx = off.getContext("2d");
    const img = octx.createImageData(W, H);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      let r, g, b, a;
      if (v < 0) { r = 18; g = 22; b = 30; a = 60; }
      else if (v < 50) { r = 20; g = 40; b = 50; a = 90; }
      else { r = 123; g = 255; b = 176; a = 230; } // green walls
      const row = H - 1 - Math.floor(i / W);
      const col = i % W;
      const p = (row * W + col) * 4;
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = a;
    }
    octx.putImageData(img, 0, 0);

    if (liveMapFloorMat.map) liveMapFloorMat.map.dispose();
    const tex = new THREE.CanvasTexture(off);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    liveMapFloorMat.map = tex;
    liveMapFloorMat.needsUpdate = true;

    const res = d.resolution || 0.05;
    const widthM = W * res, heightM = H * res;
    if (!liveMapFloorMesh.userData.sized || liveMapFloorMesh.userData.w !== widthM || liveMapFloorMesh.userData.h !== heightM) {
      liveMapFloorGeom.dispose();
      liveMapFloorMesh.geometry = new THREE.PlaneGeometry(widthM, heightM);
      liveMapFloorMesh.userData.sized = true;
      liveMapFloorMesh.userData.w = widthM;
      liveMapFloorMesh.userData.h = heightM;
    }
    const ox = d.origin_x || 0, oy = d.origin_y || 0;
    liveMapFloorMesh.position.x = ox + widthM / 2;
    liveMapFloorMesh.position.z = -(oy + heightM / 2);
    liveMapFloorMesh.visible = opts.mapFloor !== false;
  }

  // --- World group (SLAM & Trajectory) -------------------------------
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
    const mat = new THREE.PointsMaterial({ size: pointSize, transparent: true, opacity: 0.82, vertexColors: true, sizeAttenuation: true, depthTest: false });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = 999;
    pts.frustumCulled = false;
    scene.add(pts);
    layers[name] = { pts, mat, hueBase };
    return layers[name];
  }
  makeLayer("go2", 0.55);      // cyan/blue
  makeLayer("hesai", 0.08);    // amber/purple

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
  layers.mapFloor = { pts: liveMapFloorMesh };

  // Hesai persistence buffer
  let hesaiFrames = [];
  const HESAI_MAX_FRAMES = 15;

  // Camera Orbit & Tracking
  const CAM_TARGET = new THREE.Vector3(0, 0.16, 0);
  let camAngle = 0.7, camPolar = 1.15, camRadius = 1.6;
  const FPV_LOCAL_POS = new THREE.Vector3(-0.02, 0.16, 0);
  const FPV_LOCAL_LOOKAT = new THREE.Vector3(1.0, 0.05, 0);

  function place() {
    if (opts.view === "fpv") {
      robotGroup.add(camera);
      camera.position.copy(FPV_LOCAL_POS);
      const targetWorld = robotGroup.localToWorld(FPV_LOCAL_LOOKAT.clone());
      camera.lookAt(targetWorld);
    } else {
      scene.add(camera);
      if (opts.follow) {
        CAM_TARGET.x = robotGroup.position.x;
        CAM_TARGET.z = robotGroup.position.z;
      }
      camera.position.set(
        CAM_TARGET.x + camRadius * Math.sin(camPolar) * Math.cos(camAngle),
        CAM_TARGET.y + camRadius * Math.cos(camPolar),
        CAM_TARGET.z + camRadius * Math.sin(camPolar) * Math.sin(camAngle)
      );
      camera.lookAt(CAM_TARGET);
    }
  }

  let dragging = false, lastX = 0, lastY = 0, dragMode = "orbit";
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    dragMode = (e.button === 2 || e.button === 1 || e.shiftKey) ? "pan" : "orbit";
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointerup", () => { dragging = false; });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!dragging || opts.view === "fpv") return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (dragMode === "pan") {
      const factor = 0.0025 * camRadius;
      const sinA = Math.sin(camAngle), cosA = Math.cos(camAngle);
      CAM_TARGET.x += (sinA * dx + cosA * dy) * factor;
      CAM_TARGET.z += (-cosA * dx + sinA * dy) * factor;
      opts.follow = false;
      refreshBar();
    } else {
      camAngle -= dx * 0.006;
      camPolar = Math.max(0.15, Math.min(Math.PI - 0.15, camPolar - dy * 0.006));
    }
    place();
  });
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    camRadius = Math.max(0.5, Math.min(30, camRadius + e.deltaY * 0.0025 * camRadius));
    place();
  }, { passive: false });

  (function loop() {
    requestAnimationFrame(loop);
    place();
    renderer.render(scene, camera);
  })();

  function applyMotorQ(q) {
    if (!q || q.length < 12) return;
    LEGS.forEach((leg, i) => {
      const base = i * 3;
      if (legPivots[i]) {
        legPivots[i].hip.rotation.x = q[base + 0];
        legPivots[i].thigh.rotation.z = -q[base + 1];
        legPivots[i].calf.rotation.z = -q[base + 2];
      }
    });
  }

  const humanObjectsGroup = new THREE.Group();
  scene.add(humanObjectsGroup);
  const humanGroupMap = new Map();

  function createHumanDummyMesh() {
    const dummyGroup = new THREE.Group();

    const matBody = new THREE.MeshStandardMaterial({
      color: 0x3a4f66, emissive: 0x0d1a26, roughness: 0.4, metalness: 0.3
    });
    const matAccent = new THREE.MeshStandardMaterial({
      color: 0xffb84d, emissive: 0x4a2e00, roughness: 0.3
    });

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.15, 0.65, 12), matBody);
    torso.position.y = 1.05;
    dummyGroup.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 14), matAccent);
    head.position.y = 1.55;
    dummyGroup.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.12), new THREE.MeshBasicMaterial({ color: 0x22e5ff }));
    visor.position.set(0.08, 1.55, 0);
    dummyGroup.add(visor);

    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.18), matBody);
    hips.position.y = 0.7;
    dummyGroup.add(hips);

    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.045, 0.7, 10), matBody);
    legL.position.set(0, 0.35, 0.08);
    dummyGroup.add(legL);

    const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.045, 0.7, 10), matBody);
    legR.position.set(0, 0.35, -0.08);
    dummyGroup.add(legR);

    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.6, 10), matBody);
    armL.position.set(0, 1.0, 0.22);
    armL.rotation.z = -0.15;
    dummyGroup.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.6, 10), matBody);
    armR.position.set(0, 1.0, -0.22);
    armR.rotation.z = -0.15;
    dummyGroup.add(armR);

    const ringGeo = new THREE.RingGeometry(0.35, 0.42, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffb84d, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
    const scannerRing = new THREE.Mesh(ringGeo, ringMat);
    scannerRing.rotation.x = Math.PI / 2;
    scannerRing.position.y = 0.01;
    dummyGroup.add(scannerRing);

    if (window.THREE && window.THREE.ColladaLoader) {
      try {
        const daeLoader = new THREE.ColladaLoader();
        daeLoader.load("/static/models/person_dummy.dae", (collada) => {
          if (collada && collada.scene) {
            const model = collada.scene;
            model.traverse((c) => {
              if (c.isMesh) c.material = matBody;
            });
            torso.visible = false;
            hips.visible = false;
            legL.visible = false;
            legR.visible = false;
            dummyGroup.add(model);
          }
        }, undefined, () => {});
      } catch (e) {}
    }

    return { group: dummyGroup, ring: scannerRing };
  }

  function setObjects(objs) {
    if (!Array.isArray(objs)) return;
    const now = Date.now() / 1000;
    const currentIds = new Set();
    const robotPose = store.state?.pose || { x: 0, y: 0, yaw: 0 };

    for (const obj of objs) {
      if (!obj || obj.x == null || obj.y == null) continue;
      const id = obj.id ?? 0;
      currentIds.add(id);

      let entry = humanGroupMap.get(id);
      if (!entry) {
        entry = createHumanDummyMesh();
        humanGroupMap.set(id, entry);
        humanObjectsGroup.add(entry.group);
      }

      const dx = obj.x - (robotPose.x || 0);
      const dy = obj.y - (robotPose.y || 0);
      const yaw = robotPose.yaw || 0;
      const fwd = dx * Math.cos(yaw) + dy * Math.sin(yaw);
      const left = -dx * Math.sin(yaw) + dy * Math.cos(yaw);

      const targetPos = new THREE.Vector3(
        robotGroup.position.x + fwd,
        0,
        robotGroup.position.z - left
      );
      entry.group.position.lerp(targetPos, 0.45);
      entry.group.lookAt(robotGroup.position.x, 0.8, robotGroup.position.z);

      const dist = Math.hypot(dx, dy).toFixed(1);
      const conf = obj.confidence ? ` ${Math.round(obj.confidence * 100)}%` : "";
      const age = obj.age_s ?? (obj.last_seen ? now - obj.last_seen : 0);

      if (entry.label) entry.group.remove(entry.label);
      entry.label = makeTextSprite(`Ember #${id}${conf} · ${dist}m`, "#ffb84d");
      entry.label.position.set(0, 1.85, 0);
      entry.group.add(entry.label);

      const opacity = age > 1.5 ? Math.max(0.15, 1.0 - (age - 1.5) * 2) : 1.0;
      entry.group.visible = opacity > 0.05;
      if (entry.ring) entry.ring.material.opacity = 0.6 * opacity;
    }

    for (const [id, entry] of humanGroupMap.entries()) {
      if (!currentIds.has(id)) {
        humanObjectsGroup.remove(entry.group);
        humanGroupMap.delete(id);
      }
    }
  }

  return {
    get pointSize() { return pointSize; },
    setObjects(objs) { setObjects(objs); },
    setPointSize(v) {
      pointSize = v;
      for (const [name, l] of Object.entries(layers)) {
        if (name !== "map" && name !== "traj" && l.mat) l.mat.size = v;
      }
    },
    setLayer(name, on) {
      if (layers[name]) {
        const target = layers[name].pts;
        if (target) target.visible = on;
      }
    },
    setLiveMapFloor(d) { updateLiveMapFloor(d); },
    setCloud(name, points) {
      const l = layers[name];
      if (!l) return;
      const now = performance.now();

      if (name === "hesai") {
        // Hesai Multi-frame Persistence
        const n = points.length;
        const framePos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const [x, y, z] = points[i];
          framePos[i * 3 + 0] = x;
          framePos[i * 3 + 1] = z;
          framePos[i * 3 + 2] = -y;
        }
        hesaiFrames.push({ positions: framePos, count: n, timestamp: now });
        const persistMs = (opts.persistSec || 3.5) * 1000;
        while (hesaiFrames.length > 1 && (now - hesaiFrames[0].timestamp > persistMs)) {
          hesaiFrames.shift();
        }
        if (hesaiFrames.length > HESAI_MAX_FRAMES) hesaiFrames.splice(0, hesaiFrames.length - HESAI_MAX_FRAMES);

        let total = 0;
        for (let i = 0; i < hesaiFrames.length; i++) total += hesaiFrames[i].count;
        const mergedPos = new Float32Array(total * 3);
        const mergedCol = new Float32Array(total * 3);
        const c = new THREE.Color();
        let offset = 0;
        for (let i = 0; i < hesaiFrames.length; i++) {
          mergedPos.set(hesaiFrames[i].positions, offset);
          const fCount = hesaiFrames[i].count;
          for (let j = 0; j < fCount; j++) {
            const zVal = hesaiFrames[i].positions[j * 3 + 1];
            const t = Math.max(0, Math.min(1, (zVal + 0.5) / 2.4));
            c.setHSL(0.08 - t * 0.12, 0.9, 0.4 + t * 0.3);
            const pIdx = (offset / 3) + j;
            mergedCol[pIdx * 3 + 0] = c.r; mergedCol[pIdx * 3 + 1] = c.g; mergedCol[pIdx * 3 + 2] = c.b;
          }
          offset += hesaiFrames[i].positions.length;
        }
        l.pts.geometry.dispose();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(mergedCol, 3));
        l.pts.geometry = geo;
        l.pts.frustumCulled = false;
        return;
      }

      // Go2 or standard cloud
      const n = points.length;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, y, z] = points[i];
        pos[i * 3] = x; pos[i * 3 + 1] = z; pos[i * 3 + 2] = -y;
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
      const s = store.state || {};
      if (s.imu) { robotGroup.rotation.z = -(s.imu.pitch || 0); robotGroup.rotation.x = s.imu.roll || 0; }
      if (s.motor_q) applyMotorQ(s.motor_q);
    },
    applyView() { place(); },
    applyZoom(z) { camRadius = z === "near" ? 1.6 : 6.0; place(); },
    resetView() { camRadius = 1.6; camAngle = 0.7; camPolar = 1.15; CAM_TARGET.set(0, 0.16, 0); place(); },
    resize() {
      const r = host.getBoundingClientRect();
      renderer.setSize(r.width, r.height);
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
      place();
    },
  };
}
