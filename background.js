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
//
// The pure evaluation logic (SITE_DEFAULTS, normalizeSite, normalizeUsage,
// siteUsage, evaluateSite, nextLocalMidnightMs) lives in shared.js so the
// popup renders exactly the status this worker enforces.

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

function scheduleMidnightAlarm() {
  chrome.alarms.create(DAILY_RESET_ALARM, { when: nextLocalMidnightMs(), periodInMinutes: 24 * 60 });
}

chrome.runtime.onStartup.addListener(scheduleMidnightAlarm);

// Per-site lock snapshot for the companion app. `locked` is true if ANY site
// is locked; `sites` carries each site's own state so the companion can say
// which ones, and until when.
function snapshotForHost(focusSites, usage, globalBudgetMs, now) {
  const sites = {};
  let anyLocked = false;
  let minRemaining = globalBudgetMs;
  for (const site of focusSites) {
    const s = evaluateSite(site, usage, globalBudgetMs, now);
    sites[site.domain] = { locked: s.locked, reason: s.reason, until: s.until, remainingMs: s.remainingMs };
    if (s.locked) anyLocked = true;
    if (s.remainingMs < minRemaining) minRemaining = s.remainingMs;
  }
  return { locked: anyLocked, sites, remainingMs: Math.max(0, minRemaining), budgetMs: globalBudgetMs, focusSites };
}

// A lock with a known end (cool-down, schedule window, midnight) gets an
// alarm at that moment so the companion is told the site unlocked even if
// nothing heartbeats. Creating an alarm with an existing name replaces it.
const UNLOCK_ALARM_PREFIX = "unlock:";
function scheduleUnlockAlarm(domain, until) {
  if (typeof until !== "number" || until <= Date.now()) return;
  chrome.alarms.create(UNLOCK_ALARM_PREFIX + domain, { when: until });
}

// Runs through the same queue as message handling so its storage write can't
// interleave with an in-flight heartbeat's read-modify-write.
function pushSnapshot(extra) {
  const result = handleQueue.then(() => pushSnapshotLocked(extra));
  handleQueue = result.catch(() => {});
  return result;
}

async function pushSnapshotLocked(extra) {
  const stored = await get(["focusSites", "usage", "budgetSeconds"]);
  const now = Date.now();
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const globalBudgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const usage = normalizeUsage(stored.usage, now);
  // normalizeUsage() hands an expired cool-down a fresh allowance; persist
  // that so the reset is durable rather than recomputed on every read.
  await set({ usage });
  const snap = snapshotForHost(focusSites, usage, globalBudgetMs, now);
  // A site may still be locked for a different reason with a later end (a
  // cool-down ended while a schedule window is active) — keep the companion
  // informed of that next unlock too.
  for (const [domain, s] of Object.entries(snap.sites)) {
    if (s.locked) scheduleUnlockAlarm(domain, s.until);
  }
  notifyNativeHost({ ...snap, ...(extra || {}) });
  return snap;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DAILY_RESET_ALARM) {
    await pushSnapshot({ lastBlocked: "" });
    return;
  }
  if (alarm.name.startsWith(UNLOCK_ALARM_PREFIX)) {
    const snap = await pushSnapshot();
    // If the site is now free, clear the stale "what was blocked" for the
    // companion pill; if it's still locked for another reason, leave it.
    const domain = alarm.name.slice(UNLOCK_ALARM_PREFIX.length);
    const site = snap.sites[domain];
    if (site && !site.locked) notifyNativeHost({ lastBlocked: "" });
  }
});

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

// After any evaluation that found a lock, make sure the companion learns
// about the unlock moment even if no heartbeat ever arrives.
function armUnlock(site, status) {
  if (status && status.locked) scheduleUnlockAlarm(site.domain, status.until);
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
  return { ...status, site, focusSites, usage, globalBudgetMs, now };
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
  armUnlock(status.site, status);
  // No heartbeat will follow a navigation-time block, so push the per-site
  // snapshot here too.
  notifyNativeHost(snapshotForHost(status.focusSites, status.usage, status.globalBudgetMs, status.now));
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
    armUnlock(site, status);
    notifyNativeHost(snapshotForHost(focusSites, usage, globalBudgetMs, now));
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
    armUnlock(site, status);
    notifyNativeHost(snapshotForHost(focusSites, usage, globalBudgetMs, now));
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
    snapshotForHost,
    pushSnapshot,
    DAILY_RESET_ALARM,
    UNLOCK_ALARM_PREFIX
  };
}
