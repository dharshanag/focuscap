// Focus Cap — dashboard popup logic. Reads/writes chrome.storage.local;
// the background worker and content scripts react to those changes.
//
// Per-site status here is computed with the SAME pure helpers background.js
// enforces with (shared.js: normalizeSite / normalizeUsage / evaluateSite),
// so what the popup shows can never disagree with what actually gets blocked.

const DEFAULT_SETTINGS = { idleEnabled: true, idleSeconds: 45 };
const DEFAULT_BUDGET_SECONDS = 1800; // global cap across all sites (30 min)
const REMOVE_LOCK_MS = 5 * 60 * 1000; // can't remove sites in the last 5 min

// Removing a site is blocked once it's fully locked, or in the final 5
// minutes of its budget — the exact window you'd be tempted to game.
// (Skipped for tiny budgets of ≤5 min, which would otherwise never allow it.)
function removalLocked(usedMs, budgetMs) {
  if (usedMs >= budgetMs) return true;
  if (budgetMs <= REMOVE_LOCK_MS) return false;
  return budgetMs - usedMs <= REMOVE_LOCK_MS;
}

const el = (id) => document.getElementById(id);
const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

function normalizeDomain(raw) {
  let d = (raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split(":")[0];
  return d;
}

// Today's usage in ms — treats a stale (yesterday's) record as 0.
function usedMsToday(usage) {
  if (!usage || usage.date !== todayKey()) return 0;
  return usage.totalMs || 0;
}

// "17:00" for a same-day timestamp, "midnight" for the upcoming local
// midnight (the daily reset), "Thu 18:00" for anything else on another day.
function fmtUntil(ms) {
  if (typeof ms !== "number") return "";
  if (ms === nextLocalMidnightMs()) return "midnight";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
}

function describeStatus(status) {
  // Outside the global enforcement hours nothing is counted, so there's no
  // countdown to show.
  if (status.free) return "off-hours";
  if (!status.locked) return `${fmtClock(status.remainingMs)} left`;
  const until = status.until ? ` until ${fmtUntil(status.until)}` : "";
  switch (status.reason) {
    case "schedule":
      return `🔒 scheduled${until}`;
    case "global":
      return `🔒 total cap reached${until}`;
    default:
      return `🔒 locked${until}`;
  }
}

// Which site editors are open, by domain — survives re-renders.
const expanded = new Set();

// A rule you just added or edited can still be changed or removed for this
// long, even if it locked the site — anti-bypass shouldn't turn a fumble
// (wrong hour, wrong day) into a multi-hour lockout. Anything older is
// frozen while the site is locked, like every other setting.
const RULE_GRACE_MS = 60 * 1000;
function ruleInGrace(rule, now = Date.now()) {
  if (!rule || typeof rule.touchedAt !== "number") return false;
  const age = now - rule.touchedAt;
  // A future-dated stamp (clock skew, hand-edited storage) must not be a
  // perpetual grace.
  return age >= 0 && age < RULE_GRACE_MS;
}

const DEFAULT_RULE = () => ({ type: "block", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", touchedAt: Date.now() });
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function readModel() {
  const store = await get(["focusSites", "settings", "usage", "budgetSeconds", "schedule"]);
  const now = Date.now();
  const budgetSeconds = store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  const globalBudgetMs = budgetSeconds * 1000;
  const usage = normalizeUsage(store.usage, now);
  const sites = (store.focusSites || []).map(normalizeSite);
  const schedule = store.schedule;
  const statuses = sites.map((s) => evaluateSite(s, usage, globalBudgetMs, now, schedule));
  return { store, now, budgetSeconds, globalBudgetMs, usage, sites, statuses, schedule };
}

async function load() {
  const { store, now, budgetSeconds, globalBudgetMs, usage, sites, statuses, schedule } = await readModel();
  const usedMs = usage.totalMs;
  const globalLocked = usedMs >= globalBudgetMs;
  // The global schedule's state right now: a blackout locks every site, and
  // off-hours nothing is counted — both override what the header would
  // otherwise say about the total cap.
  const at = new Date(now);
  const global = scheduleStateAt(schedule, at);
  const blackoutUntil = global.blackout ? scheduleBlackoutUntil(schedule, at) : null;

  el("budgetInput").value = (budgetSeconds / 60).toFixed(budgetSeconds % 60 ? 1 : 0);
  renderStatus(usedMs, globalBudgetMs, globalLocked, global, blackoutUntil);
  renderSites(sites, statuses, usage, global.blackout);
  el("idleInput").value = (store.settings || DEFAULT_SETTINGS).idleSeconds;
}

function renderStatus(usedMs, budgetMs, locked, global = { enforcing: true, blackout: false }, blackoutUntil = null) {
  const pill = el("statusPill");
  const box = el("remaining");
  const fill = el("barFill");

  const pct = budgetMs > 0 ? Math.min(100, (usedMs / budgetMs) * 100) : 100;
  fill.style.width = `${pct}%`;
  fill.className = "bar-fill" + (locked ? " full" : pct > 75 ? " warn" : "");

  if (global.blackout) {
    box.textContent = `🔒 Blackout${blackoutUntil ? ` until ${fmtUntil(blackoutUntil)}` : ""}`;
    box.className = "remaining big empty";
    pill.textContent = "Blackout";
    pill.className = "pill locked";
  } else if (!global.enforcing) {
    box.textContent = "Off-hours — nothing is counted";
    box.className = "remaining big";
    pill.textContent = "Off";
    pill.className = "pill off";
  } else if (locked) {
    box.textContent = "🔒 Total cap reached";
    box.className = "remaining big empty";
    pill.textContent = "Locked";
    pill.className = "pill locked";
  } else {
    const leftMs = budgetMs - usedMs;
    box.textContent = `${fmtClock(leftMs)} left in total cap`;
    box.className = "remaining big live";
    pill.textContent = fmtClock(leftMs);
    pill.className = "pill on";
  }

  // Once the day's cap is spent, freeze the field so it can't be raised.
  el("budgetInput").disabled = locked;
  el("budgetNote").hidden = !locked;
}

function renderSites(sites, statuses, usage, blackout = false) {
  const list = el("siteList");
  list.innerHTML = "";
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
    edit.title = "Budget, lockout and schedule for this site";
    edit.setAttribute("aria-expanded", String(expanded.has(s.domain)));
    edit.addEventListener("click", () => {
      if (expanded.has(s.domain)) expanded.delete(s.domain);
      else expanded.add(s.domain);
      load();
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

// The per-site editor. Every control autosaves on change. While the site is
// locked the whole editor is read-only — loosening a rule or raising the
// budget is exactly the bypass this extension exists to prevent.
function buildEditor(site, status) {
  const box = document.createElement("div");
  box.className = "site-editor";
  const locked = status.locked;
  // Edits are keyed by domain, not list index: a concurrent add/remove
  // (another popup, or a re-render racing an in-flight change) must never
  // land an edit on a neighbouring site.
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
    if (isNaN(minutes) || minutes <= 0) {
      load();
      return;
    }
    updateSite(key, (s) => ({ ...s, budgetSeconds: Math.round(minutes * 60) }));
  });
  budgetWrap.append(budgetInput, " min");
  budgetLabel.appendChild(budgetWrap);
  box.appendChild(budgetLabel);

  // Lockout
  const lockoutLabel = document.createElement("label");
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
    const minutes = parseInt(lockoutMin.value, 10);
    if (isNaN(minutes) || minutes < 1) return;
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
  const end = document.createElement("input");
  end.type = "time";
  end.className = "rule-end";
  end.value = rule.end || "17:00";
  end.disabled = locked;
  end.addEventListener("change", () => patchRule({ end: end.value }));
  times.append(start, "–", end);

  row.append(type, days, removeRule, times);
  return row;
}

// Apply `mutate` to the stored site with this `domain` and persist. Refuses
// while the site is locked (re-checked against live state, not the rendered
// snapshot) or if the site no longer exists. The one exception: an edit or
// removal of a rule that is still inside its grace window (opts.ruleIndex).
async function updateSite(domain, mutate, opts = {}) {
  const { store, statuses, sites } = await readModel();
  const index = sites.findIndex((s) => s.domain === domain);
  if (index === -1) {
    load();
    return false;
  }
  if (statuses[index].locked) {
    const rule = typeof opts.ruleIndex === "number" ? sites[index].rules[opts.ruleIndex] : null;
    if (!ruleInGrace(rule)) {
      load();
      return false;
    }
  }
  const raw = (store.focusSites || []).slice();
  raw[index] = normalizeSite(mutate(sites[index]));
  await set({ focusSites: raw });
  load();
  return true;
}

async function addSite(e) {
  e.preventDefault();
  const domain = normalizeDomain(el("domainInput").value);
  if (!domain) return;
  const { focusSites } = await get(["focusSites"]);
  const sites = focusSites || [];
  if (sites.some((s) => s.domain === domain)) return; // no dupes
  sites.push(normalizeSite({ domain }));
  await set({ focusSites: sites });
  el("domainInput").value = "";
  load();
}

async function removeSite(domain) {
  const { store, statuses, sites, usage } = await readModel();
  const index = sites.findIndex((s) => s.domain === domain);
  if (index === -1) return;
  const site = sites[index];
  const siteUsed = (usage.sites[site.domain] && usage.sites[site.domain].totalMs) || 0;
  // Refuse removals while locked or in the last 5 minutes of the site's budget.
  if (statuses[index].locked || removalLocked(siteUsed, site.budgetSeconds * 1000)) {
    load();
    return;
  }
  const raw = (store.focusSites || []).slice();
  raw.splice(index, 1);
  await set({ focusSites: raw });
  load();
}

async function saveBudget() {
  const store = await get(["usage", "budgetSeconds"]);
  const currentBudget = store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  // If today's cap is already reached, refuse edits and revert the field.
  if (usedMsToday(store.usage) >= currentBudget * 1000) {
    load();
    return;
  }
  const minutes = parseFloat(el("budgetInput").value);
  if (isNaN(minutes) || minutes < 0) return;
  await set({ budgetSeconds: Math.round(minutes * 60) });
}

async function saveSettings() {
  const parsed = parseInt(el("idleInput").value, 10);
  const idleSeconds = Math.max(5, Number.isNaN(parsed) ? DEFAULT_SETTINGS.idleSeconds : parsed);
  // Merge over what's stored so flags this popup doesn't edit (idleEnabled)
  // survive an idle-seconds change.
  const { settings } = await get(["settings"]);
  await set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}), idleSeconds } });
}

function openStats() {
  chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") }).catch(() => {});
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    removalLocked,
    normalizeDomain,
    fmtClock,
    todayKey,
    usedMsToday,
    describeStatus,
    fmtUntil,
    ruleInGrace,
    RULE_GRACE_MS,
    saveSettings,
    openStats,
    saveBudget,
    addSite,
    removeSite,
    updateSite,
    load,
    expanded
  };
}

el("addForm").addEventListener("submit", addSite);
el("budgetInput").addEventListener("change", saveBudget);
el("idleInput").addEventListener("change", saveSettings);
el("statsBtn").addEventListener("click", openStats);

// Keep the popup's countdown and lock state live while it's open — but don't
// yank a control out from under the user mid-edit: usage ticks every second
// while a tracked site is open, and a full re-render would drop focus.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!(changes.usage || changes.focusSites || changes.budgetSeconds || changes.schedule)) return;
  const active = document.activeElement;
  const editing = active && typeof active.closest === "function" && active.closest(".site-editor");
  if (changes.usage && !changes.focusSites && !changes.budgetSeconds && !changes.schedule && editing) return;
  load();
});

load();
