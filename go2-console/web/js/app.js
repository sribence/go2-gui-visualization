/* Console shell: rail, module router, live socket, header, inspector.
 *
 * The inspector is generated from the backend's parameter registry, so a new
 * tunable appears in the UI without any frontend change. That is the fix for
 * the previous console's central weakness: capabilities existed but had no
 * operator-reachable settings.
 */
const V = window.__V || "";
const { api, el, $, clear, toast, store, fmt } = await import("./core.js" + V);

// Loaded dynamically so the asset version can be appended -- static imports
// cannot be versioned, and a cached stale module is a silent, confusing bug.
const MODULE_FILES = [
  "overview", "health", "perception", "live3d", "map", "manual", "cameras", "sensors",
  "missions", "audio", "blackbox", "remote", "settings",
];
const MODULES = (await Promise.all(
  MODULE_FILES.map((f) => import(`./modules/${f}.js${V}`))
)).map((m) => m.default);

let active = null;

// ---------------------------------------------------------------------------
// Rail + routing
// ---------------------------------------------------------------------------
function buildRail() {
  const rail = clear($("#rail"));
  const ws = clear($("#workspace"));
  for (const m of MODULES) {
    rail.appendChild(el("div.rail-item", {
      id: `rail-${m.id}`, title: m.title,
      onclick: () => activate(m.id),
    }, [
      el("span.ico", { text: m.icon }),
      el("span.lbl", { text: m.short }),
    ]));

    const node = el("section.module", { id: `mod-${m.id}` }, [
      el("div.mod-head", {}, [
        el("h1", { text: m.title }),
        el("span.sub", { id: `sub-${m.id}`, text: m.subtitle || "" }),
        el("span.spacer"),
        el("div.row.tight", { id: `tools-${m.id}` }),
      ]),
      el("div.mod-body" + (m.flush ? ".flush" : ""), { id: `body-${m.id}` }),
    ]);
    ws.appendChild(node);
  }
}

function activate(id) {
  const m = MODULES.find((x) => x.id === id);
  if (!m || active === id) return;
  if (active) {
    const prev = MODULES.find((x) => x.id === active);
    prev?.onLeave?.();
    $(`#mod-${active}`)?.classList.remove("active");
    $(`#rail-${active}`)?.classList.remove("active");
  }
  active = id;
  $(`#mod-${id}`).classList.add("active");
  $(`#rail-${id}`).classList.add("active");
  if (!m._mounted) {
    m.mount({ body: $(`#body-${id}`), tools: $(`#tools-${id}`), sub: $(`#sub-${id}`) });
    m._mounted = true;
  }
  m.onEnter?.();
  renderInspector(m);
  location.hash = id;
}

// ---------------------------------------------------------------------------
// Inspector -- generated from the parameter registry
// ---------------------------------------------------------------------------
function paramControl(p) {
  const cur = store.settings[p.key] ?? p.default;
  const wrap = el("div.param" + (p.danger ? ".danger" : ""));
  const row = el("div.prow");
  const name = el("span.name", { text: p.label, title: p.label });
  row.appendChild(name);

  const commit = async (v, echo) => {
    try {
      const res = await api.post("/api/settings", { [p.key]: v });
      if (res.errors && res.errors[p.key]) { toast(res.errors[p.key], "warn"); return; }
      store.settings = res.values;
      echo?.(res.values[p.key]);
    } catch (e) { toast(`Nem sikerült menteni: ${e.message}`, "error"); }
  };

  if (p.kind === "slider" || p.kind === "number") {
    const step = p.step ?? 0.01;
    // The number box is not a read-out: a slider cannot hit 0.15 reliably on
    // a 300px panel, and some of these want an exact value typed in.
    const num = el("input.num", {
      type: "number", value: numText(p, cur),
      min: p.min, max: p.max, step,
    });
    const rng = p.kind === "slider" ? el("input", {
      type: "range", min: p.min, max: p.max, step, value: cur,
      oninput: (e) => { num.value = numText(p, e.target.value); },
      onchange: (e) => commit(parseFloat(e.target.value), (v) => { num.value = numText(p, v); }),
    }) : el("span");
    num.onchange = (e) => {
      let v = parseFloat(e.target.value);
      if (!isFinite(v)) { num.value = numText(p, cur); return; }
      if (p.min != null) v = Math.max(p.min, v);
      if (p.max != null) v = Math.min(p.max, v);
      commit(v, (nv) => { num.value = numText(p, nv); if (rng.tagName === "INPUT") rng.value = nv; });
    };
    row.append(rng, num, el("span.unit", { text: p.unit || "" }));
  } else if (p.kind === "toggle") {
    const cb = el("input", { type: "checkbox", onchange: (e) => commit(e.target.checked) });
    cb.checked = !!cur;
    row.classList.add("wide");
    row.append(el("span"), el("label.switch", {}, [cb, el("span.sl")]));
  } else if (p.kind === "select") {
    const sel = el("select", { onchange: (e) => commit(castOption(p, e.target.value)) },
      (p.options || []).map((o) => el("option", { value: o, text: String(o) })));
    sel.value = String(cur);
    row.classList.add("wide");
    row.appendChild(sel);
  } else {
    const input = el("input", {
      type: "text", value: cur ?? "", onchange: (e) => commit(e.target.value),
    });
    row.classList.add("wide");
    row.appendChild(input);
  }

  wrap.appendChild(row);
  if (p.help) {
    const help = el("div.help", { text: p.help });
    help.hidden = true;
    const qm = el("button.qm", {
      text: "?", title: "Magyarázat",
      onclick: () => { help.hidden = !help.hidden; qm.classList.toggle("on", !help.hidden); },
    });
    row.appendChild(qm);
    wrap.appendChild(help);
  }
  return wrap;
}

function numText(p, v) {
  if (v === null || v === undefined) return "";
  const step = p.step ?? 0.01;
  const dec = step < 1 ? (String(step).split(".")[1]?.length || 2) : 0;
  return Number(v).toFixed(dec);
}

function castOption(p, v) {
  const first = (p.options || [])[0];
  return typeof first === "number" ? parseFloat(v) : v;
}
function renderInspector(m) {
  $("#insp-title").textContent = m.title;
  const body = clear($("#insp-body"));

  // Module-supplied custom inspector section first (if any)
  const custom = m.inspector?.();
  if (custom) body.appendChild(custom);

  const mine = store.schema.params.filter((p) => p.module === m.id);
  if (!mine.length && !custom) {
    body.appendChild(el("div.empty", { text: "Ehhez a modulhoz nincs állítható paraméter." }));
    return;
  }
  const groups = [...new Set(mine.map((p) => p.group))];
  for (const g of groups) {
    const sec = el("div.igroup", {}, [el("h4", { text: g })]);
    for (const p of mine.filter((x) => x.group === g)) sec.appendChild(paramControl(p));
    body.appendChild(sec);
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderHeader(s) {
  const link = s.link || {};
  const dot = $("#link-dot");
  dot.className = "dot " + (link.healthy ? "ok" : "bad");
  $("#link-text").textContent = link.healthy ? "élő" : "nincs kapcsolat";
  $("#link-ms").textContent = link.latency_ms != null ? `${link.latency_ms.toFixed(0)}ms` : "";

  // A missing reading is shown as absent, never as 0 -- a stale link must
  // not read as "flat battery" (the exact failure mode the audit found).
  const pct = s.battery?.percent;
  const known = typeof pct === "number";
  $("#batt-pct").textContent = known ? `${pct.toFixed(0)}%` : "--";
  const bar = $("#batt-bar");
  bar.style.width = known ? `${Math.max(0, Math.min(100, pct))}%` : "0%";
  const low = known && pct <= store.get("bb.batt_low_pct", 20);
  const crit = known && pct <= store.get("bb.batt_crit_pct", 10);
  bar.style.background = crit ? "var(--crit)" : low ? "var(--warn)" : "var(--ok)";
  $("#st-batt").className = "stat" + (crit ? " bad" : low ? " warn" : "");

  const temp = s.max_motor_temp;
  $("#temp-max").textContent = temp != null ? `${temp.toFixed(0)}°C` : "--";
  $("#st-temp").className = "stat" + (temp > store.get("bb.temp_warn_c", 65) ? " warn" : "");

  $("#mode-txt").textContent = s.mode ?? "--";
  $("#nav-txt").textContent = s.nav?.state ?? "--";

  const btn = $("#btn-arm");
  if (s.armed === null || s.armed === undefined) {
    btn.textContent = "ÁLLAPOT ISMERETLEN";
    btn.className = "hbtn";
  } else {
    btn.textContent = s.armed ? "ÉLES — LEZÁR" : "ÉLESÍTÉS";
    btn.className = "hbtn " + (s.armed ? "armed" : "safe");
  }

  // Backend badge: demo and live must never be confusable.
  const badge = $("#brand-mode");
  if (s.backend && badge.dataset.mode !== s.backend) {
    badge.dataset.mode = s.backend;
    badge.textContent = s.backend === "live" ? "ÉLES" : "demó";
    badge.style.color = s.backend === "live" ? "var(--warn)" : "";
    badge.style.fontWeight = s.backend === "live" ? "700" : "";
  }

  // Name the pillar that is down rather than showing an empty panel.
  if (s.pillars) {
    const down = Object.entries(s.pillars).filter(([, ok]) => !ok).map(([n]) => n);
    const chip = $("#st-nav");
    chip.title = down.length ? `nem elérhető: ${down.join(", ")}` : "minden pillér elérhető";
    chip.className = "stat" + (down.length ? " warn" : "");
  }
}

function renderEvents(list) {
  const box = $("#eventlog");
  const filter = $("#ev-filter").value;
  const rank = { info: 0, warn: 1, error: 2 };
  const want = rank[filter] ?? 0;
  clear(box);
  for (const e of list) {
    if (filter !== "all" && (rank[e.level] ?? 0) < want) continue;
    box.appendChild(el("div.ev." + e.level, {}, [
      el("span.t", { text: fmt.time(e.t) }),
      el("span.src", { text: e.source }),
      el("span.m", { text: e.msg }),
    ]));
  }
}

// ---------------------------------------------------------------------------
// Live socket
// ---------------------------------------------------------------------------
let ws = null, wsDelay = 800;

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { wsDelay = 800; };
  ws.onmessage = (ev) => {
    let s; try { s = JSON.parse(ev.data); } catch (e) { return; }
    renderHeader(s);
    if (s.events) renderEvents(s.events);
    store.publish(s);
  };
  ws.onclose = () => {
    $("#link-dot").className = "dot bad";
    $("#link-text").textContent = "újracsatlakozás…";
    setTimeout(connect, wsDelay);
    wsDelay = Math.min(wsDelay * 1.5, 8000);
  };
  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  buildRail();

  try {
    const [schema, values] = await Promise.all([
      api.get("/api/settings/schema"),
      api.get("/api/settings"),
    ]);
    store.schema = schema;
    store.settings = values;
    const sel = $("#profile-sel");
    for (const [k, label] of Object.entries(schema.profiles || {})) {
      sel.appendChild(el("option", { value: k, text: label }));
    }
    sel.onchange = async (e) => {
      if (!e.target.value) return;
      const res = await api.post(`/api/settings/profile/${e.target.value}`);
      store.settings = res.values;
      toast(`Profil alkalmazva: ${schema.profiles[e.target.value]}`);
      e.target.value = "";
      renderInspector(MODULES.find((m) => m.id === active));
    };
    document.documentElement.dataset.theme = values["sys.theme"] || "dark";
  } catch (e) {
    toast(`Beállítások betöltése sikertelen: ${e.message}`, "error");
  }

  // Header actions
  $("#estop").onclick = async () => {
    const b = $("#estop");
    b.classList.add("firing");
    try { await api.post("/api/estop"); toast("VÉSZLEÁLLÍTÁS kiadva", "error"); }
    catch (e) { toast("E-STOP sikertelen: " + e.message, "error"); }
    finally { setTimeout(() => b.classList.remove("firing"), 260); }
  };
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space" || e.key === "Escape") { e.preventDefault(); $("#estop").click(); }
  });
  $("#btn-arm").onclick = async () => {
    const want = !store.state.armed;
    try { await api.post("/api/arm", { armed: want }); }
    catch (e) { toast(e.message, "warn"); }
  };
  $("#btn-insp").onclick = () => document.body.classList.toggle("insp-collapsed");
  $("#btn-foot").onclick = () => {
    document.body.classList.toggle("foot-collapsed");
    $("#btn-foot").textContent = document.body.classList.contains("foot-collapsed") ? "kinyit" : "összecsuk";
  };
  $("#btn-theme").onclick = async () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    await api.post("/api/settings", { "sys.theme": next });
    store.settings["sys.theme"] = next;
  };
  $("#ev-filter").onchange = async () => renderEvents(await api.get("/api/events?limit=120"));

  // Modules ask for an inspector rebuild when their own lists change
  // (waypoints, zones, camera set) rather than reaching into the shell.
  window.addEventListener("refresh-inspector", () => {
    const m = MODULES.find((x) => x.id === active);
    if (m) renderInspector(m);
  });

  connect();
  activate(location.hash.slice(1) || "overview");
}

boot();
