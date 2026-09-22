// Focus Cap — daily stats page. Reads per-domain time from storage, classifies
// each site, and renders today's breakdown, a 7-day trend, and block suggestions.
// classify.js (classifyDomain) is loaded before this file.

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

const SUGGEST_MIN_MS = 60 * 1000; // only suggest sites with ≥1 min of use
const LIST_MIN_MS = 1000; // ignore sub-second noise in the list

const pad = (n) => String(n).padStart(2, "0");
function keyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayKey() {
  return keyOf(new Date());
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

function isBlocked(domain, sites) {
  return (sites || []).some((s) => {
    const d = (s.domain || "").replace(/^www\./, "").toLowerCase();
    return d && (domain === d || domain.endsWith("." + d));
  });
}

// A domain counts as distraction time if we classify it so, or the user blocked it.
function isDistraction(domain, sites) {
  return isBlocked(domain, sites) || classifyDomain(domain) === "distraction";
}

async function blockSite(domain) {
  const { focusSites } = await get(["focusSites"]);
  const sites = focusSites || [];
  if (sites.some((s) => s.domain === domain)) return;
  sites.push({ domain });
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

async function load() {
  const store = await get(["stats", "focusSites"]);
  const stats = store.stats || {};
  const sites = store.focusSites || [];
  const today = todayKey();
  const todayStats = stats[today] || {};

  document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  // Sorted per-domain entries for today.
  const entries = Object.entries(todayStats)
    .filter(([, ms]) => ms >= LIST_MIN_MS)
    .sort((a, b) => b[1] - a[1]);

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

function renderSuggestions(entries, sites) {
  const box = document.getElementById("suggestBox");
  const list = document.getElementById("suggestList");
  list.innerHTML = "";

  const picks = entries.filter(
    ([domain, ms]) =>
      ms >= SUGGEST_MIN_MS &&
      !isBlocked(domain, sites) &&
      classifyDomain(domain) === "distraction"
  ).slice(0, 5);

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
    const btn = document.createElement("button");
    btn.className = "block-btn";
    btn.textContent = "Block";
    btn.addEventListener("click", () => blockSite(domain));
    li.append(name, time, btn);
    list.appendChild(li);
  });
}

function renderSiteList(entries, sites) {
  const list = document.getElementById("siteList");
  const empty = document.getElementById("emptyToday");
  list.innerHTML = "";

  if (!entries.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const maxMs = entries[0][1];
  entries.slice(0, 25).forEach(([domain, ms]) => {
    const blocked = isBlocked(domain, sites);
    const category = classifyDomain(domain);
    // Meter/chip color: blocked & distraction share the "distraction" hue.
    const hue = blocked || category === "distraction" ? "distraction"
      : category === "productive" ? "productive" : "neutral";

    const li = document.createElement("li");

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
      const btn = document.createElement("button");
      btn.className = "block-btn";
      btn.textContent = "Block";
      btn.addEventListener("click", () => blockSite(domain));
      action.appendChild(btn);
    }

    li.append(main, time, action);
    list.appendChild(li);
  });
}

function renderTrend(stats, sites) {
  const trend = document.getElementById("trend");
  trend.innerHTML = "";
  const days = lastNDays(7);
  const totals = days.map((d) => {
    const day = stats[keyOf(d)] || {};
    let sum = 0;
    for (const [domain, ms] of Object.entries(day)) {
      if (isDistraction(domain, sites)) sum += ms;
    }
    return sum;
  });
  const maxMs = Math.max(1, ...totals);
  const todayIdx = days.length - 1;

  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "day";
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

load();
