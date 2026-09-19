/* Map & Navigation: the operator's primary work surface.
 *
 * 2D top-down canvas is the default because it is what you actually plan on:
 * crisp cells, real scale, no occlusion. The 3D tab is the digital-twin view
 * for situational awareness and demos.
 */
const { api, el, $, clear, store, fmt, toast, guardedMotion } = await import("../core.js" + (window.__V || ""));

let ui = {}, mapData = null, lastVersion = -1;
let view = { scale: 1, ox: 0, oy: 0, fitted: false };
let layers = { floor: true, walls: true, path: true, zones: true, grid: false };
let waypoints = [];
let zones = [];
let drawingZone = null;
let mode = "goto";        // goto | waypoint | zone
let tab = "2d";
let three = null;

export default {
  id: "map", icon: "🗺", short: "Térkép",
  title: "Térkép és navigáció", subtitle: "kattints a térképre a célért", flush: true,

  mount({ body, tools }) {
    clear(body);
    ui.wrap = el("div", { id: "mapwrap" });
    ui.canvas = el("canvas");
    ui.three = el("div", { style: { position: "absolute", inset: "0", display: "none" } });
    ui.wrap.append(ui.canvas, ui.three);

    ui.overlay = el("div.map-overlay", {}, [
      modeBtn("goto", "🎯 Cél kijelölés"),
      modeBtn("waypoint", "📍 Waypoint sor"),
      modeBtn("zone", "⛔ Tiltott zóna"),
    ]);
    ui.legend = el("div.map-legend", { html: `
      <div><i style="background:#163e38"></i>szabad</div>
      <div><i style="background:#788fb4"></i>fal / akadály</div>
      <div><i style="background:#12161e"></i>ismeretlen</div>
      <div><i style="background:#4db8ff"></i>robot</div>
      <div><i style="background:#ffb84d"></i>cél / útvonal</div>` });
    ui.wrap.append(ui.overlay, ui.legend);
    body.appendChild(ui.wrap);

    clear(tools);
    ui.tabs = el("div.tabs", {}, [
      el("div.tab.active", { text: "2D", onclick: () => setTab("2d") }),
      el("div.tab", { text: "3D iker", onclick: () => setTab("3d") }),
    ]);
    ui.explore = el("button.btn.primary", { text: "▶ Térképezés", onclick: toggleExplore });
    tools.append(
      ui.tabs,
      ui.explore,
      el("button.btn", { text: "⏹ Nav stop", onclick: () => api.post("/api/goto/cancel") }),
      el("button.btn", { text: "⤢ Illesztés", onclick: () => { view.fitted = false; draw(); } }),
      el("button.btn", { text: "⬇ Térkép mentése", onclick: exportMap }),
    );

    bindCanvas();
    this._unsub = store.subscribe(onState);
    window.addEventListener("resize", resize);
    resize();
  },

  onEnter() { resize(); },

  inspector() {
    const box = el("div.igroup", {}, [el("h4", { text: "Rétegek és eszközök" })]);
    for (const [k, label] of Object.entries({
      floor: "Padló-réteg", walls: "Fal-réteg", path: "Útvonal és cél",
      zones: "Tiltott zónák", grid: "Rács",
    })) {
      const cb = el("input", { type: "checkbox", onchange: (e) => { layers[k] = e.target.checked; draw(); } });
      cb.checked = layers[k];
      box.appendChild(el("div.param", {}, [
        el("div.top", {}, [el("span.name", { text: label }), el("label.switch", {}, [cb, el("span.sl")])]),
      ]));
    }

    const wpBox = el("div.igroup", {}, [el("h4", { text: `Waypoint sor (${waypoints.length})` })]);
    if (!waypoints.length) {
      wpBox.appendChild(el("div.param", {}, [el("div.help", { text: "Válts „Waypoint sor” módra, és kattints a térképre pontokat. A robot sorban végigjárja őket." })]));
    } else {
      waypoints.forEach((w, i) => {
        wpBox.appendChild(el("div.param", {}, [
          el("div.top", {}, [
            el("span.name", { text: `${i + 1}. ${fmt.n(w.x)}, ${fmt.n(w.y)}` }),
            el("button.btn.sm", { text: "×", onclick: () => { waypoints.splice(i, 1); draw(); refreshInspector(); } }),
          ]),
        ]));
      });
      wpBox.appendChild(el("div.param", {}, [
        el("button.btn.primary.wide", { text: "▶ Sor végrehajtása", onclick: runWaypoints }),
        el("button.btn.wide", { text: "Sor törlése", style: { marginTop: "6px" }, onclick: () => { waypoints = []; draw(); refreshInspector(); } }),
      ]));
    }

    const zBox = el("div.igroup", {}, [el("h4", { text: `Tiltott zónák (${zones.length})` })]);
    zones.forEach((z, i) => {
      zBox.appendChild(el("div.param", {}, [
        el("div.top", {}, [
          el("span.name", { text: z.name }),
          el("button.btn.sm", { text: "×", onclick: () => { zones.splice(i, 1); draw(); refreshInspector(); } }),
        ]),
      ]));
    });
    if (!zones.length) zBox.appendChild(el("div.param", {}, [el("div.help", { text: "„Tiltott zóna” módban húzz egy téglalapot. A tervező és a vészfék is figyelembe veszi." })]));

    return el("div", {}, [box, wpBox, zBox]);
  },
};

function refreshInspector() {
  const ev = new CustomEvent("refresh-inspector");
  window.dispatchEvent(ev);
}

function modeBtn(m, label) {
  return el("button.btn" + (mode === m ? ".on" : ""), {
    text: label, "data-mode": m,
    onclick: () => {
      mode = m;
      ui.overlay.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("on", b.dataset.mode === m));
    },
  });
}

async function toggleExplore() {
  const on = !store.state.exploring;
  try {
    await api.post("/api/explore", { on });
    ui.explore.textContent = on ? "■ Térképezés leáll" : "▶ Térképezés";
  } catch (e) { toast(e.message, "warn"); }
}

async function runWaypoints() {
  if (!waypoints.length) return;
  guardedMotion("Waypoint sor indítása",
    `${waypoints.length} pont végigjárása. A robot azonnal elindul.`,
    async () => {
      const steps = waypoints.map((w) => ({ type: "goto", x: w.x, y: w.y }));
      const m = await api.post("/api/missions", { name: "Waypoint sor", steps });
      await api.post(`/api/missions/${m.id}/run`);
      toast("Waypoint sor küldetésként elindítva");
    });
}

function exportMap() {
  if (!mapData) return;
  const blob = new Blob([JSON.stringify(mapData)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `go2-map-${Date.now()}.json`;
  a.click();
  toast("Térkép exportálva");
}

// ---------------------------------------------------------------------------
function resize() {
  if (!ui.canvas) return;
  const r = ui.wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ui.canvas.width = Math.max(1, r.width * dpr);
  ui.canvas.height = Math.max(1, r.height * dpr);
  ui.canvas.style.width = r.width + "px";
  ui.canvas.style.height = r.height + "px";
  view.fitted = false;
  draw();
  if (three) three.resize(r.width, r.height);
}

// Rebuilding the raster from a 40k-cell payload is the most expensive thing
// this module does; during live exploration the version changes constantly.
const MAP_MIN_INTERVAL_MS = 1200;
let lastFetch = 0, fetching = false;

async function onState(s) {
  const stale = s.map_version !== lastVersion;
  if (!fetching && (!mapData || (stale && Date.now() - lastFetch >= MAP_MIN_INTERVAL_MS))) {
    fetching = true;
    try {
      mapData = await api.get("/api/map");
      lastVersion = s.map_version;
      lastFetch = Date.now();
      offVersion = -1;
    } catch (e) {
      /* keep last */
    } finally {
      fetching = false;
    }
  }
  if (ui.explore) ui.explore.textContent = s.exploring ? "■ Térképezés leáll" : "▶ Térképezés";
  draw();
  if (tab === "3d" && three) three.update(s, mapData);
}

function fit() {
  if (!mapData) return;
  const c = ui.canvas;
  const s = Math.min(c.width / mapData.width, c.height / mapData.height) * 0.92;
  view.scale = s;
  view.ox = (c.width - mapData.width * s) / 2;
  view.oy = (c.height - mapData.height * s) / 2;
  view.fitted = true;
}

function worldToPx(wx, wy) {
  const gx = (wx - mapData.origin_x) / mapData.resolution;
  const gy = (wy - mapData.origin_y) / mapData.resolution;
  return [view.ox + gx * view.scale, view.oy + (mapData.height - gy) * view.scale];
}
function pxToWorld(px, py) {
  const gx = (px - view.ox) / view.scale;
  const gy = mapData.height - (py - view.oy) / view.scale;
  return [mapData.origin_x + gx * mapData.resolution, mapData.origin_y + gy * mapData.resolution];
}

let offscreen = null, offVersion = null;

function buildOffscreen() {
  const key = `${lastVersion}|${layers.floor}|${layers.walls}`;
  if (offVersion === key && offscreen) return;
  offVersion = key;
  const { width: W, height: H, floor, walls } = mapData;
  const img = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const f = floor[i], w = walls[i];
    let r, g, b;
    if (f < 0) { r = 18; g = 22; b = 30; }
    else if (layers.walls && w > 0) {
      const k = w / 255;
      r = 90 + k * 70; g = 120 + k * 60; b = 150 + k * 50;
    } else if (f >= 50) { r = 200; g = 70; b = 70; }
    else if (layers.floor) { r = 22; g = 62; b = 56; }
    else { r = 18; g = 22; b = 30; }
    const p = i * 4;
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  offscreen = document.createElement("canvas");
  offscreen.width = W; offscreen.height = H;
  offscreen.getContext("2d").putImageData(img, 0, 0);
}

function draw() {
  const c = ui.canvas;
  if (!c) return;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, c.width, c.height);
  if (!mapData) {
    ctx.fillStyle = "#5d6e83";
    ctx.font = "14px sans-serif";
    ctx.fillText("térkép betöltése…", 20, 30);
    return;
  }
  if (!view.fitted) fit();
  buildOffscreen();

  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);
  ctx.translate(0, mapData.height);
  ctx.scale(1, -1);
  ctx.drawImage(offscreen, 0, 0);
  ctx.restore();

  if (layers.grid) {
    ctx.strokeStyle = "rgba(90,120,150,.18)";
    ctx.lineWidth = 1;
    const step = 1.0 / mapData.resolution * view.scale;   // 1 m
    for (let x = view.ox % step; x < c.width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke();
    }
    for (let y = view.oy % step; y < c.height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
    }
  }

  if (layers.zones) {
    for (const z of zones) drawZone(ctx, z, "rgba(255,90,90,.16)", "#ff5a5a");
    if (drawingZone) drawZone(ctx, drawingZone, "rgba(255,184,77,.14)", "#ffb84d");
  }

  const s = store.state;
  if (layers.path) {
    if (waypoints.length) {
      ctx.strokeStyle = "#b07dff"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      if (s.pose) { const [x, y] = worldToPx(s.pose.x, s.pose.y); ctx.moveTo(x, y); }
      waypoints.forEach((w) => { const [x, y] = worldToPx(w.x, w.y); ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
      waypoints.forEach((w, i) => {
        const [x, y] = worldToPx(w.x, w.y);
        ctx.fillStyle = "#b07dff";
        ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(String(i + 1), x, y + 3.5);
        ctx.textAlign = "left";
      });
    }
    if (s.nav?.goal) {
      const [x, y] = worldToPx(s.nav.goal.x, s.nav.goal.y);
      ctx.strokeStyle = "#ffb84d"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16); ctx.stroke();
    }
  }

  if (s.pose) {
    const [x, y] = worldToPx(s.pose.x, s.pose.y);
    const radius = (store.get("nav.robot_radius", 0.25) / mapData.resolution) * view.scale;
    ctx.strokeStyle = "rgba(77,184,255,.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, 7); ctx.stroke();
    const stop = (store.get("nav.safety_stop_m", 0.45) / mapData.resolution) * view.scale;
    ctx.strokeStyle = "rgba(255,90,90,.28)"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(x, y, stop, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-s.pose.yaw);
    ctx.fillStyle = s.armed ? "#4db8ff" : "#8496ab";
    ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-9, 9); ctx.lineTo(-9, -9); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // scale bar
  const oneM = (1.0 / mapData.resolution) * view.scale;
  ctx.strokeStyle = "#8496ab"; ctx.lineWidth = 2;
  const bx = c.width - 30 - oneM, by = c.height - 26;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + oneM, by);
  ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by + 5);
  ctx.moveTo(bx + oneM, by - 5); ctx.lineTo(bx + oneM, by + 5); ctx.stroke();
  ctx.fillStyle = "#8496ab"; ctx.font = "11px sans-serif";
  ctx.fillText("1 m", bx + oneM / 2 - 10, by - 9);
}

function drawZone(ctx, z, fill, stroke) {
  const [x0, y0] = worldToPx(z.x0, z.y0);
  const [x1, y1] = worldToPx(z.x1, z.y1);
  ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2;
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

// ---------------------------------------------------------------------------
function bindCanvas() {
  const c = ui.canvas;
  let dragging = false, moved = 0, last = null, zoneStart = null;

  const evPx = (ev) => {
    const r = c.getBoundingClientRect();
    return [(ev.clientX - r.left) * (c.width / r.width), (ev.clientY - r.top) * (c.height / r.height)];
  };

  c.addEventListener("pointerdown", (ev) => {
    c.setPointerCapture(ev.pointerId);
    dragging = true; moved = 0; last = evPx(ev);
    if (mode === "zone" && mapData) zoneStart = pxToWorld(...last);
  });
  c.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const p = evPx(ev);
    moved += Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]);
    if (mode === "zone" && zoneStart && mapData) {
      const cur = pxToWorld(...p);
      drawingZone = { name: "új zóna", x0: zoneStart[0], y0: zoneStart[1], x1: cur[0], y1: cur[1] };
    } else if (ev.buttons === 2 || ev.shiftKey || mode !== "zone") {
      view.ox += p[0] - last[0];
      view.oy += p[1] - last[1];
    }
    last = p;
    draw();
  });
  c.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false;
    const p = evPx(ev);
    if (mode === "zone" && drawingZone) {
      if (Math.abs(drawingZone.x1 - drawingZone.x0) > 0.15) {
        zones.push({ ...drawingZone, name: `Zóna ${zones.length + 1}` });
        toast("Tiltott zóna felvéve");
      }
      drawingZone = null; zoneStart = null;
      draw(); refreshInspector();
      return;
    }
    if (moved > 6 || !mapData) { draw(); return; }
    const [wx, wy] = pxToWorld(...p);
    if (mode === "waypoint") {
      waypoints.push({ x: wx, y: wy });
      draw(); refreshInspector();
      return;
    }
    guardedMotion("Navigáció indítása",
      `A robot ide fog menni: x ${wx.toFixed(2)}, y ${wy.toFixed(2)}`,
      async () => {
        try { await api.post("/api/goto", { x: wx, y: wy }); toast("Cél elfogadva"); }
        catch (e) { toast(e.message, "warn"); }
      });
  });
  c.addEventListener("contextmenu", (e) => e.preventDefault());
  c.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (!mapData) return;
    const [px, py] = evPx(ev);
    const k = ev.deltaY > 0 ? 0.88 : 1.14;
    const before = pxToWorld(px, py);
    view.scale = Math.max(0.4, Math.min(40, view.scale * k));
    const after = pxToWorld(px, py);
    view.ox += ((after[0] - before[0]) / mapData.resolution) * view.scale;
    view.oy -= ((after[1] - before[1]) / mapData.resolution) * view.scale;
    draw();
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// 3D digital twin tab
// ---------------------------------------------------------------------------
function setTab(t) {
  tab = t;
  ui.tabs.children[0].classList.toggle("active", t === "2d");
  ui.tabs.children[1].classList.toggle("active", t === "3d");
  ui.canvas.style.display = t === "2d" ? "block" : "none";
  ui.three.style.display = t === "3d" ? "block" : "none";
  ui.legend.style.display = t === "2d" ? "block" : "none";
  if (t === "3d") {
    if (!three) three = makeThree(ui.three);
    const r = ui.wrap.getBoundingClientRect();
    three.resize(r.width, r.height);
    three.update(store.state, mapData);
  } else {
    resize();
  }
}

function makeThree(host) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d12);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 500);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75);
  sun.position.set(8, 18, 10);
  scene.add(sun);

  const target = new THREE.Vector3();
  let dist = 16, az = Math.PI * 0.25, pol = Math.PI * 0.22;
  const place = () => {
    camera.position.set(
      target.x + dist * Math.sin(pol) * Math.sin(az),
      target.y + dist * Math.cos(pol),
      target.z + dist * Math.sin(pol) * Math.cos(az));
    camera.lookAt(target);
  };

  let drag = false, lastP = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { drag = true; lastP = [e.clientX, e.clientY]; });
  window.addEventListener("pointerup", () => { drag = false; });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    az -= (e.clientX - lastP[0]) * 0.005;
    pol = Math.max(0.06, Math.min(Math.PI / 2 - 0.03, pol - (e.clientY - lastP[1]) * 0.005));
    lastP = [e.clientX, e.clientY];
    place();
  });
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    dist = Math.max(2, Math.min(120, dist * (e.deltaY > 0 ? 1.1 : 0.9)));
    place();
  }, { passive: false });

  let floorMesh = null, wallMesh = null, ver = -1, inited = false;
  const robot = new THREE.Group();
  robot.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x33e0ff, emissive: 0x0d5a68 })));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0x33e0ff }));
  nose.rotation.z = -Math.PI / 2; nose.position.x = 0.34;
  robot.add(nose);
  scene.add(robot);

  const goal = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.3, 20),
    new THREE.MeshBasicMaterial({ color: 0xffb84d, side: THREE.DoubleSide }));
  goal.rotation.x = -Math.PI / 2; goal.visible = false;
  scene.add(goal);

  (function loop() { requestAnimationFrame(loop); renderer.render(scene, camera); })();

  return {
    resize(w, h) {
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      place();
    },
    update(s, m) {
      if (m && m.version !== ver) {
        ver = m.version;
        const worldW = m.width * m.resolution, worldH = m.height * m.resolution;
        const cx = m.origin_x + worldW / 2, cz = m.origin_y + worldH / 2;

        if (floorMesh) { scene.remove(floorMesh); floorMesh.geometry.dispose(); floorMesh.material.map?.dispose(); floorMesh.material.dispose(); }
        const cv = document.createElement("canvas");
        cv.width = m.width; cv.height = m.height;
        const img = new ImageData(m.width, m.height);
        for (let i = 0; i < m.width * m.height; i++) {
          const f = m.floor[i];
          const [r, g, b] = f < 0 ? [18, 22, 30] : f >= 50 ? [150, 60, 60] : [22, 62, 56];
          const p = i * 4;
          img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
        }
        cv.getContext("2d").putImageData(img, 0, 0);
        const tex = new THREE.CanvasTexture(cv);
        tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
        floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH),
          new THREE.MeshStandardMaterial({ map: tex }));
        floorMesh.rotation.x = -Math.PI / 2;
        floorMesh.position.set(cx, 0, cz);
        scene.add(floorMesh);

        if (wallMesh) { scene.remove(wallMesh); wallMesh.geometry.dispose(); wallMesh.material.dispose(); wallMesh = null; }
        const cells = [];
        for (let i = 0; i < m.walls.length; i++) if (m.walls[i] > 0) cells.push(i);
        const use = cells.slice(0, 60000);
        if (use.length) {
          wallMesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(m.resolution * 0.96, 1, m.resolution * 0.96),
            new THREE.MeshStandardMaterial({ color: 0x6f8fae }), use.length);
          const d = new THREE.Object3D();
          use.forEach((idx, k) => {
            const h = Math.max((m.walls[idx] / 255) * 2.4, 0.05);
            d.position.set(m.origin_x + ((idx % m.width) + 0.5) * m.resolution, h / 2,
              m.origin_y + (Math.floor(idx / m.width) + 0.5) * m.resolution);
            d.scale.set(1, h, 1); d.updateMatrix();
            wallMesh.setMatrixAt(k, d.matrix);
          });
          wallMesh.instanceMatrix.needsUpdate = true;
          scene.add(wallMesh);
        }
        if (!inited) {
          inited = true;
          target.set(cx, 0, cz);
          dist = Math.max(worldW, worldH) * 0.8;
          place();
        }
      }
      if (s?.pose) {
        robot.position.set(s.pose.x, 0.16, s.pose.y);
        robot.rotation.y = -s.pose.yaw;
      }
      if (s?.nav?.goal) { goal.visible = true; goal.position.set(s.nav.goal.x, 0.02, s.nav.goal.y); }
      else goal.visible = false;
    },
  };
}
