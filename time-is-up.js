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

const messages = ["You're doing amazing; Keep going!", "Keep at it, and you'll be amazed at how far you've come.",
   "Back to the grind — you've got this.", 
   "You're doing so good, you got this!", 
   "The more you work now, the less you'll stress later.",
    "You know this isn't what you're supposed to be doing right now. You're doing great.", 
    "Lock in! You're doing awesome."];
const randomIndex = Math.floor(Math.random() * messages.length);
const randomMessage = messages[randomIndex];

const today = new Date().toDateString();
let blockViews = Number(localStorage.getItem("views") || 0);
if (localStorage.getItem("viewsDay") !== today) {
  blockViews = 0; // new day — the first block of the day shows no message
}
if (blockViews >= 1) {
  document.getElementById("encouragement").textContent = randomMessage;
}
localStorage.setItem("views", blockViews + 1);
localStorage.setItem("viewsDay", today);


tickCountdown();
setInterval(tickCountdown, 1000);
