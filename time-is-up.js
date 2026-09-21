// Focus Cap — blocked page ("time is up"). Shows which site was blocked, why,
// and a live countdown to when it unlocks: the site's own cool-down end, the
// end of a schedule window, or the local-midnight reset. The details come
// from storage (written by background.js's redirectToBlock), not the URL, so
// the address bar stays clean.

// What to tell the user for a given lock. Pure, so it's testable.
function describeBlock(reason, until, now) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const isMidnight = typeof until !== "number" || until >= midnight.getTime();
  switch (reason) {
    case "schedule":
      // A schedule window can run past midnight (22:00-02:00, or "next allow
      // window is tomorrow"), and the daily reset doesn't end it — so count
      // to the real window end whenever we know it.
      return {
        heading: "Blocked right now",
        body: "is blocked by your schedule.",
        resetLabel: "Unblocks in",
        until: typeof until === "number" ? until : midnight.getTime()
      };
    case "lockout":
    case "budget":
      return {
        heading: isMidnight ? "Blocked for the day" : "Cooling down",
        body: isMidnight ? "is out of time for today." : "is out of time for now.",
        resetLabel: isMidnight ? "Resets in" : "Back in",
        until: isMidnight ? midnight.getTime() : until
      };
    case "global":
      return {
        heading: "Blocked for the day",
        body: "is out of time — your total cap across all sites is spent for today.",
        resetLabel: "Resets in",
        until: midnight.getTime()
      };
    default:
      return {
        heading: "Blocked for the day",
        body: "is out of time for today.",
        resetLabel: "Resets in",
        until: midnight.getTime()
      };
  }
}

function fmtCountdown(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { describeBlock, fmtCountdown };
}

if (typeof document !== "undefined" && document.getElementById("countdown")) {
  chrome.storage.local.get(["lastBlocked", "lastBlockedUntil", "lastBlockedReason"]).then((store) => {
    const domain = store.lastBlocked || "This site";
    const info = describeBlock(store.lastBlockedReason, store.lastBlockedUntil, Date.now());

    document.getElementById("domain").textContent = domain;
    document.getElementById("heading").textContent = info.heading;
    document.getElementById("body").textContent = ` ${info.body} Go do the thing you meant to do.`;
    document.getElementById("resetLabel").textContent = info.resetLabel;
    document.title = `${domain} — ${info.heading.toLowerCase()}`;

    const tick = () => {
      const left = info.until - Date.now();
      if (left <= 0) {
        // Stale tab left open past the unlock: don't show a negative timer.
        document.getElementById("resetLabel").textContent = "";
        document.getElementById("countdown").textContent = "You can go back now.";
        return;
      }
      document.getElementById("resetLabel").textContent = info.resetLabel;
      document.getElementById("countdown").textContent = fmtCountdown(left);
    };
    tick();
    setInterval(tick, 1000);
  });
}
