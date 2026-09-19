/* Audio: sound library, event→sound rules, playback history. */
const { api, el, clear, fmt, toast } = await import("../core.js" + (window.__V || ""));

let ui = {}, data = { sounds: [], rules: [], history: [] };

export default {
  id: "audio", icon: "🔊", short: "Hang",
  title: "Hangesemények", subtitle: "könyvtár és kiváltó szabályok",

  async mount({ body, tools }) {
    clear(body);
    ui.lib = el("div.stack");
    ui.rules = el("div");
    ui.hist = el("div");

    body.append(el("div.grid.g3", {}, [
      el("div.card", {}, [el("h3", { text: "Hangkönyvtár" }), el("div.body", {}, [ui.lib])]),
      el("div.card.pad0", {}, [el("h3", { text: "Kiváltó szabályok" }), el("div.body", {}, [ui.rules])]),
      el("div.card.pad0", {}, [el("h3", { text: "Lejátszási előzmény" }), el("div.body", {}, [ui.hist])]),
    ]));

    clear(tools);
    tools.append(el("button.btn", { text: "⟳ Frissítés", onclick: load }));
    await load();
  },
};

async function load() {
  try { data = await api.get("/api/audio"); render(); }
  catch (e) { toast(e.message, "error"); }
}

function render() {
  clear(ui.lib);
  for (const s of data.sounds) {
    ui.lib.appendChild(el("div.row", { style: { justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line)" } }, [
      el("span", {}, [el("div", { text: s.label }), el("div.trend", { text: `${s.id} · ${s.duration_s}s` })]),
      el("button.btn.sm.primary", { text: "▶ Teszt", onclick: () => play(s.id) }),
    ]));
  }

  clear(ui.rules);
  const tbl = el("table", {}, [el("thead", {}, [el("tr", {}, [
    el("th", { text: "Esemény" }), el("th", { text: "Hang" }), el("th", { text: "Aktív" })])])]);
  const tb = el("tbody");
  for (const r of data.rules) {
    const sel = el("select", { onchange: (e) => setRule(r.id, { sound: e.target.value }) },
      data.sounds.map((s) => el("option", { value: s.id, text: s.label })));
    sel.value = r.sound;
    const cb = el("input", { type: "checkbox", onchange: (e) => setRule(r.id, { enabled: e.target.checked }) });
    cb.checked = r.enabled;
    tb.appendChild(el("tr", {}, [
      el("td", {}, [el("div", { text: r.event.split(":")[0] }),
        r.event.includes(":") ? el("div.trend", { text: r.event.split(":")[1] }) : null]),
      el("td", {}, [sel]),
      el("td", {}, [el("label.switch", {}, [cb, el("span.sl")])]),
    ]));
  }
  tbl.appendChild(tb);
  ui.rules.appendChild(tbl);

  clear(ui.hist);
  if (!data.history.length) {
    ui.hist.appendChild(el("div.empty", { text: "Még nem szólt hang." }));
  } else {
    for (const h of data.history) {
      ui.hist.appendChild(el("div.row", { style: { justifyContent: "space-between", padding: "5px 10px", borderBottom: "1px solid var(--line)" } }, [
        el("span", { text: h.label }),
        el("span.trend", { text: fmt.time(h.t) }),
      ]));
    }
  }
}

async function play(id) {
  try { await api.post(`/api/audio/play/${id}`); toast("Lejátszva: " + id); await load(); }
  catch (e) { toast(e.message, "warn"); }
}

async function setRule(id, patch) {
  try { await api.post(`/api/audio/rule/${id}`, patch); await load(); }
  catch (e) { toast(e.message, "warn"); }
}
