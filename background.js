// Focus Cap — background service worker.
// Tracks how much active time you spend on distraction sites each day against a
// single daily budget. When today's budget is spent (or during a scheduled
// blackout), those sites lock. Everything resets automatically at midnight.

importScripts("schedule.js"); // scheduleStateAt() + time helpers

const DEFAULTS = {
  focusSites: [],
  settings: { idleEnabled: true, idleSeconds: 45 },
  budgetSeconds: 1800, // daily distraction allowance (default 30 min)
  usage: { date: "", totalMs: 0 }, // budget usage today: { date, totalMs }
  stats: {}, // per-day, per-domain active time: { "YYYY-MM-DD": { domain: ms } }
  lastTickAt: 0, // shared clock for the currently-engaged tab
  // When/whether the budget is enforced. Disabled = always on (original behavior).
  schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [] }
};

const STATS_DAYS = 14; // how many days of history to keep

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// Local calendar day key (zero-padded so keys sort chronologically).
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Drop day-buckets older than the most recent STATS_DAYS.
function pruneStats(stats) {
  const days = Object.keys(stats).sort(); // ISO keys sort chronologically
  while (days.length > STATS_DAYS) delete stats[days.shift()];
  return stats;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await get(Object.keys(DEFAULTS));
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) patch[k] = DEFAULTS[k];
  }
  if (Object.keys(patch).length) await set(patch);

  // On first install, open the dashboard so the user can onboard. Guarded by a
  // stored flag so it opens exactly once — not on every dev reload.
  if (details.reason === "install") {
    const { welcomed } = await get("welcomed");
    if (!welcomed) {
      await set({ welcomed: true });
      chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    }
  }
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

// Stash which site was blocked + why (for the page to display) and send the tab
// to a clean URL — no query string, so the bar just reads ".../time-is-up.html".
async function redirectToBlock(tabId, hostname, reason) {
  await set({
    lastBlocked: (hostname || "").replace(/^www\./, ""),
    lastBlockReason: reason || "budget" // "budget" | "blackout"
  });
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL(BLOCK_PAGE) });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((res) => {
      // If the site should be blocked right now, kick the tab to the blocked page.
      if (res && res.overlay && sender.tab && sender.tab.id != null) {
        redirectToBlock(sender.tab.id, msg.hostname, res.blackout ? "blackout" : "budget");
      }
      sendResponse(res);
    })
    .catch(() => sendResponse({}));
  return true; // keep the message channel open for the async response
});

// Should a blocked site be off-limits right now? Considers the schedule
// (blackout / off-hours) as well as whether today's budget is spent.
async function blockDecision() {
  const stored = await get(["focusSites", "usage", "budgetSeconds", "schedule"]);
  const focusSites = stored.focusSites || [];
  const budgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const today = todayKey();
  const usage = stored.usage && stored.usage.date === today ? stored.usage : { totalMs: 0 };
  const { enforcing, blackout } = scheduleStateAt(stored.schedule, new Date());
  const overBudget = (usage.totalMs || 0) >= budgetMs;
  const blockNow = blackout || (enforcing && overBudget);
  return { blockNow, blackout, focusSites };
}

// Redirect a main-frame navigation to a blocked site (when it should be off
// right now) to the blocked page — fires before the site renders, so no flash.
async function guardNavigation(details) {
  if (details.frameId !== 0) return; // top frame only
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch (_) {
    return;
  }
  const { blockNow, blackout, focusSites } = await blockDecision();
  if (!blockNow || !matchSite(hostname, focusSites)) return;
  await redirectToBlock(details.tabId, hostname, blackout ? "blackout" : "budget");
}

chrome.webNavigation.onBeforeNavigate.addListener(guardNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(guardNavigation); // SPA nav

async function handle(msg) {
  const stored = await get([
    "focusSites", "settings", "usage", "budgetSeconds", "stats", "lastTickAt", "schedule"
  ]);
  const focusSites = stored.focusSites || [];
  const settings = stored.settings || DEFAULTS.settings;
  const budgetMs = (stored.budgetSeconds ?? DEFAULTS.budgetSeconds) * 1000;
  const now = Date.now();
  const today = todayKey();
  const domain = (msg.hostname || "").replace(/^www\./, "").toLowerCase();

  const site = matchSite(msg.hostname, focusSites);
  const { enforcing, blackout } = scheduleStateAt(stored.schedule, new Date());

  // Daily rollover: a new calendar day wipes yesterday's budget usage.
  let usage = stored.usage || { date: today, totalMs: 0 };
  if (usage.date !== today) usage = { date: today, totalMs: 0 };

  // Build the reply describing budget + schedule state (for blocked sites).
  const reply = () => {
    const overBudget = usage.totalMs >= budgetMs;
    return {
      track: true,
      blocked: !!site,
      enforcing,
      blackout,
      // Off right now if a blackout is on, or the budget's spent while enforcing.
      overlay: !!site && (blackout || (enforcing && overBudget)),
      remainingMs: Math.max(0, budgetMs - usage.totalMs),
      budgetMs,
      settings
    };
  };

  // Content script became engaged with a page — reset the shared clock.
  if (msg.type === "entering") {
    if (!domain) return { track: false };
    await set({ lastTickAt: now });
    return reply();
  }

  // Per-second engaged heartbeat while the page is active/focused/non-idle.
  if (msg.type === "heartbeat") {
    if (!domain) return { track: false };
    // Real elapsed time (capped) so worker-sleep gaps don't over/under count.
    const delta = Math.min(now - (stored.lastTickAt || now), 5000);
    const patch = { lastTickAt: now };

    // Per-domain stats for EVERY site (this is what powers the daily summary).
    const stats = stored.stats || {};
    stats[today] = stats[today] || {};
    stats[today][domain] = (stats[today][domain] || 0) + delta;
    patch.stats = pruneStats(stats);

    // Budget usage accrues on blocked sites only while actively enforcing
    // (not during off-hours, and not during a blackout — which hard-blocks).
    if (site && enforcing && !blackout) {
      usage.totalMs += delta;
      patch.usage = usage;
    }

    await set(patch);
    return reply();
  }

  // Content script left the page (tab switch / window blur / navigation).
  if (msg.type === "leaving") {
    return { ok: true };
  }

  return {};
}
