/* Blackbox: buffer health, incident list, and a scrubable incident replay. */
const { api, el, clear, fmt, toast, store } = await import("../core.js" + (window.__V || ""));

let ui = {}, data = { status: {}, incidents: [] }, timeline = null, cursor = 0, poll = null;

export default {
  id: "blackbox", icon: "⬛", short: "Feketedoboz",
  title: "Feketedoboz", subtitle: "gördülő puffer és incidens-visszajátszás",

  async mount({ body, tools }) {
    clear(body);
    ui.status = el("div");
    ui.list = el("div");
    ui.replay = el("div");

    body.append(
      el("div.grid.g4", {}, [
        el("div.card", {}, [el("h3", { text: "Puffer" }), el("div.body", {}, [ui.status])]),
      ]),
      el("div", { style: { height: "12px" } }),
      el("div.grid.g2", {}, [
        el("div.card.pad0", {}, [
          el("h3", {}, [el("span", { text: "Incidensek" }),
            el("button.btn.sm.danger", { text: "+ Rögzítés most", onclick: trigger })]),
          el("div.body", {}, [ui.list]),
        ]),
        el("div.card", {}, [el("h3", { text: "Visszajátszás" }), el("div.body", {}, [ui.replay])]),
      ]),
    );

    clear(tools);
    tools.append(el("button.btn", { text: "⟳ Frissítés", onclick: load }));
    await load();
  },

  onEnter() { poll = setInterval(load, 4000); },
  onLeave() { clearInterval(poll); poll = null; },
};

async function load() {
  try { data = await api.get("/api/blackbox"); render(); }
  catch (e) { /* keep last */ }
}

function render() {
  const s = data.status || {};
  const maxMb = store.get("bb.max_mb", 200);
  const pct = Math.min(100, ((s.total_mb || 0) / maxMb) * 100);
  clear(ui.status);
  ui.status.append(
    el("div.big", {}, [document.createTextNode(fmt.n(s.total_mb, 1)), el("span.u", { text: `MB / ${maxMb} MB` })]),
    el("div.meter", { style: { width: "100%", marginTop: "6px" } }, [
      el("i", { style: { width: `${pct}%`, background: pct > 85 ? "var(--warn)" : "var(--ok)" } })]),
    el("div.kv", { style: { marginTop: "8px" } }, [el("span.k", { text: "képkockák" }), el("span.v", { text: String(s.frame_count ?? "--") })]),
    el("div.kv", {}, [el("span.k", { text: "incidensek" }), el("span.v", { text: String(s.incident_count ?? 0) })]),
    el("div.kv", {}, [el("span.k", { text: "megőrzés" }), el("span.v", { text: fmt.dur(store.get("bb.retention_s", 600)) })]),
    el("div.kv", {}, [el("span.k", { text: "legrégebbi" }), el("span.v", { text: s.oldest_ts ? fmt.time(s.oldest_ts) : "--" })]),
  );

  clear(ui.list);
  if (!data.incidents.length) {
    ui.list.appendChild(el("div.empty", { text: "Nincs rögzített incidens." }));
    return;
  }
  const tbl = el("table", {}, [el("thead", {}, [el("tr", {}, [
    el("th", { text: "Idő" }), el("th", { text: "Ok" }),
    el("th", { text: "Akku" }), el("th", { text: "" })])])]);
  const tb = el("tbody");
  for (const inc of data.incidents) {
    tb.appendChild(el("tr", {}, [
      el("td", { text: fmt.time(inc.created_at) }),
      el("td", { text: inc.reason }),
      el("td", { text: `${fmt.n(inc.battery, 0)}%` }),
      el("td", {}, [el("button.btn.sm", { text: "Visszajátszás", onclick: () => openReplay(inc.id) })]),
    ]));
  }
  tbl.appendChild(tb);
  ui.list.appendChild(tbl);
}

async function trigger() {
  try { await api.post("/api/blackbox/trigger", { reason: "operator_marked" }); toast("Incidens rögzítve"); await load(); }
  catch (e) { toast(e.message, "warn"); }
}

async function openReplay(id) {
  try { timeline = await api.get(`/api/blackbox/${id}/timeline`); cursor = timeline.samples.length - 1; renderReplay(); }
  catch (e) { toast(e.message, "warn"); }
}

function renderReplay() {
  clear(ui.replay);
  if (!timeline) {
    ui.replay.appendChild(el("div.empty", { text: "Válassz egy incidenst a visszajátszáshoz. A csúszkával időben léptethetsz." }));
    return;
  }
  const s = timeline.samples[cursor];
  const chart = el("canvas", { width: 620, height: 130, style: { width: "100%", background: "var(--bg)", borderRadius: "6px" } });

  ui.replay.append(
    el("div.row", { style: { marginBottom: "8px" } }, [
      el("strong", { text: timeline.incident.reason }),
      el("span.trend", { text: fmt.time(timeline.incident.created_at) }),
    ]),
    chart,
    el("input", { type: "range", min: 0, max: timeline.samples.length - 1, value: cursor,
      oninput: (e) => { cursor = +e.target.value; renderReplay(); } }),
    el("div.grid.g3", { style: { marginTop: "6px" } }, [
      kv("idő", fmt.time(s.t)),
      kv("akku", `${fmt.n(s.battery, 1)} %`),
      kv("accel z", `${fmt.n(s.accel_z, 2)} m/s²`),
      kv("x", fmt.n(s.x)),
      kv("y", fmt.n(s.y)),
      kv("minta", `${cursor + 1}/${timeline.samples.length}`),
    ]),
    el("div.row", { style: { marginTop: "10px", gap: "6px", overflowX: "auto" } },
      timeline.frames.map((f) => el("img", {
        src: f.url, style: { height: "68px", borderRadius: "4px", border: "1px solid var(--line)" },
      }))),
  );

  const ctx = chart.getContext("2d");
  ctx.clearRect(0, 0, chart.width, chart.height);
  const series = [["accel_z", "#ffb84d", 6, 14], ["battery", "#4db8ff", 0, 100]];
  for (const [k, col, lo, hi] of series) {
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
    timeline.samples.forEach((p, i) => {
      const x = (i / (timeline.samples.length - 1)) * chart.width;
      const y = chart.height - ((p[k] - lo) / (hi - lo)) * chart.height;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  const cx = (cursor / (timeline.samples.length - 1)) * chart.width;
  ctx.strokeStyle = "#fff"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, chart.height); ctx.stroke();
  ctx.setLineDash([]);
}

function kv(k, v) {
  return el("div.kv", {}, [el("span.k", { text: k }), el("span.v", { text: String(v) })]);
}
