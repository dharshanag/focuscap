// Focus Cap — blocked page ("time is up"). Shows which site was blocked and a
// live countdown to the local-midnight reset. The blocked domain comes from
// storage (not the URL) so the address bar stays clean.

chrome.storage.local.get(["lastBlocked", "lastBlockReason"], ({ lastBlocked, lastBlockReason }) => {
  const domain = lastBlocked || "This site";
  document.getElementById("domain").textContent = domain;
  document.title = `${domain} — blocked`;

  if (lastBlockReason === "blackout") {
    // Scheduled full block — the daily budget isn't the reason, so no midnight countdown.
    document.getElementById("headline").textContent = "Blocked right now";
    document.getElementById("message").innerHTML =
      `<span class="domain">${domain}</span> is off-limits during your scheduled focus time.`;
    document.getElementById("resetLine").textContent = "It comes back when your scheduled block ends.";
  }
  // (budget reason keeps the default markup + the midnight countdown below)
});

function tickCountdown() {
  const el = document.getElementById("countdown");
  if (!el) return; // replaced by the blackout message
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // next local midnight
  let secs = Math.max(0, Math.floor((midnight - now) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  el.textContent = `${h}h ${pad(m)}m ${pad(s)}s`;
}

tickCountdown();
setInterval(tickCountdown, 1000);
