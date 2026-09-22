// Focus Cap — schedule evaluation, shared by the background worker and the
// settings/popup pages (loaded via importScripts / <script>). Pure functions,
// with names unlikely to collide with page globals.

// "HH:MM" -> minutes since midnight.
function schedToMin(hhmm) {
  const [h, m] = (hhmm || "0:0").split(":").map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

// Is `mins` (minutes since midnight) inside [start, end)? Supports overnight
// windows where start > end (e.g. 22:00–06:00).
function schedInRange(mins, start, end) {
  const s = schedToMin(start);
  const e = schedToMin(end);
  if (s === e) return false; // empty / zero-length window
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

// Given a schedule and a moment, return { enforcing, blackout }.
//   enforcing — the daily budget is active right now (block when spent)
//   blackout  — blocked sites are fully off-limits right now (ignore budget)
// A disabled/absent schedule means "always enforce, never blackout" (the
// original 24/7 behavior).
function scheduleStateAt(schedule, now) {
  now = now || new Date();
  if (!schedule || !schedule.enabled) return { enforcing: true, blackout: false };

  const day = now.getDay(); // 0 = Sunday
  const mins = now.getHours() * 60 + now.getMinutes();

  const days = schedule.days && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const windows = schedule.windows || [];
  const blackouts = schedule.blackouts || [];

  // Blackout: any rule whose day set (empty = every day) and time range match.
  const blackout = blackouts.some(
    (b) =>
      (b.days && b.days.length ? b.days.includes(day) : true) &&
      schedInRange(mins, b.start, b.end)
  );

  // Enforcement: an enforcement day AND (no windows = all day, or in a window).
  const enforcing =
    days.includes(day) &&
    (windows.length === 0 || windows.some((w) => schedInRange(mins, w.start, w.end)));

  return { enforcing, blackout };
}

// Human summary of the schedule for compact status lines.
const SCHED_DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function scheduleSummary(schedule) {
  if (!schedule || !schedule.enabled) return "Always on";
  const state = scheduleStateAt(schedule, new Date());
  if (state.blackout) return "Blackout — fully blocked now";
  return state.enforcing ? "Enforcing now" : "Off-hours — not enforcing";
}
