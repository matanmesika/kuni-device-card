/* Kuni Device Card — a Home Assistant dashboard card for the Kuni scent diffuser
 * (integration: https://github.com/taltaub22/Kuni-HomeAssistant).
 * Shows the device, the fill level of every loaded scent, and lets you switch
 * scent, power, intensity and the run timer. Only standard HA services are used. */
const KUNI_DOMAIN = "kuni";
const KUNI_VERSION = "0.1.7";
const BAD_STATES = new Set(["unknown", "unavailable"]);
const SLOT_COUNT = 3;
const TIMER_PRESETS = [1800, 3600, 7200, 14400];
const SLOT_COLORS = ["#b48ad8", "#4fb3a4", "#e3a258", "#e58fb4", "#7fa7e6", "#9cc46a"];
// Default colour per known Kuni scent (override with the `scent_colors` option).
const SCENT_COLORS = { "bossa nova": "#e3a258", "chill out": "#4fb3a4", "soft": "#e58fb4" };
function scentColor(name, index, overrides = {}) {
  const key = String(name || "").trim().toLowerCase();
  const custom = Object.entries(overrides || {}).find(([k]) => k.trim().toLowerCase() === key)?.[1];
  if (custom && /^#[0-9a-f]{3,8}$/i.test(custom)) return custom;
  if (SCENT_COLORS[key]) return SCENT_COLORS[key];
  if (!key) return SLOT_COLORS[index % SLOT_COLORS.length];
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SLOT_COLORS[hash % SLOT_COLORS.length];
}
const LOW_LEVEL = 20;
const MID_LEVEL = 50;
const registryCache = new WeakMap();
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

// Semantic role -> [domain, unique-ID key]. Kuni unique IDs end with
// `_<hardware id>_<key>`, so renamed entities still resolve.
const ROLES = {
  power: ["switch", "power"],
  scent: ["select", "current_scent"],
  intensity: ["number", "intensity"],
  time_left: ["sensor", "time_left"],
  slot_1: ["sensor", "scent_slot_1"],
  slot_2: ["sensor", "scent_slot_2"],
  slot_3: ["sensor", "scent_slot_3"],
};

const TEXT = {
  he: {
    on: "פועל", off: "כבוי", unavailable: "לא זמין", scents: "הריחות שלי", intensity: "עוצמת פיזור",
    timer: "טיימר", no_timer: "ללא טיימר", left: "נותרו", active: "פעיל", empty: "ריק", low: "כמעט נגמר",
    slot: "קפסולה", turn_on: "הפעלה", turn_off: "כיבוי", select_scent: "בחירת ריח", not_found: "לא נמצא מכשיר Kuni. בחרו מכשיר בהגדרות הכרטיס.",
    registry_error: "לא ניתן לקרוא את רשימת המכשירים.", failed: "הפקודה נכשלה. נסו שוב.", min: "ד׳", hour: "ש׳",
    editor_device: "מכשיר", editor_name: "שם להצגה", editor_language: "שפה", automatic: "אוטומטי", level: "מילוי",
    timer_running: "יכבה בעוד", sending: "שולח…",
  },
  en: {
    on: "On", off: "Off", unavailable: "Unavailable", scents: "My scents", intensity: "Intensity",
    timer: "Timer", no_timer: "No timer", left: "left", active: "Active", empty: "Empty", low: "Running low",
    slot: "Slot", turn_on: "Turn on", turn_off: "Turn off", select_scent: "Choose scent", not_found: "No Kuni device found. Pick a device in the card settings.",
    registry_error: "Could not read the device registry.", failed: "The command failed. Please try again.", min: "m", hour: "h",
    editor_device: "Device", editor_name: "Display name", editor_language: "Language", automatic: "Automatic", level: "Level",
    timer_running: "Turns off in", sending: "Sending…",
  },
};

function hardwareId(device) {
  return device?.identifiers?.find(([domain]) => domain === KUNI_DOMAIN)?.[1];
}

function kuniDevices(devices, entries) {
  return (devices || []).filter((d) => hardwareId(d) && (entries || []).some((e) => e.device_id === d.id && e.platform === KUNI_DOMAIN));
}

function resolveDevice(config, devices, entries) {
  const candidates = kuniDevices(devices, entries);
  if (config.device_id) return candidates.find((d) => d.id === config.device_id);
  if (config.entity) {
    const entry = entries.find((e) => e.entity_id === config.entity && e.platform === KUNI_DOMAIN);
    return candidates.find((d) => d.id === entry?.device_id);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveRoles(device, entries) {
  const result = {};
  const hw = hardwareId(device);
  if (!hw) return result;
  for (const [role, [domain, key]] of Object.entries(ROLES)) {
    const entry = entries.find((e) => e.device_id === device.id && e.platform === KUNI_DOMAIN &&
      typeof e.unique_id === "string" && e.unique_id.endsWith(`_${hw}_${key}`) &&
      e.entity_id.startsWith(`${domain}.`) && !e.disabled_by);
    if (entry) result[role] = entry.entity_id;
  }
  return result;
}

function levelTone(level) {
  if (!Number.isFinite(level)) return "unknown";
  if (level <= LOW_LEVEL) return "low";
  if (level <= MID_LEVEL) return "mid";
  return "ok";
}

// Seconds left on the run timer, counted down locally between polls.
// The device keeps reporting the duration that was set (it does not count down),
// so the countdown starts from the last state change. `local` is a timer set from
// this card ({seconds, at}); it wins when it is newer than the last state change,
// which covers setting the same duration again (the state then does not change).
function remainingSeconds(state, now = Date.now(), local) {
  if (!state || BAD_STATES.has(state.state)) return 0;
  const value = Number(state.state);
  const stamp = Date.parse(state.last_updated || state.last_reported || "");
  if (local && local.seconds > 0 && (!Number.isFinite(stamp) || local.at > stamp)) {
    return Math.max(0, Math.round(local.seconds - Math.max(0, (now - local.at) / 1000)));
  }
  // The device reports 1 while running without a timer.
  if (!Number.isFinite(value) || value <= 1) return 0;
  const elapsed = Number.isFinite(stamp) ? Math.max(0, (now - stamp) / 1000) : 0;
  return Math.max(0, Math.round(value - elapsed));
}

function formatDuration(seconds, t) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}:${String(m).padStart(2, "0")}`;
  if (m) return `${m} ${t("min")}`;
  return `0:${String(s % 60).padStart(2, "0")}`;
}

function presetLabel(seconds, t) {
  return seconds >= 3600 ? `${seconds / 3600} ${t("hour")}` : `${seconds / 60} ${t("min")}`;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Invalid configuration");
  if (config.language && !["he", "en"].includes(config.language)) throw new Error("language must be he or en");
  if (config.device_id && typeof config.device_id !== "string") throw new Error("device_id must be a string");
  if (config.image && (typeof config.image !== "string" || !/^\/(?:local|api|hacsfiles)\/[^\s"'<>]+$/.test(config.image))) throw new Error("image must be a /local/, /api/ or /hacsfiles/ URL");
  return { ...config };
}

const DEVICE_ART = `<svg viewBox="0 0 120 160" aria-hidden="true">
  <defs>
    <linearGradient id="kuni-body" x1="0" x2="1"><stop stop-color="#e9e6e1"/><stop offset=".55" stop-color="#fbfaf8"/><stop offset="1" stop-color="#d9d5cf"/></linearGradient>
    <radialGradient id="kuni-glow"><stop stop-color="var(--kuni-accent)" stop-opacity=".9"/><stop offset="1" stop-color="var(--kuni-accent)" stop-opacity="0"/></radialGradient>
  </defs>
  <ellipse class="kuni-mist" cx="60" cy="18" rx="34" ry="14" fill="url(#kuni-glow)"/>
  <ellipse cx="60" cy="150" rx="40" ry="6" fill="currentColor" opacity=".12"/>
  <path d="M28 40q0-12 12-12h40q12 0 12 12v98q0 10-10 10H38q-10 0-10-10Z" fill="url(#kuni-body)" stroke="#c9c4bd"/>
  <ellipse cx="60" cy="31" rx="24" ry="4" fill="#cfcac3"/>
  <ellipse cx="60" cy="31" rx="8" ry="1.6" fill="#8f8a84"/>
  <rect class="kuni-led" x="44" y="118" width="32" height="4" rx="2" fill="var(--kuni-accent)"/>
  <g opacity=".55"><rect x="38" y="60" width="44" height="40" rx="8" fill="none" stroke="#c9c4bd"/>
  <line x1="52.7" y1="60" x2="52.7" y2="100" stroke="#c9c4bd"/><line x1="67.3" y1="60" x2="67.3" y2="100" stroke="#c9c4bd"/></g>
</svg>`;

const KUNI_STYLES = `
  :host{display:block;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,system-ui)}
  ha-card{--kuni-accent:var(--primary-color);display:block;overflow:hidden;padding:20px;box-sizing:border-box;border-radius:var(--ha-card-border-radius,24px)}
  .hero{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:16px}
  .device{position:relative;width:96px;height:120px;display:grid;place-items:center;border-radius:28px;background:color-mix(in srgb,var(--kuni-accent) 10%,var(--secondary-background-color,#f2f2f2))}
  .device svg{width:80px;height:108px;color:var(--primary-text-color)}
  .device .photo{width:86%;height:92%;object-fit:contain;filter:drop-shadow(0 6px 10px rgba(0,0,0,.25));transition:filter .4s}
  ha-card[data-on=true] .device .photo{filter:drop-shadow(0 0 16px color-mix(in srgb,var(--kuni-accent) 75%,transparent)) drop-shadow(0 6px 10px rgba(0,0,0,.25))}
  .device .kuni-mist{opacity:0;transition:opacity .4s}
  ha-card[data-on=true] .device .kuni-mist{opacity:1}
  ha-card[data-on=false] .kuni-led{opacity:.25}
  @keyframes kuni-breathe{0%,100%{transform:translateY(2px) scale(.92);opacity:.55}50%{transform:translateY(-3px) scale(1.06);opacity:1}}
  .device svg .kuni-mist{transform-origin:60px 18px}
  .name{font-size:20px;font-weight:600;line-height:1.25;margin:0;word-break:break-word}
  .status{margin-top:4px;color:var(--secondary-text-color);font-size:14px;line-height:1.4}
  .status b{color:var(--kuni-accent);font-weight:600}
  button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
  button:disabled{cursor:default;opacity:.45}
  button:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}
  .power{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:var(--secondary-background-color,#eee);color:var(--secondary-text-color);transition:background .2s,color .2s,box-shadow .2s}
  .power ha-icon{--mdc-icon-size:28px}
  ha-card[data-on=true] .power{background:var(--kuni-accent);color:var(--text-primary-color,#fff);box-shadow:0 6px 18px color-mix(in srgb,var(--kuni-accent) 45%,transparent)}
  h3{font-size:15px;font-weight:600;margin:22px 0 10px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  h3 small{font-size:13px;font-weight:400;color:var(--secondary-text-color)}
  .slots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .slot{position:relative;display:grid;justify-items:center;gap:6px;padding:14px 6px 12px;border-radius:20px;background:var(--secondary-background-color,#f4f4f4);border:2px solid transparent;min-height:132px;transition:border-color .2s,transform .1s}
  .slot:active:not(:disabled){transform:scale(.97)}
  .slot[data-active=true]{border-color:var(--slot-color);background:color-mix(in srgb,var(--slot-color) 12%,var(--secondary-background-color,#f4f4f4))}
  .ring{position:relative;width:64px;height:64px}
  .ring svg{width:64px;height:64px;transform:rotate(-90deg)}
  .ring .track{stroke:var(--divider-color,#ddd)}
  .ring .fill{stroke:var(--slot-color);transition:stroke-dashoffset .5s}
  .slot[data-tone=mid] .ring .fill{stroke:var(--warning-color,#f0a020)}
  .slot[data-tone=low] .ring .fill{stroke:var(--error-color,#db4437)}
  .ring span{position:absolute;inset:0;display:grid;place-items:center;font-size:15px;font-weight:700}
  .scent{font-size:14px;font-weight:600;text-align:center;line-height:1.25;max-width:100%;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .tag{font-size:11px;padding:2px 8px;border-radius:999px;color:var(--secondary-text-color);background:var(--card-background-color,#fff)}
  .slot[data-active=true] .tag{background:var(--slot-color);color:#fff}
  .slot[data-tone=low] .tag:not(.on){color:var(--error-color,#db4437)}
  .steps{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
  .step{height:44px;border-radius:12px;background:var(--secondary-background-color,#f1f1f1);font-weight:600;color:var(--secondary-text-color)}
  .step[data-filled=true]{background:color-mix(in srgb,var(--kuni-accent) calc(30% + var(--i) * 10%),var(--secondary-background-color,#f1f1f1));color:var(--text-primary-color,#fff)}
  .step[data-current=true]{box-shadow:inset 0 0 0 2px var(--kuni-accent)}
  .chips{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
  .chip{min-height:44px;padding:0 6px;white-space:nowrap;border-radius:999px;background:var(--secondary-background-color,#f1f1f1);font-weight:500}
  .chip[data-selected=true]{background:var(--kuni-accent);color:var(--text-primary-color,#fff)}
  .countdown{font-variant-numeric:tabular-nums;color:var(--kuni-accent);font-weight:600}
  .message{margin-top:14px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--error-color,#db4437) 12%,transparent);color:var(--error-color,#db4437);font-size:13px}
  .empty{padding:8px 0;color:var(--secondary-text-color)}
  ha-card[data-pending=true] .controls{opacity:.7}
  @media (max-width:420px){ha-card{padding:16px}.device{width:80px;height:104px}.device svg{width:66px;height:92px}.power{width:50px;height:50px}.slot{min-height:122px}.ring,.ring svg{width:56px;height:56px}.step{height:42px}}
  @media (prefers-reduced-motion:reduce){ha-card[data-on=true] .device .kuni-mist{animation:none}}
`;

class KuniDeviceCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._roles = {};
    this._pending = false;
    this._message = "";
    this._generation = 0;
    this.shadowRoot.addEventListener("click", (event) => this._click(event));
    // Never swap the DOM between pointerdown and click, or the tap is lost.
    this.shadowRoot.addEventListener("pointerdown", () => {
      this._holding = true;
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this._release(), 1500);
    });
    for (const type of ["pointerup", "pointercancel"]) this.shadowRoot.addEventListener(type, () => setTimeout(() => this._release(), 60));
  }
  _release() {
    clearTimeout(this._holdTimer);
    if (!this._holding) return;
    this._holding = false;
    if (this._deferred) { this._deferred = false; this._render(); }
  }
  connectedCallback() { this._startTicker(); }
  disconnectedCallback() { clearInterval(this._ticker); this._ticker = undefined; }
  setConfig(config) {
    this._config = validateConfig(config);
    this._generation++;
    this._device = undefined;
    this._roles = {};
    this._resolved = false;
    this._registryError = "";
    this._message = "";
    if (this._hass) this._discover(true);
    this._render();
  }
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._config && (first || !this._resolved) && !this._resolving) this._discover();
    this._render();
  }
  getCardSize() { return 6; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }
  static getStubConfig() { return {}; }
  static getConfigElement() { return document.createElement("kuni-device-card-editor"); }
  get _language() { return this._config?.language || (this._hass?.language?.startsWith("he") ? "he" : "en"); }
  _t(key) { return TEXT[this._language][key] || TEXT.en[key] || key; }
  _state(role) { return this._hass?.states?.[this._roles[role]]; }
  _startTicker() {
    clearInterval(this._ticker);
    this._ticker = setInterval(() => { if (this._timeLeft() > 0) this._render(); }, 1000);
  }
  async _discover(retry = false) {
    this._resolving = true;
    const generation = this._generation;
    const hass = this._hass;
    const key = hass.connection || hass;
    try {
      if (retry) registryCache.delete(key);
      if (!registryCache.has(key)) registryCache.set(key, Promise.all([
        hass.callWS({ type: "config/device_registry/list" }), hass.callWS({ type: "config/entity_registry/list" }),
      ]));
      const [devices, entries] = await registryCache.get(key);
      if (generation !== this._generation) return;
      this._device = resolveDevice(this._config, devices, entries);
      this._roles = this._device ? resolveRoles(this._device, entries) : {};
      this._registryError = "";
    } catch {
      registryCache.delete(key);
      if (generation === this._generation) this._registryError = this._t("registry_error");
    } finally {
      if (generation === this._generation) { this._resolved = true; this._resolving = false; this._render(); }
    }
  }
  _timeLeft() { return remainingSeconds(this._state("time_left"), Date.now(), this._timerSet); }
  _isOn() { return this._state("power")?.state === "on"; }
  _available() { const p = this._state("power"); return !!p && !BAD_STATES.has(p.state); }
  _slots() {
    const select = this._state("scent");
    const options = select?.attributes?.options || [];
    let activeIndex = select && !BAD_STATES.has(select.state) ? options.indexOf(select.state) : -1;
    // Show the tapped scent right away until the device confirms it (the cloud reports back on the next 30 s poll; give up after 45 s).
    if (this._want) {
      if (activeIndex === this._want.index || Date.now() - this._want.at > 45000) this._want = undefined;
      else activeIndex = this._want.index;
    }
    const slots = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this._state(`slot_${i + 1}`);
      const raw = s && !BAD_STATES.has(s.state) ? Number(s.state) : NaN;
      const level = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : NaN;
      const fromOption = options[i] ? String(options[i]).split(" · ")[0] : "";
      const name = s?.attributes?.scent_name || fromOption || "";
      if (!s && !options[i]) continue;
      slots.push({ index: i, name, level, option: options[i], active: i === activeIndex, tone: name ? levelTone(level) : "unknown", color: scentColor(name, i, this._config?.scent_colors) });
    }
    return slots;
  }
  async _call(domain, service, data) {
    // Last tap wins: while a command is running, keep only the newest one.
    if (this._pending) { this._queued = [domain, service, data]; return; }
    this._pending = true;
    this._message = "";
    this._render();
    try {
      await this._hass.callService(domain, service, data);
    } catch {
      this._message = this._t("failed");
    } finally {
      this._pending = false;
      const next = this._queued;
      this._queued = undefined;
      if (next) this._call(...next); else this._render();
    }
  }
  _click(event) {
    const target = event.target?.closest?.("button");
    if (!target || target.disabled) return;
    const d = target.dataset;
    if (d.action === "power") {
      const id = this._roles.power;
      if (id) this._call("switch", this._isOn() ? "turn_off" : "turn_on", { entity_id: id });
    } else if (d.action === "scent") {
      const slot = this._slots().find((s) => String(s.index) === d.slot);
      const select = this._state("scent");
      if (slot?.option && select?.attributes?.options?.includes(slot.option) && !slot.active) {
        this._want = { index: slot.index, at: Date.now() };
        this._render();
        this._call("select", "select_option", { entity_id: this._roles.scent, option: slot.option });
      }
    } else if (d.action === "intensity") {
      const n = Number(d.value);
      const st = this._state("intensity");
      const { min = 1, max = 7 } = st?.attributes || {};
      if (Number.isInteger(n) && n >= min && n <= max && String(n) !== String(Number(st?.state))) {
        this._call("number", "set_value", { entity_id: this._roles.intensity, value: n });
      }
    } else if (d.action === "timer") {
      const seconds = Number(d.seconds);
      if (!this._device) return;
      this._timerSet = seconds > 0 ? { seconds, at: Date.now() } : undefined;
      if (seconds > 0) this._call(KUNI_DOMAIN, "set_timer", { device_id: this._device.id, duration_seconds: seconds });
      else if (this._roles.power) this._call("switch", "turn_on", { entity_id: this._roles.power });
    }
  }
  _render() {
    if (!this._config) return;
    if (this._holding) { this._deferred = true; return; }
    const t = (k) => this._t(k);
    const dir = this._language === "he" ? "rtl" : "ltr";
    let body;
    if (!this._resolved && !this._registryError) {
      body = `<div class="empty">…</div>`;
    } else if (this._registryError || !this._device) {
      body = `<div class="empty">${escapeHTML(this._registryError || t("not_found"))}</div>`;
    } else {
      const on = this._isOn();
      const available = this._available();
      const slots = this._slots();
      const active = slots.find((s) => s.active);
      const intensity = this._state("intensity");
      const current = Number(intensity?.state);
      const min = Number(intensity?.attributes?.min ?? 1);
      const max = Number(intensity?.attributes?.max ?? 7);
      const left = this._timeLeft();
      const name = this._config.name || this._device.name_by_user || this._device.name || "Kuni";
      const status = !available ? t("unavailable") : [
        `<b>${on ? t("on") : t("off")}</b>`,
        active ? escapeHTML(active.name) : "",
        on && left > 0 ? `${t("left")} <span class="countdown">${formatDuration(left, t)}</span>` : "",
      ].filter(Boolean).join(" · ");
      const disabled = !available ? "disabled" : "";
      const circumference = 2 * Math.PI * 27;
      const slotHTML = slots.map((s) => {
        const pct = Number.isFinite(s.level) ? Math.round(s.level) : null;
        const offset = circumference * (1 - (pct ?? 0) / 100);
        const tag = s.active ? t("active") : !s.name ? t("empty") : s.tone === "low" ? t("low") : `${t("slot")} ${s.index + 1}`;
        const label = `${s.name || t("empty")}, ${t("level")} ${pct ?? "?"}%${s.active ? `, ${t("active")}` : ""}`;
        return `<button class="slot" data-action="scent" data-slot="${s.index}" data-active="${s.active}" data-tone="${s.tone}" style="--slot-color:${s.color}" aria-pressed="${s.active}" aria-label="${escapeHTML(label)}" ${disabled || !s.option ? "disabled" : ""}>
          <div class="ring"><svg viewBox="0 0 64 64"><circle class="track" cx="32" cy="32" r="27" fill="none" stroke-width="6"/><circle class="fill" cx="32" cy="32" r="27" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/></svg><span>${pct ?? "–"}%</span></div>
          <div class="scent">${escapeHTML(s.name || t("empty"))}</div>
          <div class="tag ${s.active ? "on" : ""}">${escapeHTML(tag)}</div>
        </button>`;
      }).join("");
      const steps = [];
      for (let i = min; i <= max; i++) {
        steps.push(`<button class="step" data-action="intensity" data-value="${i}" style="--i:${i - min}" data-filled="${Number.isFinite(current) && i <= current}" data-current="${i === current}" aria-pressed="${i === current}" aria-label="${t("intensity")} ${i}" ${disabled || !this._roles.intensity ? "disabled" : ""}>${i}</button>`);
      }
      const chips = [`<button class="chip" data-action="timer" data-seconds="0" data-selected="${on && left === 0}" ${disabled}>${t("no_timer")}</button>`]
        .concat(TIMER_PRESETS.map((sec) => `<button class="chip" data-action="timer" data-seconds="${sec}" ${disabled}>${presetLabel(sec, t)}</button>`)).join("");
      body = `<div class="hero">
          <div class="device">${this._config.image ? `<img class="photo" src="${escapeHTML(this._config.image)}" alt="">` : DEVICE_ART}</div>
          <div><p class="name">${escapeHTML(name)}</p><div class="status">${status}</div></div>
          <button class="power" data-action="power" aria-label="${on ? t("turn_off") : t("turn_on")}" aria-pressed="${on}" ${disabled || !this._roles.power ? "disabled" : ""}><ha-icon icon="mdi:power"></ha-icon></button>
        </div>
        <div class="controls">
          <h3>${t("scents")}<small>${this._pending ? t("sending") : t("select_scent")}</small></h3>
          <div class="slots">${slotHTML || `<div class="empty">${t("empty")}</div>`}</div>
          <h3>${t("intensity")}<small>${Number.isFinite(current) ? `${current} / ${max}` : "–"}</small></h3>
          <div class="steps">${steps.join("")}</div>
          <h3>${t("timer")}<small>${on && left > 0 ? `${t("timer_running")} <span class="countdown">${formatDuration(left, t)}</span>` : ""}</small></h3>
          <div class="chips">${chips}</div>
        </div>
        ${this._message ? `<div class="message" role="alert">${escapeHTML(this._message)}</div>` : ""}`;
      this._accent = active?.color;
    }
    const accent = this._accent ? `--kuni-accent:${this._accent};` : "";
    const html = `<style>${KUNI_STYLES}</style><ha-card dir="${dir}" style="${accent}" data-on="${this._isOn()}" data-pending="${this._pending}">${body}</ha-card>`;
    if (html === this._html) return;
    this._html = html;
    this.shadowRoot.innerHTML = html;
  }
}

class KuniDeviceCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.addEventListener("change", (event) => this._change(event));
  }
  setConfig(config) { this._config = { ...config }; this._render(); }
  set hass(hass) {
    this._hass = hass;
    if (hass?.callWS && !this._devices && !this._loading) {
      this._loading = true;
      Promise.all([hass.callWS({ type: "config/device_registry/list" }), hass.callWS({ type: "config/entity_registry/list" })])
        .then(([devices, entries]) => { this._devices = kuniDevices(devices, entries); this._render(); })
        .catch(() => { this._devices = []; this._render(); });
    }
    this._render();
  }
  _t(key) { const lang = this._config?.language || (this._hass?.language?.startsWith("he") ? "he" : "en"); return TEXT[lang][key] || key; }
  _change(event) {
    const field = event.target?.dataset?.field;
    if (!field) return;
    const config = { ...this._config };
    const value = event.target.value;
    if (value) config[field] = value; else delete config[field];
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    this._render();
  }
  _render() {
    if (!this._config) return;
    if (["INPUT", "SELECT"].includes(this.shadowRoot.activeElement?.tagName)) return;
    const c = this._config;
    const devices = this._devices || [];
    const html = `<style>:host{display:block}label{display:grid;gap:6px;font-size:13px;margin:12px 0}input,select{font:inherit;color:inherit;background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:10px;min-height:44px;box-sizing:border-box;width:100%}</style>
      <label>${this._t("editor_device")}<select data-field="device_id"><option value="">${this._t("automatic")}</option>${devices.map((d) => `<option value="${escapeHTML(d.id)}" ${d.id === c.device_id ? "selected" : ""}>${escapeHTML(d.name_by_user || d.name || d.id)}</option>`).join("")}</select></label>
      <label>${this._t("editor_name")}<input data-field="name" value="${escapeHTML(c.name || "")}"></label>
      <label>${this._t("editor_language")}<select data-field="language"><option value="" ${!c.language ? "selected" : ""}>${this._t("automatic")}</option><option value="he" ${c.language === "he" ? "selected" : ""}>עברית</option><option value="en" ${c.language === "en" ? "selected" : ""}>English</option></select></label>`;
    if (html === this._html) return;
    this._html = html;
    this.shadowRoot.innerHTML = html;
  }
}

if (!customElements.get("kuni-device-card-editor")) customElements.define("kuni-device-card-editor", KuniDeviceCardEditor);
if (!customElements.get("kuni-device-card")) customElements.define("kuni-device-card", KuniDeviceCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "kuni-device-card")) window.customCards.push({
  type: "kuni-device-card", name: "Kuni scent diffuser", description: "Device, scent levels, scent choice, intensity and timer for Kuni diffusers.", preview: true,
});
console.info(`%c KUNI-DEVICE-CARD %c ${KUNI_VERSION} `, "background:#b48ad8;color:#fff;font-weight:700", "");
