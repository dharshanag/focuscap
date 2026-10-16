// Focus Cap — background service worker.
// Tracks how much active time you spend on each distraction site against
// per-site rules — a daily budget, an optional cool-down lockout, and optional
// allow/block schedule windows — plus one global daily cap across all sites.
// Usage resets automatically at local midnight (checked lazily). Separately,
// every page's engaged time is recorded per domain per day for the stats page.

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
//   stats: { "YYYY-MM-DD": { [domain]: ms } } — engaged time on EVERY page
//     (tracked or not), keyed by hostname with a leading "www." stripped,
//     lowercased; pruned to the most recent STATS_DAYS day keys on each write.
//   schedule: { enabled, days, windows, blackouts } — the GLOBAL schedule
//     layered over every site's own rules (see shared.js): a blackout locks
//     every tracked site outright; outside the enforcement windows sites are
//     free and nothing is charged to any budget. Disabled = always enforcing.
//
// The pure evaluation logic (SITE_DEFAULTS, normalizeSite, normalizeUsage,
// siteUsage, evaluateSite, scheduleStateAt, nextLocalMidnightMs) lives in
// shared.js so the popup renders exactly the status this worker enforces.

const DEFAULTS = {
  focusSites: [],
  settings: { idleEnabled: true, idleSeconds: 45 },
  budgetSeconds: 1800, // global daily cap across all sites (default 30 min)
  usage: { date: "", totalMs: 0, sites: {} },
  stats: {}, // per-day, per-domain engaged time (see storage layout above)
  schedule: SCHEDULE_DEFAULTS // global enforcement windows + blackouts; off = always on
};

const STATS_DAYS = 14; // how many days of stats history to keep
const STATS_FLUSH_MS = 5000; // write accumulated stats at most this often
const TICK_CAP_MS = 5000; // a single heartbeat can't credit more than this
// A domain's tick clock is "live" if a tick landed this recently: heartbeats
// are 1 s apart, so a tick inside this window means another tab on the same
// domain is still heartbeating (see "entering" below).
const TICK_LIVE_MS = 2000;

// ---- Per-domain stats accounting ----
//
// Delta source: an in-memory per-domain tick clock (`tickClock[domain]` = the
// last "entering"/"heartbeat" time for that domain, for EVERY domain, not just
// tracked sites). A heartbeat credits real elapsed time since the previous
// tick, capped at TICK_CAP_MS, exactly like the per-site usage clock. It's
// deliberately not persisted: the worker only sleeps when heartbeats have
// stopped, and after a restart the first heartbeat (no clock yet) credits 0
// rather than a stale capped 5 s. Two tabs on the same domain share one
// clock, so they split the second between them instead of double counting;
// "entering" leaves a live clock alone (rather than resetting it) so the
// interval since the other tab's last tick isn't dropped on the floor, but
// restarts a stale one so a tab re-shown after a long gap credits nothing
// for the gap. Like the usage clock, the clock is NOT cleared on "leaving"
// or when a visible page goes idle, so the first tick after a long idle
// stretch credits up to TICK_CAP_MS rather than ~1 s — a bounded over-credit
// per resume, kept identical to rec.lastTickAt so stats and budget agree.
// A tick that straddles local midnight is credited wholly to the new day.
//
// Throttle: deltas accumulate in `pending` and are merged into storage at
// most every STATS_FLUSH_MS — on the first heartbeat that is due, on
// "leaving", when the calendar day rolls over (the old day's deltas are
// written under the old key first), and from a fallback timer so the last
// few seconds aren't stranded in memory if no further message arrives. A
// flush inside a heartbeat piggybacks on that heartbeat's single storage
// write. The worst case on a worker crash is losing < STATS_FLUSH_MS of stats.
const tickClock = {}; // domain -> last tick time (ms)
const pending = { day: null, deltas: {} }; // deltas not yet written, for one day key
let lastStatsFlushAt = 0;
let statsFlushTimer = null;

// Hostname -> stats key: lowercase, leading "www." stripped. "" if unusable.
function statsDomain(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

// Drop day-buckets older than the most recent STATS_DAYS (keys are
// zero-padded so a plain sort is chronological).
function pruneStats(stats) {
  const days = Object.keys(stats).sort();
  while (days.length > STATS_DAYS) delete stats[days.shift()];
  return stats;
}

function accrueStats(day, domain, delta) {
  if (!(delta > 0)) return;
  pending.day = day;
  pending.deltas[domain] = (pending.deltas[domain] || 0) + delta;
}

// Merge the pending deltas into `base` (the stats object read from storage)
// and return the object to write — or null if there's nothing to write or it's
// not time yet. Pure apart from clearing `pending`.
function drainStats(base, now, force) {
  if (!pending.day) return null;
  if (!force && now - lastStatsFlushAt < STATS_FLUSH_MS) return null;
  const stats = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const dayRaw = stats[pending.day];
  const day = dayRaw && typeof dayRaw === "object" ? dayRaw : {};
  for (const [domain, ms] of Object.entries(pending.deltas)) {
    day[domain] = (typeof day[domain] === "number" ? day[domain] : 0) + ms;
  }
  stats[pending.day] = day;
  pending.day = null;
  pending.deltas = {};
  lastStatsFlushAt = now;
  cancelStatsFlushTimer();
  return pruneStats(stats);
}

// Also used by tests as a teardown hook so a real-timer flush armed by one
// module instance can't outlive it and fire into a later test's mock.
function cancelStatsFlushTimer() {
  if (statsFlushTimer) {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = null;
  }
}

// Make sure anything left in `pending` reaches storage within STATS_FLUSH_MS
// even if no further heartbeat/leaving arrives (tab closed without a
// "leaving", user went idle). Runs through the handle queue like every other
// storage read-modify-write.
function armStatsFlushTimer(now) {
  if (!pending.day || statsFlushTimer) return;
  const delay = Math.max(0, lastStatsFlushAt + STATS_FLUSH_MS - now);
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = null;
    enqueue(async () => {
      const stored = await get("stats");
      const stats = drainStats(stored.stats, Date.now(), true);
      if (stats) await set({ stats });
    });
  }, delay);
  // Under Node (tests) don't let a pending flush keep the process alive.
  if (statsFlushTimer && typeof statsFlushTimer.unref === "function") statsFlushTimer.unref();
}

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
// which ones, and until when. A global blackout shows up here as every site
// locked with reason "schedule".
function snapshotForHost(focusSites, usage, globalBudgetMs, now, schedule) {
  const sites = {};
  let anyLocked = false;
  let minRemaining = globalBudgetMs;
  for (const site of focusSites) {
    const s = evaluateSite(site, usage, globalBudgetMs, now, schedule);
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
  return enqueue(() => pushSnapshotLocked(extra));
}

async function pushSnapshotLocked(extra) {
  const stored = await get(["focusSites", "usage", "budgetSeconds", "schedule"]);
  const now = Date.now();
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const globalBudgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const usage = normalizeUsage(stored.usage, now);
  // normalizeUsage() hands an expired cool-down a fresh allowance; persist
  // that so the reset is durable rather than recomputed on every read.
  await set({ usage });
  const snap = snapshotForHost(focusSites, usage, globalBudgetMs, now, stored.schedule);
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
  const stored = await get(["focusSites", "usage", "budgetSeconds", "schedule"]);
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const site = matchSite(hostname, focusSites);
  if (!site) return { locked: false, site: null, focusSites };
  const now = Date.now();
  const usage = normalizeUsage(stored.usage, now);
  const globalBudgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const schedule = stored.schedule;
  const status = evaluateSite(site, usage, globalBudgetMs, now, schedule);
  return { ...status, site, focusSites, usage, globalBudgetMs, now, schedule };
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
  notifyNativeHost(snapshotForHost(status.focusSites, status.usage, status.globalBudgetMs, status.now, status.schedule));
  await redirectToBlock(details.tabId, hostname, status);
}

chrome.webNavigation.onBeforeNavigate.addListener(guardNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(guardNavigation); // SPA nav

// All storage read-modify-writes (message handling, alarm snapshots, the
// stats flush timer) are serialized through this queue so two tabs'
// heartbeats can never interleave on the usage or stats records.
let handleQueue = Promise.resolve();
function enqueue(fn) {
  const result = handleQueue.then(fn);
  handleQueue = result.catch(() => {});
  return result;
}
async function handle(msg) {
  return enqueue(() => handleLocked(msg));
}

async function handleLocked(msg) {
  const stored = await get(["focusSites", "settings", "usage", "budgetSeconds", "stats", "schedule"]);
  const focusSites = (stored.focusSites || []).map(normalizeSite);
  const settings = { ...DEFAULTS.settings, ...(stored.settings || {}) };
  const globalBudgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const schedule = stored.schedule;
  const now = Date.now();
  const usage = normalizeUsage(stored.usage, now);

  const domain = statsDomain(msg.hostname);
  const site = matchSite(msg.hostname, focusSites);

  // Every page is told to keep heartbeating (that feeds the stats); `tracked`
  // says whether this page is on the distraction list (budget + badge);
  // `free` says the global schedule isn't enforcing right now (off-hours), so
  // nothing is being charged and the badge stays hidden.
  const untracked = () => ({ track: true, tracked: false, overlay: false, settings });
  const respond = (status) => ({
    track: true,
    tracked: true,
    overlay: status.locked,
    free: !!status.free,
    reason: status.reason,
    until: status.until,
    remainingMs: status.remainingMs,
    budgetMs: status.budgetMs,
    settings
  });

  // Content script announces it just became engaged with a page.
  if (msg.type === "entering") {
    if (!domain) return { track: false };
    // Start this domain's stats clock — unless it's still live (another tab
    // on the same domain ticked within TICK_LIVE_MS), in which case leave it
    // so the next heartbeat credits the whole interval since that tick.
    if (!(now - tickClock[domain] <= TICK_LIVE_MS)) tickClock[domain] = now;
    if (!site) return untracked(); // stats only — usage is never touched
    const rec = siteUsage(usage, site.domain);
    rec.lastTickAt = now;
    const status = evaluateSite(site, usage, globalBudgetMs, now, schedule);
    if (status.locked && status.reason === "budget") rec.lockedUntil = status.until;
    await set({ usage });
    armUnlock(site, status);
    notifyNativeHost(snapshotForHost(focusSites, usage, globalBudgetMs, now, schedule));
    return respond(status);
  }

  // Per-second engaged heartbeat while the page is visible and non-idle.
  if (msg.type === "heartbeat") {
    if (!domain) return { track: false };

    // Per-domain stats for EVERY page. Real elapsed time (capped) so
    // worker-sleep gaps don't over/under count.
    const statsDelta = Math.min(now - (tickClock[domain] ?? now), TICK_CAP_MS);
    tickClock[domain] = now;
    const today = todayKey();
    // A new calendar day: write what's pending under the old day key first.
    let stats = pending.day && pending.day !== today ? drainStats(stored.stats, now, true) : null;
    accrueStats(today, domain, statsDelta);
    const due = drainStats(stats || stored.stats, now, false);
    if (due) stats = due;
    armStatsFlushTimer(now);
    const patch = stats ? { stats } : {};

    if (!site) {
      if (stats) await set(patch);
      return untracked();
    }

    // Budget/usage accrual for tracked sites (unchanged by the stats work).
    const rec = siteUsage(usage, site.domain);
    const delta = Math.min(now - (rec.lastTickAt || now), TICK_CAP_MS);
    // Time spent off-hours, during a global blackout, or while a per-site
    // block window already locks the site (the redirect is in flight)
    // shouldn't eat into today's budget. Stats (above) accrue regardless.
    if (usageAccrues(site, now, schedule)) {
      rec.totalMs += delta;
      usage.totalMs += delta;
    }
    rec.lastTickAt = now;
    const status = evaluateSite(site, usage, globalBudgetMs, now, schedule);
    // Exhausting the site's own budget starts its cool-down clock.
    if (status.locked && status.reason === "budget") rec.lockedUntil = status.until;
    patch.usage = usage;
    await set(patch); // one write: usage, plus stats when a flush is due
    armUnlock(site, status);
    notifyNativeHost(snapshotForHost(focusSites, usage, globalBudgetMs, now, schedule));
    return respond(status);
  }

  // Content script left the page (tab hidden / navigation): don't leave the
  // last few seconds of stats sitting in memory.
  if (msg.type === "leaving") {
    const stats = drainStats(stored.stats, now, true);
    if (stats) await set({ stats });
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
    scheduleStateAt,
    scheduleBlackoutUntil,
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
    UNLOCK_ALARM_PREFIX,
    STATS_DAYS,
    STATS_FLUSH_MS,
    TICK_LIVE_MS,
    statsDomain,
    pruneStats,
    cancelStatsFlushTimer
  };
}
