import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

// dashboard.js wires up its DOM listeners and calls load() as soon as it's
// imported, so the real popup markup (minus script tags) + the chrome mock
// must exist first. Mounting the real dashboard.html means a renamed id
// breaks here, not only in the browser.
function mountPopupDom() {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard.html"), "utf8");
  const page = new JSDOM(html).window.document;
  page.querySelectorAll("script").forEach((s) => s.remove());
  document.body.innerHTML = page.body.innerHTML;
}

async function loadDashboard(initialStorage) {
  vi.resetModules();
  mountPopupDom();
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const dash = await import("../dashboard.js");
  await flush(); // let the import-time load() finish rendering
  return { dash, ...mock };
}

function localTodayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const row = (domain) => document.querySelector(`#siteList li[data-domain="${domain}"]`);
const el = (id) => document.getElementById(id);
const setBudgetFields = (h, m) => {
  el("budgetHours").value = h;
  el("budgetMinutes").value = m;
};

describe("dashboard.js (popup)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("removalLocked() forbids removal once locked or within the last 5 minutes of budget", async () => {
    const { dash } = await loadDashboard({});
    const budgetMs = 30 * 60 * 1000;
    expect(dash.removalLocked(budgetMs, budgetMs)).toBe(true); // fully locked
    expect(dash.removalLocked(budgetMs - 60_000, budgetMs)).toBe(true); // 1 min left
    expect(dash.removalLocked(budgetMs - 10 * 60_000, budgetMs)).toBe(false); // 10 min left
    expect(dash.removalLocked(60_000, 3 * 60_000)).toBe(false); // tiny budget: never locks removal early
  });

  it("normalizeDomain() strips protocol, www, path, and port", async () => {
    const { dash } = await loadDashboard({});
    expect(dash.normalizeDomain("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(dash.normalizeDomain("reddit.com:443/r/all")).toBe("reddit.com");
  });

  // Issue #18: reserved names can't become tracked domains.
  it("normalizeDomain() rejects __proto__ / constructor / prototype (even behind a protocol) and the add form stores nothing for them", async () => {
    const { dash, chrome, getStore } = await loadDashboard({ focusSites: [] });
    for (const raw of ["__proto__", "constructor", "prototype", "https://__proto__/x"]) {
      expect(dash.normalizeDomain(raw), raw).toBe("");
      el("domainInput").value = raw;
      await dash.addSite(new Event("submit"));
      await flush();
    }
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ focusSites: expect.anything() }));
    expect(getStore().focusSites).toEqual([]);
    // A real domain that merely contains the word is still accepted.
    expect(dash.normalizeDomain("proto.example.com")).toBe("proto.example.com");
    el("domainInput").value = "proto.example.com";
    await dash.addSite(new Event("submit"));
    await flush();
    expect(getStore().focusSites.map((s) => s.domain)).toEqual(["proto.example.com"]);
  });

  // --- Buttons ---
  it("the Daily stats button opens stats.html in a new tab (and a rejected tabs.create is swallowed)", async () => {
    const { chrome } = await loadDashboard({});
    el("statsBtn").click();
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test-extension-id/stats.html" });

    const rejections = [];
    const onUnhandled = (r) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      chrome.tabs.create = () => Promise.reject(new Error("Tabs cannot be created in this context"));
      el("statsBtn").click();
      await flush();
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the Dashboard & schedule button opens the options page via chrome.runtime.openOptionsPage", async () => {
    const { chrome } = await loadDashboard({});
    el("dashBtn").click();
    await flush();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("has no per-site editor or idle-seconds control (those live on the options page)", async () => {
    await loadDashboard({ focusSites: [{ domain: "youtube.com" }] });
    expect(document.querySelector(".site-editor")).toBeNull();
    expect(document.querySelector(".edit")).toBeNull();
    expect(el("idleInput")).toBeNull();
  });

  // --- Daily limit (global cap) in hours + minutes ---
  describe("daily limit", () => {
    it("renders the stored global cap as hours + minutes", async () => {
      await loadDashboard({ budgetSeconds: 5400 });
      expect(el("budgetHours").value).toBe("1");
      expect(el("budgetMinutes").value).toBe("30");
      expect(el("remaining").textContent).toBe("90:00 left today");
      expect(el("statusPill").textContent).toBe("90:00");
      expect(el("statusPill").className).toBe("pill on");
    });

    it("defaults to 30 minutes when nothing is stored", async () => {
      await loadDashboard({});
      expect(el("budgetHours").value).toBe("0");
      expect(el("budgetMinutes").value).toBe("30");
    });

    it("a stored cap that isn't minute-aligned rounds to whole minutes, carrying into the hours field (no 60 m)", async () => {
      await loadDashboard({ budgetSeconds: 3599 });
      expect(el("budgetHours").value).toBe("1");
      expect(el("budgetMinutes").value).toBe("0");
    });

    it("saves hours + minutes as seconds", async () => {
      const { dash, getStore } = await loadDashboard({ budgetSeconds: 1800 });
      setBudgetFields("1", "15");
      await dash.saveBudget();
      expect(getStore().budgetSeconds).toBe(4500);
    });

    it("clamps to the 2-hour maximum and reflects the clamped value back into the fields", async () => {
      const { dash, getStore } = await loadDashboard({ budgetSeconds: 1800 });
      setBudgetFields("3", "45");
      await dash.saveBudget();
      expect(getStore().budgetSeconds).toBe(7200);
      expect(el("budgetHours").value).toBe("2");
      expect(el("budgetMinutes").value).toBe("0");
    });

    it("clamps to the 1-minute minimum (0h 0m can't zero the cap)", async () => {
      const { dash, getStore } = await loadDashboard({ budgetSeconds: 1800 });
      setBudgetFields("0", "0");
      await dash.saveBudget();
      expect(getStore().budgetSeconds).toBe(60);
      expect(el("budgetMinutes").value).toBe("1");
    });

    it("treats a blank or non-numeric field as 0, not as a reason to skip the save", async () => {
      const { dash, getStore } = await loadDashboard({ budgetSeconds: 1800 });
      setBudgetFields("", "20");
      await dash.saveBudget();
      expect(getStore().budgetSeconds).toBe(1200);
      setBudgetFields("1", "abc");
      await dash.saveBudget();
      expect(getStore().budgetSeconds).toBe(3600);
    });

    it("a change event on either field saves", async () => {
      const { getStore } = await loadDashboard({ budgetSeconds: 1800 });
      setBudgetFields("0", "45");
      el("budgetMinutes").dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().budgetSeconds).toBe(2700);
      setBudgetFields("1", "45");
      el("budgetHours").dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().budgetSeconds).toBe(6300);
    });

    it("locks the fields once the cap is spent and refuses to raise it (reverting the fields)", async () => {
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com" }],
        budgetSeconds: 60,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      expect(el("remaining").textContent).toBe("🔒 Daily limit reached");
      expect(el("statusPill").textContent).toBe("Locked");
      expect(el("statusPill").className).toBe("pill locked");
      expect(el("budgetHours").disabled).toBe(true);
      expect(el("budgetMinutes").disabled).toBe(true);
      expect(el("budgetNote").hidden).toBe(false);
      expect(el("barFill").className).toBe("bar-fill full");
      expect(row("youtube.com").querySelector(".budget").textContent).toMatch(/^🔒 /);

      setBudgetFields("2", "0");
      await dash.saveBudget();
      await flush();
      expect(getStore().budgetSeconds).toBe(60);
      expect(el("budgetHours").value).toBe("0");
      expect(el("budgetMinutes").value).toBe("1");
    });

    it("ignores yesterday's usage record (a stale date counts as 0 used)", async () => {
      await loadDashboard({
        budgetSeconds: 600,
        usage: { date: "2000-01-01", totalMs: 600_000, sites: {} }
      });
      expect(el("remaining").textContent).toBe("10:00 left today");
      expect(el("budgetHours").disabled).toBe(false);
    });

    it("warns (amber bar) past 75% of the cap", async () => {
      await loadDashboard({
        budgetSeconds: 600,
        usage: { date: localTodayKey(), totalMs: 480_000, sites: {} }
      });
      expect(el("barFill").className).toBe("bar-fill warn");
      expect(el("barFill").style.width).toBe("80%");
    });
  });

  // --- Site rows: status text from the shared evaluation ---
  describe("site rows", () => {
    it("renders each site's own remaining time from the shared evaluation, not the global cap", async () => {
      await loadDashboard({
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 600 },
          { domain: "reddit.com", budgetSeconds: 120 }
        ],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      expect(row("youtube.com").querySelector(".budget").textContent).toBe("9:00 left");
      expect(row("reddit.com").querySelector(".budget").textContent).toBe("2:00 left");
      expect(row("youtube.com").classList.contains("locked")).toBe(false);
    });

    it("shows the empty hint when there are no sites", async () => {
      await loadDashboard({});
      expect(document.querySelector("#siteList .empty").textContent).toMatch(/No sites yet/);
    });

    it("shows a cool-down-locked site with its unlock time and disables removal", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const lockedUntil = new Date(2026, 0, 14, 14, 30, 0).getTime();
      await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60, lockoutSeconds: 9000 }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000, lockedUntil } } }
      });
      const li = row("youtube.com");
      expect(li.classList.contains("locked")).toBe(true);
      expect(li.querySelector(".budget").textContent).toBe("🔒 locked until 14:30");
      expect(li.querySelector(".budget").title).toBe("Out of time");
      expect(li.querySelector(".remove").disabled).toBe(true);
      expect(li.querySelector(".remove").title).toBe("Can't remove while locked");
    });

    it("shows a budget-locked site as locked until midnight", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60 }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      expect(row("youtube.com").querySelector(".budget").textContent).toBe("🔒 locked until midnight");
    });

    it("shows a schedule-locked site with the rule's end and names the rule in the hover text", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00, inside the block window
      await loadDashboard({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      const li = row("youtube.com");
      expect(li.querySelector(".budget").textContent).toBe("🔒 scheduled until 17:00");
      expect(li.querySelector(".budget").title).toBe("Blocked by a schedule rule");
      expect(li.querySelector(".remove").disabled).toBe(true);
    });

    it("disables removal in the last 5 minutes of a site's budget with a reason, but not with plenty left", async () => {
      await loadDashboard({
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 1800 },
          { domain: "reddit.com", budgetSeconds: 1800 }
        ],
        budgetSeconds: 7200,
        usage: { date: localTodayKey(), totalMs: 1_560_000, sites: { "youtube.com": { totalMs: 1_560_000 } } }
      });
      const yt = row("youtube.com").querySelector(".remove");
      expect(yt.disabled).toBe(true);
      expect(yt.title).toBe("Can't remove in the last 5 minutes of its budget");
      const rd = row("reddit.com").querySelector(".remove");
      expect(rd.disabled).toBe(false);
      expect(rd.title).toBe("Remove");
    });
  });

  // --- Add / remove ---
  describe("add and remove", () => {
    it("adding a site stores it with per-site defaults filled in and clears the field", async () => {
      const { dash, getStore } = await loadDashboard({ budgetSeconds: 3600 });
      el("domainInput").value = "https://www.Reddit.com/r/all";
      await dash.addSite({ preventDefault() {} });
      expect(getStore().focusSites).toEqual([{ domain: "reddit.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }]);
      expect(el("domainInput").value).toBe("");
      await flush();
      expect(row("reddit.com")).not.toBeNull();
    });

    it("submitting the form adds the site; duplicates and blanks are ignored", async () => {
      const { getStore } = await loadDashboard({ focusSites: [{ domain: "reddit.com" }] });
      el("domainInput").value = "reddit.com";
      el("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      expect(getStore().focusSites).toHaveLength(1);
      el("domainInput").value = "   ";
      el("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      expect(getStore().focusSites).toHaveLength(1);
      el("domainInput").value = "news.ycombinator.com";
      el("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["reddit.com", "news.ycombinator.com"]);
    });

    it("adding a site tolerates a corrupt (null) focusSites entry instead of throwing on the duplicate check", async () => {
      const { dash, getStore } = await loadDashboard({ focusSites: [null, { domain: "reddit.com" }], budgetSeconds: 3600 });
      el("domainInput").value = "youtube.com";
      await dash.addSite({ preventDefault() {} });
      expect(getStore().focusSites.map((s) => s && s.domain)).toEqual([null, "reddit.com", "youtube.com"]);
      el("domainInput").value = "reddit.com";
      await dash.addSite({ preventDefault() {} });
      expect(getStore().focusSites).toHaveLength(3); // still no dupes
    });

    it("removeSite() refuses while the site is locked but allows an unlocked site with plenty left", async () => {
      const { dash, getStore } = await loadDashboard({
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 60 },
          { domain: "reddit.com", budgetSeconds: 1800 }
        ],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      await dash.removeSite("youtube.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com", "reddit.com"]);
      await dash.removeSite("reddit.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com"]);
    });

    it("removeSite() refuses in the last 5 minutes of the site's budget even though the row was rendered earlier", async () => {
      const { dash, getStore, setStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 1800 }],
        budgetSeconds: 7200
      });
      expect(row("youtube.com").querySelector(".remove").disabled).toBe(false);
      // Usage ticks past the threshold after render; the live check still refuses.
      setStore({ usage: { date: localTodayKey(), totalMs: 1_560_000, sites: { "youtube.com": { totalMs: 1_560_000 } } } });
      await dash.removeSite("youtube.com");
      expect(getStore().focusSites).toHaveLength(1);
    });

    it("removeSite() refuses a schedule-locked site even with zero usage (lock check, not just budget math)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0));
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      await dash.removeSite("youtube.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com"]);
    });

    it("clicking × removes by domain, so a concurrent removal elsewhere can't delete a neighbour", async () => {
      const { getStore, setStore } = await loadDashboard({
        focusSites: [{ domain: "a.com" }, { domain: "b.com" }, { domain: "c.com" }],
        budgetSeconds: 3600
      });
      // The options page removed a.com after this popup rendered; b.com is now index 0.
      setStore({ focusSites: [{ domain: "b.com" }, { domain: "c.com" }] });
      row("c.com").querySelector(".remove").click();
      await flush();
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["b.com"]);
    });
  });

  // --- Live refresh ---
  it("re-renders on usage / focusSites / budgetSeconds / schedule changes in local storage only", async () => {
    const { listeners, setStore } = await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600
    });
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("10:00 left");
    const usage = { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } };
    setStore({ usage });
    listeners.onChanged.forEach((fn) => fn({ usage: { newValue: usage } }, "sync"));
    await flush();
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("10:00 left"); // wrong area: ignored
    listeners.onChanged.forEach((fn) => fn({ usage: { newValue: usage } }, "local"));
    await flush();
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("9:00 left");
  });

  it("a usage tick doesn't overwrite a half-typed Daily limit, but a spent cap still reverts the fields", async () => {
    const { listeners, setStore } = await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 1800
    });
    const minutes = el("budgetMinutes");
    minutes.focus();
    expect(document.activeElement).toBe(minutes);
    el("budgetHours").value = "1";
    minutes.value = "5";
    const tick = (totalMs) => {
      const usage = { date: localTodayKey(), totalMs, sites: { "youtube.com": { totalMs } } };
      setStore({ usage });
      listeners.onChanged.forEach((fn) => fn({ usage: { newValue: usage } }, "local"));
    };
    tick(60_000);
    await flush();
    expect(el("remaining").textContent).toBe("29:00 left today"); // the countdown still refreshed
    expect(el("budgetHours").value).toBe("1"); // the edit in progress survived
    expect(minutes.value).toBe("5");

    // Once the cap is spent the fields freeze, so the stored value wins over a typed one.
    tick(1_800_000);
    await flush();
    expect(minutes.disabled).toBe(true);
    expect(el("budgetHours").value).toBe("0");
    expect(minutes.value).toBe("30");
  });
});

// --- Global schedule: the header pill and rows must agree with the background. ---
describe("dashboard.js global schedule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const officeHours = { enabled: true, days: allDays, windows: [{ start: "09:00", end: "17:00" }], blackouts: [] };

  it("off-hours: the pill reads 'off-hours', rows show no countdown, nothing is locked, removal works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 20, 0, 0)); // Wed 20:00, outside 09:00-17:00
    const { dash, getStore } = await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } },
      schedule: officeHours
    });
    const li = row("youtube.com");
    expect(li.classList.contains("locked")).toBe(false);
    expect(li.querySelector(".budget").textContent).toBe("off-hours");
    expect(li.querySelector(".budget").title).toMatch(/enforcement hours/);
    expect(li.querySelector(".remove").disabled).toBe(false);
    expect(el("remaining").textContent).toBe("Off-hours — nothing is counted");
    expect(el("statusPill").textContent).toBe("off-hours");
    expect(el("statusPill").className).toBe("pill off");
    // The total-cap fields are still editable off-hours (the cap isn't spent).
    expect(el("budgetHours").disabled).toBe(false);

    await dash.removeSite("youtube.com");
    expect(getStore().focusSites).toEqual([]);
  });

  it("a non-enforcement day is off-hours too, even with no windows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 17, 12, 0, 0)); // Saturday
    await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      schedule: { enabled: true, days: [1, 2, 3, 4, 5], windows: [], blackouts: [] }
    });
    expect(el("statusPill").textContent).toBe("off-hours");
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("off-hours");
  });

  it("inside the enforcement window the countdown shows as usual", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
    await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } },
      schedule: officeHours
    });
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("9:00 left");
    expect(el("remaining").textContent).toBe("59:00 left today");
    expect(el("statusPill").textContent).toBe("59:00");
    expect(el("statusPill").className).toBe("pill on");
  });

  it("a disabled schedule enforces 24/7 (no off-hours pill at night)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 23, 0, 0));
    await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      schedule: { ...officeHours, enabled: false }
    });
    expect(el("statusPill").className).toBe("pill on");
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("10:00 left");
  });

  it("during a global blackout the header and every row read as locked until the blackout ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
    const { dash, getStore } = await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }, { domain: "reddit.com" }],
      budgetSeconds: 3600,
      schedule: { enabled: true, days: allDays, windows: [], blackouts: [{ start: "11:00", end: "13:30" }] }
    });
    for (const domain of ["youtube.com", "reddit.com"]) {
      const li = row(domain);
      expect(li.classList.contains("locked")).toBe(true);
      expect(li.querySelector(".budget").textContent).toBe("🔒 scheduled until 13:30");
      expect(li.querySelector(".budget").title).toBe("Blocked by your global blackout");
      expect(li.querySelector(".remove").disabled).toBe(true);
    }
    expect(el("remaining").textContent).toBe("🔒 Blackout until 13:30");
    expect(el("statusPill").textContent).toBe("Blackout");
    expect(el("statusPill").className).toBe("pill locked");
    await dash.removeSite("youtube.com");
    expect(getStore().focusSites).toHaveLength(2);
  });

  it("a schedule change in storage re-renders the rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 20, 0, 0));
    const { listeners, setStore } = await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600
    });
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("10:00 left");
    setStore({ schedule: officeHours });
    listeners.onChanged.forEach((fn) => fn({ schedule: { newValue: officeHours } }, "local"));
    await flush();
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("off-hours");
    expect(el("statusPill").textContent).toBe("off-hours");
  });
});
