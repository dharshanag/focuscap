// Focus Cap companion corner pill — a small, non-blocking, always-on-top
// notice listing which tracked sites are currently locked and until when.
// Deliberately NOT a full-screen lock: the extension's promise is
// "distraction *sites* are locked", not "your computer is locked", and
// without foreground-window detection the companion can't tell whether a
// tracked site is even in front of you. It only informs; it never covers
// your work.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "17:00", "midnight" for the upcoming local midnight, "Thu 18:00" otherwise.
function fmtUntil(ms, now = Date.now()) {
  if (typeof ms !== "number") return "";
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  if (ms === midnight.getTime()) return "midnight";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${DAYS[d.getDay()]} ${time}`;
}

// One line per locked site, most-recently-blocked first. Falls back to the
// legacy single lastBlocked field for older extension builds.
function describeLocked(state, now = Date.now()) {
  const sites = state && state.sites && typeof state.sites === "object" ? state.sites : {};
  const locked = Object.entries(sites)
    .filter(([, s]) => s && s.locked)
    .map(([domain, s]) => ({ domain, until: typeof s.until === "number" ? s.until : null, reason: s.reason || null }));
  if (!locked.length && state && state.lastBlocked) {
    locked.push({ domain: state.lastBlocked, until: null, reason: null });
  }
  locked.sort((a, b) => (a.domain === (state && state.lastBlocked) ? -1 : b.domain === (state && state.lastBlocked) ? 1 : 0));
  return locked.map(({ domain, until, reason }) => {
    const when = until ? ` until ${fmtUntil(until, now)}` : "";
    const why = reason === "schedule" ? " (schedule)" : reason === "global" ? " (total cap)" : "";
    return `${domain}${when}${why}`;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { fmtUntil, describeLocked };
}

if (typeof window !== "undefined" && window.focusCap) {
  const refresh = async () => {
    const state = await window.focusCap.getState();
    const lines = describeLocked(state);
    document.getElementById("domain").textContent = lines[0] || "a tracked site";
    document.getElementById("label").textContent =
      lines.length > 1 ? `and ${lines.length - 1} more locked` : lines.length ? "is locked" : "is out of time today";
    document.getElementById("domain").title = lines.join("\n");
  };
  // Tell main once the current state is painted, so it can show the (reused,
  // hidden) window without flashing the previous lock's text. Report even if
  // reading the state failed, so the pill never stays hidden on an error.
  const refreshAndReport = () =>
    refresh()
      .catch(() => {})
      .then(() => window.focusCap.rendered && window.focusCap.rendered());
  if (window.focusCap.onRefresh) window.focusCap.onRefresh(refreshAndReport);
  refreshAndReport();
  setInterval(refresh, 2000);
}
