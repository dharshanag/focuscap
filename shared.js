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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { todayKey, fmtClock };
}
