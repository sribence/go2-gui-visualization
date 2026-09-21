/* Perception: Person tracking, annotated stream, 2D radar, mode selection, YOLO model selector, latency P50/P90, Jetson power mode display, Audio & TTS control. */
const { api, el, clear, store, toast, fmt } = await import("../core.js" + (window.__V || ""));

let ui = {};
let sseSource = null;
let pollTimer = null;
let statusTimer = null;
let modelPollTimer = null;
let armTimer = null;
let armTimeRemaining = 0;
let lastPersonsData = null;
let lastFollowData = null;
let lastModelsData = null;
let lastPowerData = null;
let lastExecutorStatus = null;
let switchStartTime = null;

export default {
  id: "perception",
  icon: "👤",
  short: "Érzékelés",
  title: "Emberérzékelés és Személykövetés",
  subtitle: "3D pozíciók, YOLO TensorRT modellek, Latency P50/P90, 2D radar, Hang & TTS",
  flush: true,

  mount({ body, tools, sub }) {
    clear(body);
    clear(tools);

    // Tools bar
    tools.append(
      el("button.btn.primary", { text: "🔓 Követés Újraengedélyezése (:9113)", onclick: () => this.enableFollow() }),
      el("button.btn.danger", { text: "⏹ Követés Leállítása", onclick: () => this.setMode("off") }),
      el("button.btn", { text: "🔄 Célpont feloldása (Auto)", onclick: () => this.releaseLock() }),
      el("button.btn", { text: "⟳ Frissítés", onclick: () => this.pollAll() })
    );

    // Main layout grid
    const grid = el("div.grid.g2", { style: { gap: "12px", padding: "12px" } });

    // Left Column: Controls, Stepper, Limits, Audio, Stream & YOLO Model
    const leftCol = el("div.stack", { style: { gap: "12px" } });

    // --- Mode Selection & Control Panel ---
    ui.modeBtnOff = el("button.btn", { text: "⏹ Standby / Ki", onclick: () => this.setMode("off") });
    ui.modeBtnUser = el("button.btn", { text: "👤 User-Follow", onclick: () => this.setMode("user_follow") });
    ui.modeBtnIntruder = el("button.btn", { text: "🚨 Intrúder Mód", onclick: () => this.setMode("intruder") });
    ui.modeBtnTrick = el("button.btn", { text: "🪄 Trick & Gesture", onclick: () => this.setMode("trick") });

    ui.distVal = el("span", { text: "2.0 m", style: { fontWeight: "bold", marginLeft: "6px" } });
    ui.distSlider = el("input", {
      type: "range", min: 1.0, max: 4.0, step: 0.1, value: 2.0,
      style: { width: "100%", margin: "8px 0" },
      oninput: (e) => { ui.distVal.textContent = parseFloat(e.target.value).toFixed(1) + " m"; },
      onchange: (e) => this.setDistance(parseFloat(e.target.value))
    });

    ui.audioToggle = el("input", {
      type: "checkbox", checked: true,
      onchange: (e) => this.setAudioAlert(e.target.checked)
    });

    ui.dryRunToggle = el("input", {
      type: "checkbox", checked: true,
      onchange: (e) => this.setDryRun(e.target.checked)
    });

    // Gesture & Flip Action Buttons (Trick Mode)
    ui.gestureBox = el("div.row.tight", { style: { marginTop: "8px", gap: "6px", flexWrap: "wrap" } }, [
      el("button.btn.sm", { text: "👋 Intés", onclick: () => this.sendGesture("wave") }),
      el("button.btn.sm", { text: "✋ Stop / Ülj", onclick: () => this.sendGesture("stop") }),
      el("button.btn.sm", { text: "👍 Oké / Kövess", onclick: () => this.sendGesture("ok") }),
      el("button.btn.sm.warning", { text: "🤸 Szaltó (Flip)", onclick: () => this.sendGesture("flip") }),
      el("button.btn.sm.warning", { text: "🤸 Front Flip", onclick: () => this.sendGesture("front_flip") }),
      el("button.btn.sm.warning", { text: "🤸 Back Flip", onclick: () => this.sendGesture("back_flip") })
    ]);

    const modeCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "⚙️ Nyomkövetési Módok & Testreszabás" })]),
      el("div.body", {}, [
        el("div", { style: { fontSize: "11px", color: "var(--muted)", marginBottom: "6px" } }, [
          document.createTextNode("Válassz funkciót a gombokkal:")
        ]),
        el("div.row", { style: { gap: "6px", marginBottom: "12px", flexWrap: "wrap" } }, [
          ui.modeBtnOff, ui.modeBtnUser, ui.modeBtnIntruder, ui.modeBtnTrick
        ]),
        el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", fontSize: "12px", borderTop: "1px solid var(--border)", paddingTop: "10px" } }, [
          el("div", {}, [
            el("label", {}, [document.createTextNode("Követési távolság: "), ui.distVal]),
            ui.distSlider
          ]),
          el("div.stack", { style: { gap: "6px" } }, [
            el("label.switch-wrap", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } }, [
              ui.audioToggle, el("span", { text: "🔊 Hangjelzés / Reakcióhangok" })
            ]),
            el("label.switch-wrap", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } }, [
              ui.dryRunToggle, el("span", { text: "🛡️ Dry Run (Szimulált mozgás)" })
            ])
          ])
        ]),
        el("div", { style: { marginTop: "10px", fontSize: "11px", color: "var(--muted)" } }, [
          document.createTextNode("Kézjelek és Szaltók (Trick mód):"),
          ui.gestureBox
        ])
      ])
    ]);
    leftCol.appendChild(modeCard);

    // --- 5-Step Test Workflow Stepper Card ---
    ui.stepperCard = el("div.card");
    leftCol.appendChild(ui.stepperCard);

    // --- Speed Limits Sliders Card (:9113/limits) ---
    ui.limitsCard = el("div.card");
    leftCol.appendChild(ui.limitsCard);

    // --- Robot Audio & TTS Card (:5001) ---
    ui.audioCard = this.renderAudioCard();
    leftCol.appendChild(ui.audioCard);

    // --- YOLO Model Selector Card ---
    ui.modelSelCard = el("div.card");
    leftCol.appendChild(ui.modelSelCard);

    // Stream card
    ui.streamImg = el("img", {
      alt: "Élő annotált perception stream",
      title: "Kattints egy személy téglalapjára a zároláshoz!",
      style: { width: "100%", borderRadius: "6px", background: "#000", objectFit: "contain", minHeight: "260px", cursor: "pointer" },
      onclick: (ev) => this.handleStreamClick(ev)
    });
    ui.streamImg.onerror = () => {
      if (ui.streamImg) ui.streamImg.style.display = "none";
      if (ui.streamFallback) {
        ui.streamFallback.style.display = "flex";
        ui.streamFallback.textContent = "⏳ Perception újraindul / stream csatlakozás...";
      }
    };
    ui.streamImg.onload = () => {
      if (ui.streamImg) ui.streamImg.style.display = "block";
      if (ui.streamFallback) ui.streamFallback.style.display = "none";
    };

    ui.streamFallback = el("div.empty", {
      text: "Stream nem elérhető (http://192.168.123.18:9112/stream.mjpg)",
      style: { display: "none", height: "260px", alignItems: "center", justifyContent: "center", background: "#0a0d12", borderRadius: "6px" }
    });

    ui.targetBanner = el("div.toast.info", { text: "Célpont: Auto (legközelebbi)", style: { margin: "6px 0 0 0" } });
    ui.latencyBanner = el("div.toast.warn", { text: "⏱️ Kamerakésés ellenőrzése...", style: { margin: "6px 0 0 0", display: "none" } });

    const streamCard = el("div.card", {}, [
      el("h3", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, [
        el("span", { text: "📷 Annotált kamerafolyam (RealSense :9112)" }),
        el("span.badge", { text: "💡 Kattints a téglalapba a kijelöléshez!", style: { fontSize: "11px", fontWeight: "normal", opacity: 0.85 } })
      ]),
      el("div.body", {}, [ui.streamImg, ui.streamFallback, ui.targetBanner, ui.latencyBanner])
    ]);
    leftCol.appendChild(streamCard);

    grid.appendChild(leftCol);

    // Right Column: HUD Telemetry, Latency P50/P90, Power, 2D Radar, Person Table
    const rightCol = el("div.stack", { style: { gap: "12px" } });

    // --- HUD Telemetry Box ---
    ui.hudBox = el("div.telemetry-grid", { style: { gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" } });
    const hudCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "📊 Követési Telemetria & HUD" })]),
      el("div.body", {}, [ui.hudBox])
    ]);
    rightCol.appendChild(hudCard);

    // --- Latency & Performance Card ---
    ui.perfBox = el("div");
    const perfCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "⏱️ Késleltetés P50 / P90 & Teljesítmény" })]),
      el("div.body", {}, [ui.perfBox])
    ]);
    rightCol.appendChild(perfCard);

    // --- Jetson Power Mode Card ---
    ui.powerBox = el("div");
    const powerCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "⚡ Jetson Energiamód (CPU / GPU)" })]),
      el("div.body", {}, [ui.powerBox])
    ]);
    rightCol.appendChild(powerCard);

    // 2D Radar canvas
    ui.radarCanvas = el("canvas", {
      width: 480, height: 260,
      style: { width: "100%", height: "240px", borderRadius: "6px", background: "#080a0e", border: "1px solid var(--line)", cursor: "pointer" }
    });
    ui.radarCanvas.onclick = (ev) => handleRadarClick(ev);

    const radarCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "🎯 Top-Down 2D Radar (Robot-koordináták)" })]),
      el("div.body", {}, [ui.radarCanvas])
    ]);
    rightCol.appendChild(radarCard);

    // Person table
    ui.personTable = el("div.table-wrap", { style: { overflowX: "auto", maxHeight: "180px" } });
    const tableCard = el("div.card", {}, [
      el("h3", {}, [el("span", { text: "👥 Észlelt személyek" })]),
      el("div.body", {}, [ui.personTable])
    ]);
    rightCol.appendChild(tableCard);

    grid.appendChild(rightCol);
    body.appendChild(grid);

    this.startData();
  },

  onEnter() {
    this.startData();
  },

  onLeave() {
    this.stopData();
  },

  getBaseUrl() {
    return store.get("perception.url", "http://192.168.123.18:9112").replace(/\/$/, "");
  },

  startData() {
    this.stopData();
    const baseUrl = this.getBaseUrl();

    if (ui.streamImg) {
      ui.streamImg.src = `${baseUrl}/stream.mjpg`;
      ui.streamImg.style.display = "block";
      if (ui.streamFallback) ui.streamFallback.style.display = "none";
    }

    try {
      sseSource = new EventSource(`${baseUrl}/persons/stream`);
      sseSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.updatePersons(data);
        } catch (e) { console.error("SSE JSON parse error", e); }
      };
      sseSource.onerror = () => {
        if (sseSource) { sseSource.close(); sseSource = null; }
        if (!pollTimer) {
          pollTimer = setInterval(() => this.pollPersons(), 500);
        }
      };
    } catch (e) {
      pollTimer = setInterval(() => this.pollPersons(), 500);
    }

    this.pollAll();
    statusTimer = setInterval(() => this.pollAll(), 1500);
  },

  stopData() {
    if (sseSource) { sseSource.close(); sseSource = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (modelPollTimer) { clearInterval(modelPollTimer); modelPollTimer = null; }
    if (armTimer) { clearInterval(armTimer); armTimer = null; }
  },

  pollAll() {
    this.pollFollowState();
    this.pollModels();
    this.pollPower();
    this.pollExecutorStatus();
  },

  async pollPersons() {
    const baseUrl = this.getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/persons`);
      if (res.ok) {
        const data = await res.json();
        this.updatePersons(data);
        return;
      }
    } catch (e) {
      this.fetchProxyPersons();
    }
  },

  async fetchProxyPersons() {
    try {
      const data = await api.get("/api/perception/persons");
      this.updatePersons(data);
    } catch (e) {
      this.updatePersons(getMockPersonsData());
    }
  },

  async pollFollowState() {
    const baseUrl = this.getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/follow`);
      if (res.ok) {
        const data = await res.json();
        this.updateFollowUI(data);
        return;
      }
    } catch (e) {
      try {
        const data = await api.get("/api/perception/follow");
        this.updateFollowUI(data);
        return;
      } catch (err) {}
    }
    this.updateFollowUI(getMockFollowData());
  },

  async pollExecutorStatus() {
    const overrideUrl = store.get("perception.override_url", "http://192.168.123.18:9113").replace(/\/$/, "");
    try {
      const res = await fetch(`${overrideUrl}/status`);
      if (res.ok) {
        const data = await res.json();
        lastExecutorStatus = data;
        this.renderStepper();
        this.renderLimits(data);
        return;
      }
    } catch (e) {
      try {
        const data = await api.get("/api/perception/executor/status");
        lastExecutorStatus = data;
        this.renderStepper();
        this.renderLimits(data);
        return;
      } catch (err) {}
    }
    const mockEx = {
      enabled: true, moving: false, reason: "dry_run_active",
      last_cmd: { vx: 0.0, vyaw: 0.0 },
      limits: { max_vx: 0.3, max_vx_back: 0.15, max_vyaw: 0.6 },
      hard_caps: { max_vx: 0.4, max_vx_back: 0.2, max_vyaw: 0.8 }
    };
    lastExecutorStatus = mockEx;
    this.renderStepper();
    this.renderLimits(mockEx);
  },

  async pollModels() {
    const baseUrl = this.getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/models`);
      if (res.status === 404) {
        this.renderModelSelector({ not_ready: true });
        return;
      } else if (res.ok) {
        const data = await res.json();
        this.renderModelSelector(data);
        return;
      }
    } catch (e) {
      try {
        const data = await api.get("/api/perception/models");
        this.renderModelSelector(data);
        return;
      } catch (err) {
        if (err.status === 404) {
          this.renderModelSelector({ not_ready: true });
          return;
        }
      }
    }
    this.renderModelSelector({ not_ready: true });
  },

  async pollPower() {
    const baseUrl = this.getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/system/power`);
      if (res.status === 404) {
        this.renderPowerInfo({ not_ready: true });
        return;
      } else if (res.ok) {
        const data = await res.json();
        this.renderPowerInfo(data);
        return;
      }
    } catch (e) {
      try {
        const data = await api.get("/api/perception/system/power");
        this.renderPowerInfo(data);
        return;
      } catch (err) {
        if (err.status === 404) {
          this.renderPowerInfo({ not_ready: true });
          return;
        }
      }
    }
    this.renderPowerInfo({ not_ready: true });
  },

  renderStepper() {
    const card = ui.stepperCard;
    if (!card) return;
    clear(card);

    const ex = lastExecutorStatus || { enabled: false, moving: false, reason: "unknown" };
    const targetId = lastPersonsData ? lastPersonsData.target_id : null;
    const isLocked = targetId != null;
    const mode = lastFollowData ? lastFollowData.mode : "off";
    const isUserFollow = mode === "user_follow";
    const dryRun = lastFollowData ? lastFollowData.dry_run : true;
    const isDryRunOff = dryRun === false;
    const isArmed = armTimeRemaining > 0;

    card.appendChild(el("h3", {}, [
      el("span", { text: "🧪 5-Lépéses Követési Tesztfolyamat" }),
      el("span.badge" + (ex.enabled && ex.moving ? ".on" : ".off"), {
        text: ex.enabled && ex.moving ? "🟢 KÖVETÉS FUT" : "⏹ FOLYAMAT MEGÁLLVA",
        style: { marginLeft: "8px" }
      })
    ]));

    const body = el("div.body", { style: { display: "flex", flexDirection: "column", gap: "8px" } });

    // Step 1: Arm mc_motion
    const step1 = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: "4px", border: "1px solid var(--border)" } }, [
      el("div", {}, [
        el("b", { text: "1. mc_motion Armolás: " }),
        el("span.badge" + (isArmed ? ".on" : ".off"), { text: isArmed ? `ARMOLVA (${armTimeRemaining}s)` : "INAKTÍV" })
      ]),
      el("button.btn.sm" + (isArmed ? ".warning" : ".primary"), {
        text: isArmed ? "⏳ Újra-armolás (300s)" : "⚡ Armolás (300s)",
        onclick: () => this.armRobot()
      })
    ]);

    // Step 2: Lock Target
    const step2 = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: "4px", border: "1px solid var(--border)" } }, [
      el("div", {}, [
        el("b", { text: "2. Célpont kijelölése: " }),
        el("span.badge" + (isLocked ? ".on" : ".warn"), { text: isLocked ? `ZÁROLVA (#${targetId})` : "AUTO / NINCS" })
      ]),
      isLocked ? el("span", { text: "✓ Kész", style: { color: "var(--ok)", fontSize: "12px", fontWeight: "bold" } }) : el("span", { text: "Kattints a képre!", style: { fontSize: "11px", color: "var(--muted)" } })
    ]);

    // Step 3: User Follow Mode
    const step3 = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: "4px", border: "1px solid var(--border)" } }, [
      el("div", {}, [
        el("b", { text: "3. User-Follow Mód: " }),
        el("span.badge" + (isUserFollow ? ".on" : ".off"), { text: isUserFollow ? "AKTÍV" : `INAKTÍV (${mode.toUpperCase()})` })
      ]),
      !isUserFollow ? el("button.btn.sm.primary", { text: "Aktiválás", onclick: () => this.setMode("user_follow") }) : el("span", { text: "✓ Kész", style: { color: "var(--ok)", fontSize: "12px", fontWeight: "bold" } })
    ]);

    // Step 4: Dry Run OFF
    const step4 = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: "4px", border: "1px solid var(--border)" } }, [
      el("div", {}, [
        el("b", { text: "4. Éles Mozgás (Dry Run KI): " }),
        el("span.badge" + (isDryRunOff ? ".on" : ".danger"), { text: isDryRunOff ? "ÉLES MOZGÁS" : "SZIMULÁLT (Dry Run)" })
      ]),
      el("button.btn.sm" + (isDryRunOff ? ".warning" : ".danger"), {
        text: isDryRunOff ? "Dry Run Be" : "Élesre váltás",
        onclick: () => this.setDryRun(!dryRun)
      })
    ]);

    // Step 5: Executor Enabled & Status / Reason
    const reasonText = translateReason(ex.reason);
    const step5 = el("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: "4px", border: "1px solid var(--border)" } }, [
      el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, [
        el("div", {}, [
          el("b", { text: "5. Follow Executor: " }),
          el("span.badge" + (ex.enabled && ex.moving ? ".on" : ".off"), { text: ex.enabled ? (ex.moving ? "MOZOG" : "ENGEDÉLYEZVE (ÁLL)") : "LETILTVA (:9113)" })
        ]),
        el("button.btn.sm" + (ex.enabled ? ".secondary" : ".primary"), {
          text: ex.enabled ? "Letiltás" : "🔓 Újraengedélyezés",
          onclick: () => ex.enabled ? this.disableExecutor() : this.enableFollow()
        })
      ]),
      el("div", { style: { fontSize: "12px", color: ex.moving ? "var(--ok)" : "var(--danger)", marginTop: "2px", fontWeight: "bold" } }, [
        document.createTextNode(`🛑 Leállási indok: ${reasonText}`)
      ])
    ]);

    body.append(step1, step2, step3, step4, step5);
    card.appendChild(body);
  },

  async armRobot() {
    try {
      await api.post("/api/arm", { armed: true });
      armTimeRemaining = 300;
      if (armTimer) clearInterval(armTimer);
      armTimer = setInterval(() => {
        if (armTimeRemaining > 0) {
          armTimeRemaining--;
          this.renderStepper();
        } else {
          clearInterval(armTimer);
          armTimer = null;
          this.renderStepper();
        }
      }, 1000);
      toast("⚡ Robot armolva 300 másodpercre!");
      this.renderStepper();
    } catch (e) {
      toast("Hiba az armolás során: " + e.message, "warn");
    }
  },

  renderLimits(data) {
    const card = ui.limitsCard;
    if (!card) return;

    if (ui.limitsVxInput && document.activeElement && card.contains(document.activeElement)) {
      return;
    }

    clear(card);

    const limits = (data && data.limits) || { max_vx: 0.3, max_vx_back: 0.15, max_vyaw: 0.6 };
    const caps = (data && data.hard_caps) || { max_vx: 0.4, max_vx_back: 0.2, max_vyaw: 0.8 };

    card.appendChild(el("h3", {}, [
      el("span", { text: "🏎️ Sebességhatárok (:9113/limits)" }),
      el("span.badge", { text: "Hard caps korláttal", style: { marginLeft: "8px", opacity: 0.8 } })
    ]));

    ui.limitsVxVal = el("span", { text: `${limits.max_vx} m/s`, style: { fontWeight: "bold", marginLeft: "6px" } });
    ui.limitsVxInput = el("input", {
      type: "range", min: 0.05, max: caps.max_vx, step: 0.01, value: limits.max_vx,
      style: { width: "100%", margin: "4px 0" },
      oninput: (e) => { ui.limitsVxVal.textContent = parseFloat(e.target.value).toFixed(2) + " m/s"; }
    });

    ui.limitsVxBackVal = el("span", { text: `${limits.max_vx_back} m/s`, style: { fontWeight: "bold", marginLeft: "6px" } });
    ui.limitsVxBackInput = el("input", {
      type: "range", min: 0.00, max: caps.max_vx_back, step: 0.01, value: limits.max_vx_back,
      style: { width: "100%", margin: "4px 0" },
      oninput: (e) => { ui.limitsVxBackVal.textContent = parseFloat(e.target.value).toFixed(2) + " m/s"; }
    });

    ui.limitsVyawVal = el("span", { text: `${limits.max_vyaw} rad/s`, style: { fontWeight: "bold", marginLeft: "6px" } });
    ui.limitsVyawInput = el("input", {
      type: "range", min: 0.1, max: caps.max_vyaw, step: 0.01, value: limits.max_vyaw,
      style: { width: "100%", margin: "4px 0" },
      oninput: (e) => { ui.limitsVyawVal.textContent = parseFloat(e.target.value).toFixed(2) + " rad/s"; }
    });

    const saveBtn = el("button.btn.primary", {
      text: "💾 Határok mentése",
      onclick: () => this.saveLimits(
        parseFloat(ui.limitsVxInput.value),
        parseFloat(ui.limitsVxBackInput.value),
        parseFloat(ui.limitsVyawInput.value)
      )
    });

    const body = el("div.body", { style: { display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" } }, [
      el("div", {}, [
        el("label", {}, [document.createTextNode(`Max előremenet (hard cap ${caps.max_vx} m/s): `), ui.limitsVxVal]),
        ui.limitsVxInput
      ]),
      el("div", {}, [
        el("label", {}, [document.createTextNode(`Max hátramenet (hard cap ${caps.max_vx_back} m/s) — 💡 hátrálás csak szemből (0 = soha nem tolat): `), ui.limitsVxBackVal]),
        ui.limitsVxBackInput
      ]),
      el("div", {}, [
        el("label", {}, [document.createTextNode(`Max fordulás (hard cap ${caps.max_vyaw} rad/s): `), ui.limitsVyawVal]),
        ui.limitsVyawInput
      ]),
      el("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "4px" } }, [saveBtn])
    ]);

    card.appendChild(body);
  },

  renderAudioCard() {
    const card = el("div.card");

    card.appendChild(el("h3", {}, [
      el("span", { text: "🔊 Robot Hangkiadás & TTS (WebRTC :5001)" }),
      el("span.badge", { text: "Hangszóró / Megafon", style: { marginLeft: "8px", opacity: 0.8 } })
    ]));

    // 1. Preset sounds
    const presetBox = el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" } }, [
      el("button.btn.sm", { text: "🔊 Akadályelkerülés Be", onclick: () => this.playPresetSound("obstacle_avoidance") }),
      el("button.btn.sm", { text: "⏹ Akadályelkerülés Ki", onclick: () => this.playPresetSound("obstacle_avoidance_exit") }),
      el("button.btn.sm", { text: "🐕 Kísérő Mód Be", onclick: () => this.playPresetSound("companion_mode") }),
      el("button.btn.sm", { text: "⏹ Kísérő Mód Ki", onclick: () => this.playPresetSound("companion_mode_exit") })
    ]);

    // 2. TTS input
    const ttsInput = el("input", { type: "text", placeholder: "Írd be, amit a robot mondjon...", style: { flex: "1", padding: "6px", borderRadius: "4px", border: "1px solid var(--border)" } });
    const ttsBtn = el("button.btn.primary.sm", {
      text: "🗣️ Kimondás",
      onclick: () => {
        if (ttsInput.value.trim()) {
          this.speakTTS(ttsInput.value.trim());
        }
      }
    });
    ttsInput.onkeydown = (e) => {
      if (e.key === "Enter" && ttsInput.value.trim()) {
        this.speakTTS(ttsInput.value.trim());
      }
    };

    const ttsBox = el("div", { style: { display: "flex", gap: "8px", marginBottom: "10px" } }, [ttsInput, ttsBtn]);

    // 3. Megaphone File upload
    const fileInput = el("input", { type: "file", accept: ".wav,.mp3", style: { fontSize: "11px" } });
    const playFileBtn = el("button.btn.sm", {
      text: "🎙️ Hangfájl Bejátszása",
      onclick: () => this.uploadMegaphone(fileInput)
    });

    const fileBox = el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [fileInput, playFileBtn]);

    const body = el("div.body", { style: { display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" } }, [
      el("div", { style: { color: "var(--muted)", fontSize: "11px", fontWeight: "bold" } }, [document.createTextNode("Gyári Rendszerhangok (Presets):")]),
      presetBox,
      el("div", { style: { color: "var(--muted)", fontSize: "11px", fontWeight: "bold" } }, [document.createTextNode("Szöveg-felolvasás (TTS / Megafon):")]),
      ttsBox,
      el("div", { style: { color: "var(--muted)", fontSize: "11px", fontWeight: "bold" } }, [document.createTextNode("Megafon (.wav / .mp3 fájl feltöltése):")]),
      fileBox
    ]);

    card.appendChild(body);
    return card;
  },

  async playPresetSound(soundId) {
    try {
      await api.post(`/api/audio/play/${soundId}`);
      toast(`🔊 Robot hang lejátszva: ${soundId}`);
      return;
    } catch (e) {
      const bridgeUrl = store.get("webrtc.bridge_url", "http://192.168.123.18:5001").replace(/\/$/, "");
      try {
        const res = await fetch(`${bridgeUrl}/audio/play/${soundId}`, { method: "POST" });
        if (res.ok) {
          toast(`🔊 Robot hang lejátszva: ${soundId}`);
          return;
        }
      } catch (err) {
        toast("Hiba a hanglejátszáskor: " + err.message, "warn");
      }
    }
  },

  async speakTTS(text) {
    try {
      await api.post("/api/speak", { text });
      toast(`🗣️ TTS felolvasás elküldve: "${text}"`);
      return;
    } catch (e) {
      const bridgeUrl = store.get("webrtc.bridge_url", "http://192.168.123.18:5001").replace(/\/$/, "");
      try {
        const res = await fetch(`${bridgeUrl}/api/speak`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
        if (res.ok) {
          toast(`🗣️ TTS felolvasás elküldve: "${text}"`);
          return;
        }
      } catch (err) {
        toast("TTS Hiba: " + err.message, "warn");
      }
    }
  },

  async uploadMegaphone(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      toast("Válassz ki egy .wav vagy .mp3 fájlt!", "warn");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/audio/megaphone", {
        method: "POST",
        body: formData
      });
      if (res.ok) {
        toast("🎙️ Hangfájl sikeresen bejátszva a robot hangszóróján!");
        return;
      }
    } catch (e) {
      const bridgeUrl = store.get("webrtc.bridge_url", "http://192.168.123.18:5001").replace(/\/$/, "");
      try {
        const res = await fetch(`${bridgeUrl}/audio/megaphone`, {
          method: "POST",
          body: formData
        });
        if (res.ok) {
          toast("🎙️ Hangfájl sikeresen bejátszva a robot hangszóróján!");
          return;
        }
      } catch (err) {
        toast("Megafon feltöltési hiba: " + err.message, "warn");
      }
    }
  },

  async saveLimits(max_vx, max_vx_back, max_vyaw) {
    const overrideUrl = store.get("perception.override_url", "http://192.168.123.18:9113").replace(/\/$/, "");
    try {
      const res = await fetch(`${overrideUrl}/limits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_vx, max_vx_back, max_vyaw })
      });
      if (res.ok) {
        toast("💾 Sebességhatárok sikeresen frissítve!");
        this.pollExecutorStatus();
        return;
      }
    } catch (e) {
      try {
        await api.post("/api/perception/executor/limits", { max_vx, max_vx_back, max_vyaw });
        toast("💾 Sebességhatárok frissítve (proxy)!");
        this.pollExecutorStatus();
        return;
      } catch (err) {
        toast("Hiba a sebességhatárok mentésekor: " + err.message, "warn");
      }
    }
  },

  async disableExecutor() {
    const overrideUrl = store.get("perception.override_url", "http://192.168.123.18:9113").replace(/\/$/, "");
    try {
      const res = await fetch(`${overrideUrl}/disable`, { method: "POST" });
      if (res.ok) {
        toast("⏹ Follow executor letiltva!");
        this.pollExecutorStatus();
        return;
      }
    } catch (e) {
      try {
        await api.post("/api/perception/executor/disable");
        toast("⏹ Follow executor letiltva!");
        this.pollExecutorStatus();
        return;
      } catch (err) {}
    }
  },

  renderModelSelector(data) {
    const card = ui.modelSelCard;
    if (!card) return;
    clear(card);

    if (data && data.not_ready) {
      card.appendChild(el("h3", {}, [
        el("span", { text: "🤖 YOLO Modellválasztó" }),
        el("span.badge", { text: "hamarosan", style: { marginLeft: "8px", opacity: 0.7 } })
      ]));
      card.appendChild(el("div.body", {}, [
        el("div.empty", { text: "A TensorRT FP16 modellválasztó végpont (:9112/models) fejlesztés alatt." })
      ]));
      return;
    }

    lastModelsData = data || getMockModelsData();
    const cur = lastModelsData.current || { id: "yolov8n", format: "engine", imgsz: 640 };
    const sw = lastModelsData.switch || { state: "idle" };
    const available = lastModelsData.available || [];
    const imgszOpts = lastModelsData.imgsz_options || [320, 416, 480, 640];

    const isBuilding = sw.state === "building" || sw.state === "loading";
    if (isBuilding && !modelPollTimer) {
      switchStartTime = Date.now();
      modelPollTimer = setInterval(() => this.pollModels(), 2000);
    } else if (!isBuilding && modelPollTimer) {
      clearInterval(modelPollTimer);
      modelPollTimer = null;
    }

    card.appendChild(el("h3", {}, [
      el("span", { text: "🤖 YOLO Modell & Felbontás (TensorRT FP16)" }),
      el("span.badge" + (isBuilding ? ".warn" : ".on"), {
        text: isBuilding ? `⏳ Modell építése/betöltése (${sw.state})` : `Aktív: ${cur.id} (${cur.format}, ${cur.imgsz}px)`,
        style: { marginLeft: "8px" }
      })
    ]));

    const body = el("div.body");

    if (isBuilding) {
      const elapsedS = switchStartTime ? Math.round((Date.now() - switchStartTime) / 1000) : 0;
      body.appendChild(el("div.toast.warn", {
        text: `⏳ Modellváltás folyamatban (${sw.progress_note || sw.state}) — Eltelt idő: ${elapsedS} s. A régi modell közben folyamatosan fut.`,
        style: { marginBottom: "10px" }
      }));
    }

    if (sw.state === "error") {
      body.appendChild(el("div.toast.error", { text: `⚠️ Modellváltási hiba: ${sw.error}`, style: { marginBottom: "10px" } }));
    }

    const selModel = el("select", { disabled: isBuilding }, available.map(m => el("option", { value: m.id, text: `${m.id} (${m.params_m}M param)` })));
    selModel.value = cur.id;

    const selFmt = el("select", { disabled: isBuilding }, [
      el("option", { value: "engine", text: "engine (TensorRT FP16 - Gyors)" }),
      el("option", { value: "pt", text: "pt (PyTorch - Lassabb)" })
    ]);
    selFmt.value = cur.format || "engine";

    const selImgsz = el("select", { disabled: isBuilding }, imgszOpts.map(sz => el("option", { value: sz, text: `${sz} x ${sz} px` })));
    selImgsz.value = cur.imgsz || 640;

    const applyBtn = el("button.btn.primary", {
      disabled: isBuilding,
      text: "⚡ Váltás és Építés",
      onclick: () => this.switchModel(selModel.value, selFmt.value, parseInt(selImgsz.value))
    });

    body.append(
      el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: "8px", alignItems: "center" } }, [
        el("div", {}, [el("span.k", { text: "Modell: ", style: { fontSize: "11px" } }), selModel]),
        el("div", {}, [el("span.k", { text: "Formátum: ", style: { fontSize: "11px" } }), selFmt]),
        el("div", {}, [el("span.k", { text: "Felbontás: ", style: { fontSize: "11px" } }), selImgsz]),
        applyBtn
      ]),
      el("div", { style: { fontSize: "11px", color: "var(--muted)", marginTop: "8px" } }, [
        document.createTextNode("💡 Tanács: n = leggyorsabb, s = pontosabb, de ~2-3× lassabb; kisebb imgsz = gyorsabb, a távoli emberre gyengébb.")
      ])
    );

    card.appendChild(body);
  },

  async switchModel(id, format, imgsz) {
    const isTracking = (lastFollowData && lastFollowData.mode !== "off") || (lastPersonsData && (lastPersonsData.target_mode === "locked" || lastPersonsData.target_id != null));
    if (isTracking) {
      const confirmSwitch = window.confirm(
        "⚠️ FONTOS FIGYELMEZTETÉS:\n\nModellváltáskor a YOLO újraindul, a kijelölt célpont zárolása ÉS A KÖVETÉS MEGSZAKAD, a robot megáll!\n\nBiztosan elindítod a modellváltást?"
      );
      if (!confirmSwitch) return;
    }
    const baseUrl = this.getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, format, imgsz })
      });
      if (res.status === 202) {
        toast(`Modellváltás elindítva: ${id} (${imgsz}px)`);
        switchStartTime = Date.now();
        this.pollModels();
        return;
      } else if (res.status === 409) {
        toast("Már folyamatban van egy modellváltás!", "warn");
        return;
      }
    } catch (e) {
      try {
        await api.post("/api/perception/model", { id, format, imgsz });
        toast(`Modellváltás beállítva: ${id} (${imgsz}px)`);
        this.pollModels();
        return;
      } catch (err) {}
    }
    toast("Modellváltási kérelem elküldve.");
  },

  renderPowerInfo(data) {
    const box = ui.powerBox;
    if (!box) return;
    clear(box);

    if (data && data.not_ready) {
      box.appendChild(el("div", { style: { fontSize: "12px", color: "var(--muted)" } }, [
        document.createTextNode("Energiamód szerviz (:9112/system/power): "),
        el("span.badge", { text: "hamarosan", style: { opacity: 0.7 } })
      ]));
      return;
    }

    lastPowerData = data || getMockPowerData();
    const p = lastPowerData;
    const cpuOnline = p.cpu_online != null ? `${p.cpu_online} / ${p.cpu_total || 8} mag` : "--";
    const gpuLoad = p.gpu_load_pct != null ? `${p.gpu_load_pct}%` : "--";
    const supported = p.switch_supported === true;

    box.appendChild(el("div.telemetry-grid", { style: { gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", fontSize: "12px" } }, [
      kv("Aktív Mód", p.mode || "MAXN"),
      kv("CPU Magok", cpuOnline),
      kv("GPU Terhelés", gpuLoad)
    ]));

    box.appendChild(el("div", { style: { marginTop: "8px", display: "flex", gap: "6px", alignItems: "center" } }, [
      el("button.btn.sm", { disabled: true, text: "⚡ MAXN" }),
      el("button.btn.sm", { disabled: true, text: "🔋 15W" }),
      el("button.btn.sm", { disabled: true, text: "🌱 10W" }),
      el("span.badge.off", { text: supported ? "újraindítás szükségeshet" : "🔒 admin jóváhagyás kell" })
    ]));
  },

  async setMode(mode) {
    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode })
      });
    } catch (e) {
      await api.post("/api/perception/follow", { mode });
    }
    toast(`Mód átállítva: ${mode.toUpperCase()}`);
    this.pollFollowState();
  },

  async enableFollow() {
    const overrideUrl = store.get("perception.override_url", "http://192.168.123.18:9113").replace(/\/$/, "");
    try {
      const res = await fetch(`${overrideUrl}/enable`, { method: "POST" });
      if (res.ok) {
        toast("🔓 Távirányítós felülírás törölve, követés újraengedélyezve!");
        this.pollFollowState();
        this.pollExecutorStatus();
        return;
      }
    } catch (e) {
      try {
        await api.post("/api/perception/follow/enable");
        toast("🔓 Követés újraengedélyezve!");
        this.pollFollowState();
        this.pollExecutorStatus();
        return;
      } catch (err) {}
    }
    toast("Nem sikerült hívni a :9113/enable végpontot", "warn");
  },

  async setDistance(dist) {
    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_distance_m: dist })
      });
    } catch (e) {
      await api.post("/api/perception/follow", { target_distance_m: dist });
    }
    toast(`Cél távolság: ${dist.toFixed(1)} m`);
    this.pollFollowState();
  },

  async setAudioAlert(enabled) {
    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_alert: enabled })
      });
    } catch (e) {
      await api.post("/api/perception/follow", { audio_alert: enabled });
    }
    toast(enabled ? "Hangjelzések bekapcsolva" : "Hangjelzések kikapcsolva");
  },

  async setDryRun(enabled) {
    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: enabled })
      });
    } catch (e) {
      await api.post("/api/perception/follow", { dry_run: enabled });
    }
    toast(enabled ? "Dry Run módban (robot nem mozog)" : "Éles mozgás aktiválva!");
    this.pollFollowState();
  },

  async releaseLock() {
    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/follow/release`, { method: "POST" });
    } catch (e) {
      await api.post("/api/perception/follow/release");
    }
    toast("Célpont feloldva (Auto mód)");
    this.pollFollowState();
  },

  async sendGesture(gesture) {
    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/follow/gesture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gesture })
      });
    } catch (e) {
      await api.post("/api/perception/follow/gesture", { gesture });
    }
    toast(`Akció / Kézjel elküldve: ${gesture.toUpperCase()}`);
  },

  handleStreamClick(ev) {
    if (!lastPersonsData || !lastPersonsData.persons || !lastPersonsData.persons.length) {
      toast("Nincs észlelt személy a képen.", "warn");
      return;
    }

    const img = ui.streamImg;
    if (!img) return;

    const rect = img.getBoundingClientRect();
    const clickX = ev.clientX - rect.left;
    const clickY = ev.clientY - rect.top;

    const dispW = rect.width;
    const dispH = rect.height;
    if (dispW <= 0 || dispH <= 0) return;

    const imgSize = lastPersonsData.image_size || [640, 480];
    const imgW = imgSize[0] || 640;
    const imgH = imgSize[1] || 480;

    const imgAspect = imgW / imgH;
    const elemAspect = dispW / dispH;

    let renderW, renderH, offsetX, offsetY;
    if (elemAspect > imgAspect) {
      renderH = dispH;
      renderW = dispH * imgAspect;
      offsetX = (dispW - renderW) / 2;
      offsetY = 0;
    } else {
      renderW = dispW;
      renderH = dispW / imgAspect;
      offsetX = 0;
      offsetY = (dispH - renderH) / 2;
    }

    const normX = (clickX - offsetX) / renderW;
    const normY = (clickY - offsetY) / renderH;

    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) {
      return;
    }

    const frameX = normX * imgW;
    const frameY = normY * imgH;

    let matchedPerson = null;
    let minArea = Infinity;

    lastPersonsData.persons.forEach(p => {
      const b = getBBox(p.bbox);
      if (b) {
        if (frameX >= b.x1 && frameX <= b.x2 && frameY >= b.y1 && frameY <= b.y2) {
          const area = Math.abs((b.x2 - b.x1) * (b.y2 - b.y1));
          if (area < minArea) {
            minArea = area;
            matchedPerson = p;
          }
        }
      } else if (p.pixel && p.pixel.u != null && p.pixel.v != null) {
        const dist = Math.hypot(frameX - p.pixel.u, frameY - p.pixel.v);
        if (dist <= 50) {
          matchedPerson = p;
        }
      }
    });

    if (matchedPerson) {
      const isTarget = lastPersonsData.target_id === matchedPerson.track_id;
      if (isTarget) {
        setTarget(null);
        toast(`Célpont zárolása feloldva (#${matchedPerson.track_id})`);
      } else {
        setTarget(matchedPerson.track_id);
        toast(`🎯 Személy zárolva a kameraképről: #${matchedPerson.track_id}`);
      }
    } else {
      toast("Nincs személy a kattintott ponton.", "info");
    }
  },

  lastPurpleLedTime: 0,
  triggerTargetLed(data) {
    const hasTarget = data && (data.target_id != null || (Array.isArray(data.persons) && data.persons.length > 0));
    const mode = lastFollowData ? lastFollowData.mode : "off";
    if (hasTarget && mode !== "off") {
      const now = Date.now();
      if (now - this.lastPurpleLedTime > 4000) {
        this.lastPurpleLedTime = now;
        api.post("/api/led/preset/purple").catch(() => {});
      }
    }
  },

  updatePersons(data) {
    if (!data) return;
    lastPersonsData = data;
    this.renderBanner(data);
    this.renderRadar(data);
    this.renderTable(data);
    this.renderStepper();
    this.triggerTargetLed(data);
  },

  updateFollowUI(data) {
    if (!data || !ui.hudBox || !ui.perfBox) return;
    lastFollowData = data;

    const mode = data.mode || "off";
    if (ui.modeBtnOff) ui.modeBtnOff.className = "btn " + (mode === "off" ? "primary" : "");
    if (ui.modeBtnUser) ui.modeBtnUser.className = "btn " + (mode === "user_follow" ? "primary" : "");
    if (ui.modeBtnIntruder) ui.modeBtnIntruder.className = "btn " + (mode === "intruder" ? "danger" : "");
    if (ui.modeBtnTrick) ui.modeBtnTrick.className = "btn " + (mode === "trick" ? "primary" : "");

    const targetDist = data.target_distance_m != null ? data.target_distance_m : (data.config && data.config.follow_distance_m);
    if (ui.distSlider && targetDist != null) {
      ui.distSlider.value = targetDist;
      if (ui.distVal) ui.distVal.textContent = parseFloat(targetDist).toFixed(1) + " m";
    }

    if (ui.audioToggle && data.audio_alert != null) ui.audioToggle.checked = data.audio_alert;
    if (ui.dryRunToggle && data.dry_run != null) ui.dryRunToggle.checked = data.dry_run;

    const lat = data.latency || {};
    const p50 = lat.p50_s != null ? lat.p50_s : (data.result_age_s || 0.25);
    const p90 = lat.p90_s != null ? lat.p90_s : (p50 * 1.3);

    const latColor = p50 < 0.3 ? "var(--ok)" : p50 < 0.6 ? "#e3b341" : "var(--danger)";

    clear(ui.perfBox);
    ui.perfBox.appendChild(el("div", { style: { display: "flex", gap: "16px", alignItems: "center" } }, [
      el("div", { style: { fontSize: "28px", fontWeight: "bold", color: latColor } }, [
        document.createTextNode(`${p50.toFixed(2)}s`),
        el("span", { text: " (P50)", style: { fontSize: "12px", color: "var(--muted)", fontWeight: "normal" } })
      ]),
      el("div", { style: { fontSize: "18px", fontWeight: "bold", color: "var(--muted)" } }, [
        document.createTextNode(`P90: ${p90.toFixed(2)}s`)
      ]),
      el("div.spacer"),
      el("div", { style: { textAlign: "right", fontSize: "12px" } }, [
        el("div", {}, [el("span.k", { text: "Forrás: " }), el("b", { text: data.source || "realsense" })]),
        el("div", {}, [el("span.k", { text: "Inferencia: " }), el("b", { text: `${fmt.n(data.infer_ms, 1)} ms` })]),
        el("div", {}, [el("span.k", { text: "FPS: " }), el("b", { text: `${fmt.n(data.loop_fps, 1)} Hz` })])
      ])
    ]));

    if (ui.latencyBanner) {
      if (p50 >= 0.6) {
        ui.latencyBanner.style.display = "block";
        ui.latencyBanner.className = "toast error";
        ui.latencyBanner.textContent = `🔴 KÉSLELTETÉS MAGAS: P50=${p50.toFixed(2)}s (küszöb: 0.6s)`;
      } else if (p50 >= 0.3) {
        ui.latencyBanner.style.display = "block";
        ui.latencyBanner.className = "toast warn";
        ui.latencyBanner.textContent = `🟡 Késleltetés közepes: P50=${p50.toFixed(2)}s`;
      } else {
        ui.latencyBanner.style.display = "none";
      }
    }

    // Update HUD telemetry box with Reversing Badge if cmd.vx < 0
    clear(ui.hudBox);
    const cmd = data.command || { vx: 0.0, vyaw: 0.0 };
    const distCm = data.target_dist_cm != null ? `${data.target_dist_cm} cm` : "--";
    const isReversing = cmd.vx < 0;

    ui.hudBox.append(
      kv("Követési Mód", mode.toUpperCase()),
      kv("Állapot", data.state || "IDLE"),
      kv("Dry Run", data.dry_run ? "IGEN (szimulált)" : "NEM (éles)"),
      kv("Késleltetés P50", `${p50.toFixed(2)} s`),
      kv("Parancs vx", `${fmt.n(cmd.vx, 2)} m/s`),
      kv("Parancs vyaw", `${fmt.n(cmd.vyaw, 2)} rad/s`),
      kv("Cél távolság", distCm),
      el("div", { style: { gridColumn: "span 2", marginTop: "4px" } }, [
        isReversing
          ? el("span.badge.danger", { text: `⚠️ HÁTRA (TOLATÁS) [vx: ${fmt.n(cmd.vx, 2)} m/s]`, style: { fontSize: "13px", padding: "6px 12px", display: "block", textAlign: "center" } })
          : el("span.badge.off", { text: "▶ ELŐRE / ÁLLÓ", style: { fontSize: "11px", display: "block", textAlign: "center" } })
      ])
    );

    this.renderStepper();
  },

  renderBanner(data) {
    if (!ui.targetBanner) return;
    const targetId = data.target_id;
    const mode = data.target_mode;

    if (mode === "locked" && targetId == null) {
      ui.targetBanner.className = "toast error";
      ui.targetBanner.textContent = "⚠️ Célpont elveszett! (Zárolt mód, de az észlelt személy eltűnt)";
    } else if (targetId != null) {
      ui.targetBanner.className = "toast info";
      ui.targetBanner.textContent = `🎯 Célpont zárolva: #${targetId} (${mode === "locked" ? "Zárolt" : "Auto"})`;
    } else {
      ui.targetBanner.className = "toast info";
      ui.targetBanner.textContent = "🔍 Célpont: Auto (legközelebbi személy keresése)";
    }
  },

  renderRadar(data) {
    const canvas = ui.radarCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "#080a0e";
    ctx.fillRect(0, 0, w, h);

    const rx = w / 2;
    const ry = h - 40;
    const scale = 40;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";

    [1, 2, 3, 5, 8].forEach((r) => {
      ctx.beginPath();
      ctx.arc(rx, ry, r * scale, Math.PI, 2 * Math.PI);
      ctx.stroke();
      ctx.fillText(`${r}m`, rx + 4, ry - r * scale + 12);
    });

    ctx.fillStyle = "#3d8bfd";
    ctx.beginPath();
    ctx.arc(rx, ry, 8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText("ROBOT", rx - 18, ry + 20);

    const persons = data.persons || [];
    const targetId = data.target_id;

    persons.forEach((p) => {
      let px, py;
      const isTarget = p.track_id === targetId;

      if (p.depth_ok && p.position) {
        px = rx - p.position.y * scale;
        py = ry - p.position.x * scale;
      } else if (p.bearing_deg != null && p.distance_m != null) {
        const rad = (p.bearing_deg * Math.PI) / 180;
        const x = p.distance_m * Math.cos(rad);
        const y = p.distance_m * Math.sin(rad);
        px = rx - y * scale;
        py = ry - x * scale;
      } else {
        const deg = p.bearing_deg || 0;
        const rad = (deg * Math.PI) / 180;
        px = rx - Math.sin(rad) * 1.5 * scale;
        py = ry - Math.cos(rad) * 1.5 * scale;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, isTarget ? 10 : 7, 0, 2 * Math.PI);

      if (!p.depth_ok) {
        ctx.fillStyle = "#8b8f9a";
      } else if (isTarget) {
        ctx.fillStyle = "#ff007f";
        ctx.shadowColor = "#ff007f";
        ctx.shadowBlur = 12;
      } else {
        ctx.fillStyle = "#3fb950";
      }
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`#${p.track_id}`, px + 12, py + 4);
      if (p.distance_m != null) {
        ctx.font = "9px sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        ctx.fillText(`${fmt.n(p.distance_m, 1)}m`, px + 12, py + 15);
      }
      ctx.restore();
    });
  },

  renderTable(data) {
    const wrap = ui.personTable;
    if (!wrap) return;
    clear(wrap);

    const persons = data.persons || [];
    if (!persons.length) {
      wrap.appendChild(el("div.empty", { text: "Jelenleg egyetlen személy sem látható." }));
      return;
    }

    const table = el("table.tbl", { style: { width: "100%", fontSize: "12px" } }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Track ID" }),
          el("th", { text: "Konfidencia" }),
          el("th", { text: "Távolság" }),
          el("th", { text: "Irány" }),
          el("th", { text: "Pozíció (x,y,z)" }),
          el("th", { text: "Mélység" }),
          el("th", { text: "Művelet" }),
        ])
      ])
    ]);

    const tbody = el("tbody");
    const targetId = data.target_id;

    persons.forEach((p) => {
      const isTarget = p.track_id === targetId;
      const posText = p.position
        ? `${fmt.n(p.position.x, 2)}, ${fmt.n(p.position.y, 2)}, ${fmt.n(p.position.z, 2)}`
        : "--";

      const tr = el("tr", { style: isTarget ? { background: "rgba(255, 0, 127, 0.15)" } : {} }, [
        el("td", { text: `#${p.track_id}` + (isTarget ? " 🎯" : "") }),
        el("td", { text: `${(p.confidence * 100).toFixed(0)}%` }),
        el("td", { text: p.distance_m != null ? `${fmt.n(p.distance_m, 2)} m` : "--" }),
        el("td", { text: p.bearing_deg != null ? `${fmt.n(p.bearing_deg, 1)}°` : "--" }),
        el("td", { text: posText }),
        el("td", {}, [
          el("span.badge" + (p.depth_ok ? ".on" : ".off"), { text: p.depth_ok ? "OK" : "NEM" })
        ]),
        el("td", {}, [
          el("button.btn.sm" + (isTarget ? ".danger" : ".primary"), {
            text: isTarget ? "Feloldás" : "🎯 Zárolás",
            onclick: () => setTarget(isTarget ? null : p.track_id)
          })
        ])
      ]);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
  }
};

function kv(k, v) {
  return el("div", {}, [el("span", { text: k, style: { color: "var(--muted)", display: "block" } }), el("b", { text: String(v) })]);
}

function translateReason(r) {
  switch (r) {
    case "tracking": return "🟢 Követés aktív (mozgásban)";
    case "target_lost": return "⚠️ Célpont elveszett";
    case "target_reached": return "🎯 Célpont elért távolságban";
    case "joystick_override": return "🎮 Távirányító felülírta a vezérlést!";
    case "dry_run_active": return "🛡️ Dry run aktív (szimulált mód)";
    case "mc_motion_disarmed": return "🔒 Robot inaktív (nincs armolva)";
    case "user_disabled": return "⏹ Követés leállítva/letiltva";
    case "low_battery": return "🪫 Alacsony akkumulátor feszültség";
    default: return r || "Ismeretlen ok";
  }
}

function getBBox(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    return { x1: bbox[0], y1: bbox[1], x2: bbox[2], y2: bbox[3] };
  }
  if (typeof bbox === "object" && bbox.x1 != null && bbox.y1 != null && bbox.x2 != null && bbox.y2 != null) {
    return bbox;
  }
  return null;
}

async function setTarget(trackId) {
  const baseUrl = store.get("perception.url", "http://192.168.123.18:9112").replace(/\/$/, "");
  try {
    const res = await fetch(`${baseUrl}/follow/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track_id: trackId })
    });
    if (res.ok) {
      toast(trackId != null ? `Célpont zárolva (#${trackId})` : "Zárolás feloldva (Auto mód)");
      return;
    }
  } catch (e) {
    try {
      await api.post("/api/perception/follow/lock", { track_id: trackId });
      toast(trackId != null ? `Célpont zárolva (#${trackId})` : "Zárolás feloldva (Auto mód)");
      return;
    } catch (err) {
      toast("Nem sikerült módosítani a célpontot: " + err.message, "warn");
    }
  }
}

function handleRadarClick(ev) {
  if (!lastPersonsData || !lastPersonsData.persons) return;
  const canvas = ui.radarCanvas;
  const rect = canvas.getBoundingClientRect();
  const clickX = ev.clientX - rect.left;
  const clickY = ev.clientY - rect.top;

  const w = canvas.width;
  const h = canvas.height;
  const rx = w / 2;
  const ry = h - 40;
  const scale = 40;

  let closest = null;
  let minDistance = 25;

  lastPersonsData.persons.forEach((p) => {
    let px, py;
    if (p.depth_ok && p.position) {
      px = rx - p.position.y * scale;
      py = ry - p.position.x * scale;
    } else {
      const rad = ((p.bearing_deg || 0) * Math.PI) / 180;
      const dist = p.distance_m || 1.5;
      px = rx - Math.sin(rad) * dist * scale;
      py = ry - Math.cos(rad) * dist * scale;
    }

    const d = Math.hypot(clickX - px, clickY - py);
    if (d < minDistance) {
      minDistance = d;
      closest = p;
    }
  });

  if (closest) {
    setTarget(closest.track_id);
  }
}

function getMockPersonsData() {
  return {
    t: Date.now() / 1000,
    seq: 100,
    source: "realsense",
    infer_ms: 14.5,
    image_size: [640, 480],
    count: 2,
    target_id: 1,
    target_mode: "nearest",
    persons: [
      {
        track_id: 1,
        confidence: 0.88,
        bbox: { x1: 180, y1: 50, x2: 320, y2: 400 },
        pixel: { u: 250, v: 220 },
        depth_ok: true,
        depth_valid_ratio: 1.0,
        position: { x: 2.1, y: 0.3, z: 0.2 },
        velocity: { vx: 0.0, vy: 0.0 },
        distance_m: 2.12,
        bearing_deg: -8.1,
        age_s: 5.2,
        hits: 50
      },
      {
        track_id: 2,
        confidence: 0.65,
        bbox: { x1: 400, y1: 100, x2: 480, y2: 300 },
        pixel: { u: 440, v: 200 },
        depth_ok: false,
        depth_valid_ratio: 0.0,
        position: null,
        velocity: null,
        distance_m: null,
        bearing_deg: 25.0,
        age_s: 1.1,
        hits: 12
      }
    ]
  };
}

function getMockFollowData() {
  return {
    mode: "user_follow",
    target_distance_m: 2.0,
    audio_alert: true,
    dry_run: true,
    target_id: 1,
    state: "TRACKING",
    source: "realsense",
    latency: { p50_s: 0.18, p90_s: 0.25, window: 50 },
    infer_ms: 14.5,
    loop_fps: 12.0,
    command: { vx: 0.15, vyaw: -0.05 },
    target_dist_cm: 212
  };
}

function getMockModelsData() {
  return {
    current: { id: "yolov8n", format: "engine", imgsz: 640, half: true },
    available: [
      { id: "yolov8n", params_m: 3.2, engine_ready: { "640": true, "480": true, "320": false } },
      { id: "yolov8s", params_m: 11.2, engine_ready: { "640": true, "480": false, "320": false } },
      { id: "yolo11n", params_m: 2.6, engine_ready: { "640": false, "480": false, "320": false } },
      { id: "yolo11s", params_m: 9.4, engine_ready: { "640": false, "480": false, "320": false } }
    ],
    imgsz_options: [320, 416, 480, 640],
    switch: { state: "idle", target: null, error: null, started_at: null, progress_note: null }
  };
}

function getMockPowerData() {
  return {
    mode: "MAXN",
    cpu_online: 4,
    cpu_total: 8,
    cpu_freq_mhz: [1651, 1651, 1651, 1651, 0, 0, 0, 0],
    gpu_load_pct: 45,
    switch_supported: false
  };
}
