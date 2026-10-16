// Focus Cap -- small helpers shared by background.js, content.js, and dashboard.js.
// Loaded via importScripts() in the background service worker, as an extra
// content_scripts entry (content scripts injected together share one global
// scope), and as a <script> tag before dashboard.js in dashboard.html.

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

// ---- Per-site schedule rules ----
// A rule is { type: "block" | "allow", days: [0..6] (Sunday = 0), start: "HH:MM", end: "HH:MM" }.
// Precedence (see scheduleVerdict): an active block rule always wins; if a
// site has any allow rules at all, it's blocked outside every allow window;
// with no rules the schedule has no opinion and budgets decide.

const DAY_MS = 24 * 60 * 60 * 1000;

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

// When does the current schedule-driven block end? For an active block
// window: that window's end. For "outside every allow window": the next
// allow window's start (searched up to 7 days out). null if not blocked by
// schedule or if nothing is found.
function scheduleBlockedUntil(rules, date) {
  const list = Array.isArray(rules) ? rules : [];
  const now = new Date(date);
  const verdict = scheduleVerdict(list, now);
  if (verdict !== "block") return null;

  const activeBlocks = list.filter((r) => r && r.type === "block" && ruleActiveAt(r, now));
  if (activeBlocks.length) {
    // Latest end among active block windows, resolved to an absolute time.
    let latest = null;
    for (const r of activeBlocks) {
      const start = parseHHMM(r.start);
      const end = parseHHMM(r.end);
      const base = startOfDay(now).getTime();
      const minutes = now.getHours() * 60 + now.getMinutes();
      // If we're in the post-midnight tail of a wrapped window, its end is today; otherwise
      // a wrapped window's end is tomorrow.
      const endsTomorrow = end <= start && minutes >= start;
      const endMs = base + end * 60 * 1000 + (endsTomorrow ? DAY_MS : 0);
      if (latest === null || endMs > latest) latest = endMs;
    }
    return latest;
  }

  // Outside every allow window: find the soonest upcoming allow start.
  let soonest = null;
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dayStart = startOfDay(now).getTime() + dayOffset * DAY_MS;
    const dow = new Date(dayStart).getDay();
    for (const r of list) {
      if (!r || r.type !== "allow" || !Array.isArray(r.days) || !r.days.includes(dow)) continue;
      const start = parseHHMM(r.start);
      if (start === null) continue;
      const t = dayStart + start * 60 * 1000;
      if (t > now.getTime() && (soonest === null || t < soonest)) soonest = t;
    }
    if (soonest !== null) break;
  }
  return soonest;
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

// Absolute ms at which the blackout active at `date` ends — the latest end
// among every blackout matching right now; an overnight blackout entered
// before midnight ends tomorrow. null when no blackout is active.
function scheduleBlackoutUntil(schedule, date) {
  const now = date === undefined ? new Date() : new Date(date);
  if (!schedule || !schedule.enabled) return null;
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const base = startOfDay(now).getTime();
  let latest = null;
  for (const b of schedList(schedule.blackouts)) {
    if (!schedBlackoutMatches(b, day, mins)) continue;
    const s = schedToMin(b.start);
    const e = schedToMin(b.end);
    const endsTomorrow = s > e && mins >= s;
    const endMs = base + e * 60 * 1000 + (endsTomorrow ? DAY_MS : 0);
    if (latest === null || endMs > latest) latest = endMs;
  }
  return latest;
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
