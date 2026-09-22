// Focus Cap — full dashboard (options page). Manages blocked sites, the daily
// limit, the enforcement/blackout schedule, onboarding, and advanced settings.
// schedule.js (scheduleStateAt, SCHED_DAY_ABBR) is loaded before this file.

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

const DEFAULT_BUDGET_SECONDS = 1800;
const MAX_BUDGET_SECONDS = 2 * 60 * 60;
const MIN_BUDGET_SECONDS = 60;
const REMOVE_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_SCHEDULE = { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [] };
const PRESETS = [
  "youtube.com", "instagram.com", "tiktok.com", "twitter.com",
  "reddit.com", "facebook.com", "netflix.com", "twitch.tv"
];
const DAY_ABBR = typeof SCHED_DAY_ABBR !== "undefined"
  ? SCHED_DAY_ABBR : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const el = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function usedMsToday(usage) {
  if (!usage || usage.date !== todayKey()) return 0;
  return usage.totalMs || 0;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
function normalizeDomain(raw) {
  let d = (raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return d.split("/")[0].split(":")[0];
}
// Removing a site is blocked in the final 5 min of budget (or once spent),
// unless the whole budget is ≤5 min (which would otherwise never allow it).
function removalLocked(usedMs, budgetMs) {
  if (usedMs >= budgetMs) return true;
  if (budgetMs <= REMOVE_LOCK_MS) return false;
  return budgetMs - usedMs <= REMOVE_LOCK_MS;
}

let store = {}; // cached storage snapshot
function schedule() {
  return Object.assign({}, DEFAULT_SCHEDULE, store.schedule || {});
}

async function load() {
  store = await get([
    "focusSites", "budgetSeconds", "usage", "settings", "schedule", "onboarded"
  ]);
  render();
}

async function persist(patch) {
  Object.assign(store, patch);
  await set(patch);
  render();
}

function render() {
  renderOnboarding();
  renderSites();
  renderBudget();
  renderSchedule();
  el("idleInput").value = (store.settings || { idleSeconds: 45 }).idleSeconds;
}

// --- Onboarding --------------------------------------------------------------

function renderOnboarding() {
  const box = el("onboard");
  if (store.onboarded) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const grid = el("presetSites");
  if (grid.childElementCount) return; // build once
  PRESETS.forEach((domain) => {
    const chip = document.createElement("div");
    chip.className = "preset";
    chip.dataset.domain = domain;
    chip.textContent = domain;
    chip.addEventListener("click", () => chip.classList.toggle("on"));
    grid.appendChild(chip);
  });
}

async function finishOnboarding(save) {
  const patch = { onboarded: true };
  if (save) {
    const chosen = [...document.querySelectorAll(".preset.on")].map((c) => c.dataset.domain);
    const sites = store.focusSites || [];
    chosen.forEach((d) => {
      if (!sites.some((s) => s.domain === d)) sites.push({ domain: d });
    });
    patch.focusSites = sites;
    const mins = (parseInt(el("obHours").value, 10) || 0) * 60 + (parseInt(el("obMinutes").value, 10) || 0);
    patch.budgetSeconds = Math.min(MAX_BUDGET_SECONDS, Math.max(MIN_BUDGET_SECONDS, mins * 60));
  }
  await persist(patch);
}

// --- Blocked sites -----------------------------------------------------------

function renderSites() {
  const list = el("siteList");
  const sites = store.focusSites || [];
  const budgetMs = (store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
  const lockRemove = removalLocked(usedMsToday(store.usage), budgetMs);

  list.innerHTML = "";
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites yet — add one below.";
    list.appendChild(li);
    return;
  }
  sites.forEach((s, i) => {
    const li = document.createElement("li");
    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = s.domain;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "×";
    if (lockRemove) {
      remove.disabled = true;
      remove.title = "Can't remove near/at your daily limit — resets tomorrow";
    } else {
      remove.title = "Remove";
      remove.addEventListener("click", () => removeSite(i));
    }
    li.append(domain, remove);
    list.appendChild(li);
  });
}

async function addSite(e) {
  e.preventDefault();
  const domain = normalizeDomain(el("domainInput").value);
  if (!domain) return;
  const sites = store.focusSites || [];
  if (sites.some((s) => s.domain === domain)) return;
  el("domainInput").value = "";
  await persist({ focusSites: [...sites, { domain }] });
}

async function removeSite(index) {
  const budgetMs = (store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
  if (removalLocked(usedMsToday(store.usage), budgetMs)) return; // guard the race
  const sites = [...(store.focusSites || [])];
  sites.splice(index, 1);
  await persist({ focusSites: sites });
}

// --- Daily limit -------------------------------------------------------------

function renderBudget() {
  const budgetSeconds = store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  const budgetMs = budgetSeconds * 1000;
  const usedMs = usedMsToday(store.usage);
  const locked = usedMs >= budgetMs;

  el("budgetHours").value = Math.floor(budgetSeconds / 3600);
  el("budgetMinutes").value = Math.round((budgetSeconds % 3600) / 60);
  el("budgetHours").disabled = locked;
  el("budgetMinutes").disabled = locked;
  el("budgetNote").hidden = !locked;

  const box = el("remaining");
  const fill = el("barFill");
  const pct = budgetMs > 0 ? Math.min(100, (usedMs / budgetMs) * 100) : 100;
  fill.style.width = `${pct}%`;
  fill.className = "bar-fill" + (locked ? " full" : pct > 75 ? " warn" : "");
  if (locked) {
    box.textContent = "🔒 Daily limit reached";
    box.className = "remaining empty";
  } else {
    box.textContent = `${fmtClock(budgetMs - usedMs)} left today`;
    box.className = "remaining live";
  }
}

async function saveBudget() {
  const budgetMs = (store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
  if (usedMsToday(store.usage) >= budgetMs) { render(); return; } // frozen when spent
  const hours = parseInt(el("budgetHours").value, 10) || 0;
  const minutes = parseInt(el("budgetMinutes").value, 10) || 0;
  const total = Math.min(MAX_BUDGET_SECONDS, Math.max(MIN_BUDGET_SECONDS, hours * 3600 + minutes * 60));
  await persist({ budgetSeconds: total });
}

// --- Schedule ----------------------------------------------------------------

function renderSchedule() {
  const s = schedule();
  el("schedEnabled").checked = s.enabled;
  el("schedBody").hidden = !s.enabled;
  el("schedOff").hidden = s.enabled;
  if (!s.enabled) return;

  // Enforcement days
  const dayRow = el("enforceDays");
  dayRow.innerHTML = "";
  for (let d = 0; d < 7; d++) {
    const b = document.createElement("button");
    b.className = "day-btn" + (s.days.includes(d) ? " on" : "");
    b.textContent = DAY_ABBR[d];
    b.addEventListener("click", () => toggleEnforceDay(d));
    dayRow.appendChild(b);
  }

  // Enforcement windows
  const wl = el("windowList");
  wl.innerHTML = "";
  s.windows.forEach((w, i) => wl.appendChild(timeRow(w, i, "window")));

  // Blackout windows
  const bl = el("blackoutList");
  bl.innerHTML = "";
  s.blackouts.forEach((b, i) => bl.appendChild(blackoutRow(b, i)));
}

function timeInput(value, onChange) {
  const inp = document.createElement("input");
  inp.type = "time";
  inp.value = value || "";
  inp.addEventListener("change", () => onChange(inp.value));
  return inp;
}

function timeRow(win, i, kind) {
  const li = document.createElement("li");
  const start = timeInput(win.start, (v) => updateWindow(i, "start", v));
  const to = document.createElement("span");
  to.className = "to";
  to.textContent = "to";
  const end = timeInput(win.end, (v) => updateWindow(i, "end", v));
  const rm = document.createElement("button");
  rm.className = "row-remove";
  rm.textContent = "×";
  rm.title = "Remove";
  rm.addEventListener("click", () => removeWindow(i));
  li.append(start, to, end, rm);
  return li;
}

function blackoutRow(b, i) {
  const li = document.createElement("li");
  const start = timeInput(b.start, (v) => updateBlackout(i, "start", v));
  const to = document.createElement("span");
  to.className = "to";
  to.textContent = "to";
  const end = timeInput(b.end, (v) => updateBlackout(i, "end", v));
  const rm = document.createElement("button");
  rm.className = "row-remove";
  rm.textContent = "×";
  rm.title = "Remove";
  rm.addEventListener("click", () => removeBlackout(i));
  li.append(start, to, end, rm);

  const days = document.createElement("div");
  days.className = "blackout-days";
  const active = b.days && b.days.length ? b.days : [0, 1, 2, 3, 4, 5, 6];
  for (let d = 0; d < 7; d++) {
    const btn = document.createElement("button");
    btn.className = "day-btn mini" + (active.includes(d) ? " on" : "");
    btn.textContent = DAY_ABBR[d][0];
    btn.title = DAY_ABBR[d];
    btn.addEventListener("click", () => toggleBlackoutDay(i, d));
    days.appendChild(btn);
  }
  li.appendChild(days);
  return li;
}

function toggleEnforceDay(d) {
  const s = schedule();
  s.days = s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort();
  persist({ schedule: s });
}
function addWindow() {
  const s = schedule();
  s.windows = [...s.windows, { start: "09:00", end: "17:00" }];
  persist({ schedule: s });
}
function updateWindow(i, field, val) {
  const s = schedule();
  if (!s.windows[i]) return;
  s.windows[i] = { ...s.windows[i], [field]: val };
  persist({ schedule: s });
}
function removeWindow(i) {
  const s = schedule();
  s.windows.splice(i, 1);
  persist({ schedule: s });
}
function addBlackout() {
  const s = schedule();
  s.blackouts = [...s.blackouts, { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] }];
  persist({ schedule: s });
}
function updateBlackout(i, field, val) {
  const s = schedule();
  if (!s.blackouts[i]) return;
  s.blackouts[i] = { ...s.blackouts[i], [field]: val };
  persist({ schedule: s });
}
function toggleBlackoutDay(i, d) {
  const s = schedule();
  const b = s.blackouts[i];
  if (!b) return;
  const cur = b.days && b.days.length ? b.days : [0, 1, 2, 3, 4, 5, 6];
  b.days = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort();
  persist({ schedule: s });
}
function removeBlackout(i) {
  const s = schedule();
  s.blackouts.splice(i, 1);
  persist({ schedule: s });
}

async function saveIdle() {
  const idleSeconds = Math.max(5, parseInt(el("idleInput").value, 10) || 45);
  await persist({ settings: { idleSeconds } });
}

// --- Wire up -----------------------------------------------------------------

el("addForm").addEventListener("submit", addSite);
el("budgetHours").addEventListener("change", saveBudget);
el("budgetMinutes").addEventListener("change", saveBudget);
el("idleInput").addEventListener("change", saveIdle);
el("schedEnabled").addEventListener("change", (e) =>
  persist({ schedule: { ...schedule(), enabled: e.target.checked } })
);
el("addWindow").addEventListener("click", addWindow);
el("addBlackout").addEventListener("click", addBlackout);
el("obStart").addEventListener("click", () => finishOnboarding(true));
el("obSkip").addEventListener("click", () => finishOnboarding(false));
el("statsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") });
});

// Live-refresh on external changes. Keep the cache fresh, but only rebuild the
// structural UI on real config changes — a per-second usage tick just refreshes
// the countdown, so it never disrupts editing the schedule.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(changes)) store[k] = changes[k].newValue;

  if (changes.focusSites || changes.budgetSeconds || changes.schedule || changes.onboarded) {
    render();
  } else if (changes.usage) {
    renderBudget();
    renderSites(); // the removal lock can flip as you near the limit
  } else if (changes.settings) {
    el("idleInput").value = (store.settings || { idleSeconds: 45 }).idleSeconds;
  }
});

load();
