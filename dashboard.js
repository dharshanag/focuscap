// Focus Cap — dashboard popup logic. Reads/writes chrome.storage.local;
// the background worker and content scripts react to those changes.

const DEFAULT_SETTINGS = { idleSeconds: 45 };
const DEFAULT_BUDGET_SECONDS = 1800; // daily allowance (30 min)
const REMOVE_LOCK_MS = 5 * 60 * 1000; // can't remove sites in the last 5 min

// Removing a site is blocked once you're fully locked, or in the final 5
// minutes of your budget — the exact window you'd be tempted to game.
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

async function load() {
  const store = await get(["focusSites", "settings", "usage", "budgetSeconds"]);
  const budgetSeconds = store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  const usedMs = usedMsToday(store.usage);
  const budgetMs = budgetSeconds * 1000;
  const locked = usedMs >= budgetMs;

  el("budgetInput").value = (budgetSeconds / 60).toFixed(budgetSeconds % 60 ? 1 : 0);
  renderStatus(usedMs, budgetMs, locked);
  renderSites(store.focusSites || [], locked, removalLocked(usedMs, budgetMs));
  el("idleInput").value = (store.settings || DEFAULT_SETTINGS).idleSeconds;
}

function renderStatus(usedMs, budgetMs, locked) {
  const pill = el("statusPill");
  const box = el("remaining");
  const fill = el("barFill");

  const pct = budgetMs > 0 ? Math.min(100, (usedMs / budgetMs) * 100) : 100;
  fill.style.width = `${pct}%`;
  fill.className = "bar-fill" + (locked ? " full" : pct > 75 ? " warn" : "");

  if (locked) {
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

  // Once the day's limit is spent, freeze the field so it can't be raised.
  el("budgetInput").disabled = locked;
  el("budgetNote").hidden = !locked;
}

function renderSites(sites, locked, removeLock) {
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
    const li = document.createElement("li");
    if (locked) li.classList.add("locked");

    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = s.domain;

    const status = document.createElement("span");
    status.className = "budget";
    if (locked) {
      status.textContent = "🔒 locked";
      status.title = "Unlocks tomorrow";
    }

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "×";
    if (removeLock) {
      // Can't delete a site to dodge the block near/at the limit.
      remove.disabled = true;
      remove.title = locked
        ? "Can't remove while locked — resets tomorrow"
        : "Can't remove in the last 5 minutes of your budget";
    } else {
      remove.title = "Remove";
      remove.addEventListener("click", () => removeSite(i));
    }

    li.append(domain, status, remove);
    list.appendChild(li);
  });
}

async function addSite(e) {
  e.preventDefault();
  const domain = normalizeDomain(el("domainInput").value);
  if (!domain) return;
  const { focusSites } = await get(["focusSites"]);
  const sites = focusSites || [];
  if (sites.some((s) => s.domain === domain)) return; // no dupes
  sites.push({ domain });
  await set({ focusSites: sites });
  el("domainInput").value = "";
  load();
}

async function removeSite(index) {
  const store = await get(["focusSites", "usage", "budgetSeconds"]);
  const budgetMs = (store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
  // Refuse removals in the last 5 minutes (or once fully locked).
  if (removalLocked(usedMsToday(store.usage), budgetMs)) {
    load();
    return;
  }
  const sites = store.focusSites || [];
  sites.splice(index, 1);
  await set({ focusSites: sites });
  load();
}

async function saveBudget() {
  const store = await get(["usage", "budgetSeconds"]);
  const currentBudget = store.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  // If today's limit is already reached, refuse edits and revert the field.
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
  await set({ settings: { idleSeconds } });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    removalLocked,
    normalizeDomain,
    fmtClock,
    todayKey,
    usedMsToday,
    saveSettings,
    saveBudget,
    addSite,
    removeSite,
    load
  };
}

el("addForm").addEventListener("submit", addSite);
el("budgetInput").addEventListener("change", saveBudget);
el("idleInput").addEventListener("change", saveSettings);

// Keep the popup's countdown and lock state live while it's open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.usage || changes.focusSites || changes.budgetSeconds)) {
    load();
  }
});

load();
