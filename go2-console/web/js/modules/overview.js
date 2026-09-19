/* Overview: the at-a-glance dashboard an operator keeps open by default. */
const { api, el, clear, store, fmt, guardedMotion, toast } = await import("../core.js" + (window.__V || ""));

let nodes = {};
const battHistory = [];
const tempHistory = [];

function card(title, bodyNode, tools) {
  return el("div.card", {}, [
    el("h3", {}, [el("span", { text: title }), tools || el("span")]),
    el("div.body", {}, [bodyNode]),
  ]);
}

function bars(values, warnAt, critAt) {
  const box = el("div.bars");
  const max = Math.max(1, ...values);
  for (const v of values) {
    const i = el("i", { style: { height: `${Math.max(3, (v / max) * 100)}%` } });
    if (v >= critAt) i.className = "crit";
    else if (v >= warnAt) i.className = "hot";
    box.appendChild(i);
  }
  return box;
}

export default {
  id: "overview", icon: "⌂", short: "Áttekintés",
  title: "Áttekintés", subtitle: "élő állapot és gyorsparancsok",

  mount({ body }) {
    clear(body);
    const grid = el("div.grid.g4");

    nodes.pose = el("div");
    nodes.batt = el("div");
    nodes.nav = el("div");
    nodes.health = el("div");
    nodes.cams = el("div.grid.g2", { style: { gap: "6px" } });
    nodes.alerts = el("div.stack");
    nodes.perception = el("div");
    nodes.mini = el("canvas", { width: 420, height: 300, style: { width: "100%", borderRadius: "6px", background: "#0a0d12", cursor: "crosshair" } });

    grid.appendChild(card("Pozíció és mozgás", nodes.pose));
    grid.appendChild(card("Energia", nodes.batt));
    grid.appendChild(card("Navigáció", nodes.nav));
    grid.appendChild(card("Robot-egészség", nodes.health));
    body.appendChild(grid);

    const row2 = el("div.grid.g2", { style: { marginTop: "12px" } });
    row2.appendChild(card("Minitérkép — kattints a célért", nodes.mini));
    const right = el("div.stack");
    right.appendChild(card("Személykövetés (Perception)", nodes.perception));
    right.appendChild(card("Aktív riasztások", nodes.alerts));
    right.appendChild(card("Kameraképek", nodes.cams));
    row2.appendChild(right);
    body.appendChild(row2);

    const quick = el("div.row", { style: { marginTop: "12px" } }, [
      el("button.btn.primary", { text: "▶ Térképezés indítása", onclick: () => setExplore(true) }),
      el("button.btn", { text: "■ Térképezés leállítása", onclick: () => setExplore(false) }),
      el("button.btn", { text: "📷 Fotó", onclick: () => cap("photo") }),
      el("button.btn", { text: "📡 LiDAR scan", onclick: () => cap("lidar_scan") }),
      el("button.btn", { text: "🌡 Hőkép", onclick: () => cap("thermal") }),
      el("button.btn", { text: "⏹ Navigáció megállítása", onclick: () => api.post("/api/goto/cancel") }),
      el("button.btn.danger", { text: "⬛ Incidens rögzítése", onclick: () => api.post("/api/blackbox/trigger", { reason: "operator_marked" }).then(() => toast("Incidens rögzítve")) }),
    ]);
    body.appendChild(card("Gyorsparancsok", quick));

    loadThumbs();

    nodes.mini.onclick = (ev) => miniClick(ev);
    this._unsub = store.subscribe((s) => this.update(s));
  },

  update(s) {
    if (!nodes.pose) return;
    const v = s.velocity || {};
    nodes.pose.innerHTML = "";
    nodes.pose.append(
      el("div.big", {}, [document.createTextNode(`${fmt.n(s.pose?.x)}, ${fmt.n(s.pose?.y)}`), el("span.u", { text: "m" })]),
      kv("irány", fmt.deg(s.pose?.yaw)),
      kv("sebesség", `${fmt.n(v.vx)} m/s`),
      kv("fordulás", `${fmt.n(v.vyaw)} rad/s`),
      kv("megtett út", `${fmt.n(s.distance_m, 1)} m`),
      kv("vezérlés", s.control_mode === "manual" ? "kézi" : "automata"),
    );

    const p = s.battery?.percent;
    const battKnown = typeof p === "number";
    if (battKnown) { battHistory.push(p); if (battHistory.length > 40) battHistory.shift(); }
    nodes.batt.innerHTML = "";
    nodes.batt.append(
      el("div.big", {}, [document.createTextNode(battKnown ? fmt.n(p, 0) : "--"),
                          el("span.u", { text: "%" })]),
      kv("feszültség", `${fmt.n(s.battery?.voltage, 1)} V`),
      kv("áram", `${fmt.n(s.battery?.current, 2)} A`),
      kv("üzemidő", fmt.dur(s.uptime_s)),
      bars(battHistory.map((x) => 100 - x), 80, 92),
    );

    nodes.nav.innerHTML = "";
    nodes.nav.append(
      el("div.big", { text: s.nav?.state ?? "--", style: { fontSize: "20px" } }),
      kv("cél", s.nav?.goal ? `${fmt.n(s.nav.goal.x)}, ${fmt.n(s.nav.goal.y)}` : "nincs"),
      kv("térképezés", s.exploring ? "fut" : "áll"),
      kv("lefedettség", `${fmt.n(s.coverage_pct, 1)} %`),
      kv("hiba", s.nav?.error || "nincs"),
    );

    const t = s.max_motor_temp;
    const tempKnown = typeof t === "number";
    if (tempKnown) { tempHistory.push(t); if (tempHistory.length > 40) tempHistory.shift(); }
    const warn = store.get("bb.temp_warn_c", 65);
    nodes.health.innerHTML = "";
    nodes.health.append(
      el("div.big", {}, [document.createTextNode(tempKnown ? fmt.n(t, 0) : "n/a"),
                          el("span.u", { text: "°C max motor" })]),
      kv("üzemmód", s.mode ?? "--"),
      kv("élesítve", s.armed ? "IGEN" : "nem"),
      kv("legközelebbi tárgy", `${fmt.n(s.proximity?.min_distance_m)} m`),
      bars(tempHistory, warn, warn + 10),
    );

    const pTarget = s.perception?.target_id;
    nodes.perception.innerHTML = "";
    nodes.perception.append(
      kv("célpont zárolva", pTarget != null ? `#${pTarget}` : "Auto (legközelebbi)"),
      kv("érzékelt személyek", `${s.perception?.count ?? 0} fő`),
      el("button.btn.sm", {
        text: "👤 Érzékelés modul megnyitása",
        style: { marginTop: "6px" },
        onclick: () => { location.hash = "perception"; }
      })
    );

    // Alerts
    clear(nodes.alerts);
    const alerts = [];
    if (s.estopped) alerts.push(["error", "VÉSZLEÁLLÍTÁS aktív — a robot lezárva"]);
    if (!s.link?.healthy) alerts.push(["error", "Megszakadt a kapcsolat a robottal"]);
    if (!battKnown) alerts.push(["warn", "Az akkumulátor-adat nem elérhető"]);
    else if (p <= store.get("bb.batt_crit_pct", 10)) alerts.push(["error", `KRITIKUS akkumulátorszint (${p.toFixed(0)}%)`]);
    else if (p <= store.get("bb.batt_low_pct", 20)) alerts.push(["warn", `Alacsony akkumulátorszint (${p.toFixed(0)}%)`]);
    if (s.proximity?.active) alerts.push(["warn", `Tárgy vagy személy ${fmt.n(s.proximity.min_distance_m)} m-en belül`]);
    if (tempKnown && t > warn) alerts.push(["warn", `Motorhőmérséklet ${t.toFixed(0)}°C a ${warn}°C küszöb felett`]);
    if (s.nav?.state === "blocked") alerts.push(["warn", "Vészfék: akadály a haladási irányban"]);
    // Only pillars this deployment actually expects count as a fault.
    if (s.pillars) {
      const expected = s.pillars_expected || Object.keys(s.pillars);
      const down = expected.filter((n) => s.pillars[n] === false);
      if (down.length) alerts.push(["error", `Nem elérhető pillér: ${down.join(", ")}`]);
      const optional = Object.keys(s.pillars).filter((n) => !expected.includes(n));
      if (optional.length) {
        alerts.push(["ok", `Csak szenzor-mód: ${expected.join(", ")} fut. ` +
                            `Nincs telepítve (nem hiba): ${optional.join(", ")}`]);
      }
    }
    if (!alerts.length) alerts.push(["ok", "Nincs aktív riasztás"]);
    for (const [k, msg] of alerts) {
      nodes.alerts.appendChild(el("div.toast." + (k === "ok" ? "info" : k), { text: msg, style: { animation: "none" } }));
    }

    drawMini(s);
  },

  onLeave() {},
};

function kv(k, v) {
  return el("div.kv", {}, [el("span.k", { text: k }), el("span.v", { text: String(v) })]);
}

async function loadThumbs() {
  let cams = [];
  try { cams = await api.get("/api/cameras"); } catch (e) { /* leave empty */ }
  clear(nodes.cams);
  if (!cams.length) {
    nodes.cams.appendChild(el("div.empty", { text: "Nincs elérhető kamera." }));
    return;
  }
  for (const c of cams.slice(0, 4)) {
    nodes.cams.appendChild(el("img", {
      src: `/api/cameras/${c.id}/stream`, alt: c.label, title: c.label,
      style: { width: "100%", borderRadius: "5px", border: "1px solid var(--line)", display: "block" },
    }));
  }
}

async function setExplore(on) {
  try { await api.post("/api/explore", { on }); }
  catch (e) { toast(e.message, "warn"); }
}
async function cap(kind) {
  try { const r = await api.post(`/api/capture/${kind}`); toast(`${kind} rögzítve (${r.id})`); }
  catch (e) { toast(e.message, "warn"); }
}

// ---- minimap ----------------------------------------------------------
let mapData = null, lastVersion = -1, lastFetch = 0, fetching = false;

// During live exploration the map version bumps on every poll. Refetching a
// 40k-cell payload that often locks up the browser, so the minimap settles
// for a slower refresh than the telemetry.
const MINIMAP_MIN_INTERVAL_MS = 2500;

async function ensureMap(s) {
  if (fetching) return;
  const stale = s.map_version !== lastVersion;
  if (mapData && (!stale || Date.now() - lastFetch < MINIMAP_MIN_INTERVAL_MS)) return;
  fetching = true;
  try {
    mapData = await api.get("/api/map");
    lastVersion = s.map_version;
    lastFetch = Date.now();
  } catch (e) {
    /* keep the previous map rather than blanking the panel */
  } finally {
    fetching = false;
  }
}

function drawMini(s) {
  ensureMap(s);
  const c = nodes.mini;
  if (!c || !mapData) return;
  const ctx = c.getContext("2d");
  const { width: W, height: H, floor, walls, resolution, origin_x, origin_y } = mapData;
  const sc = Math.min(c.width / W, c.height / H);
  const ox = (c.width - W * sc) / 2, oy = (c.height - H * sc) / 2;

  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const f = floor[i], w = walls[i];
    let r, g, b;
    if (f < 0) { r = 18; g = 22; b = 30; }
    else if (w > 0) { r = 120; g = 150; b = 180; }
    else if (f >= 50) { r = 200; g = 70; b = 70; }
    else { r = 22; g = 62; b = 56; }
    const p = i * 4;
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  off.getContext("2d").putImageData(img, 0, 0);

  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.translate(ox, oy + H * sc);
  ctx.scale(1, -1);                      // world y up
  ctx.drawImage(off, 0, 0, W * sc, H * sc);
  ctx.restore();

  const toPx = (wx, wy) => [
    ox + ((wx - origin_x) / resolution) * sc,
    oy + H * sc - ((wy - origin_y) / resolution) * sc,
  ];

  if (s.nav?.goal) {
    const [gx, gy] = toPx(s.nav.goal.x, s.nav.goal.y);
    ctx.strokeStyle = "#ffb84d"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(gx, gy, 7, 0, 7); ctx.stroke();
  }
  if (s.pose) {
    const [px, py] = toPx(s.pose.x, s.pose.y);
    ctx.save();
    ctx.translate(px, py); ctx.rotate(-s.pose.yaw);
    ctx.fillStyle = "#4db8ff";
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-6, 6); ctx.lineTo(-6, -6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  nodes.mini._toWorld = (px, py) => [
    origin_x + ((px - ox) / sc) * resolution,
    origin_y + ((oy + H * sc - py) / sc) * resolution,
  ];
}

function miniClick(ev) {
  const c = nodes.mini;
  if (!c._toWorld) return;
  const r = c.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (c.width / r.width);
  const py = (ev.clientY - r.top) * (c.height / r.height);
  const [wx, wy] = c._toWorld(px, py);
  guardedMotion("Navigáció indítása",
    `A robot ide fog menni: x ${wx.toFixed(2)}, y ${wy.toFixed(2)}`,
    async () => {
      try { await api.post("/api/goto", { x: wx, y: wy }); toast("Cél elfogadva"); }
      catch (e) { toast(e.message, "warn"); }
    });
}
