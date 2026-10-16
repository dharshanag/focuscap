// Focus Cap — daily stats page. Reads per-domain time from storage, classifies
// each site, and renders today's breakdown, a 7-day trend, and block suggestions.
// shared.js (todayKey, dayKey, matchSite, normalizeSite) and classify.js
// (classifyDomain) are loaded before this file.

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

const SUGGEST_MIN_MS = 60 * 1000; // only suggest sites with ≥1 min of use
const SUGGEST_MAX = 5; // at most this many suggestions
const LIST_MIN_MS = 1000; // ignore sub-second noise in the list
const LIST_MAX = 25; // longest site list rendered
const TREND_DAYS = 7;

const pad = (n) => String(n).padStart(2, "0");

// "42s", "7m", "1h 05m" — coarser than fmtClock, since this page is about
// where whole minutes went rather than a live countdown.
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

// Is this stats domain on the user's blocked list? Same matching rule as
// enforcement (bare, www- and subdomain forms all match).
function isBlocked(domain, sites) {
  return !!matchSite(domain, sites);
}

// A domain counts as distraction time if we classify it so, or the user blocked it.
function isDistraction(domain, sites) {
  return isBlocked(domain, sites) || classifyDomain(domain) === "distraction";
}

async function blockSite(domain) {
  const { focusSites } = await get(["focusSites"]);
  const sites = Array.isArray(focusSites) ? focusSites : [];
  if (sites.some((s) => s && s.domain === domain)) return;
  sites.push(normalizeSite({ domain }));
  await set({ focusSites: sites });
  load();
}

function lastNDays(n) {
  const out = [];
  const base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push(d);
  }
  return out;
}

// Today's per-domain entries, biggest first, sub-second noise dropped.
function todayEntries(stats, today) {
  const day = stats[today];
  if (!day || typeof day !== "object") return [];
  return Object.entries(day)
    .filter(([domain, ms]) => domain && typeof ms === "number" && ms >= LIST_MIN_MS)
    .sort((a, b) => b[1] - a[1]);
}

async function load() {
  const store = await get(["stats", "focusSites"]);
  const stats = store.stats && typeof store.stats === "object" ? store.stats : {};
  const sites = Array.isArray(store.focusSites) ? store.focusSites : [];
  const entries = todayEntries(stats, todayKey());

  document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  renderTiles(entries, sites);
  renderSuggestions(entries, sites);
  renderSiteList(entries, sites);
  renderTrend(stats, sites);
}

function renderTiles(entries, sites) {
  let active = 0, distraction = 0, productive = 0;
  for (const [domain, ms] of entries) {
    active += ms;
    if (isDistraction(domain, sites)) distraction += ms;
    else if (classifyDomain(domain) === "productive") productive += ms;
  }
  document.getElementById("totalActive").textContent = fmtDur(active);
  document.getElementById("totalDistraction").textContent = fmtDur(distraction);
  document.getElementById("totalProductive").textContent = fmtDur(productive);
}

// Unblocked sites we classify as distractions, with real time on them today.
function suggestions(entries, sites) {
  return entries
    .filter(([domain, ms]) => ms >= SUGGEST_MIN_MS && !isBlocked(domain, sites) && classifyDomain(domain) === "distraction")
    .slice(0, SUGGEST_MAX);
}

function blockButton(domain) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "block-btn";
  btn.textContent = "Block";
  btn.addEventListener("click", () => blockSite(domain));
  return btn;
}

function renderSuggestions(entries, sites) {
  const box = document.getElementById("suggestBox");
  const list = document.getElementById("suggestList");
  list.textContent = "";

  const picks = suggestions(entries, sites);
  if (!picks.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  picks.forEach(([domain, ms]) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = domain;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmtDur(ms);
    li.append(name, time, blockButton(domain));
    list.appendChild(li);
  });
}

function renderSiteList(entries, sites) {
  const list = document.getElementById("siteList");
  const empty = document.getElementById("emptyToday");
  list.textContent = "";

  if (!entries.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const maxMs = entries[0][1];
  entries.slice(0, LIST_MAX).forEach(([domain, ms]) => {
    const blocked = isBlocked(domain, sites);
    const category = classifyDomain(domain);
    // Meter/chip color: blocked & distraction share the "distraction" hue.
    const hue = blocked || category === "distraction" ? "distraction"
      : category === "productive" ? "productive" : "neutral";

    const li = document.createElement("li");
    li.dataset.domain = domain;

    const main = document.createElement("div");
    main.className = "row-main";
    const top = document.createElement("div");
    top.className = "row-top";
    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = domain;
    const chip = document.createElement("span");
    chip.className = "chip " + (blocked ? "blocked" : category);
    chip.textContent = blocked ? "blocked" : category;
    top.append(name, chip);
    const meter = document.createElement("div");
    meter.className = "meter";
    const fill = document.createElement("div");
    fill.className = "meter-fill " + hue;
    fill.style.width = `${Math.max(2, (ms / maxMs) * 100)}%`;
    meter.appendChild(fill);
    main.append(top, meter);

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmtDur(ms);

    const action = document.createElement("span");
    if (blocked) {
      action.className = "blocked-tag";
      action.textContent = "✓ blocked";
    } else if (category !== "productive") {
      action.appendChild(blockButton(domain));
    }

    li.append(main, time, action);
    list.appendChild(li);
  });
}

// Distraction time per day for the last `days` dates (oldest first).
function trendTotals(stats, sites, days) {
  return days.map((d) => {
    const day = stats[dayKey(d)];
    if (!day || typeof day !== "object") return 0;
    let sum = 0;
    for (const [domain, ms] of Object.entries(day)) {
      if (typeof ms === "number" && isDistraction(domain, sites)) sum += ms;
    }
    return sum;
  });
}

function renderTrend(stats, sites) {
  const trend = document.getElementById("trend");
  trend.textContent = "";
  const days = lastNDays(TREND_DAYS);
  const totals = trendTotals(stats, sites, days);
  const maxMs = Math.max(1, ...totals);
  const todayIdx = days.length - 1;

  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "day";
    col.dataset.day = dayKey(d);
    col.dataset.ms = String(totals[i]);
    const val = document.createElement("div");
    val.className = "bar-val";
    val.textContent = totals[i] >= 60000 ? fmtDur(totals[i]) : "";
    const bar = document.createElement("div");
    bar.className = "bar" + (i === todayIdx ? " today" : "");
    bar.style.height = `${Math.max(3, Math.round((totals[i] / maxMs) * 90))}px`;
    const label = document.createElement("div");
    label.className = "bar-day";
    label.textContent = d.toLocaleDateString(undefined, { weekday: "short" });
    col.append(val, bar, label);
    trend.appendChild(col);
  });
}

// Refresh live if usage/sites change while the page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stats || changes.focusSites)) load();
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    fmtDur,
    isBlocked,
    isDistraction,
    blockSite,
    lastNDays,
    todayEntries,
    suggestions,
    trendTotals,
    load,
    SUGGEST_MIN_MS,
    SUGGEST_MAX,
    TREND_DAYS
  };
}

load();
