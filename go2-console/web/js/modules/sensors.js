/* Sensors: on-demand capture commands and the resulting gallery. */
const { api, el, clear, fmt, toast, modal, closeModal } = await import("../core.js" + (window.__V || ""));

let ui = {}, items = [], filter = "all";

const KINDS = [
  ["photo", "📷 Fotó", "Egy képkocka a kiválasztott kameráról."],
  ["lidar_scan", "📡 LiDAR pillanatfelvétel", "Sűrű pontfelhő mentése JSON-be."],
  ["thermal", "🌡 Hőkamera", "Hőkép rögzítése (demóban szintetikus)."],
];

export default {
  id: "sensors", icon: "📡", short: "Szenzorok",
  title: "Szenzorok", subtitle: "egyszeri parancsok és felvétel-galéria",

  async mount({ body, tools }) {
    clear(body);

    const cmdRow = el("div.row");
    for (const [kind, label, help] of KINDS) {
      cmdRow.appendChild(el("button.btn.primary", { text: label, title: help, onclick: () => capture(kind) }));
    }
    cmdRow.appendChild(el("button.btn", { text: "⟳ Frissítés", onclick: load }));

    ui.gallery = el("div.grid.g4");
    ui.count = el("span.pill", { text: "0 elem" });

    body.append(
      el("div.card", {}, [
        el("h3", { text: "Parancsok" }),
        el("div.body", {}, [
          cmdRow,
          el("div.help", {
            style: { marginTop: "9px", fontSize: "11.5px", color: "var(--dim)" },
            text: "A hőkamera valós hardver nélkül 501-et adna vissza az éles rendszeren; itt szintetikus képet kapsz, hogy a munkafolyamat végigjárható legyen.",
          }),
        ]),
      ]),
      el("div", { style: { height: "12px" } }),
      el("div.card", {}, [
        el("h3", {}, [el("span", { text: "Felvételek" }), ui.count]),
        el("div.body", {}, [ui.gallery]),
      ]),
    );

    clear(tools);
    ui.filter = el("select", { style: { width: "auto" }, onchange: (e) => { filter = e.target.value; render(); } }, [
      el("option", { value: "all", text: "mind" }),
      el("option", { value: "photo", text: "fotó" }),
      el("option", { value: "lidar_scan", text: "lidar" }),
      el("option", { value: "thermal", text: "hő" }),
    ]);
    tools.append(ui.filter);

    await load();
  },
};

async function load() {
  try { items = await api.get("/api/captures"); render(); }
  catch (e) { toast(e.message, "error"); }
}

async function capture(kind) {
  try {
    const r = await api.post(`/api/capture/${kind}`);
    toast(`${kind} rögzítve`);
    items.unshift(r);
    render();
  } catch (e) { toast(e.message, "warn"); }
}

function render() {
  clear(ui.gallery);
  const show = items.filter((i) => filter === "all" || i.kind === filter);
  ui.count.textContent = `${show.length} elem`;
  if (!show.length) {
    ui.gallery.appendChild(el("div.empty", { text: "Még nincs felvétel. Adj ki egy parancsot fent." }));
    return;
  }
  for (const it of show) {
    const isImg = it.kind !== "lidar_scan";
    const thumb = isImg
      ? el("img", { src: it.url, style: { width: "100%", display: "block", borderRadius: "5px 5px 0 0", cursor: "zoom-in" },
          onclick: () => modal(`${it.kind} — ${fmt.time(it.t)}`,
            el("img", { src: it.url, style: { width: "100%", borderRadius: "6px" } }),
            [el("button.btn", { text: "Bezár", onclick: closeModal })]) })
      : el("div", { style: { height: "104px", display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--bg)", borderRadius: "5px 5px 0 0", fontSize: "26px" }, text: "📡" });

    ui.gallery.appendChild(el("div.card.pad0", {}, [
      thumb,
      el("div.body", { style: { padding: "8px 10px" } }, [
        el("div.kv", {}, [el("span.k", { text: it.kind }), el("span.v", { text: fmt.time(it.t) })]),
        it.point_count
          ? el("div.kv", {}, [el("span.k", { text: "pont" }), el("span.v", { text: String(it.point_count) })])
          : el("div.kv", {}, [el("span.k", { text: "méret" }), el("span.v", { text: `${((it.bytes || 0) / 1024).toFixed(0)} kB` })]),
      ]),
    ]));
  }
}
