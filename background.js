// Focus Cap — background service worker.
// Tracks how much active time you spend on each distraction site against
// per-site rules — a daily budget, an optional cool-down lockout, and optional
// allow/block schedule windows — plus one global daily cap across all sites.
// Usage resets automatically at local midnight (checked lazily). Separately,
// every page's engaged time is recorded per domain per day for the stats page.

if (typeof importScripts === "function") importScripts("shared.js");

// Storage layout (chrome.storage.local):
//   schemaVersion: integer, SCHEMA_VERSION (shared.js) once migrateStorage()
//     below has run; absent on installs that predate it (treated as 0)
//   focusSites: [{ domain, budgetSeconds, lockoutSeconds, rules }]
//     budgetSeconds  — this site's own daily allowance
//     lockoutSeconds — how long the site stays blocked after exhausting its
//                      budget; null = until local midnight
//     rules          — [{ type: "block"|"allow", days, start, end }], see shared.js
//     (entries saved as a bare { domain } before per-site rules existed are
//     rewritten to this shape by the v0 -> v1 migration; normalizeSite()
//     still fills defaults at read time as a safety net)
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
  // Global enforcement windows + blackouts; off = always on. Copied so an
  // in-place edit of DEFAULTS can never alter the fallback scheduleStateAt()
  // uses when storage has no schedule.
  schedule: { ...SCHEDULE_DEFAULTS, days: [...SCHEDULE_DEFAULTS.days] }
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

// ---- Storage schema migration ----
//
// MIGRATIONS[n] upgrades a store at schemaVersion n to n + 1 — a pure
// function of the stored keys it cares about that returns only the keys it
// changed (an empty object when the data already has the new shape, so an
// install whose data happens to be current gets just the version stamp).
// migrateStorage() runs them in order from the stored version (absent =
// 0) up to SCHEMA_VERSION and writes the union plus the new version in ONE
// set() — or nothing at all when the version already matches, so a routine
// startup never emits a storage.onChanged event. A store stamped with a
// version NEWER than this build (a downgrade) is left untouched: the
// read-time normalizers (normalizeSite / normalizeUsage) keep enforcement
// working on whatever shape they find, and we warn rather than guess.
const MIGRATIONS = [
  // v0 -> v1: day keys became zero-padded (stats/usage written as
  // "2026-9-5" would otherwise sort out of order and, for usage, be read as
  // "not today" — wiping today's usage on the first run of the padded
  // build); and legacy { domain }-only sites get their defaults persisted.
  function v0ToV1(stored) {
    const patch = {};
    const usage = stored.usage;
    if (usage && typeof usage === "object" && typeof usage.date === "string") {
      const date = padDayKey(usage.date);
      if (date !== usage.date) patch.usage = { ...usage, date };
    }
    const stats = stored.stats;
    if (stats && typeof stats === "object" && !Array.isArray(stats)) {
      const merged = mergePaddedStats(stats);
      if (merged) patch.stats = merged;
    }
    if (Array.isArray(stored.focusSites)) {
      // Materialise legacy { domain } entries with their defaults. Garbage
      // entries (null, strings, no domain) used to be ignored at read time;
      // don't bake them into storage as empty-domain sites — drop them.
      const sites = stored.focusSites.map(normalizeSite).filter((s) => s.domain);
      if (JSON.stringify(sites) !== JSON.stringify(stored.focusSites)) patch.focusSites = sites;
    }
    return patch;
  }
];

// Rewrite every legacy day key in a stats object to its padded form. When a
// day exists under both spellings (the padded build ran after the unpadded
// one on the same day) the two buckets are merged by summing each domain's
// ms, since both are genuine engaged time for that day. Returns the new
// object, or null when no key needed padding.
function mergePaddedStats(stats) {
  let changed = false;
  const out = {};
  for (const [key, raw] of Object.entries(stats)) {
    const day = padDayKey(key);
    if (day !== key) changed = true;
    const bucket = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (!out[day]) {
      out[day] = day === key ? bucket : { ...bucket };
      continue;
    }
    const target = { ...out[day] }; // never mutate the bucket read from storage
    for (const [domain, ms] of Object.entries(bucket)) {
      const prev = typeof target[domain] === "number" ? target[domain] : 0;
      target[domain] = prev + (typeof ms === "number" ? ms : 0);
    }
    out[day] = target;
  }
  return changed ? out : null;
}

// The stored schemaVersion as an integer: anything missing or malformed is
// a pre-versioning store, i.e. 0.
function storedSchemaVersion(stored) {
  const v = stored.schemaVersion;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

// Pure planner: { status: "current" | "newer" | "upgrade", from, patch }.
// `patch` is the single set() payload for an upgrade; null otherwise.
function planMigration(stored) {
  const from = storedSchemaVersion(stored);
  if (from === SCHEMA_VERSION) return { status: "current", from, patch: null };
  if (from > SCHEMA_VERSION) return { status: "newer", from, patch: null };
  let view = stored;
  const patch = {};
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v] ? MIGRATIONS[v](view) : {};
    Object.assign(patch, step);
    view = { ...view, ...step }; // the next step sees the previous step's result
  }
  patch.schemaVersion = SCHEMA_VERSION;
  return { status: "upgrade", from, patch };
}

// Runs through the handle queue so the rewrite can't interleave with a
// heartbeat's read-modify-write of usage/stats. Resolves to the plan's
// status so callers (and tests) can tell what happened.
function migrateStorage() {
  return enqueue(async () => {
    const stored = await get(["schemaVersion", "usage", "stats", "focusSites"]);
    const plan = planMigration(stored);
    if (plan.status === "newer") {
      console.warn(`Focus Cap: storage is schemaVersion ${plan.from}, newer than this build understands (${SCHEMA_VERSION}); leaving it untouched.`);
    } else if (plan.status === "upgrade") {
      await set(plan.patch);
    }
    return plan.status;
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await get(Object.keys(DEFAULTS));
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) patch[k] = DEFAULTS[k];
  }
  if (Object.keys(patch).length) await set(patch);
  // Defaults are seeded first, but a migration step must not rely on that:
  // onStartup also fires migrateStorage() (concurrently, on a command-line
  // loaded extension), so every step guards each key it touches.
  await migrateStorage();
  scheduleMidnightAlarm();

  // On first install, open the dashboard (options page) so the user can
  // onboard. Guarded by a stored flag so it opens exactly once — not on
  // every dev reload or update.
  if (details && details.reason === "install") {
    const { welcomed } = await get("welcomed");
    if (!welcomed) {
      await set({ welcomed: true });
      chrome.tabs.create({ url: chrome.runtime.getURL("options.html") }).catch(() => {});
    }
  }
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

// A browser restart doesn't fire onInstalled, but the stored data may have
// been written by an older build (the extension updated while the profile
// was closed), so the migration runs here too — a no-op write-free check
// when the version already matches.
chrome.runtime.onStartup.addListener(() => {
  scheduleMidnightAlarm();
  migrateStorage();
});

// Per-site lock snapshot for the companion app. `locked` is true if ANY site
// is locked; `sites` carries each site's own state so the companion can say
// which ones, and until when. A global blackout shows up here as every site
// locked with reason "schedule".
function snapshotForHost(focusSites, usage, globalBudgetMs, now, schedule) {
  // Keyed by domain, so null-prototype like usage.sites: a legacy stored
  // domain named "__proto__" must be an own entry, never a prototype swap.
  const sites = Object.create(null);
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

// In a packed/store build Chrome clamps a one-shot alarm to a 30-second
// minimum delay ("Alarm delay is less than minimum of 30 seconds. In released
// .crx, alarm ... will fire in approximately 30 seconds."); unpacked builds
// honour any delay. The extension itself still unlocks on time (evaluation is
// lazy via normalizeUsage on the next visit/heartbeat) — only the companion's
// notification would lag. So a lock ending sooner than this also arms a plain
// timer at the real unlock time as a best-effort early push; the alarm stays
// the durable backstop because a service-worker shutdown drops timers. The
// alarm itself is deliberately NOT floored: that would delay the unpacked
// case for nothing, and Chrome clamps the packed case anyway. (#17)
const ALARM_MIN_DELAY_MS = 30 * 1000;
const unlockTimers = new Map(); // domain -> pending sub-floor timer

function cancelUnlockTimer(domain) {
  const timer = unlockTimers.get(domain);
  if (timer === undefined) return;
  clearTimeout(timer);
  unlockTimers.delete(domain);
}

// Test teardown hook (like cancelStatsFlushTimer) so a timer armed by one
// module instance can't fire into a later test's mock.
function cancelUnlockTimers() {
  for (const domain of [...unlockTimers.keys()]) cancelUnlockTimer(domain);
}

function scheduleUnlockAlarm(domain, until) {
  if (typeof until !== "number" || until <= Date.now()) return;
  chrome.alarms.create(UNLOCK_ALARM_PREFIX + domain, { when: until });
  // One pending timer per domain: re-arming replaces the previous one so the
  // early push can't double-fire.
  cancelUnlockTimer(domain);
  const delay = until - Date.now();
  if (delay >= ALARM_MIN_DELAY_MS || typeof setTimeout !== "function") return;
  // The alarm is left armed on purpose as the durable backstop, so in a
  // packed build it fires a second, identical (idempotent) push at the clamp.
  // A storage failure here is swallowed: a dropped early push just means the
  // alarm path reports the unlock instead, and a timer callback has nowhere
  // to surface a rejection anyway.
  const timer = setTimeout(() => {
    unlockTimers.delete(domain);
    onUnlockDue(domain).catch(() => {});
  }, delay);
  // Under Node (tests) don't let a pending early push keep the process alive.
  if (timer && typeof timer.unref === "function") timer.unref();
  unlockTimers.set(domain, timer);
}

// Shared by the unlock alarm and the sub-floor early-push timer: tell the
// companion the site's state now, and if the site is free clear the stale
// "what was blocked" for its pill (if it's still locked for another reason,
// leave it — pushSnapshot re-arms the later unlock).
async function onUnlockDue(domain) {
  cancelUnlockTimer(domain);
  const snap = await pushSnapshot();
  const site = snap.sites[domain];
  if (site && !site.locked) notifyNativeHost({ lastBlocked: "" });
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
    await onUnlockDue(alarm.name.slice(UNLOCK_ALARM_PREFIX.length));
  }
});

const BLOCK_PAGE = "time-is-up.html";

// Best-effort bridge to the desktop companion app (see native-host/ and
// companion/). Entirely optional: if the native host isn't installed or
// registered, connectNative either throws synchronously or the port
// disconnects immediately — either way we silently do nothing, since the
// extension must keep working with zero setup beyond "load unpacked".
// The wire-protocol version this build expects the native host to reply
// with (native-host/host.js PROTOCOL_VERSION). A mismatch — or a reply
// from a host too old to send one — is only warned about for now (GitHub
// issue #12, phase 1); the snapshot is still sent, since the host sanitizes
// whatever it gets.
const NATIVE_PROTOCOL_VERSION = 1;

let nativePort = null;
function getNativePort() {
  if (nativePort) return nativePort;
  if (typeof chrome.runtime.connectNative !== "function") return null;
  try {
    nativePort = chrome.runtime.connectNative("com.focuscap.host");
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
    });
    watchNativeProtocol(nativePort);
  } catch (_) {
    nativePort = null;
  }
  return nativePort;
}

// Warn once per connection if the host's replies don't speak our protocol
// version. Every reply is checked (not just the first) but the warning is
// emitted at most once, so a chatty session doesn't spam the console.
function watchNativeProtocol(port) {
  if (!port.onMessage || typeof port.onMessage.addListener !== "function") return;
  let warned = false;
  port.onMessage.addListener((reply) => {
    if (warned || !reply || typeof reply !== "object") return;
    if (reply.protocolVersion === NATIVE_PROTOCOL_VERSION) return;
    warned = true;
    const got = reply.protocolVersion === undefined ? "none (host predates protocol versioning)" : String(reply.protocolVersion);
    console.warn(`Focus Cap: native host protocolVersion ${got} differs from the expected ${NATIVE_PROTOCOL_VERSION} (host version ${reply.version || "unknown"}); update the native host and the extension together.`);
  });
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
  // The read-modify-write below goes through the same queue as heartbeats:
  // a navigation-time budget lock must never land on top of (and erase) a
  // usage increment a concurrent heartbeat is in the middle of writing.
  const status = await enqueue(async () => {
    const s = await isLocked(hostname);
    if (!s.locked) return s;
    // A budget lock discovered here (e.g. the site's budget was lowered below
    // what's already been used) has to start its cool-down clock too — the
    // redirect fires before content.js ever gets to send "entering", so no
    // heartbeat path would otherwise persist lockedUntil.
    if (s.reason === "budget" && s.site) {
      const rec = siteUsage(s.usage, s.site.domain);
      if (rec.lockedUntil !== s.until) {
        rec.lockedUntil = s.until;
        await set({ usage: s.usage });
      }
    }
    return s;
  });
  if (!status.locked) return;
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
  const untracked = () => ({ track: true, tracked: false, overlay: false, free: false, settings });
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
    NATIVE_PROTOCOL_VERSION,
    SCHEMA_VERSION,
    MIGRATIONS,
    mergePaddedStats,
    planMigration,
    migrateStorage,
    nextLocalMidnightMs,
    scheduleMidnightAlarm,
    snapshotForHost,
    pushSnapshot,
    DAILY_RESET_ALARM,
    UNLOCK_ALARM_PREFIX,
    ALARM_MIN_DELAY_MS,
    cancelUnlockTimers,
    STATS_DAYS,
    STATS_FLUSH_MS,
    TICK_LIVE_MS,
    statsDomain,
    pruneStats,
    cancelStatsFlushTimer
  };
}
