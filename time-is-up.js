// Focus Cap — blocked page ("time is up"). Shows which site was blocked and a
// live countdown to the local-midnight reset. The blocked domain comes from
// storage (not the URL) so the address bar stays clean.

chrome.storage.local.get("lastBlocked", ({ lastBlocked }) => {
  if (lastBlocked) {
    document.getElementById("domain").textContent = lastBlocked;
    document.title = `${lastBlocked} — time's up`;
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
