/* Missions: visual step-chain editor + live execution monitor.
 *
 * This is the module the previous console was missing entirely: the task
 * engine could already chain "drive there, call another system's API, wait
 * for its answer, then continue", but there was no way to author or watch
 * one without curl.
 */
const { api, el, clear, fmt, toast, store, guardedMotion, modal, closeModal } = await import("../core.js" + (window.__V || ""));

let ui = {}, stepTypes = [], missions = [], draft = [], draftName = "", selected = null, poll = null;

export default {
  id: "missions", icon: "✅", short: "Küldetés",
  title: "Küldetések", subtitle: "lépéslánc szerkesztése és futtatása",

  async mount({ body, tools }) {
    clear(body);
    stepTypes = await api.get("/api/missions/step_types");

    // ---- editor ----
    ui.steps = el("div.stack");
    ui.addRow = el("div.row");
    for (const st of stepTypes) {
      ui.addRow.appendChild(el("button.btn.sm", { text: "+ " + st.label, onclick: () => addStep(st.type) }));
    }
    ui.name = el("input", { type: "text", placeholder: "Küldetés neve", value: "",
      onchange: (e) => { draftName = e.target.value; } });

    const editor = el("div.card", {}, [
      el("h3", {}, [
        el("span", { text: "Szerkesztő" }),
        el("span.row.tight", {}, [
          el("button.btn.sm", { text: "Sablon: őrjárat", onclick: () => loadTemplate("patrol") }),
          el("button.btn.sm", { text: "Sablon: API-lánc", onclick: () => loadTemplate("api") }),
          el("button.btn.sm", { text: "Ürítés", onclick: () => { draft = []; renderSteps(); } }),
        ]),
      ]),
      el("div.body", {}, [
        el("label.field", {}, [el("span", { text: "Név" }), ui.name]),
        el("div", { style: { height: "10px" } }),
        ui.steps,
        el("div", { style: { height: "10px" } }),
        ui.addRow,
        el("div", { style: { height: "12px" } }),
        el("div.row", {}, [
          el("button.btn.primary", { text: "💾 Mentés", onclick: save }),
          el("button.btn.ok", { text: "▶ Mentés és indítás", onclick: saveAndRun }),
        ]),
      ]),
    ]);

    // ---- list + monitor ----
    ui.list = el("div");
    ui.monitor = el("div");
    const listCard = el("div.card.pad0", {}, [
      el("h3", {}, [el("span", { text: "Küldetések" }), el("button.btn.sm", { text: "⟳", onclick: load })]),
      el("div.body", {}, [ui.list]),
    ]);
    const monCard = el("div.card", {}, [
      el("h3", { text: "Végrehajtás" }),
      el("div.body", {}, [ui.monitor]),
    ]);

    body.append(el("div.grid.g2", {}, [editor, el("div.stack", {}, [listCard, monCard])]));

    clear(tools);
    tools.append(
      el("span.pill", { id: "mi-count", text: "0" }),
      el("button.btn", { text: "Protokoll-végpontok", onclick: showEndpoints }),
    );

    renderSteps();
    await load();
  },

  onEnter() { poll = setInterval(load, 1500); },
  onLeave() { clearInterval(poll); poll = null; },
};

// ---------------------------------------------------------------------------
function addStep(type) {
  const st = stepTypes.find((s) => s.type === type);
  const step = { type };
  for (const f of st.fields) step[f.key] = f.kind === "number" ? 0 : (f.options ? f.options[0] : "");
  if (type === "goto" && store.state.pose) { step.x = +store.state.pose.x.toFixed(2); step.y = +store.state.pose.y.toFixed(2); }
  draft.push(step);
  renderSteps();
}

function renderSteps() {
  clear(ui.steps);
  if (!draft.length) {
    ui.steps.appendChild(el("div.empty", { text: "Adj hozzá lépéseket lent. A lépések sorban futnak; az API-hívás megvárja a választ." }));
    return;
  }
  draft.forEach((step, i) => {
    const st = stepTypes.find((s) => s.type === step.type);
    const fields = el("div.stack", { style: { marginTop: "8px" } });
    for (const f of st.fields) {
      let input;
      if (f.kind === "select") {
        input = el("select", { onchange: (e) => { step[f.key] = e.target.value; } },
          f.options.map((o) => el("option", { value: o, text: o })));
        input.value = step[f.key];
      } else if (f.kind === "textarea") {
        input = el("textarea", { onchange: (e) => { step[f.key] = e.target.value; }, text: step[f.key] ?? "" });
      } else {
        input = el("input", { type: f.kind === "number" ? "number" : "text", step: "any",
          value: step[f.key] ?? "",
          onchange: (e) => { step[f.key] = f.kind === "number" ? parseFloat(e.target.value) : e.target.value; } });
      }
      fields.appendChild(el("label.field", {}, [el("span", { text: f.label }), input]));
    }

    ui.steps.appendChild(el("div.card", { style: { background: "var(--panel-2)" } }, [
      el("h3", {}, [
        el("span", { text: `${i + 1}. ${st.label}` }),
        el("span.row.tight", {}, [
          el("button.btn.sm", { text: "↑", onclick: () => move(i, -1) }),
          el("button.btn.sm", { text: "↓", onclick: () => move(i, 1) }),
          el("button.btn.sm.danger", { text: "×", onclick: () => { draft.splice(i, 1); renderSteps(); } }),
        ]),
      ]),
      el("div.body", { style: { paddingTop: "4px" } }, [fields]),
    ]));
  });
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= draft.length) return;
  [draft[i], draft[j]] = [draft[j], draft[i]];
  renderSteps();
}

function loadTemplate(kind) {
  if (kind === "patrol") {
    draft = [
      { type: "goto", x: -3.0, y: 3.0 },
      { type: "sensor", kind: "photo" },
      { type: "goto", x: 3.0, y: -3.0 },
      { type: "sensor", kind: "lidar_scan" },
      { type: "play_sound", sound: "task_complete" },
      { type: "goto", x: 0, y: 0 },
    ];
    draftName = "Őrjárat kör";
  } else {
    draft = [
      { type: "goto", x: 2.0, y: 1.0 },
      { type: "call_api", url: "https://example.org/api/pickup", method: "POST",
        body: '{"station": "A1"}', wait_for: "response" },
      { type: "wait", seconds: 2 },
      { type: "mqtt_publish", topic: "missioncontrol/handoff", payload: '{"status":"arrived"}' },
      { type: "play_sound", sound: "task_complete" },
    ];
    draftName = "Átadás másik rendszernek";
  }
  ui.name.value = draftName;
  renderSteps();
}

async function save() {
  if (!draft.length) { toast("Adj hozzá legalább egy lépést", "warn"); return null; }
  try {
    const m = await api.post("/api/missions", { name: ui.name.value || draftName, steps: draft });
    toast(`Küldetés mentve: ${m.name}`);
    await load();
    return m;
  } catch (e) { toast(e.message, "error"); return null; }
}

async function saveAndRun() {
  const m = await save();
  if (!m) return;
  const hasMotion = draft.some((s) => s.type === "goto");
  const run = async () => {
    await api.post(`/api/missions/${m.id}/run`);
    selected = m.id;
    toast("Küldetés elindítva");
  };
  if (hasMotion) {
    guardedMotion("Küldetés indítása",
      `„${m.name}" — ${draft.length} lépés, ebből ${draft.filter((s) => s.type === "goto").length} mozgással jár. A robot azonnal elindul.`,
      run);
  } else run();
}

async function load() {
  try { missions = await api.get("/api/missions"); } catch (e) { return; }
  const c = document.getElementById("mi-count");
  if (c) c.textContent = `${missions.length} küldetés`;
  renderList();
  renderMonitor();
}

function statusPill(s) {
  const cls = { succeeded: "ok", failed: "bad", running: "run", cancelled: "warn" }[s] || "";
  return el("span.pill." + cls, { text: s });
}

function renderList() {
  clear(ui.list);
  if (!missions.length) {
    ui.list.appendChild(el("div.empty", { text: "Nincs mentett küldetés." }));
    return;
  }
  const tbl = el("table", {}, [
    el("thead", {}, [el("tr", {}, [
      el("th", { text: "Név" }), el("th", { text: "Lépés" }),
      el("th", { text: "Állapot" }), el("th", { text: "" })])]),
  ]);
  const tb = el("tbody");
  for (const m of missions) {
    tb.appendChild(el("tr" + (selected === m.id ? ".sel" : ""), { onclick: () => { selected = m.id; renderList(); renderMonitor(); } }, [
      el("td", { text: m.name }),
      el("td", { text: String(m.steps.length) }),
      el("td", {}, [statusPill(m.status)]),
      el("td", {}, [el("div.row.tight", {}, [
        el("button.btn.sm.ok", { text: "▶", title: "Futtatás",
          onclick: (e) => { e.stopPropagation(); runMission(m); } }),
        el("button.btn.sm", { text: "⏹", title: "Megszakítás",
          onclick: (e) => { e.stopPropagation(); api.post(`/api/missions/${m.id}/cancel`); } }),
        el("button.btn.sm.danger", { text: "×", title: "Törlés",
          onclick: (e) => { e.stopPropagation(); api.del(`/api/missions/${m.id}`).then(load); } }),
      ])]),
    ]));
  }
  tbl.appendChild(tb);
  ui.list.appendChild(tbl);
}

function runMission(m) {
  const motion = m.steps.filter((s) => s.type === "goto").length;
  const go = () => api.post(`/api/missions/${m.id}/run`).then(() => { selected = m.id; toast("Elindítva"); });
  if (motion) {
    guardedMotion("Küldetés indítása",
      `„${m.name}" — ${m.steps.length} lépés, ${motion} mozgással. A robot azonnal elindul.`, go);
  } else go();
}

function renderMonitor() {
  clear(ui.monitor);
  const m = missions.find((x) => x.id === selected) || missions.find((x) => x.status === "running");
  if (!m) {
    ui.monitor.appendChild(el("div.empty", { text: "Válassz egy küldetést a listából." }));
    return;
  }
  ui.monitor.appendChild(el("div.row", { style: { marginBottom: "10px" } }, [
    el("strong", { text: m.name }), statusPill(m.status),
    el("span.trend", { text: fmt.time(m.created_at) }),
  ]));
  m.steps.forEach((step, i) => {
    const r = m.results[i] || {};
    const icon = { succeeded: "✔", failed: "✖", running: "◐", pending: "○" }[r.status] || "○";
    const col = { succeeded: "var(--ok)", failed: "var(--crit)", running: "var(--accent)" }[r.status] || "var(--dim)";
    ui.monitor.appendChild(el("div.row", { style: { padding: "5px 0", borderBottom: "1px solid var(--line)" } }, [
      el("span", { text: icon, style: { color: col, width: "16px" } }),
      el("span", { text: `${i + 1}. ${step.type}`, style: { minWidth: "128px" } }),
      el("span.trend", { text: r.detail || describe(step) }),
    ]));
  });
}

function describe(step) {
  switch (step.type) {
    case "goto": return `→ ${step.x}, ${step.y}`;
    case "call_api": return `${step.method} ${step.url} · vár: ${step.wait_for}`;
    case "sensor": return step.kind;
    case "play_sound": return step.sound;
    case "wait": return `${step.seconds} mp`;
    case "mqtt_publish": return step.topic;
    case "ws_send": return step.url;
    default: return "";
  }
}

function showEndpoints() {
  const host = location.host;
  const body = el("div.stack", {}, [
    el("div", { text: "Ezeken a csatornákon lehet küldetést beküldeni külső rendszerből:" }),
    el("label.field", {}, [el("span", { text: "REST" }),
      el("textarea", { text: `POST http://${host}/api/missions\nContent-Type: application/json\n\n{"name":"külső","steps":[{"type":"goto","x":1,"y":1}]}` })]),
    el("label.field", {}, [el("span", { text: "MQTT" }),
      el("textarea", { text: `topic: ${store.get("mission.mqtt_submit_topic", "missioncontrol/task/submit")}\npayload: {"steps":[{"type":"goto","x":1,"y":1}]}\n\nesemények: ${store.get("mission.mqtt_events_topic", "missioncontrol/task/events")}` })]),
    el("label.field", {}, [el("span", { text: "WebSocket" }),
      el("textarea", { text: `ws://${host}/ws  (állapot-adás)\nA beküldő WS a mission-control orchestration pillérén: ws://<host>:9104/ws` })]),
  ]);
  modal("Protokoll-végpontok", body, [el("button.btn", { text: "Bezár", onclick: closeModal })]);
}
