/* Settings: every registered parameter, grouped, searchable, plus profiles. */
const { api, el, clear, store, toast } = await import("../core.js" + (window.__V || ""));

let ui = {}, query = "";

export default {
  id: "settings", icon: "⚙", short: "Beállítás",
  title: "Beállítások", subtitle: "minden rendszerparaméter egy helyen",

  mount({ body, tools }) {
    clear(body);
    ui.body = el("div");
    body.appendChild(ui.body);

    clear(tools);
    ui.search = el("input", { type: "text", placeholder: "keresés…", style: { width: "200px" },
      oninput: (e) => { query = e.target.value.toLowerCase(); render(); } });
    tools.append(
      ui.search,
      el("button.btn", { text: "Exportálás", onclick: exportJson }),
      el("button.btn.danger", { text: "Alaphelyzet", onclick: reset }),
    );
    render();
  },

  onEnter() { render(); },
};

function render() {
  clear(ui.body);

  const profiles = el("div.card", {}, [
    el("h3", { text: "Profilok" }),
    el("div.body", {}, [
      el("div.row", {}, Object.entries(store.schema.profiles || {}).map(([k, label]) =>
        el("button.btn.primary", { text: label, onclick: () => applyProfile(k) }))),
      el("div.help", { style: { marginTop: "9px", fontSize: "11.5px", color: "var(--dim)" },
        text: "Egy profil egyszerre több csúszkát állít át. Élő bemutató és terepi váltás előtt hasznos." }),
    ]),
  ]);
  ui.body.appendChild(profiles);
  ui.body.appendChild(el("div", { style: { height: "12px" } }));

  const byModule = {};
  for (const p of store.schema.params) {
    if (query && !(`${p.label} ${p.key} ${p.group}`.toLowerCase().includes(query))) continue;
    (byModule[p.module] ||= []).push(p);
  }
  const labels = {
    manual: "Kézi irányítás", map: "Térkép és navigáció", cameras: "Kamerák",
    sensors: "Szenzorok", missions: "Küldetések", audio: "Hang",
    blackbox: "Feketedoboz", remote: "Távoli elérés", settings: "Rendszer",
  };

  const grid = el("div.grid.g2");
  for (const [mod, params] of Object.entries(byModule)) {
    const card = el("div.card.pad0", {}, [el("h3", { text: labels[mod] || mod })]);
    const tbl = el("table");
    const tb = el("tbody");
    for (const p of params) {
      const cur = store.settings[p.key] ?? p.default;
      tb.appendChild(el("tr", {}, [
        el("td", {}, [
          el("div", { text: (p.danger ? "⚠ " : "") + p.label }),
          el("div.trend", { text: `${p.key} · ${p.group}` }),
        ]),
        el("td", { style: { width: "148px" } }, [control(p, cur)]),
      ]));
    }
    tbl.appendChild(tb);
    card.appendChild(tbl);
    grid.appendChild(card);
  }
  if (!Object.keys(byModule).length) {
    grid.appendChild(el("div.empty", { text: "Nincs a keresésre illeszkedő paraméter." }));
  }
  ui.body.appendChild(grid);
}

function control(p, cur) {
  const commit = async (v) => {
    const res = await api.post("/api/settings", { [p.key]: v });
    if (res.errors?.[p.key]) { toast(res.errors[p.key], "warn"); return; }
    store.settings = res.values;
  };
  if (p.kind === "toggle") {
    const cb = el("input", { type: "checkbox", onchange: (e) => commit(e.target.checked) });
    cb.checked = !!cur;
    return el("label.switch", {}, [cb, el("span.sl")]);
  }
  if (p.kind === "select") {
    const sel = el("select", { onchange: (e) => commit(typeof p.options[0] === "number" ? parseFloat(e.target.value) : e.target.value) },
      p.options.map((o) => el("option", { value: o, text: String(o) })));
    sel.value = String(cur);
    return sel;
  }
  if (p.kind === "slider" || p.kind === "number") {
    return el("input", { type: "number", value: cur, min: p.min, max: p.max, step: p.step ?? "any",
      onchange: (e) => commit(parseFloat(e.target.value)) });
  }
  return el("input", { type: "text", value: cur ?? "", onchange: (e) => commit(e.target.value) });
}

async function applyProfile(k) {
  const res = await api.post(`/api/settings/profile/${k}`);
  store.settings = res.values;
  toast(`Profil alkalmazva: ${store.schema.profiles[k]}`);
  render();
}

async function reset() {
  const res = await api.post("/api/settings/reset");
  store.settings = res.values;
  toast("Minden paraméter alapértelmezettre állítva", "warn");
  render();
}

function exportJson() {
  const blob = new Blob([JSON.stringify(store.settings, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "go2-console-settings.json";
  a.click();
}
