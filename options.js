// Focus Cap — full dashboard (options page). Manages blocked sites and each
// site's own budget / cool-down / schedule rules, the global daily limit, the
// enforcement/blackout schedule, onboarding, and advanced settings.
//
// shared.js is loaded before this file and provides the bare globals used
// here: todayKey, fmtClock, parseIntOr, fmtUntil, describeStatus, ruleInGrace,
// normalizeDomain, normalizeSite, normalizeUsage, evaluateSite,
// scheduleStateAt, scheduleBlackoutUntil, SCHED_DAY_ABBR and
// SCHEDULE_DEFAULTS. Per-site status is computed with the SAME pure helpers
// background.js enforces with, so what this page shows can never disagree
// with what actually gets blocked.

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

const DEFAULT_SETTINGS = { idleEnabled: true, idleSeconds: 45 };
const DEFAULT_BUDGET_SECONDS = 1800; // global cap across all sites (30 min)
const MAX_BUDGET_SECONDS = 2 * 60 * 60; // hard cap: 2 hours
const MIN_BUDGET_SECONDS = 60; // at least 1 minute
const RETICK_MS = 30_000; // how often time-dependent statuses are re-derived without a storage change
const REMOVE_LOCK_MS = 5 * 60 * 1000; // can't remove sites in the last 5 min
const PRESETS = [
  "youtube.com", "instagram.com", "tiktok.com", "twitter.com",
  "reddit.com", "facebook.com", "netflix.com", "twitch.tv"
];
const STORE_KEYS = ["focusSites", "budgetSeconds", "usage", "settings", "schedule", "onboarded"];

const DEFAULT_RULE = () => ({ type: "block", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", touchedAt: Date.now() });
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const el = (id) => document.getElementById(id);

// Removing a site is blocked once it's fully locked, or in the final 5
// minutes of its budget — the exact window you'd be tempted to game.
// (Skipped for tiny budgets of ≤5 min, which would otherwise never allow it.)
function removalLocked(usedMs, budgetMs) {
  if (usedMs >= budgetMs) return true;
  if (budgetMs <= REMOVE_LOCK_MS) return false;
  return budgetMs - usedMs <= REMOVE_LOCK_MS;
}

// Hours + minutes fields -> seconds, clamped to [1 min, 2 h] like main.
function clampBudgetSeconds(hours, minutes) {
  return Math.min(MAX_BUDGET_SECONDS, Math.max(MIN_BUDGET_SECONDS, hours * 3600 + minutes * 60));
}

// --- State -------------------------------------------------------------------

let store = {}; // cached storage snapshot (kept fresh by onChanged)
let model = computeModel(store); // derived per-site statuses for `store` at "now"

// Which site editors are open, by domain — survives re-renders.
const expanded = new Set();

let retickTimer = null; // the periodic status re-derivation (see retick, below)

function computeModel(snapshot) {
  const now = Date.now();
  const budgetSeconds = snapshot.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  const globalBudgetMs = budgetSeconds * 1000;
  const usage = normalizeUsage(snapshot.usage, now);
  const sites = (snapshot.focusSites || []).map(normalizeSite);
  const schedule = snapshot.schedule;
  const statuses = sites.map((s) => evaluateSite(s, usage, globalBudgetMs, now, schedule));
  return { now, budgetSeconds, globalBudgetMs, usage, sites, statuses, schedule };
}

// Re-read storage and recompute the model (no render).
async function refresh() {
  store = await get(STORE_KEYS);
  model = computeModel(store);
}

async function load() {
  await refresh();
  render();
  renderAdvanced();
}

async function persist(patch) {
  Object.assign(store, patch);
  await set(patch);
  model = computeModel(store);
  render();
}

// Everything that autosaves. The Advanced card is rendered separately: it has
// an explicit Save, so a re-render triggered by some other change must not
// wipe an edit in progress there.
function render() {
  renderOnboarding();
  renderSites();
  renderBudget();
  renderSchedule();
}

// --- Advanced ----------------------------------------------------------------

function renderAdvanced() {
  const s = { ...DEFAULT_SETTINGS, ...(store.settings || {}) };
  const enabled = s.idleEnabled !== false; // default on (back-compat with older data)
  el("idleEnabled").checked = enabled;
  el("idleInput").value = s.idleSeconds;
  reflectIdleEnabled(enabled);
}

// Enable/disable the seconds field to match the checkbox (visual only until Save).
function reflectIdleEnabled(enabled) {
  el("idleSecondsRow").classList.toggle("disabled", !enabled);
  el("idleInput").disabled = !enabled;
}

async function saveAdvanced() {
  const idleEnabled = el("idleEnabled").checked;
  // An explicit 0 clamps to the 5 s minimum; only a blank/garbage field falls
  // back to the default.
  const idleSeconds = Math.max(5, parseIntOr(el("idleInput").value, DEFAULT_SETTINGS.idleSeconds));
  await persist({ settings: { ...DEFAULT_SETTINGS, ...(store.settings || {}), idleEnabled, idleSeconds } });
  renderAdvanced();
  const msg = el("advancedSaved");
  msg.hidden = false;
  clearTimeout(saveAdvanced._t);
  saveAdvanced._t = setTimeout(() => { msg.hidden = true; }, 2000);
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
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "preset";
    chip.dataset.domain = domain;
    chip.textContent = domain;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      const on = chip.classList.toggle("on");
      chip.setAttribute("aria-pressed", String(on));
    });
    grid.appendChild(chip);
  });
}

async function finishOnboarding(save) {
  const patch = { onboarded: true };
  if (save) {
    const chosen = [...document.querySelectorAll(".preset.on")].map((c) => c.dataset.domain);
    const sites = [...(store.focusSites || [])];
    chosen.forEach((d) => {
      if (!sites.some((s) => s && s.domain === d)) sites.push(normalizeSite({ domain: d }));
    });
    patch.focusSites = sites;
    patch.budgetSeconds = clampBudgetSeconds(parseIntOr(el("obHours").value, 0), parseIntOr(el("obMinutes").value, 0));
  }
  await persist(patch);
}

// --- Blocked sites -----------------------------------------------------------

function renderSites() {
  const list = el("siteList");
  const { sites, statuses, usage, schedule, now } = model;
  const blackout = scheduleStateAt(schedule, new Date(now)).blackout;

  list.replaceChildren();
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites yet — add one below.";
    list.appendChild(li);
    return;
  }
  sites.forEach((s, i) => {
    const status = statuses[i];
    const siteUsed = (usage.sites[s.domain] && usage.sites[s.domain].totalMs) || 0;
    const removeLock = status.locked || removalLocked(siteUsed, s.budgetSeconds * 1000);

    const li = document.createElement("li");
    li.dataset.domain = s.domain;
    if (status.locked) li.classList.add("locked");

    const row = document.createElement("div");
    row.className = "row";

    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = s.domain;

    const meta = document.createElement("span");
    meta.className = "budget";
    meta.textContent = describeStatus(status);
    // A global blackout and a per-site block window both lock with reason
    // "schedule"; the blackout outranks the rules, so when one is on that's
    // what the row is showing.
    if (status.locked && status.reason === "schedule") meta.title = blackout ? "Blocked by your global blackout" : "Blocked by a schedule rule";
    else if (status.locked) meta.title = "Out of time";
    else if (status.free) meta.title = "Outside your enforcement hours — time here isn't counted";

    const edit = document.createElement("button");
    edit.className = "edit";
    edit.type = "button";
    edit.textContent = "⚙";
    edit.title = "Budget, cool-down and schedule for this site";
    edit.setAttribute("aria-expanded", String(expanded.has(s.domain)));
    edit.addEventListener("click", () => {
      if (expanded.has(s.domain)) expanded.delete(s.domain);
      else expanded.add(s.domain);
      renderSites();
    });

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "×";
    if (removeLock) {
      // Can't delete a site to dodge the block near/at the limit.
      remove.disabled = true;
      remove.title = status.locked ? "Can't remove while locked" : "Can't remove in the last 5 minutes of its budget";
    } else {
      remove.title = "Remove";
      remove.addEventListener("click", () => removeSite(s.domain));
    }

    row.append(domain, meta, edit, remove);
    li.appendChild(row);
    if (expanded.has(s.domain)) li.appendChild(buildEditor(s, status));
    list.appendChild(li);
  });
}

async function addSite(e) {
  e.preventDefault();
  const domain = normalizeDomain(el("domainInput").value);
  if (!domain) return;
  await refresh();
  const sites = store.focusSites || [];
  if (sites.some((s) => s && s.domain === domain)) return; // no dupes
  el("domainInput").value = "";
  await persist({ focusSites: [...sites, normalizeSite({ domain })] });
}

// Keyed by domain, not list index: a concurrent add/remove (the popup, or a
// re-render racing an in-flight change) must never land on a neighbour.
async function removeSite(domain) {
  await refresh();
  const { sites, statuses, usage } = model;
  const index = sites.findIndex((s) => s.domain === domain);
  if (index === -1) {
    render();
    return;
  }
  const site = sites[index];
  const siteUsed = (usage.sites[site.domain] && usage.sites[site.domain].totalMs) || 0;
  // Refuse removals while locked or in the last 5 minutes of the site's budget.
  if (statuses[index].locked || removalLocked(siteUsed, site.budgetSeconds * 1000)) {
    render();
    return;
  }
  const raw = (store.focusSites || []).slice();
  raw.splice(index, 1);
  expanded.delete(domain); // re-adding the domain later starts collapsed
  await persist({ focusSites: raw });
}

// --- Per-site editor ---------------------------------------------------------
// Every control autosaves on change. While the site is locked the whole
// editor is read-only — loosening a rule or raising the budget is exactly the
// bypass this extension exists to prevent.

function buildEditor(site, status) {
  const box = document.createElement("div");
  box.className = "site-editor";
  const locked = status.locked;
  // Edits are keyed by domain, not list index.
  const key = site.domain;

  if (locked) {
    const note = document.createElement("div");
    note.className = "locked-note";
    const anyGrace = site.rules.some((r) => ruleInGrace(r));
    note.textContent = anyGrace
      ? "Locked — settings can't be changed until it unlocks. A rule you just changed stays editable for a minute."
      : "Locked — settings can't be changed until it unlocks.";
    box.appendChild(note);
  }

  // Budget
  const budgetLabel = document.createElement("label");
  budgetLabel.className = "editor-row";
  budgetLabel.append("Daily budget");
  const budgetWrap = document.createElement("span");
  const budgetInput = document.createElement("input");
  budgetInput.type = "number";
  budgetInput.min = "0.5";
  budgetInput.step = "0.5";
  budgetInput.className = "site-budget";
  budgetInput.value = (site.budgetSeconds / 60).toFixed(site.budgetSeconds % 60 ? 1 : 0);
  budgetInput.disabled = locked;
  budgetInput.addEventListener("change", () => {
    const minutes = parseFloat(budgetInput.value);
    // A zero budget would lock the site instantly (and freeze this editor)
    // with no way back until midnight — refuse it rather than trap the user.
    if (Number.isNaN(minutes) || minutes <= 0) {
      renderSites();
      return;
    }
    updateSite(key, (s) => ({ ...s, budgetSeconds: Math.round(minutes * 60) }));
  });
  budgetWrap.append(budgetInput, " min");
  budgetLabel.appendChild(budgetWrap);
  box.appendChild(budgetLabel);

  // Lockout
  const lockoutLabel = document.createElement("label");
  lockoutLabel.className = "editor-row";
  lockoutLabel.append("After limit");
  const lockoutWrap = document.createElement("span");
  const mode = document.createElement("select");
  mode.className = "lockout-mode";
  for (const [value, text] of [["midnight", "block until midnight"], ["minutes", "block for"]]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    mode.appendChild(opt);
  }
  const hasLockout = typeof site.lockoutSeconds === "number";
  mode.value = hasLockout ? "minutes" : "midnight";
  const lockoutMin = document.createElement("input");
  lockoutMin.type = "number";
  // Whole minutes, minimum 1: a packed build can't report a sub-30 s cool-down on time (#17).
  lockoutMin.min = "1";
  lockoutMin.step = "1";
  lockoutMin.className = "lockout-min";
  lockoutMin.value = hasLockout ? String(Math.round(site.lockoutSeconds / 60)) : "60";
  lockoutMin.hidden = !hasLockout;
  const lockoutUnit = document.createElement("span");
  lockoutUnit.textContent = hasLockout ? " min" : "";
  mode.disabled = locked;
  lockoutMin.disabled = locked;
  const saveLockout = () => {
    if (mode.value === "midnight") {
      updateSite(key, (s) => ({ ...s, lockoutSeconds: null }));
      return;
    }
    const minutes = parseIntOr(lockoutMin.value, NaN);
    if (Number.isNaN(minutes) || minutes < 1) return;
    updateSite(key, (s) => ({ ...s, lockoutSeconds: minutes * 60 }));
  };
  mode.addEventListener("change", () => {
    lockoutMin.hidden = mode.value !== "minutes";
    lockoutUnit.textContent = mode.value === "minutes" ? " min" : "";
    saveLockout();
  });
  lockoutMin.addEventListener("change", saveLockout);
  lockoutWrap.append(mode, " ", lockoutMin, lockoutUnit);
  lockoutLabel.appendChild(lockoutWrap);
  box.appendChild(lockoutLabel);

  // Schedule rules
  const rulesHead = document.createElement("div");
  rulesHead.className = "rules-head";
  rulesHead.textContent = site.rules.length ? "Schedule" : "Schedule — none (budget applies all day)";
  box.appendChild(rulesHead);

  const rules = document.createElement("div");
  rules.className = "rules";
  site.rules.forEach((rule, ri) => rules.appendChild(buildRuleRow(rule, key, ri, locked)));
  box.appendChild(rules);

  const addRule = document.createElement("button");
  addRule.type = "button";
  addRule.className = "add-rule";
  addRule.textContent = "+ Add rule";
  addRule.disabled = locked;
  addRule.addEventListener("click", () => updateSite(key, (s) => ({ ...s, rules: [...s.rules, DEFAULT_RULE()] })));
  box.appendChild(addRule);

  return box;
}

function buildRuleRow(rule, siteKey, ruleIndex, siteLocked) {
  const row = document.createElement("div");
  row.className = "rule-row";
  // This row stays live while the site is locked only during its grace window.
  const locked = siteLocked && !ruleInGrace(rule);
  if (siteLocked && !locked) row.classList.add("grace");

  const patchRule = (patch) =>
    updateSite(
      siteKey,
      (s) => ({
        ...s,
        rules: s.rules.map((r, i) => (i === ruleIndex ? { ...r, ...patch, touchedAt: Date.now() } : r))
      }),
      { ruleIndex }
    );

  const type = document.createElement("select");
  type.className = "rule-type";
  for (const [value, text] of [["block", "Block"], ["allow", "Allow only"]]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    type.appendChild(opt);
  }
  type.value = rule.type === "allow" ? "allow" : "block";
  type.disabled = locked;
  type.addEventListener("change", () => patchRule({ type: type.value }));

  const days = document.createElement("div");
  days.className = "days";
  DAY_LABELS.forEach((label, day) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-toggle";
    b.textContent = label;
    b.title = DAY_NAMES[day];
    const on = Array.isArray(rule.days) && rule.days.includes(day);
    b.setAttribute("aria-pressed", String(on));
    b.disabled = locked;
    b.addEventListener("click", () => {
      const cur = Array.isArray(rule.days) ? rule.days : [];
      const next = on ? cur.filter((d) => d !== day) : [...new Set([...cur, day])].sort((a, z) => a - z);
      patchRule({ days: next });
    });
    days.appendChild(b);
  });

  const removeRule = document.createElement("button");
  removeRule.type = "button";
  removeRule.className = "remove remove-rule";
  removeRule.textContent = "×";
  removeRule.title = "Remove rule";
  removeRule.disabled = locked;
  removeRule.addEventListener("click", () =>
    updateSite(siteKey, (s) => ({ ...s, rules: s.rules.filter((_, i) => i !== ruleIndex) }), { ruleIndex })
  );

  const times = document.createElement("div");
  times.className = "times";
  const start = document.createElement("input");
  start.type = "time";
  start.className = "rule-start";
  start.value = rule.start || "09:00";
  start.disabled = locked;
  start.addEventListener("change", () => patchRule({ start: start.value }));
  const to = document.createElement("span");
  to.className = "to";
  to.textContent = "to";
  const end = document.createElement("input");
  end.type = "time";
  end.className = "rule-end";
  end.value = rule.end || "17:00";
  end.disabled = locked;
  end.addEventListener("change", () => patchRule({ end: end.value }));
  times.append(start, to, end);

  row.append(type, days, removeRule, times);
  return row;
}

// Apply `mutate` to the stored site with this `domain` and persist. Refuses
// while the site is locked (re-checked against live storage, not the rendered
// snapshot) or if the site no longer exists. The one exception: an edit or
// removal of a rule that is still inside its grace window (opts.ruleIndex).
async function updateSite(domain, mutate, opts = {}) {
  await refresh();
  const { sites, statuses } = model;
  const index = sites.findIndex((s) => s.domain === domain);
  if (index === -1) {
    render();
    return false;
  }
  if (statuses[index].locked) {
    const rule = typeof opts.ruleIndex === "number" ? sites[index].rules[opts.ruleIndex] : null;
    if (!ruleInGrace(rule)) {
      render();
      return false;
    }
  }
  const raw = (store.focusSites || []).slice();
  raw[index] = normalizeSite(mutate(sites[index]));
  await persist({ focusSites: raw });
  return true;
}

// --- Daily limit (global cap) ------------------------------------------------

function fillBudgetFields(budgetSeconds) {
  // Round to whole minutes first so a non-minute-aligned value (e.g. 3599)
  // carries into the hours field instead of rendering as "60" minutes.
  const totalMinutes = Math.round(budgetSeconds / 60);
  el("budgetHours").value = Math.floor(totalMinutes / 60);
  el("budgetMinutes").value = totalMinutes % 60;
}

// True while the cursor is in one of the Daily-limit fields.
function editingBudget() {
  const active = document.activeElement;
  return active === el("budgetHours") || active === el("budgetMinutes");
}

function renderBudget() {
  const { budgetSeconds, globalBudgetMs, usage } = model;
  const usedMs = usage.totalMs;
  const locked = usedMs >= globalBudgetMs;

  // A background usage tick re-renders this card every second while a
  // tracked site is open elsewhere; don't overwrite a half-typed limit. Once
  // the cap is spent the fields freeze anyway, so the stored value wins.
  if (locked || !editingBudget()) fillBudgetFields(budgetSeconds);
  el("budgetHours").disabled = locked;
  el("budgetMinutes").disabled = locked;
  el("budgetNote").hidden = !locked;

  const box = el("remaining");
  const fill = el("barFill");
  const pct = globalBudgetMs > 0 ? Math.min(100, (usedMs / globalBudgetMs) * 100) : 100;
  fill.style.width = `${pct}%`;
  fill.className = "bar-fill" + (locked ? " full" : pct > 75 ? " warn" : "");
  if (locked) {
    box.textContent = "🔒 Daily limit reached";
    box.className = "remaining empty";
  } else {
    box.textContent = `${fmtClock(globalBudgetMs - usedMs)} left today`;
    box.className = "remaining live";
  }
}

async function saveBudget() {
  await refresh();
  // Frozen once today's limit is spent: refuse and revert the fields.
  if (model.usage.totalMs >= model.globalBudgetMs) {
    render();
    return;
  }
  const total = clampBudgetSeconds(parseIntOr(el("budgetHours").value, 0), parseIntOr(el("budgetMinutes").value, 0));
  await persist({ budgetSeconds: total });
  // Reflect the clamped value back (e.g. 3h -> 2h 0m) even if the field still
  // has focus — renderBudget() skips the fill while you're typing.
  fillBudgetFields(total);
}

// --- Global schedule ---------------------------------------------------------

// A fresh copy of the stored schedule over the defaults; mutations below build
// new arrays rather than editing the cached snapshot in place.
function schedule() {
  const s = { ...SCHEDULE_DEFAULTS, ...(store.schedule || {}) };
  s.days = Array.isArray(s.days) ? [...s.days] : [...SCHEDULE_DEFAULTS.days];
  s.windows = Array.isArray(s.windows) ? [...s.windows] : [];
  s.blackouts = Array.isArray(s.blackouts) ? [...s.blackouts] : [];
  return s;
}

function renderSchedule() {
  const s = schedule();
  el("schedEnabled").checked = !!s.enabled;
  el("schedBody").hidden = !s.enabled;
  el("schedOff").hidden = !!s.enabled;
  if (!s.enabled) return;

  // Enforcement days
  const dayRow = el("enforceDays");
  dayRow.replaceChildren();
  for (let d = 0; d < 7; d++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-btn" + (s.days.includes(d) ? " on" : "");
    b.textContent = SCHED_DAY_ABBR[d];
    b.setAttribute("aria-pressed", String(s.days.includes(d)));
    b.addEventListener("click", () => toggleEnforceDay(d));
    dayRow.appendChild(b);
  }

  // Enforcement windows
  const wl = el("windowList");
  wl.replaceChildren();
  s.windows.forEach((w, i) => wl.appendChild(windowRow(w, i)));

  // Blackout windows
  const bl = el("blackoutList");
  bl.replaceChildren();
  s.blackouts.forEach((b, i) => bl.appendChild(blackoutRow(b, i)));
}

function timeInput(value, onChange) {
  const inp = document.createElement("input");
  inp.type = "time";
  inp.value = value || "";
  inp.addEventListener("change", () => onChange(inp.value));
  return inp;
}

function timeSpan(win, onStart, onEnd, onRemove) {
  const start = timeInput(win.start, onStart);
  start.className = "win-start";
  const to = document.createElement("span");
  to.className = "to";
  to.textContent = "to";
  const end = timeInput(win.end, onEnd);
  end.className = "win-end";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "row-remove";
  rm.textContent = "×";
  rm.title = "Remove";
  rm.addEventListener("click", onRemove);
  return [start, to, end, rm];
}

function windowRow(w, i) {
  const li = document.createElement("li");
  li.append(...timeSpan(w, (v) => updateWindow(i, "start", v), (v) => updateWindow(i, "end", v), () => removeWindow(i)));
  return li;
}

function blackoutRow(b, i) {
  const li = document.createElement("li");
  li.append(...timeSpan(b, (v) => updateBlackout(i, "start", v), (v) => updateBlackout(i, "end", v), () => removeBlackout(i)));

  const days = document.createElement("div");
  days.className = "blackout-days";
  const active = Array.isArray(b.days) && b.days.length ? b.days : SCHEDULE_DEFAULTS.days;
  for (let d = 0; d < 7; d++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-btn mini" + (active.includes(d) ? " on" : "");
    btn.textContent = SCHED_DAY_ABBR[d][0];
    btn.title = SCHED_DAY_ABBR[d];
    btn.setAttribute("aria-pressed", String(active.includes(d)));
    btn.addEventListener("click", () => toggleBlackoutDay(i, d));
    days.appendChild(btn);
  }
  li.appendChild(days);
  return li;
}

const sortDays = (days) => [...days].sort((a, b) => a - b);

function toggleEnforceDay(d) {
  const s = schedule();
  s.days = s.days.includes(d) ? s.days.filter((x) => x !== d) : sortDays([...s.days, d]);
  return persist({ schedule: s });
}
function addWindow() {
  const s = schedule();
  s.windows = [...s.windows, { start: "09:00", end: "17:00" }];
  return persist({ schedule: s });
}
function updateWindow(i, field, val) {
  const s = schedule();
  if (!s.windows[i]) return;
  s.windows[i] = { ...s.windows[i], [field]: val };
  return persist({ schedule: s });
}
function removeWindow(i) {
  const s = schedule();
  s.windows = s.windows.filter((_, x) => x !== i);
  return persist({ schedule: s });
}
function addBlackout() {
  const s = schedule();
  s.blackouts = [...s.blackouts, { start: "22:00", end: "06:00", days: [...SCHEDULE_DEFAULTS.days] }];
  return persist({ schedule: s });
}
function updateBlackout(i, field, val) {
  const s = schedule();
  if (!s.blackouts[i]) return;
  s.blackouts[i] = { ...s.blackouts[i], [field]: val };
  return persist({ schedule: s });
}
function toggleBlackoutDay(i, d) {
  const s = schedule();
  const b = s.blackouts[i];
  if (!b) return;
  const cur = Array.isArray(b.days) && b.days.length ? b.days : SCHEDULE_DEFAULTS.days;
  s.blackouts[i] = { ...b, days: cur.includes(d) ? cur.filter((x) => x !== d) : sortDays([...cur, d]) };
  return persist({ schedule: s });
}
function removeBlackout(i) {
  const s = schedule();
  s.blackouts = s.blackouts.filter((_, x) => x !== i);
  return persist({ schedule: s });
}

function openStats(e) {
  if (e && typeof e.preventDefault === "function") e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") }).catch(() => {});
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    removalLocked,
    normalizeDomain,
    clampBudgetSeconds,
    todayKey,
    fmtClock,
    load,
    addSite,
    removeSite,
    updateSite,
    saveBudget,
    saveAdvanced,
    finishOnboarding,
    openStats,
    expanded,
    stopRetick: () => clearInterval(retickTimer)
  };
}

// --- Wire up -----------------------------------------------------------------

el("addForm").addEventListener("submit", addSite);
el("budgetHours").addEventListener("change", saveBudget);
el("budgetMinutes").addEventListener("change", saveBudget);
el("idleEnabled").addEventListener("change", (e) => reflectIdleEnabled(e.target.checked));
el("saveAdvanced").addEventListener("click", saveAdvanced);
el("schedEnabled").addEventListener("change", (e) => persist({ schedule: { ...schedule(), enabled: e.target.checked } }));
el("addWindow").addEventListener("click", addWindow);
el("addBlackout").addEventListener("click", addBlackout);
el("obStart").addEventListener("click", () => finishOnboarding(true));
el("obSkip").addEventListener("click", () => finishOnboarding(false));
el("statsLink").addEventListener("click", openStats);

// Live-refresh on external changes (the popup, the background's usage ticks).
// Keep the cache fresh, but only rebuild the structural UI on real config
// changes — a per-second usage tick refreshes the countdown and the lock
// state, and never yanks a control out from under someone mid-edit.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(changes)) {
    if (STORE_KEYS.includes(k)) store[k] = changes[k].newValue;
  }
  model = computeModel(store);

  if (changes.focusSites || changes.budgetSeconds || changes.schedule || changes.onboarded) {
    render();
  } else if (changes.usage) {
    renderBudget();
    // The removal lock and the per-site countdowns flip as you near a limit —
    // but don't drop focus from an open site editor for a tick.
    const active = document.activeElement;
    const editing = active && typeof active.closest === "function" && active.closest(".site-editor");
    if (!editing) renderSites();
  }
  if (changes.settings) renderAdvanced();
});

// Statuses are time-dependent (a rule window opening, a cool-down ending, a
// blackout starting) but storage only changes while a tracked site is open
// somewhere. Re-derive from the cached snapshot on a coarse timer, and when
// the tab comes back into view, so a long-lived Dashboard tab doesn't show a
// stale row. Same focus guard as the usage tick: never yank an open editor.
function retick() {
  model = computeModel(store);
  renderBudget();
  const active = document.activeElement;
  const editing = active && typeof active.closest === "function" && active.closest(".site-editor");
  if (!editing) renderSites();
}
retickTimer = setInterval(retick, RETICK_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) retick();
});

load();
