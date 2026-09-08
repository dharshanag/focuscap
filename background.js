// Focus Cap — background service worker.
// Tracks how much active time you spend on distraction sites each day against a
// single daily budget. When today's budget is spent, those sites lock until the
// next local day. Usage resets automatically at midnight (checked lazily).

const DEFAULTS = {
  focusSites: [],
  settings: { idleSeconds: 45 },
  budgetSeconds: 1800, // daily distraction allowance (default 30 min)
  usage: { date: "", totalMs: 0 } // { date: "YYYY-M-D", totalMs, lastTickAt }
};

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// Local calendar day key — the boundary at which the budget resets.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await get(Object.keys(DEFAULTS));
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) patch[k] = DEFAULTS[k];
  }
  if (Object.keys(patch).length) await set(patch);
});

// Match a page hostname against the user's distraction list.
// "youtube.com" matches youtube.com and www.youtube.com and m.youtube.com.
function matchSite(hostname, sites) {
  const h = (hostname || "").replace(/^www\./, "");
  return sites.find((s) => {
    const d = (s.domain || "").replace(/^www\./, "").toLowerCase();
    if (!d) return false;
    return h === d || h.endsWith("." + d);
  });
}

const BLOCK_PAGE = "time-is-up.html";

// Stash which site was blocked (for the page to display) and send the tab to a
// clean URL — no query string, so the address bar just reads ".../time-is-up.html".
async function redirectToBlock(tabId, hostname) {
  await set({ lastBlocked: (hostname || "").replace(/^www\./, "") });
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL(BLOCK_PAGE) });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((res) => {
      // If time is spent, kick the reporting tab over to the blocked page.
      if (res && res.overlay && sender.tab && sender.tab.id != null) {
        redirectToBlock(sender.tab.id, msg.hostname);
      }
      sendResponse(res);
    })
    .catch(() => sendResponse({}));
  return true; // keep the message channel open for the async response
});

// Is today's budget already spent? (with the same daily-rollover rule)
async function isLocked() {
  const stored = await get(["focusSites", "usage", "budgetSeconds"]);
  const focusSites = stored.focusSites || [];
  const budgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const today = todayKey();
  const usage = stored.usage && stored.usage.date === today ? stored.usage : { totalMs: 0 };
  return { locked: (usage.totalMs || 0) >= budgetMs, focusSites };
}

// Redirect a main-frame navigation to a blocked site (while locked) to the
// blocked page — this fires before the site renders, so there's no flash.
async function guardNavigation(details) {
  if (details.frameId !== 0) return; // top frame only
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch (_) {
    return;
  }
  const { locked, focusSites } = await isLocked();
  if (!locked || !matchSite(hostname, focusSites)) return;
  await redirectToBlock(details.tabId, hostname);
}

chrome.webNavigation.onBeforeNavigate.addListener(guardNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(guardNavigation); // SPA nav

async function handle(msg) {
  const stored = await get(["focusSites", "settings", "usage", "budgetSeconds"]);
  const focusSites = stored.focusSites || [];
  const settings = stored.settings || DEFAULTS.settings;
  const budgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const now = Date.now();
  const today = todayKey();

  // Daily rollover: a new calendar day wipes yesterday's usage.
  let usage = stored.usage || { date: today, totalMs: 0 };
  if (usage.date !== today) usage = { date: today, totalMs: 0 };

  const site = matchSite(msg.hostname, focusSites);

  // Content script announces it just became engaged with a distraction page.
  if (msg.type === "entering") {
    if (!site) return { track: false };
    usage.lastTickAt = now;
    await set({ usage });
    return {
      track: true,
      overlay: usage.totalMs >= budgetMs,
      remainingMs: Math.max(0, budgetMs - usage.totalMs),
      budgetMs,
      settings
    };
  }

  // Per-second engaged heartbeat while the page is active/focused/non-idle.
  if (msg.type === "heartbeat") {
    if (!site) return { track: false };
    // Use real elapsed time (capped) so worker-sleep gaps don't over/under count.
    const delta = Math.min(now - (usage.lastTickAt || now), 5000);
    usage.totalMs += delta;
    usage.lastTickAt = now;
    await set({ usage });
    return {
      track: true,
      overlay: usage.totalMs >= budgetMs,
      remainingMs: Math.max(0, budgetMs - usage.totalMs),
      budgetMs,
      settings
    };
  }

  // Content script left the page (tab switch / window blur / navigation).
  if (msg.type === "leaving") {
    return { ok: true };
  }

  return {};
}
