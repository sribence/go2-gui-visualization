/* Shared plumbing: API client, tiny DOM helper, toasts, modal, live state. */

export const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty body is fine */ }
    if (!r.ok) throw new Error(data?.detail || `${r.status}`);
    return data;
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    return r.ok;
  },
};

/** el("div.card", {onclick}, [children]) -- terse element builder. */
export function el(spec, attrs = {}, children = []) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

export function toast(msg, kind = "info", ms = 3600) {
  const box = $("#toasts");
  const t = el("div.toast." + kind, { text: msg });
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function modal(title, bodyNode, buttons = []) {
  const dlg = $("#dialog");
  clear(dlg);
  dlg.appendChild(el("h3", { text: title }));
  dlg.appendChild(el("div.body", {}, [bodyNode]));
  dlg.appendChild(el("div.foot", {}, buttons));
  $("#modal").classList.add("show");
  return dlg;
}
export function closeModal() { $("#modal").classList.remove("show"); }

/** Confirm dialog. Motion commands go through this unless the operator
 *  turned confirmation off in Settings. */
export function confirmAction(title, message, onYes, yesLabel = "Indítás") {
  modal(title, el("div", { text: message }), [
    el("button.btn", { text: "Mégse", onclick: closeModal }),
    el("button.btn.primary", {
      text: yesLabel,
      onclick: () => { closeModal(); onYes(); },
    }),
  ]);
}

export const fmt = {
  n: (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "--" : Number(v).toFixed(d)),
  deg: (rad) => (rad === null || rad === undefined ? "--" : `${((rad * 180) / Math.PI).toFixed(0)}°`),
  time: (ts) => new Date(ts * 1000).toLocaleTimeString("hu-HU", { hour12: false }),
  dur: (s) => {
    if (s === null || s === undefined) return "--";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h ? `${h}ó ${m}p` : m ? `${m}p ${sec}mp` : `${sec}mp`;
  },
};

/** Live state shared by every module. Modules subscribe; the shell publishes. */
export const store = {
  state: {},
  settings: {},
  schema: { params: [], profiles: {} },
  _subs: new Set(),
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  publish(s) {
    this.state = s;
    for (const fn of this._subs) { try { fn(s); } catch (e) { console.error(e); } }
  },
  get(key, fallback) {
    const v = this.settings[key];
    return v === undefined ? fallback : v;
  },
};

/** Fire a motion-capable action, honouring the confirm-motion setting. */
export function guardedMotion(title, message, run) {
  if (store.get("sys.confirm_motion", true)) confirmAction(title, message, run);
  else run();
}
