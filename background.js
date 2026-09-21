// Focus Cap — background service worker.
// Tracks how much active time you spend on each distraction site against
// per-site rules — a daily budget, an optional cool-down lockout, and optional
// allow/block schedule windows — plus one global daily cap across all sites.
// Usage resets automatically at local midnight (checked lazily).

if (typeof importScripts === "function") importScripts("shared.js");

// Storage layout (chrome.storage.local):
//   focusSites: [{ domain, budgetSeconds, lockoutSeconds, rules }]
//     budgetSeconds  — this site's own daily allowance
//     lockoutSeconds — how long the site stays blocked after exhausting its
//                      budget; null = until local midnight
//     rules          — [{ type: "block"|"allow", days, start, end }], see shared.js
//     (older entries with only { domain } are normalized to SITE_DEFAULTS at
//     read time, so no explicit migration step is needed)
//   budgetSeconds: the GLOBAL cap across all sites per day (the key predates
//     per-site budgets and already meant "total across all sites")
//   usage: { date, totalMs, sites: { [domain]: { totalMs, lastTickAt, lockedUntil } } }
const SITE_DEFAULTS = {
  budgetSeconds: 1800, // 30 min/day
  lockoutSeconds: null, // until midnight
  rules: []
};

const DEFAULTS = {
  focusSites: [],
  settings: { idleSeconds: 45 },
  budgetSeconds: 1800, // global daily cap across all sites (default 30 min)
  usage: { date: "", totalMs: 0, sites: {} }
};

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await get(Object.keys(DEFAULTS));
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) patch[k] = DEFAULTS[k];
  }
  if (Object.keys(patch).length) await set(patch);
  scheduleMidnightAlarm();
});

// The companion app (see companion/) only learns about lock state when the
// extension tells it to (via notifyNativeHost, below) — it has no visibility
// into chrome.storage itself. Usage naturally resets at midnight the next
// time handleLocked() runs (see the daily-rollover check there), but if
// nothing's actively heartbeating right at midnight, the companion's pill
// would otherwise stay stuck "locked" until the next heartbeat. This alarm
// proactively pushes an unlocked notification at local midnight regardless
// of browsing activity. chrome.alarms.create() with a name that already
// exists replaces it, so calling this on every install/startup is safe.
const DAILY_RESET_ALARM = "dailyReset";

function nextLocalMidnightMs() {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0); // next local midnight
  return midnight.getTime();
}

function scheduleMidnightAlarm() {
  chrome.alarms.create(DAILY_RESET_ALARM, { when: nextLocalMidnightMs(), periodInMinutes: 24 * 60 });
}

chrome.runtime.onStartup.addListener(scheduleMidnightAlarm);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== DAILY_RESET_ALARM) return;
  const stored = await get(["focusSites", "budgetSeconds"]);
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const budgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  notifyNativeHost({ locked: false, remainingMs: budgetMs, budgetMs, focusSites, lastBlocked: "" });
});

// Fill in per-site defaults for entries saved before per-site rules existed.
function normalizeSite(site) {
  const s = site || {};
  return {
    domain: s.domain || "",
    budgetSeconds: typeof s.budgetSeconds === "number" && s.budgetSeconds >= 0 ? s.budgetSeconds : SITE_DEFAULTS.budgetSeconds,
    // A zero/negative cool-down would expire on the very next read and hand
    // out a fresh full budget every time — an unbounded-budget loophole. Treat
    // anything non-positive as "until midnight".
    lockoutSeconds: typeof s.lockoutSeconds === "number" && s.lockoutSeconds > 0 ? s.lockoutSeconds : SITE_DEFAULTS.lockoutSeconds,
    rules: Array.isArray(s.rules) ? s.rules : SITE_DEFAULTS.rules
  };
}

// Match a page hostname against the user's distraction list.
// "youtube.com" matches youtube.com and www.youtube.com and m.youtube.com.
function matchSite(hostname, sites) {
  const h = (hostname || "").replace(/^www\./, "");
  return sites.find((s) => {
    const d = (s.domain || "").replace(/^www\./, "").toLowerCase();
    if (!d) return false;
    return h === d || h.endsWith("." + d);
  });
}

// Bring a stored usage record up to date for `now`: a new calendar day wipes
// everything, and a per-site cool-down that has expired hands that site a
// fresh allowance (otherwise it'd re-lock on the very next heartbeat).
// Pure — callers decide whether to persist the result.
function normalizeUsage(stored, now) {
  const today = todayKey();
  let usage = stored && typeof stored === "object" ? stored : null;
  if (!usage || usage.date !== today) usage = { date: today, totalMs: 0, sites: {} };
  const sites = {};
  const storedSites = usage.sites && typeof usage.sites === "object" ? usage.sites : {};
  for (const [domain, raw] of Object.entries(storedSites)) {
    // Tolerate a corrupted entry rather than throwing — a rejection here in
    // guardNavigation would leave the navigation UNBLOCKED.
    const rec = raw && typeof raw === "object" ? raw : {};
    const r = { totalMs: rec.totalMs || 0, lastTickAt: rec.lastTickAt, lockedUntil: rec.lockedUntil };
    if (typeof r.lockedUntil === "number" && now >= r.lockedUntil) {
      r.totalMs = 0;
      r.lockedUntil = undefined;
    }
    sites[domain] = r;
  }
  return { date: usage.date, totalMs: usage.totalMs || 0, sites };
}

function siteUsage(usage, domain) {
  return usage.sites[domain] || (usage.sites[domain] = { totalMs: 0 });
}

// Decide whether a site is currently locked and why. Order:
//   1. schedule (block window active, or outside every allow window)
//   2. an in-progress cool-down lockout
//   3. this site's own daily budget
//   4. the global cap across all sites
// Returns { locked, reason, until, remainingMs, budgetMs } where budgetMs /
// remainingMs reflect the tighter of the site's and the global allowance.
function evaluateSite(site, usage, globalBudgetMs, now) {
  const rec = siteUsage(usage, site.domain);
  const siteBudgetMs = site.budgetSeconds * 1000;
  const remainingSite = Math.max(0, siteBudgetMs - rec.totalMs);
  const remainingGlobal = Math.max(0, globalBudgetMs - usage.totalMs);
  const remainingMs = Math.min(remainingSite, remainingGlobal);
  const budgetMs = Math.min(siteBudgetMs, globalBudgetMs);

  const verdict = scheduleVerdict(site.rules, new Date(now));
  if (verdict === "block") {
    return { locked: true, reason: "schedule", until: scheduleBlockedUntil(site.rules, new Date(now)), remainingMs, budgetMs };
  }
  if (typeof rec.lockedUntil === "number" && now < rec.lockedUntil) {
    return { locked: true, reason: "lockout", until: rec.lockedUntil, remainingMs: 0, budgetMs };
  }
  if (rec.totalMs >= siteBudgetMs) {
    return { locked: true, reason: "budget", until: lockoutEndFor(site, now), remainingMs: 0, budgetMs };
  }
  if (usage.totalMs >= globalBudgetMs) {
    return { locked: true, reason: "global", until: nextLocalMidnightMs(), remainingMs: 0, budgetMs };
  }
  return { locked: false, reason: null, until: null, remainingMs, budgetMs };
}

function lockoutEndFor(site, now) {
  return typeof site.lockoutSeconds === "number" ? now + site.lockoutSeconds * 1000 : nextLocalMidnightMs();
}

const BLOCK_PAGE = "time-is-up.html";

// Best-effort bridge to the desktop companion app (see native-host/ and
// companion/). Entirely optional: if the native host isn't installed or
// registered, connectNative either throws synchronously or the port
// disconnects immediately — either way we silently do nothing, since the
// extension must keep working with zero setup beyond "load unpacked".
let nativePort = null;
function getNativePort() {
  if (nativePort) return nativePort;
  if (typeof chrome.runtime.connectNative !== "function") return null;
  try {
    nativePort = chrome.runtime.connectNative("com.focuscap.host");
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
    });
  } catch (_) {
    nativePort = null;
  }
  return nativePort;
}

function notifyNativeHost(patch) {
  const port = getNativePort();
  if (!port) return;
  try {
    port.postMessage(patch);
  } catch (_) {
    nativePort = null;
  }
}

// Stash which site was blocked (for the page to display) and send the tab to a
// clean URL — no query string, so the address bar just reads ".../time-is-up.html".
async function redirectToBlock(tabId, hostname, status) {
  const lastBlocked = (hostname || "").replace(/^www\./, "");
  await set({ lastBlocked, lastBlockedUntil: (status && status.until) || null, lastBlockedReason: (status && status.reason) || null });
  notifyNativeHost({ locked: true, lastBlocked });
  await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(BLOCK_PAGE) }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((res) => {
      // If the site is locked, kick the reporting tab over to the blocked page.
      if (res && res.overlay && sender.tab && sender.tab.id != null) {
        redirectToBlock(sender.tab.id, msg.hostname, res);
      }
      sendResponse(res);
    })
    .catch(() => sendResponse({}));
  return true; // keep the message channel open for the async response
});

// Is this hostname's site currently locked? (read-only; same rules as handle)
async function isLocked(hostname) {
  const stored = await get(["focusSites", "usage", "budgetSeconds"]);
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const site = matchSite(hostname, focusSites);
  if (!site) return { locked: false, site: null, focusSites };
  const now = Date.now();
  const usage = normalizeUsage(stored.usage, now);
  const globalBudgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const status = evaluateSite(site, usage, globalBudgetMs, now);
  return { ...status, site, focusSites, usage };
}

// Redirect a main-frame navigation to a locked site to the blocked page —
// this fires before the site renders, so there's no flash.
async function guardNavigation(details) {
  if (details.frameId !== 0) return; // top frame only
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch (_) {
    return;
  }
  const status = await isLocked(hostname);
  if (!status.locked) return;
  // A budget lock discovered here (e.g. the site's budget was lowered below
  // what's already been used) has to start its cool-down clock too — the
  // redirect fires before content.js ever gets to send "entering", so no
  // heartbeat path would otherwise persist lockedUntil.
  if (status.reason === "budget" && status.site) {
    const rec = siteUsage(status.usage, status.site.domain);
    if (rec.lockedUntil !== status.until) {
      rec.lockedUntil = status.until;
      await set({ usage: status.usage });
    }
  }
  await redirectToBlock(details.tabId, hostname, status);
}

chrome.webNavigation.onBeforeNavigate.addListener(guardNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(guardNavigation); // SPA nav

// All message handling is serialized through this queue so two tabs'
// heartbeats can never interleave a read-modify-write on the usage record.
let handleQueue = Promise.resolve();
async function handle(msg) {
  const result = handleQueue.then(() => handleLocked(msg));
  handleQueue = result.catch(() => {});
  return result;
}

async function handleLocked(msg) {
  const stored = await get(["focusSites", "settings", "usage", "budgetSeconds"]);
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const settings = stored.settings || DEFAULTS.settings;
  const globalBudgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const now = Date.now();
  const usage = normalizeUsage(stored.usage, now);

  const site = matchSite(msg.hostname, focusSites);

  const respond = (status) => ({
    track: true,
    overlay: status.locked,
    reason: status.reason,
    until: status.until,
    remainingMs: status.remainingMs,
    budgetMs: status.budgetMs,
    settings
  });

  // Content script announces it just became engaged with a distraction page.
  if (msg.type === "entering") {
    if (!site) return { track: false };
    const rec = siteUsage(usage, site.domain);
    rec.lastTickAt = now;
    const status = evaluateSite(site, usage, globalBudgetMs, now);
    if (status.locked && status.reason === "budget") rec.lockedUntil = status.until;
    await set({ usage });
    notifyNativeHost({ locked: status.locked, remainingMs: status.remainingMs, budgetMs: status.budgetMs, focusSites });
    return respond(status);
  }

  // Per-second engaged heartbeat while the page is active/focused/non-idle.
  if (msg.type === "heartbeat") {
    if (!site) return { track: false };
    const rec = siteUsage(usage, site.domain);
    // Use real elapsed time (capped) so worker-sleep gaps don't over/under count.
    const delta = Math.min(now - (rec.lastTickAt || now), 5000);
    // Time spent while the schedule already blocks the site (the redirect is
    // in flight) shouldn't eat into today's budget.
    if (scheduleVerdict(site.rules, new Date(now)) !== "block") {
      rec.totalMs += delta;
      usage.totalMs += delta;
    }
    rec.lastTickAt = now;
    const status = evaluateSite(site, usage, globalBudgetMs, now);
    // Exhausting the site's own budget starts its cool-down clock.
    if (status.locked && status.reason === "budget") rec.lockedUntil = status.until;
    await set({ usage });
    notifyNativeHost({ locked: status.locked, remainingMs: status.remainingMs, budgetMs: status.budgetMs, focusSites });
    return respond(status);
  }

  // Content script left the page (tab switch / window blur / navigation).
  if (msg.type === "leaving") {
    return { ok: true };
  }

  return {};
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULTS,
    SITE_DEFAULTS,
    todayKey,
    matchSite,
    normalizeSite,
    normalizeUsage,
    evaluateSite,
    isLocked,
    redirectToBlock,
    guardNavigation,
    handle,
    notifyNativeHost,
    nextLocalMidnightMs,
    scheduleMidnightAlarm,
    DAILY_RESET_ALARM
  };
}
