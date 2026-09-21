// Focus Cap -- small helpers shared by background.js, content.js, and dashboard.js.
// Loaded via importScripts() in the background service worker, as an extra
// content_scripts entry (content scripts injected together share one global
// scope), and as a <script> tag before dashboard.js in dashboard.html.

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { todayKey, fmtClock, parseHHMM, ruleActiveAt, scheduleVerdict, scheduleBlockedUntil };
}
