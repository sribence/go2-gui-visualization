/* Remote: Tailscale status and off-robot log shipping. */
const { api, el, clear, fmt, toast, store } = await import("../core.js" + (window.__V || ""));

let ui = {}, data = {};

export default {
  id: "remote", icon: "🌐", short: "Távoli",
  title: "Távoli elérés", subtitle: "Tailscale és log-továbbítás",

  async mount({ body, tools }) {
    clear(body);
    ui.ts = el("div");
    ui.ship = el("div");
    ui.access = el("div");

    body.append(el("div.grid.g3", {}, [
      el("div.card", {}, [el("h3", { text: "Tailscale" }), el("div.body", {}, [ui.ts])]),
      el("div.card", {}, [el("h3", { text: "Log-továbbítás" }), el("div.body", {}, [ui.ship])]),
      el("div.card", {}, [el("h3", { text: "Elérési címek" }), el("div.body", {}, [ui.access])]),
    ]));

    clear(tools);
    tools.append(el("button.btn", { text: "⟳ Frissítés", onclick: load }));
    await load();
  },
};

async function load() {
  try { data = await api.get("/api/remote"); render(); }
  catch (e) { toast(e.message, "error"); }
}

function render() {
  const ts = data.tailscale || {};
  clear(ui.ts);
  ui.ts.append(
    el("div.row", {}, [
      el("span.dot" + (ts.connected ? ".ok" : ".bad")),
      el("strong", { text: ts.connected ? "csatlakoztatva" : "nincs csatlakoztatva" }),
    ]),
    el("div.kv", { style: { marginTop: "8px" } }, [el("span.k", { text: "hostnév" }), el("span.v", { text: ts.hostname || "--" })]),
    el("div.kv", {}, [el("span.k", { text: "tailnet IP" }), el("span.v" + (ts.ip ? "" : ".na"), { text: ts.ip || "nincs" })]),
    el("div.kv", {}, [el("span.k", { text: "címkék" }), el("span.v", { text: (ts.tags || []).join(", ") || "--" })]),
    el("div.help", { style: { marginTop: "10px", fontSize: "11.5px", color: "var(--dim)" },
      text: ts.note || "A csatlakozáshoz érvényes auth-key kell (TS_AUTHKEY), és a Docker-profilt külön kell indítani." }),
    el("div", { style: { height: "10px" } }),
    el("label.field", {}, [el("span", { text: "Auth-key (nem tárolódik a felületen)" }),
      el("input", { type: "text", placeholder: "tskey-..." })]),
    el("button.btn.wide", { text: "Csatlakoztatás", style: { marginTop: "8px" },
      onclick: () => toast("Demó módban a tailnet-csatlakozás nem hajtható végre", "warn") }),
  );

  clear(ui.ship);
  ui.ship.append(
    el("div.kv", {}, [el("span.k", { text: "utolsó küldés" }),
      el("span.v" + (data.last_ship ? "" : ".na"), { text: data.last_ship ? fmt.time(data.last_ship) : "még nem volt" })]),
    el("div.kv", {}, [el("span.k", { text: "küldések száma" }), el("span.v", { text: String(data.ship_count ?? 0) })]),
    el("div.kv", {}, [el("span.k", { text: "gyakoriság" }), el("span.v", { text: fmt.dur(store.get("remote.ship_interval_s", 300)) })]),
    el("div.kv", {}, [el("span.k", { text: "célpont" }),
      el("span.v" + (store.get("remote.ship_endpoint") ? "" : ".na"),
        { text: store.get("remote.ship_endpoint") || "nincs beállítva" })]),
    el("button.btn.primary.wide", { text: "Küldés most", style: { marginTop: "12px" },
      onclick: async () => { await api.post("/api/remote/ship"); toast("Összegzés elküldve"); await load(); } }),
    el("div.help", { style: { marginTop: "10px", fontSize: "11.5px", color: "var(--dim)" },
      text: "Célpont nélkül csak naplózza, mit küldött volna — így a teljes lánc tesztelhető külső infrastruktúra nélkül." }),
  );

  const host = location.host;
  clear(ui.access);
  ui.access.append(
    el("div.kv", {}, [el("span.k", { text: "ez a konzol" }), el("span.v", { text: `http://${host}/` })]),
    el("div.kv", {}, [el("span.k", { text: "API" }), el("span.v", { text: `http://${host}/api/` })]),
    el("div.kv", {}, [el("span.k", { text: "élő socket" }), el("span.v", { text: `ws://${host}/ws` })]),
    el("div.help", { style: { marginTop: "10px", fontSize: "11.5px", color: "var(--dim)" },
      text: "Telefonról ugyanezen a WiFi-n a gép LAN-címével érhető el. Az indító script kiírja a pontos URL-t." }),
  );
}
