// Focus Cap — blocked page ("time is up"). Shows which site was blocked, why,
// and a live countdown to when it unlocks: the site's own cool-down end, the
// end of a schedule window, or the local-midnight reset. The details come
// from storage (written by background.js's redirectToBlock), not the URL, so
// the address bar stays clean.
//
// From the second block-page view of a day onwards it also shows a short
// encouraging message. The first view of the day stays plain — the first time
// you hit the wall the explanation is enough. The view counter lives in this
// page's localStorage ("views" / "viewsDay"), not in chrome.storage, so it is
// a purely cosmetic nudge and never affects enforcement.

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

// The encouraging messages, shown from the second block of the day onwards.
const MESSAGES = Object.freeze([
  "You're doing amazing; Keep going!",
  "Keep at it, and you'll be amazed at how far you've come.",
  "Back to the grind — you've got this.",
  "You're doing so good, you got this!",
  "The more you work now, the less you'll stress later.",
  "You know this isn't what you're supposed to be doing right now. You're doing great.",
  "Lock in! You're doing awesome."
]);

// Pick one message at random. `rng` is Math.random by default; tests inject a
// fixed one. Out-of-range values are clamped so a bad rng can't yield undefined.
function pickMessage(rng = Math.random) {
  const r = Number(rng());
  const i = Number.isNaN(r) ? 0 : Math.min(MESSAGES.length - 1, Math.max(0, Math.floor(r * MESSAGES.length)));
  return MESSAGES[i];
}

// How many block-page views have happened today, given the raw localStorage
// state { views, viewsDay } (strings or null) and today's key. A different
// (or missing) day means the counter starts over.
function viewsToday(viewsState, today) {
  const state = viewsState || {};
  if (state.viewsDay !== today) return 0;
  const n = Number(state.views);
  return Number.isNaN(n) || n < 0 ? 0 : Math.floor(n);
}

// Encourage only when this is NOT the first block-page view of the day.
function shouldEncourage(viewsState, today) {
  return viewsToday(viewsState, today) >= 1;
}

// The state to store after this view: today's count plus one.
function bumpViews(viewsState, today) {
  return { views: String(viewsToday(viewsState, today) + 1), viewsDay: today };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { describeBlock, fmtCountdown, MESSAGES, pickMessage, shouldEncourage, bumpViews, viewsToday };
}

if (typeof document !== "undefined" && document.getElementById("countdown")) {
  // Same day key main uses: the local date in Date#toDateString() form.
  const today = new Date().toDateString();
  const viewsState = { views: localStorage.getItem("views"), viewsDay: localStorage.getItem("viewsDay") };
  const encourage = shouldEncourage(viewsState, today);
  const next = bumpViews(viewsState, today);
  localStorage.setItem("views", next.views);
  localStorage.setItem("viewsDay", next.viewsDay);
  document.getElementById("encouragement").textContent = encourage ? pickMessage() : "";

  chrome.storage.local.get(["lastBlocked", "lastBlockedUntil", "lastBlockedReason"]).then((store) => {
    const domain = store.lastBlocked || "This site";
    const info = describeBlock(store.lastBlockedReason, store.lastBlockedUntil, Date.now());

    document.getElementById("domain").textContent = domain;
    document.getElementById("headline").textContent = info.heading;
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
