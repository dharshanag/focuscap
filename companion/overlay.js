// Focus Cap companion overlay — same look and countdown logic as the
// extension's time-is-up.js, but sourced from the shared state file (via
// preload.js) instead of chrome.storage, since this runs outside the browser.
window.focusCap.getState().then((state) => {
  if (state && state.lastBlocked) {
    document.getElementById("domain").textContent = state.lastBlocked;
    document.title = `${state.lastBlocked} — time's up`;
  }
});

function tickCountdown() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // next local midnight
  let secs = Math.max(0, Math.floor((midnight - now) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  document.getElementById("countdown").textContent = `${h}h ${pad(m)}m ${pad(s)}s`;
}

tickCountdown();
setInterval(tickCountdown, 1000);
