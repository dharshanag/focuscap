// Focus Cap — popup logic. Reads/writes chrome.storage.local; the background
// worker and content scripts react to those changes.
//
// The popup is the quick view: today's total cap, one status line per site,
// add/remove. Per-site budgets, cool-downs and schedule rules (and the global
// schedule) are edited on the options page ("Dashboard & schedule").
//
// Per-site status here is computed with the SAME pure helpers background.js
// enforces with (shared.js: normalizeSite / normalizeUsage / evaluateSite /
// scheduleStateAt), so what the popup shows can never disagree with what
// actually gets blocked.

const DEFAULT_BUDGET_SECONDS = 1800; // global cap across all sites (30 min)
const MAX_BUDGET_SECONDS = 2 * 60 * 60; // hard cap: 2 hours
const MIN_BUDGET_SECONDS = 60; // at least 1 minute
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

// Hours + minutes fields -> seconds, clamped to [1 min, 2 h] like main.
function clampBudgetSeconds(hours, minutes) {
  return Math.min(MAX_BUDGET_SECONDS, Math.max(MIN_BUDGET_SECONDS, hours * 3600 + minutes * 60));
}

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

async function readModel() {
  const store = await get(["focusSites", "usage", "budgetSeconds", "schedule"]);
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
  const { now, budgetSeconds, globalBudgetMs, usage, sites, statuses, schedule } = await readModel();
  const usedMs = usage.totalMs;
  const globalLocked = usedMs >= globalBudgetMs;
  // The global schedule's state right now: a blackout locks every site, and
  // off-hours nothing is counted — both override what the header would
  // otherwise say about the total cap.
  const at = new Date(now);
  const global = scheduleStateAt(schedule, at);
  const blackoutUntil = global.blackout ? scheduleBlackoutUntil(schedule, at) : null;

  // A usage tick from the background re-runs load() every second while a
  // tracked site is open; don't overwrite a half-typed limit. Once the cap is
  // spent the fields freeze anyway, so the stored value wins.
  if (globalLocked || !editingBudget()) fillBudgetFields(budgetSeconds);
  renderStatus(usedMs, globalBudgetMs, globalLocked, global, blackoutUntil);
  renderSites(sites, statuses, usage, global.blackout);
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
    pill.textContent = "off-hours";
    pill.className = "pill off";
  } else if (locked) {
    box.textContent = "🔒 Daily limit reached";
    box.className = "remaining big empty";
    pill.textContent = "Locked";
    pill.className = "pill locked";
  } else {
    const leftMs = budgetMs - usedMs;
    box.textContent = `${fmtClock(leftMs)} left today`;
    box.className = "remaining big live";
    pill.textContent = fmtClock(leftMs);
    pill.className = "pill on";
  }

  // Once the day's limit is spent, freeze the fields so it can't be raised.
  el("budgetHours").disabled = locked;
  el("budgetMinutes").disabled = locked;
  el("budgetNote").hidden = !locked;
}

function renderSites(sites, statuses, usage, blackout = false) {
  const list = el("siteList");
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

    li.append(domain, meta, remove);
    list.appendChild(li);
  });
}

async function addSite(e) {
  e.preventDefault();
  const domain = normalizeDomain(el("domainInput").value);
  if (!domain) return;
  const { focusSites } = await get(["focusSites"]);
  const sites = focusSites || [];
  if (sites.some((s) => s && s.domain === domain)) return; // no dupes (tolerates a corrupt entry)
  sites.push(normalizeSite({ domain }));
  await set({ focusSites: sites });
  el("domainInput").value = "";
  load();
}

// Keyed by domain, not list index: a concurrent add/remove from the options
// page must never land a removal on a neighbouring site.
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
  // If today's limit is already reached, refuse edits and revert the fields.
  if (usedMsToday(store.usage) >= currentBudget * 1000) {
    load();
    return;
  }
  const hours = parseIntOr(el("budgetHours").value, 0);
  const minutes = parseIntOr(el("budgetMinutes").value, 0);
  const total = clampBudgetSeconds(hours, minutes);
  // Reflect the clamped value back into the fields (e.g. 3h → 2h 0m).
  fillBudgetFields(total);
  await set({ budgetSeconds: total });
}

function openStats() {
  chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") }).catch(() => {});
}

function openDashboard() {
  chrome.runtime.openOptionsPage();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    removalLocked,
    normalizeDomain,
    fmtClock,
    todayKey,
    usedMsToday,
    clampBudgetSeconds,
    openStats,
    openDashboard,
    saveBudget,
    addSite,
    removeSite,
    load
  };
}

el("addForm").addEventListener("submit", addSite);
el("budgetHours").addEventListener("change", saveBudget);
el("budgetMinutes").addEventListener("change", saveBudget);
el("statsBtn").addEventListener("click", openStats);
el("dashBtn").addEventListener("click", openDashboard);

// Keep the popup's countdown and lock state live while it's open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.usage || changes.focusSites || changes.budgetSeconds || changes.schedule) load();
});

load();
