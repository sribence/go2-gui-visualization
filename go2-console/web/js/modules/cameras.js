/* Cameras: multi-feed grid with per-camera recording and snapshots. */
const { api, el, clear, store, toast, modal, closeModal } = await import("../core.js" + (window.__V || ""));
const { depthView } = await import("../depthview.js" + (window.__V || ""));

let ui = {}, cams = [], enabled = new Set(), fullscreen = null;
let views = [];

export default {
  id: "cameras", icon: "📷", short: "Kamerák",
  title: "Kamerák", subtitle: "élő kép, felvétel, pillanatkép", flush: true,

  async mount({ body, tools }) {
    clear(body);
    ui.grid = el("div.camgrid");
    body.appendChild(ui.grid);

    clear(tools);
    ui.gridSel = el("select", { style: { width: "auto" }, onchange: (e) => setGrid(e.target.value) },
      ["1x1", "2x1", "2x2", "3x3"].map((g) => el("option", { value: g, text: g })));
    ui.gridSel.value = store.get("cam.grid", "2x2");
    const lightSlider = el("input", {
      type: "range", min: 0, max: 10, value: 10,
      title: "💡 Go2 LED Fényerősség (0-10)",
      style: { width: "80px", cursor: "pointer" },
      onchange: (e) => {
        const br = parseInt(e.target.value);
        api.post("/api/led", { brightness: br, switch: br > 0 ? 1 : 0 }).catch(err => {
          toast(err.message || "Hiba a LED állításakor", "warn");
        });
      }
    });

    tools.append(
      ui.gridSel,
      el("div.row", { style: { alignItems: "center", gap: "6px", marginLeft: "6px" } }, [
        el("span", { text: "💡 Lámpa:" }),
        lightSlider
      ]),
      el("button.btn", { text: "📸 Pillanatkép mind", onclick: snapAll }),
      el("button.btn", { text: "⏺ Felvétel mind", onclick: () => recordAll(true) }),
      el("button.btn", { text: "⏹ Felvétel stop", onclick: () => recordAll(false) }),
      el("button.btn", { text: "⟳ Újrakeresés", onclick: load }),
    );

    await load();
  },

  onLeave() {
    for (const v of views) v.stop();
    views = [];
  },

  onEnter() { if (cams.length && !views.length) render(); },

  inspector() {
    const box = el("div.igroup", {}, [el("h4", { text: "Megjelenített kamerák" })]);
    for (const c of cams) {
      const cb = el("input", { type: "checkbox", onchange: (e) => {
        e.target.checked ? enabled.add(c.id) : enabled.delete(c.id);
        render();
      } });
      cb.checked = enabled.has(c.id);
      box.appendChild(el("div.param", {}, [
        el("div.top", {}, [
          el("span.name", { text: c.label }),
          el("label.switch", {}, [cb, el("span.sl")]),
        ]),
        el("div.help", { text: `azonosító: ${c.id} · forrás: ${c.kind}` }),
      ]));
    }
    if (!cams.length) box.appendChild(el("div.param", {}, [el("div.help", { text: "Nincs felderített kamera." })]));
    return box;
  },
};

async function load() {
  try {
    cams = await api.get("/api/cameras");
    if (!enabled.size) cams.slice(0, 4).forEach((c) => enabled.add(c.id));
    render();
  } catch (e) { toast("Kameralista betöltése sikertelen: " + e.message, "error"); }
}

function setGrid(g) {
  api.post("/api/settings", { "cam.grid": g }).then((r) => { store.settings = r.values; });
  render();
}

function render() {
  for (const v of views) v.stop();
  views = [];
  const g = ui.gridSel?.value || "2x2";
  ui.grid.className = "camgrid " + ({ "1x1": "x1", "2x1": "x2", "2x2": "x2", "3x3": "x3" }[g] || "x2");
  clear(ui.grid);
  const show = cams.filter((c) => enabled.has(c.id));
  if (!show.length) {
    ui.grid.appendChild(el("div.empty", { text: "Nincs kiválasztott kamera. Kapcsolj be egyet az Inspektorban." }));
    return;
  }
  for (const c of show) ui.grid.appendChild(camTile(c));
}

function isDepth(c) { return /depth|melys/i.test(c.id + " " + c.label); }

function camTile(c) {
  // Depth feeds arrive greyscale; colourising them in the browser is free for
  // the robot and makes distance readable at a glance.
  const palette = store.get("cam.depth_palette", "turbo");
  let img;
  if (isDepth(c) && palette !== "nincs") {
    const v = depthView(`/api/cameras/${c.id}/stream`, palette,
                        Math.min(15, store.get("cam.stream_fps", 10)));
    views.push(v);
    img = v.node;
  } else {
    img = el("img", { src: `/api/cameras/${c.id}/stream`, alt: c.label });
  }
  const recBadge = el("span.rec", { text: "● REC", style: { display: c.recording ? "block" : "none" } });
  const tile = el("div.cam", {}, [
    img, recBadge,
    el("div.bar", {}, [
      el("span.nm", { text: c.label }),
      el("button.btn.sm", { text: "📸", title: "Pillanatkép", onclick: () => snap(c.id) }),
      el("button.btn.sm" + (c.recording ? ".danger" : ""), {
        text: c.recording ? "⏹" : "⏺", title: "Felvétel",
        onclick: async (e) => {
          e.stopPropagation();
          await api.post(`/api/cameras/${c.id}/record`, { on: !c.recording });
          await load();
        },
      }),
      el("button.btn.sm", { text: "⤢", title: "Teljes nézet", onclick: () => openFull(c) }),
    ]),
  ]);
  return tile;
}

function openFull(c) {
  modal(c.label,
    el("img", { src: `/api/cameras/${c.id}/stream`, style: { width: "100%", borderRadius: "6px", background: "#000" } }),
    [el("button.btn", { text: "Bezár", onclick: closeModal })]);
}

async function snap(camId) {
  try {
    await api.post("/api/settings", { "sensor.photo_cam": camId });
    const r = await api.post("/api/capture/photo");
    toast(`Pillanatkép mentve (${r.id})`);
  } catch (e) { toast(e.message, "warn"); }
}

async function snapAll() {
  for (const c of cams.filter((x) => enabled.has(x.id))) await snap(c.id);
}

async function recordAll(on) {
  for (const c of cams.filter((x) => enabled.has(x.id))) {
    await api.post(`/api/cameras/${c.id}/record`, { on });
  }
  await load();
  toast(on ? "Felvétel indítva minden megjelenített kamerán" : "Felvétel leállítva");
}
