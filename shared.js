// Focus Cap -- small helpers shared by background.js, content.js, dashboard.js and options.js.
// Loaded via importScripts() in the background service worker, as an extra
// content_scripts entry (content scripts injected together share one global
// scope), and as a <script> tag before the page script in every HTML page.

// Local calendar day of `date` as a zero-padded "YYYY-MM-DD" key. Zero
// padding keeps the keys lexically sortable, which the stats pruning (and the
// stats page's 7-day lookback) rely on.
function dayKey(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today's day key.
function todayKey() {
  return dayKey(new Date());
}

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// parseInt that falls back only on NaN — an explicit "0" stays 0 instead of
// being swallowed by a `|| fallback`.
function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

// "17:00" for a same-day timestamp, "midnight" for the upcoming local
// midnight (the daily reset), "Thu 18:00" for anything else on another day.
function fmtUntil(ms) {
  if (typeof ms !== "number") return "";
  if (ms === nextLocalMidnightMs()) return "midnight";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${SCHED_DAY_ABBR[d.getDay()]} ${time}`;
}

// One line of status text for an evaluateSite() result, shared by the popup
// rows and the options page so the two can never word a lock differently.
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

// ---- Per-site schedule rules ----
// A rule is { type: "block" | "allow", days: [0..6] (Sunday = 0), start: "HH:MM", end: "HH:MM" }.
// Precedence (see scheduleVerdict): an active block rule always wins; if a
// site has any allow rules at all, it's blocked outside every allow window;
// with no rules the schedule has no opinion and budgets decide.

// Safety cap for the "walk forward through adjacent windows" loops below:
// enough to cross a full week of back-to-back windows, never unbounded.
const MAX_WINDOW_HOPS = 64;

// The absolute ms of `minutes` past local midnight, `dayOffset` days after
// `base`'s calendar day. Resolved through the Date wall-clock setters, NOT by
// adding 24h multiples: across a DST change a local day is 23 or 25 hours
// long, so "+ n * 24h" lands an hour off. (Issue #15.)
function localTimeMs(base, dayOffset, minutes) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(0, 0, 0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

// "09:30" -> 570 (minutes since local midnight). Returns null if malformed.
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

// Local midnight at the start of the given date's day.
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Is this rule's window active at `date`? Windows with end <= start wrap
// past midnight (e.g. 22:00-02:00), so the post-midnight part belongs to
// the previous day's day-of-week.
function ruleActiveAt(rule, date) {
  const start = parseHHMM(rule && rule.start);
  const end = parseHHMM(rule && rule.end);
  const days = Array.isArray(rule && rule.days) ? rule.days : [];
  if (start === null || end === null || !days.length) return false;
  const d = new Date(date);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  if (end > start) return days.includes(day) && minutes >= start && minutes < end;
  const prevDay = (day + 6) % 7;
  return (days.includes(day) && minutes >= start) || (days.includes(prevDay) && minutes < end);
}

// "block" | "allow" | null (no rules -> no opinion).
function scheduleVerdict(rules, date) {
  const list = Array.isArray(rules) ? rules : [];
  if (list.some((r) => r && r.type === "block" && ruleActiveAt(r, date))) return "block";
  const allows = list.filter((r) => r && r.type === "allow");
  if (!allows.length) return null;
  return allows.some((r) => ruleActiveAt(r, date)) ? "allow" : "block";
}

// Latest end, as absolute ms, among the block windows active at `at`.
// A wrapped window (22:00-02:00) entered before midnight ends tomorrow; in
// its post-midnight tail it ends today. null if none is active.
function activeBlockEnd(list, at) {
  const minutes = at.getHours() * 60 + at.getMinutes();
  let latest = null;
  for (const r of list) {
    if (!r || r.type !== "block" || !ruleActiveAt(r, at)) continue;
    const start = parseHHMM(r.start);
    const end = parseHHMM(r.end);
    const endsTomorrow = end <= start && minutes >= start;
    const endMs = localTimeMs(at, endsTomorrow ? 1 : 0, end);
    if (latest === null || endMs > latest) latest = endMs;
  }
  return latest;
}

// Soonest allow-window start strictly after `at`, searched a week out.
function nextAllowStart(list, at) {
  let soonest = null;
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dow = new Date(localTimeMs(at, dayOffset, 0)).getDay();
    for (const r of list) {
      if (!r || r.type !== "allow" || !Array.isArray(r.days) || !r.days.includes(dow)) continue;
      const start = parseHHMM(r.start);
      if (start === null) continue;
      const t = localTimeMs(at, dayOffset, start);
      if (t > at.getTime() && (soonest === null || t < soonest)) soonest = t;
    }
    if (soonest !== null) break;
  }
  return soonest;
}

// When does the current schedule-driven block end? Walks forward from `date`
// until the schedule no longer says "block": through the active block
// window's end, then on through any window that starts right where the
// previous one ended (09-12 then 12-17 reports 17:00, not 12:00), and
// through "outside every allow window" stretches to the next allow start.
// null if not blocked by schedule, or if the block has no foreseeable end
// (an allow rule whose days never match) — callers show "indefinitely".
function scheduleBlockedUntil(rules, date) {
  const list = Array.isArray(rules) ? rules : [];
  let t = new Date(date);
  if (scheduleVerdict(list, t) !== "block") return null;
  for (let hop = 0; hop < MAX_WINDOW_HOPS; hop++) {
    const end = activeBlockEnd(list, t);
    const next = end !== null ? end : nextAllowStart(list, t);
    if (next === null || next <= t.getTime()) return null;
    t = new Date(next);
    if (scheduleVerdict(list, t) !== "block") return t.getTime();
  }
  return null;
}

// ---- Global schedule: enforcement windows + blackouts ----
// One schedule for the whole extension, layered OVER the per-site rules:
//   { enabled, days: [0..6], windows: [{ start, end }], blackouts: [{ start, end, days }] }
//   enforcing — budgets and per-site rules are live right now: an enforcement
//               day AND (no windows = all day, or inside one of them)
//   blackout  — every tracked site is off-limits right now, whatever its
//               budget says (a blackout's empty `days` means every day)
// A disabled/absent schedule means "always enforce, never blackout".

const SCHED_DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_DEFAULTS = { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [] };

// "HH:MM" -> minutes since midnight. Lenient: a missing or unparseable part
// counts as 0, so a malformed window degrades to 00:00 rather than throwing.
function schedToMin(hhmm) {
  const [h, m] = String(hhmm || "0:0")
    .split(":")
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  return h * 60 + m;
}

// Is `mins` (minutes since midnight) inside [start, end)? Supports overnight
// ranges where start > end (22:00-06:00). start === end is an empty range.
function schedInRange(mins, start, end) {
  const s = schedToMin(start);
  const e = schedToMin(end);
  if (s === e) return false;
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

function schedList(list) {
  return Array.isArray(list) ? list.filter((x) => x && typeof x === "object") : [];
}

function schedBlackoutMatches(b, day, mins) {
  const days = Array.isArray(b.days) && b.days.length ? b.days : null;
  return (days ? days.includes(day) : true) && schedInRange(mins, b.start, b.end);
}

// { enforcing, blackout } for the schedule at `date` (default: now).
function scheduleStateAt(schedule, date) {
  const now = date === undefined ? new Date() : new Date(date);
  if (!schedule || !schedule.enabled) return { enforcing: true, blackout: false };
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : SCHEDULE_DEFAULTS.days;
  const windows = schedList(schedule.windows);
  const blackouts = schedList(schedule.blackouts);
  const blackout = blackouts.some((b) => schedBlackoutMatches(b, day, mins));
  const enforcing = days.includes(day) && (windows.length === 0 || windows.some((w) => schedInRange(mins, w.start, w.end)));
  return { enforcing, blackout };
}

// Latest end, as absolute ms, among the blackouts active at `at`; an
// overnight blackout entered before midnight ends tomorrow. null if none.
function activeBlackoutEnd(schedule, at) {
  const day = at.getDay();
  const mins = at.getHours() * 60 + at.getMinutes();
  let latest = null;
  for (const b of schedList(schedule.blackouts)) {
    if (!schedBlackoutMatches(b, day, mins)) continue;
    const s = schedToMin(b.start);
    const e = schedToMin(b.end);
    const endsTomorrow = s > e && mins >= s;
    const endMs = localTimeMs(at, endsTomorrow ? 1 : 0, e);
    if (latest === null || endMs > latest) latest = endMs;
  }
  return latest;
}

// Absolute ms at which the blackout active at `date` ends, walking through
// blackouts that start right where the previous one ended (and resolving
// ends through the wall clock, so DST days don't shift it by an hour).
// null when no blackout is active.
function scheduleBlackoutUntil(schedule, date) {
  let t = date === undefined ? new Date() : new Date(date);
  if (!schedule || !schedule.enabled) return null;
  for (let hop = 0; hop < MAX_WINDOW_HOPS; hop++) {
    const end = activeBlackoutEnd(schedule, t);
    if (end === null) return hop === 0 ? null : t.getTime();
    if (end <= t.getTime()) return null;
    t = new Date(end);
    if (!scheduleStateAt(schedule, t).blackout) return t.getTime();
  }
  return null;
}

// ---- Per-site evaluation (shared by background.js enforcement, the popup, and the badge) ----

// Match a page hostname against the user's distraction list.
// "youtube.com" matches youtube.com and www.youtube.com and m.youtube.com.
function matchSite(hostname, sites) {
  const h = (hostname || "").replace(/^www\./, "").toLowerCase();
  return (sites || []).find((s) => {
    const d = ((s && s.domain) || "").replace(/^www\./, "").toLowerCase();
    if (!d) return false;
    return h === d || h.endsWith("." + d);
  });
}

const SITE_DEFAULTS = {
  budgetSeconds: 1800, // 30 min/day
  lockoutSeconds: null, // until midnight
  rules: []
};

function nextLocalMidnightMs(from) {
  const midnight = from === undefined ? new Date() : new Date(from);
  midnight.setHours(24, 0, 0, 0); // next local midnight
  return midnight.getTime();
}

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
    // Drop non-object entries (corrupt storage) so consumers can index rule
    // fields without guarding every access.
    rules: Array.isArray(s.rules) ? s.rules.filter((r) => r && typeof r === "object") : SITE_DEFAULTS.rules
  };
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

function lockoutEndFor(site, now) {
  return typeof site.lockoutSeconds === "number" ? now + site.lockoutSeconds * 1000 : nextLocalMidnightMs(now);
}

// Decide whether a site is currently locked and why. Order:
//   0. a global blackout (reason "schedule", until the blackout ends)
//   1. this site's own schedule rules (block window active, or outside every
//      allow window)
//   2. off-hours: outside the global enforcement windows / on a non-enforce
//      day the site is free — not locked, nothing accrues
//   3. an in-progress cool-down lockout
//   4. this site's own daily budget
//   5. the global cap across all sites
// Returns { locked, free, reason, until, remainingMs, budgetMs } where
// budgetMs / remainingMs reflect the tighter of the site's and the global
// allowance. `free` is true only for the off-hours case, where remainingMs
// is the full allowance (time spent off-hours is never charged).
// `schedule` is the global schedule (absent = always enforcing).
function evaluateSite(site, usage, globalBudgetMs, now, schedule) {
  const rec = siteUsage(usage, site.domain);
  const siteBudgetMs = site.budgetSeconds * 1000;
  const remainingSite = Math.max(0, siteBudgetMs - rec.totalMs);
  const remainingGlobal = Math.max(0, globalBudgetMs - usage.totalMs);
  const remainingMs = Math.min(remainingSite, remainingGlobal);
  const budgetMs = Math.min(siteBudgetMs, globalBudgetMs);
  const at = new Date(now);

  const global = scheduleStateAt(schedule, at);
  if (global.blackout) {
    return { locked: true, free: false, reason: "schedule", until: scheduleBlackoutUntil(schedule, at), remainingMs, budgetMs };
  }
  const verdict = scheduleVerdict(site.rules, at);
  if (verdict === "block") {
    return { locked: true, free: false, reason: "schedule", until: scheduleBlockedUntil(site.rules, at), remainingMs, budgetMs };
  }
  if (!global.enforcing) {
    return { locked: false, free: true, reason: null, until: null, remainingMs: budgetMs, budgetMs };
  }
  if (typeof rec.lockedUntil === "number" && now < rec.lockedUntil) {
    return { locked: true, free: false, reason: "lockout", until: rec.lockedUntil, remainingMs: 0, budgetMs };
  }
  if (rec.totalMs >= siteBudgetMs) {
    return { locked: true, free: false, reason: "budget", until: lockoutEndFor(site, now), remainingMs: 0, budgetMs };
  }
  if (usage.totalMs >= globalBudgetMs) {
    return { locked: true, free: false, reason: "global", until: nextLocalMidnightMs(now), remainingMs: 0, budgetMs };
  }
  return { locked: false, free: false, reason: null, until: null, remainingMs, budgetMs };
}

// Should a heartbeat on this site charge its budget right now? Not during a
// global blackout, not off-hours, and not while a per-site block window is
// active (the redirect is in flight — that time shouldn't eat into today).
function usageAccrues(site, now, schedule) {
  const at = new Date(now);
  const global = scheduleStateAt(schedule, at);
  return global.enforcing && !global.blackout && scheduleVerdict(site.rules, at) !== "block";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    dayKey,
    todayKey,
    fmtClock,
    parseIntOr,
    fmtUntil,
    describeStatus,
    RULE_GRACE_MS,
    ruleInGrace,
    parseHHMM,
    ruleActiveAt,
    scheduleVerdict,
    scheduleBlockedUntil,
    SCHED_DAY_ABBR,
    SCHEDULE_DEFAULTS,
    scheduleStateAt,
    scheduleBlackoutUntil,
    usageAccrues,
    matchSite,
    SITE_DEFAULTS,
    nextLocalMidnightMs,
    normalizeSite,
    normalizeUsage,
    siteUsage,
    lockoutEndFor,
    evaluateSite
  };
}
