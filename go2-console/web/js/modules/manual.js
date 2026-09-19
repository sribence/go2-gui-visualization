/* Manual control: joystick, keyboard, gamepad, gait/posture.
 *
 * Commands are streamed at a fixed rate while any input is active. The
 * backend runs a deadman timer, so releasing the stick (or losing this tab)
 * stops the robot rather than leaving the last velocity latched.
 */
const { api, el, clear, store, fmt, toast } = await import("../core.js" + (window.__V || ""));

let ui = {}, timer = null, active = false;
let allCams = [], selectedCams = [], streaming = false;
const MAX_TILES = 4;
let input = { vx: 0, vy: 0, vyaw: 0 };
let keys = new Set();
let padIndex = null;
const trace = [];

const GAITS = [
  ["damp", "Damp (ellazít)", "A motorok szabadon mozognak. Mindig biztonságos."],
  ["lay_down", "Fekszik (lay_down)", "Lefekszik a földre."],
  ["sit", "Sit (ül)", "Leül, alacsony fogyasztás."],
  ["stand", "Stand (áll)", "Alapállás, mozgásra kész."],
  ["balance", "Balance (egyensúly)", "Aktív egyensúlyozás, egyenetlen talajra."],
];

export default {
  id: "manual", icon: "🎮", short: "Kézi",
  title: "Kézi irányítás", subtitle: "WASD / joystick / gamepad",

  mount({ body, tools }) {
    clear(body);

    // --- stick + keypad ------------------------------------------------
    ui.stick = el("div.stick", {}, [el("div.knob")]);
    ui.knob = ui.stick.firstChild;
    bindStick();

    ui.keypad = el("div.keypad", {}, [
      el("span"), key("w", "▲"), el("span"),
      key("a", "◀"), key("s", "▼"), key("d", "▶"),
      key("q", "↺"), el("button.btn", { text: "STOP", onclick: stopNow }), key("e", "↻"),
    ]);

    ui.readout = el("div");
    const driveCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "Vezérlés" }), el("span.pill", { id: "man-src", text: "tétlen" })]),
      el("div.body", {}, [
        el("div.row", { style: { gap: "22px", alignItems: "flex-start" } }, [
          ui.stick,
          el("div.stack", {}, [
            ui.keypad,
            el("div.help", { style: { fontSize: "11px", color: "var(--dim)" }, text: "W/S előre-hátra · A/D oldalazás · Q/E fordulás · Szóköz = E-STOP" }),
          ]),
          ui.readout,
        ]),
      ]),
    ]);

    // --- gait / posture -------------------------------------------------
    ui.gait = el("div.row");
    for (const [id, label, help] of GAITS) {
      ui.gait.appendChild(el("button.btn", {
        text: label, title: help, "data-mode": id,
        onclick: () => setMode(id),
      }));
    }
    ui.avoidToggle = el("input", {
      type: "checkbox", checked: true,
      onchange: (e) => setObstacleAvoid(e.target.checked)
    });
    api.get("/api/obstacle_avoid").then(r => {
      if (ui.avoidToggle && r.obstacle_avoid != null) ui.avoidToggle.checked = r.obstacle_avoid;
    }).catch(() => {});

    const GESTURES = [
      ["greet", "👋", "Üdvözlés (Greet / Hello)"],
      ["love", "🫶", "Szeretet / Szív (Love / Heart)"],
      ["shake_hand", "🤝", "Kézfogás (Shake hand)"],
      ["stretch", "🙆", "Nyújtózás (Stretch)"],
      ["pounce", "🐅", "Rátámadás (Pounce)"],
      ["jump", "🦘", "Ugrás (Jump)"],
      ["front_flip", "🤸", "Front Flip (Szaltó)"],
      ["search_light", "💡", "Keresőfény (Search light)"],
    ];

    ui.gestures = el("div.row.tight", { style: { gap: "6px", flexWrap: "wrap", marginTop: "4px" } });
    for (const [id, ico, title] of GESTURES) {
      ui.gestures.appendChild(el("button.btn.sm", {
        text: ico, title: `${ico} ${title}`,
        style: { fontSize: "16px", padding: "4px 10px" },
        onclick: () => setMode(id)
      }));
    }

    const gaitCard = el("div.card", {}, [
      el("h3", { text: "Testtartás, Trükkök és üzemmód" }),
      el("div.body", {}, [
        ui.gait,
        el("div", { style: { marginTop: "10px", fontSize: "11px", color: "var(--dim)" } }, [
          el("div", { text: "Kézjelek, Trükkök és Keresőfény (Emoji gombok):", style: { marginBottom: "4px" } }),
          ui.gestures
        ]),
        el("div.row", { style: { marginTop: "12px", paddingTop: "8px", borderTop: "1px solid var(--border)", alignItems: "center", gap: "8px" } }, [
          el("label.switch-wrap", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" } }, [
            ui.avoidToggle,
            el("span", { text: "🛡️ Akadálykerülés (Obstacle Avoidance)" })
          ])
        ]),
        el("div.help", { style: { marginTop: "8px", fontSize: "11px", color: "var(--dim)" },
          text: "A Damp mindig kiadható. A többihez élesített robot kell." }),
      ]),
    ]);

    // --- gamepad --------------------------------------------------------
    ui.pad = el("div");
    const padCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "Gamepad" }), el("span.pill", { id: "pad-pill", text: "nincs" })]),
      el("div.body", {}, [ui.pad]),
    ]);

    // --- trace ----------------------------------------------------------
    ui.trace = el("canvas", { width: 640, height: 180, style: { width: "100%", background: "var(--bg)", borderRadius: "6px" } });
    const traceCard = el("div.card", {}, [
      el("h3", { text: "Parancs-előzmény (utolsó 10 mp)" }),
      el("div.body", {}, [ui.trace]),
    ]);

    // --- camera feeds ---------------------------------------------------
    // Any mix of feeds, side by side: the tile count drives the layout, so
    // one selection is full-size and four fall into a 2x2.
    ui.camToggles = el("div.camtoggles");
    ui.camGrid = el("div.camgrid.embedded");
    const camCard = el("div.card.pad0", {}, [
      el("h3", {}, [el("span", { text: "Kameraképek" }), ui.camToggles]),
      el("div.body", { style: { padding: "8px" } }, [ui.camGrid]),
    ]);

    body.append(
      el("div.grid.g2", {}, [driveCard, el("div.stack", {}, [gaitCard, padCard])]),
      el("div", { style: { height: "12px" } }),
      camCard,
      el("div", { style: { height: "12px" } }),
      traceCard,
    );

    loadCameras();

    clear(tools);
    tools.append(
      el("span.pill", { id: "man-armed", text: "lezárva" }),
      el("button.btn", { text: "Fókusz a billentyűzetre", onclick: () => body.focus() }),
    );

    body.tabIndex = 0;
    this._unsub = store.subscribe(onState);
  },

  onEnter() {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stopNow);
    timer = setInterval(tick, 100);
    startStreams();
  },

  onLeave() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", stopNow);
    clearInterval(timer); timer = null;
    stopNow();
    // MJPEG connections stay open on a hidden <img>, so drop them on the
    // way out instead of leaving one per feed running in the background.
    stopStreams();
  },
};

// ---------------------------------------------------------------------------
// Camera feeds
// ---------------------------------------------------------------------------
async function loadCameras() {
  try {
    allCams = await api.get("/api/cameras");
  } catch (e) {
    allCams = [];
  }
  const stored = JSON.parse(localStorage.getItem("mc_manual_cams") || "null");
  const valid = (stored || []).filter((id) => allCams.some((c) => c.id === id));
  selectedCams = valid.length ? valid : allCams.slice(0, 1).map((c) => c.id);
  renderToggles();
  renderTiles();
}

function renderToggles() {
  clear(ui.camToggles);
  if (!allCams.length) {
    ui.camToggles.appendChild(el("span.trend", { text: "nincs kamera" }));
    return;
  }
  for (const c of allCams) {
    const on = selectedCams.includes(c.id);
    const atLimit = !on && selectedCams.length >= MAX_TILES;
    ui.camToggles.appendChild(el("span.camtoggle" + (on ? ".on" : "") + (atLimit ? ".off-limit" : ""), {
      text: c.label,
      title: atLimit ? `Legfeljebb ${MAX_TILES} kamera egyszerre` : c.id,
      onclick: () => toggleCam(c.id),
    }));
  }
}

function toggleCam(id) {
  const i = selectedCams.indexOf(id);
  if (i >= 0) {
    selectedCams.splice(i, 1);
  } else {
    if (selectedCams.length >= MAX_TILES) {
      toast(`Legfeljebb ${MAX_TILES} kamera jeleníthető meg egyszerre`, "warn");
      return;
    }
    selectedCams.push(id);
  }
  localStorage.setItem("mc_manual_cams", JSON.stringify(selectedCams));
  renderToggles();
  renderTiles();
}

function renderTiles() {
  const n = selectedCams.length;
  // 1 -> one big, 2 -> side by side, 3 -> three across, 4 -> 2x2
  const cls = n <= 1 ? "x1" : n === 3 ? "x3" : "x2";
  const tall = n >= 4 ? " tall" : "";
  ui.camGrid.className = `camgrid embedded ${cls}${tall}`;
  clear(ui.camGrid);
  if (!n) {
    ui.camGrid.appendChild(el("div.empty", {
      text: "Válassz kamerát fent. Több is bekapcsolható — egymás mellett jelennek meg.",
    }));
    return;
  }
  for (const id of selectedCams) {
    const cam = allCams.find((c) => c.id === id) || { id, label: id };
    const img = el("img", { alt: cam.label, "data-cam": id });
    if (streaming) img.src = `/api/cameras/${id}/stream`;
    ui.camGrid.appendChild(el("div.cam", {}, [
      img,
      el("div.bar", {}, [
        el("span.nm", { text: cam.label }),
        el("button.btn.sm", { text: "📸", title: "Pillanatkép", onclick: () => snap(id) }),
        el("button.btn.sm", { text: "✕", title: "Elrejtés", onclick: () => toggleCam(id) }),
      ]),
    ]));
  }
}

function startStreams() {
  streaming = true;
  ui.camGrid?.querySelectorAll("img[data-cam]").forEach((img) => {
    if (!img.src) img.src = `/api/cameras/${img.dataset.cam}/stream`;
  });
}

function stopStreams() {
  streaming = false;
  ui.camGrid?.querySelectorAll("img[data-cam]").forEach((img) => {
    img.removeAttribute("src");
  });
}

async function snap(camId) {
  try {
    if (camId !== "lidar") await api.post("/api/settings", { "sensor.photo_cam": camId });
    const r = await api.post(`/api/capture/${camId === "lidar" ? "lidar_scan" : "photo"}`);
    toast(`Rögzítve (${r.id})`);
  } catch (e) { toast(e.message, "warn"); }
}


function key(k, label) {
  return el("button.btn", {
    text: label, "data-key": k,
    onpointerdown: (e) => { e.preventDefault(); keys.add(k); },
    onpointerup: () => keys.delete(k),
    onpointerleave: () => keys.delete(k),
  });
}

function setMode(m) {
  if (m === "damp") {
    const confirmDamp = window.confirm(
      "⚠️ DAMP / ELLAZÍTÁS FIGYELMEZTETÉS:\n\nA Damp parancs azonnal lekapcsolja a motorok tartónyomatékát, és a robot összecsuklik a földre!\n\nBiztosan kiadod a Damp parancsot?"
    );
    if (!confirmDamp) return;
  }
  api.post("/api/mode", { mode: m })
    .then(() => toast(`Üzemmód: ${m}`))
    .catch((e) => toast(e.message, "warn"));
}

function setObstacleAvoid(enabled) {
  api.post("/api/obstacle_avoid", { enable: enabled })
    .then(() => toast(`Akadálykerülés: ${enabled ? "BEKAPCSOLVA" : "KIKAPCSOLVA"}`))
    .catch((e) => toast(e.message, "warn"));
}

function stopNow() {
  input = { vx: 0, vy: 0, vyaw: 0 };
  keys.clear();
  if (ui.knob) ui.knob.style.transform = "translate(-50%, -50%)";
  if (active) { api.post("/api/manual", { vx: 0, vy: 0, vyaw: 0 }).catch(() => {}); active = false; }
}

// ---------------------------------------------------------------------------
function bindStick() {
  const s = ui.stick;
  let dragging = false;
  const R = 67;
  const apply = (ev) => {
    const r = s.getBoundingClientRect();
    let dx = ev.clientX - (r.left + r.width / 2);
    let dy = ev.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    ui.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    input.vx = -dy / R;
    input.vyaw = -dx / R;
  };
  s.addEventListener("pointerdown", (ev) => {
    dragging = true; s.classList.add("active");
    s.setPointerCapture(ev.pointerId); apply(ev);
  });
  s.addEventListener("pointermove", (ev) => { if (dragging) apply(ev); });
  const release = () => {
    if (!dragging) return;
    dragging = false; s.classList.remove("active");
    ui.knob.style.transform = "translate(-50%, -50%)";
    input.vx = 0; input.vyaw = 0;
  };
  s.addEventListener("pointerup", release);
  s.addEventListener("pointercancel", release);
}

function onKeyDown(e) {
  if (e.target.matches("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if ("wasdqe".includes(k)) { keys.add(k); e.preventDefault(); }
}
function onKeyUp(e) { keys.delete(e.key.toLowerCase()); }

function readGamepad() {
  if (!store.get("manual.gamepad", true)) { padIndex = null; return null; }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find((p) => p && p.connected);
  padIndex = pad ? pad.index : null;
  if (!pad) return null;
  return {
    name: pad.id,
    vx: -(pad.axes[1] || 0),
    vy: -(pad.axes[0] || 0),
    vyaw: -(pad.axes[2] || 0),
    estop: pad.buttons[1]?.pressed,
    axes: pad.axes.slice(0, 4),
  };
}

function tick() {
  const pad = readGamepad();
  let src = "tétlen";
  let cmd = { vx: 0, vy: 0, vyaw: 0 };

  if (keys.size) {
    src = "billentyűzet";
    cmd.vx = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
    cmd.vy = (keys.has("a") ? 1 : 0) - (keys.has("d") ? 1 : 0);
    cmd.vyaw = (keys.has("q") ? 1 : 0) - (keys.has("e") ? 1 : 0);
  } else if (Math.abs(input.vx) + Math.abs(input.vyaw) > 0.02) {
    src = "joystick";
    cmd = { ...input };
  } else if (pad && (Math.abs(pad.vx) + Math.abs(pad.vy) + Math.abs(pad.vyaw)) > 0.12) {
    src = "gamepad";
    cmd = { vx: pad.vx, vy: pad.vy, vyaw: pad.vyaw };
  }

  if (pad?.estop) { document.getElementById("estop").click(); }

  const pill = document.getElementById("man-src");
  if (pill) { pill.textContent = src; pill.className = "pill" + (src === "tétlen" ? "" : " run"); }
  const padPill = document.getElementById("pad-pill");
  if (padPill) {
    padPill.textContent = pad ? "csatlakoztatva" : "nincs";
    padPill.className = "pill" + (pad ? " ok" : "");
  }
  if (ui.pad) {
    clear(ui.pad);
    if (!pad) {
      ui.pad.appendChild(el("div.help", { style: { color: "var(--dim)", fontSize: "11.5px" },
        text: "Csatlakoztass egy gamepadet és nyomj meg rajta egy gombot. Bal bot: haladás, jobb bot: fordulás, B gomb: vészleállítás." }));
    } else {
      ui.pad.appendChild(el("div.kv", {}, [el("span.k", { text: "eszköz" }), el("span.v", { text: pad.name.slice(0, 34) })]));
      pad.axes.forEach((a, i) => {
        ui.pad.appendChild(el("div.kv", {}, [el("span.k", { text: `tengely ${i}` }), el("span.v", { text: fmt.n(a) })]));
      });
    }
  }

  ui.keypad?.querySelectorAll("[data-key]").forEach((b) =>
    b.classList.toggle("held", keys.has(b.dataset.key)));

  const moving = Math.abs(cmd.vx) + Math.abs(cmd.vy) + Math.abs(cmd.vyaw) > 0.01;
  if (moving || active) {
    active = moving;
    api.post("/api/manual", cmd).catch((e) => {
      if (moving) { toast(e.message, "warn"); stopNow(); }
    });
  }

  trace.push({ ...cmd, t: Date.now() });
  while (trace.length && Date.now() - trace[0].t > 10000) trace.shift();

  renderReadout(cmd);
  drawTrace();
}

function renderReadout(cmd) {
  if (!ui.readout) return;
  const mx = store.get("manual.max_vx", 0.6);
  const my = store.get("manual.max_vy", 0.3);
  const mw = store.get("manual.max_vyaw", 0.9);
  clear(ui.readout);
  ui.readout.append(
    el("div.kv", {}, [el("span.k", { text: "vx parancs" }), el("span.v", { text: `${fmt.n(cmd.vx * mx)} m/s` })]),
    el("div.kv", {}, [el("span.k", { text: "vy parancs" }), el("span.v", { text: `${fmt.n(cmd.vy * my)} m/s` })]),
    el("div.kv", {}, [el("span.k", { text: "vyaw parancs" }), el("span.v", { text: `${fmt.n(cmd.vyaw * mw)} rad/s` })]),
    el("div.kv", {}, [el("span.k", { text: "limit vx" }), el("span.v", { text: `${fmt.n(mx)} m/s` })]),
    el("div.kv", {}, [el("span.k", { text: "holtsáv" }), el("span.v", { text: fmt.n(store.get("manual.deadzone", 0.08)) })]),
    el("div.kv", {}, [el("span.k", { text: "deadman" }), el("span.v", { text: `${fmt.n(store.get("manual.deadman_s", 0.5), 1)} s` })]),
  );
}

function drawTrace() {
  const c = ui.trace;
  if (!c) return;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "rgba(130,150,175,.25)";
  ctx.beginPath(); ctx.moveTo(0, c.height / 2); ctx.lineTo(c.width, c.height / 2); ctx.stroke();
  if (trace.length < 2) return;
  const t0 = Date.now() - 10000;
  const series = [["vx", "#4db8ff"], ["vy", "#b07dff"], ["vyaw", "#ffb84d"]];
  for (const [k, col] of series) {
    ctx.strokeStyle = col; ctx.lineWidth = 1.6;
    ctx.beginPath();
    trace.forEach((p, i) => {
      const x = ((p.t - t0) / 10000) * c.width;
      const y = c.height / 2 - p[k] * (c.height / 2 - 8);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.font = "10px sans-serif";
  series.forEach(([k, col], i) => {
    ctx.fillStyle = col;
    ctx.fillText(k, 8 + i * 34, 13);
  });
}

function onState(s) {
  const pill = document.getElementById("man-armed");
  if (pill) {
    pill.textContent = s.armed ? "ÉLES" : "lezárva";
    pill.className = "pill " + (s.armed ? "bad" : "ok");
  }
  ui.gait?.querySelectorAll("[data-mode]").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === s.mode));
}
