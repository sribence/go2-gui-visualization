/* Health: Comprehensive system health checker UI module.
 * Inspects Docker containers, microservices, DDS telemetry, hardware, and diagnostic tips.
 */
const { api, el, clear, fmt, toast } = await import("../core.js" + (window.__V || ""));

let timer = null;
let autoRefresh = true;
let lastData = null;
let ui = {};

export default {
  id: "health",
  icon: "🛡",
  short: "Egészség",
  title: "Rendszer-egészség",
  subtitle: "konténerek, mikroszolgáltatások, DDS és hardver részletes ellenőrzése",

  async mount({ body, tools }) {
    clear(body);
    clear(tools);

    // Tools bar (top right)
    ui.btnAuto = el("button.btn", {
      text: "⏱ Auto-frissítés: BE",
      onclick: () => toggleAutoRefresh()
    });
    ui.btnRefresh = el("button.btn.primary", {
      text: "⟳ Frissítés most",
      onclick: () => fetchHealth()
    });
    ui.btnCopy = el("button.btn", {
      text: "📋 Jelentés másolása",
      onclick: () => copyReport()
    });

    tools.append(ui.btnAuto, ui.btnRefresh, ui.btnCopy);

    // Main layout nodes
    ui.banner = el("div.card", { style: { marginBottom: "12px" } });
    ui.containersCard = el("div.card", { style: { marginBottom: "12px" } });
    ui.servicesCard = el("div.card", { style: { marginBottom: "12px" } });
    ui.hardwareCard = el("div.card", { style: { marginBottom: "12px" } });
    ui.diagCard = el("div.card");

    body.append(
      ui.banner,
      ui.containersCard,
      el("div.grid.g2", { style: { gap: "12px" } }, [
        ui.servicesCard,
        ui.hardwareCard
      ]),
      ui.diagCard
    );

    await fetchHealth();
  },

  onEnter() {
    if (autoRefresh && !timer) {
      timer = setInterval(() => fetchHealth(), 5000);
    }
  },

  onLeave() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
};

function toggleAutoRefresh() {
  autoRefresh = !autoRefresh;
  ui.btnAuto.textContent = autoRefresh ? "⏱ Auto-frissítés: BE" : "⏱ Auto-frissítés: KI";
  ui.btnAuto.className = autoRefresh ? "btn" : "btn dim";
  if (autoRefresh) {
    if (!timer) timer = setInterval(() => fetchHealth(), 5000);
    toast("Auto-frissítés bekapcsolva (5s)");
  } else {
    if (timer) { clearInterval(timer); timer = null; }
    toast("Auto-frissítés kikapcsolva");
  }
}

async function fetchHealth() {
  try {
    const data = await api.get("/api/system/health");
    lastData = data;
    render(data);
  } catch (err) {
    toast(`Egészség-ellenőrzés sikertelen: ${err.message}`, "error");
  }
}

function render(data) {
  renderBanner(data);
  renderContainers(data.containers || []);
  renderServices(data.services || []);
  renderHardware(data.hardware || []);
  renderDiagnostics(data.diagnostics || []);
}

function renderBanner(data) {
  clear(ui.banner);

  const statusMap = {
    "OK": { label: "MINDEN RENDSZER OPERATÍV", class: "green", icon: "🟢", bg: "#0d2818", border: "#1b5e20" },
    "DEGRADED": { label: "DEGRADÁLT MŰKÖDÉS", class: "yellow", icon: "🟡", bg: "#332701", border: "#f57f17" },
    "CRITICAL": { label: "KRITIKUS HIBA", class: "red", icon: "🔴", bg: "#2c0b0e", border: "#b71c1c" },
  };

  const st = statusMap[data.overall_status] || statusMap["DEGRADED"];
  const tStr = new Date((data.timestamp || Date.now() / 1000) * 1000).toLocaleTimeString();

  ui.banner.style.background = st.bg;
  ui.banner.style.border = `1px solid ${st.border}`;

  ui.banner.append(
    el("div.body", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px" } }, [
      el("div.row", { style: { gap: "12px", alignItems: "center" } }, [
        el("span", { style: { fontSize: "24px" }, text: st.icon }),
        el("div", {}, [
          el("div", { style: { fontWeight: "bold", fontSize: "16px", color: "#fff" }, text: st.label }),
          el("div", { style: { fontSize: "12px", color: "var(--dim)", marginTop: "2px" }, text: data.summary || "" })
        ])
      ]),
      el("div", { style: { fontSize: "11px", color: "var(--dim)", textAlign: "right" } }, [
        el("div", { text: `Üzemmód: ${data.mode === "live" ? "Éles (Robot HW)" : "Demó"}` }),
        el("div", { text: `Frissítve: ${tStr}` })
      ])
    ])
  );
}

function renderContainers(list) {
  clear(ui.containersCard);

  const runningCount = list.filter(c => c.ok).length;
  const headerPill = el("span.pill", { text: `${runningCount}/${list.length} fut` });
  if (runningCount === list.length) headerPill.style.color = "#4caf50";
  else headerPill.style.color = "#f44336";

  const grid = el("div.grid.g3", { style: { gap: "8px", marginTop: "8px" } });

  for (const c of list) {
    const isOk = c.ok;
    const item = el("div", {
      style: {
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${isOk ? "rgba(76,175,80,0.3)" : "rgba(244,67,54,0.4)"}`,
        borderRadius: "6px",
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between"
      }
    }, [
      el("div", {}, [
        el("div", { style: { fontWeight: "bold", fontSize: "12px", color: "#eee" }, text: c.label }),
        el("div", { style: { fontSize: "10px", color: "var(--dim)" }, text: c.name })
      ]),
      el("div", { style: { textAlign: "right" } }, [
        el("span.pill", {
          style: {
            background: isOk ? "rgba(76,175,80,0.2)" : "rgba(244,67,54,0.2)",
            color: isOk ? "#81c784" : "#e57373",
            fontSize: "10px",
            fontWeight: "bold"
          },
          text: isOk ? "FUT" : "LEÁLLT"
        }),
        c.restarts > 0 ? el("div", { style: { fontSize: "9px", color: "#ffb74d", marginTop: "2px" }, text: `${c.restarts} újratöltés` }) : el("span")
      ])
    ]);
    grid.append(item);
  }

  ui.containersCard.append(
    el("h3", {}, [el("span", { text: "🐳 Docker Konténerek" }), headerPill]),
    el("div.body", {}, [grid])
  );
}

function renderServices(list) {
  clear(ui.servicesCard);

  const tbody = el("tbody");
  for (const s of list) {
    const isOk = s.ok;
    tbody.append(
      el("tr", {}, [
        el("td", { style: { fontWeight: "bold", padding: "6px 8px" }, text: s.name }),
        el("td", { style: { fontSize: "10px", color: "var(--dim)", padding: "6px 8px" }, text: s.url }),
        el("td", { style: { padding: "6px 8px", textAlign: "center" } }, [
          el("span.pill", {
            style: {
              background: isOk ? "rgba(76,175,80,0.2)" : "rgba(244,67,54,0.2)",
              color: isOk ? "#81c784" : "#e57373",
              fontSize: "10px"
            },
            text: isOk ? `${s.code || 200} OK` : `${s.code || "HIBA"}`
          })
        ]),
        el("td", { style: { fontSize: "11px", textAlign: "right", padding: "6px 8px", color: s.latency_ms > 100 ? "#ffb74d" : "inherit" }, text: s.latency_ms ? `${s.latency_ms} ms` : "--" })
      ])
    );
  }

  const table = el("table", { style: { width: "100%", fontSize: "11px", borderCollapse: "collapse" } }, [
    el("thead", {}, [
      el("tr", { style: { borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" } }, [
        el("th", { style: { padding: "4px 8px" }, text: "Szolgáltatás" }),
        el("th", { style: { padding: "4px 8px" }, text: "Végpont URL" }),
        el("th", { style: { padding: "4px 8px", textAlign: "center" }, text: "Státusz" }),
        el("th", { style: { padding: "4px 8px", textAlign: "right" }, text: "Válaszidő" })
      ])
    ]),
    tbody
  ]);

  ui.servicesCard.append(
    el("h3", { text: "🌐 Mikroszolgáltatások & HTTP Végpontok" }),
    el("div.body", {}, [table])
  );
}

function renderHardware(list) {
  clear(ui.hardwareCard);

  const stack = el("div.stack", { style: { gap: "8px" } });
  for (const h of list) {
    const isOk = h.ok;
    stack.append(
      el("div", {
        style: {
          background: "rgba(255,255,255,0.02)",
          borderLeft: `3px solid ${isOk ? "#4caf50" : "#f44336"}`,
          padding: "8px 12px",
          borderRadius: "0 4px 4px 0"
        }
      }, [
        el("div", { style: { fontWeight: "bold", fontSize: "12px", color: isOk ? "#e8e8e8" : "#ff8a80" }, text: h.name }),
        el("div", { style: { fontSize: "11px", color: "var(--dim)", marginTop: "2px" }, text: h.details })
      ])
    );
  }

  ui.hardwareCard.append(
    el("h3", { text: "🤖 Hardver & DDS Telemetria Kapcsolatok" }),
    el("div.body", {}, [stack])
  );
}

function renderDiagnostics(list) {
  clear(ui.diagCard);

  if (!list || list.length === 0) {
    ui.diagCard.append(
      el("h3", { text: "🛠 Diagnosztika & Hibaelhárítás" }),
      el("div.body", {}, [
        el("div", { style: { color: "#81c784", fontSize: "12px", padding: "8px 0" }, text: "✅ Nincs aktív hiba vagy figyelmeztetés. Minden komponens elvárt módon üzemel." })
      ])
    );
    return;
  }

  const itemsNode = el("div.stack", { style: { gap: "8px" } });
  for (const d of list) {
    itemsNode.append(
      el("div", {
        style: {
          background: "rgba(244,67,54,0.08)",
          border: "1px solid rgba(244,67,54,0.3)",
          borderRadius: "6px",
          padding: "10px 14px",
          fontSize: "12px",
          color: "#ffcdd2"
        },
        text: d
      })
    );
  }

  ui.diagCard.append(
    el("h3", {}, [el("span", { text: "🛠 Diagnosztika & Hibaelhárítás" }), el("span.pill", { style: { color: "#f44336" }, text: `${list.length} figyelmeztetés` })]),
    el("div.body", {}, [itemsNode])
  );
}

function copyReport() {
  if (!lastData) { toast("Nincs másolható adat", "warn"); return; }
  const jsonStr = JSON.stringify(lastData, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    toast("Egészségügyi jelentés vágólapra másolva (JSON)");
  }).catch(() => {
    toast("Másolás sikertelen", "error");
  });
}
