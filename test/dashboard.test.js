import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

// dashboard.js wires up its DOM listeners and calls load() as soon as it's
// imported, so the required elements + chrome mock must exist first.
function mountDashboardDom() {
  document.body.innerHTML = `
    <form id="addForm"><input id="domainInput" /></form>
    <input id="budgetInput" />
    <input id="idleInput" />
    <ul id="siteList"></ul>
    <span id="statusPill"></span>
    <div id="remaining"></div>
    <div id="barFill"></div>
    <div id="budgetNote"></div>
    <button id="statsBtn"></button>
  `;
}

async function loadDashboard(initialStorage) {
  vi.resetModules();
  mountDashboardDom();
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

describe("dashboard.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // --- Issue #2: parseInt(...) || default treats an explicit 0 as falsy ---
  // https://github.com/dharshanag/focuscap/issues/2
  it("saving idleSeconds=0 should clamp to the 5s minimum, not silently reset to the 45s default", async () => {
    const { dash, getStore } = await loadDashboard({});
    document.getElementById("idleInput").value = "0";
    await dash.saveSettings();
    expect(getStore().settings.idleSeconds).toBe(5);
  });

  it("saves a normal idleSeconds value unchanged", async () => {
    const { dash, getStore } = await loadDashboard({});
    document.getElementById("idleInput").value = "30";
    await dash.saveSettings();
    expect(getStore().settings.idleSeconds).toBe(30);
  });

  it("saving idleSeconds preserves an idleEnabled flag this popup doesn't edit", async () => {
    const { dash, getStore } = await loadDashboard({ settings: { idleEnabled: false, idleSeconds: 45 } });
    document.getElementById("idleInput").value = "30";
    await dash.saveSettings();
    expect(getStore().settings).toEqual({ idleEnabled: false, idleSeconds: 30 });
  });

  it("saving idleSeconds with no stored settings writes the full default shape (idleEnabled: true)", async () => {
    const { dash, getStore } = await loadDashboard({});
    document.getElementById("idleInput").value = "30";
    await dash.saveSettings();
    expect(getStore().settings).toEqual({ idleEnabled: true, idleSeconds: 30 });
  });

  it("the Daily stats button opens stats.html in a new tab (and a rejected tabs.create is swallowed)", async () => {
    const { chrome } = await loadDashboard({});
    document.getElementById("statsBtn").click();
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test-extension-id/stats.html" });

    const rejections = [];
    const onUnhandled = (r) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      chrome.tabs.create = () => Promise.reject(new Error("Tabs cannot be created in this context"));
      document.getElementById("statsBtn").click();
      await flush();
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("removalLocked() forbids removal once locked or within the last 5 minutes of budget", async () => {
    const { dash } = await loadDashboard({});
    const budgetMs = 30 * 60 * 1000;
    expect(dash.removalLocked(budgetMs, budgetMs)).toBe(true); // fully locked
    expect(dash.removalLocked(budgetMs - 60_000, budgetMs)).toBe(true); // 1 min left
    expect(dash.removalLocked(budgetMs - 10 * 60_000, budgetMs)).toBe(false); // 10 min left
  });

  it("normalizeDomain() strips protocol, www, path, and port", async () => {
    const { dash } = await loadDashboard({});
    expect(dash.normalizeDomain("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(dash.normalizeDomain("reddit.com:443/r/all")).toBe("reddit.com");
  });

  // --- Per-site rules UI (phase 2) ---
  describe("per-site rows", () => {
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
    });

    it("shows a locked site as locked with its unlock time, and disables removal and editing", async () => {
      // Fake only Date: the harness's flush() needs real setTimeout to fire.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const lockedUntil = new Date(2026, 0, 14, 14, 30, 0).getTime();
      const { dash } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60, lockoutSeconds: 9000 }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000, lockedUntil } } }
      });
      const li = row("youtube.com");
      expect(li.classList.contains("locked")).toBe(true);
      expect(li.querySelector(".budget").textContent).toBe("🔒 locked until 14:30");
      expect(li.querySelector(".remove").disabled).toBe(true);

      // Open the editor: everything in it is read-only while locked.
      dash.expanded.add("youtube.com");
      await dash.load();
      const editor = row("youtube.com").querySelector(".site-editor");
      expect(editor.querySelector(".locked-note")).not.toBeNull();
      expect(editor.querySelector(".site-budget").disabled).toBe(true);
      expect(editor.querySelector(".add-rule").disabled).toBe(true);
    });

    it("describes schedule and global-cap locks distinctly", async () => {
      const { dash } = await loadDashboard({});
      expect(dash.describeStatus({ locked: true, reason: "schedule", until: null })).toBe("🔒 scheduled");
      expect(dash.describeStatus({ locked: true, reason: "global", until: null })).toBe("🔒 total cap reached");
      expect(dash.describeStatus({ locked: false, remainingMs: 90_000 })).toBe("1:30 left");
    });

    it("fmtUntil() says 'midnight' for the daily reset instead of a next-day clock time", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const { dash } = await loadDashboard({});
      expect(dash.fmtUntil(new Date(2026, 0, 15, 0, 0, 0, 0).getTime())).toBe("midnight");
      expect(dash.fmtUntil(new Date(2026, 0, 14, 17, 0, 0, 0).getTime())).toBe("17:00");
      expect(dash.fmtUntil(new Date(2026, 0, 15, 18, 0, 0, 0).getTime())).toBe("Thu 18:00");
      expect(dash.describeStatus({ locked: true, reason: "budget", until: new Date(2026, 0, 15, 0, 0, 0, 0).getTime() })).toBe("🔒 locked until midnight");
    });

    it("clicking ⚙ opens the editor pre-filled with the site's current settings", async () => {
      await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 900, lockoutSeconds: 7200, rules: [{ type: "allow", days: [0, 6], start: "10:00", end: "12:00" }] }],
        budgetSeconds: 3600
      });
      row("youtube.com").querySelector(".edit").click();
      await flush();
      const editor = row("youtube.com").querySelector(".site-editor");
      expect(editor).not.toBeNull();
      expect(editor.querySelector(".site-budget").value).toBe("15");
      expect(editor.querySelector(".lockout-mode").value).toBe("minutes");
      expect(editor.querySelector(".lockout-min").value).toBe("120");
      const rule = editor.querySelector(".rule-row");
      expect(rule.querySelector(".rule-type").value).toBe("allow");
      expect(rule.querySelector(".rule-start").value).toBe("10:00");
      expect(rule.querySelector(".rule-end").value).toBe("12:00");
      const pressed = [...rule.querySelectorAll(".day-toggle")].map((b) => b.getAttribute("aria-pressed"));
      expect(pressed).toEqual(["true", "false", "false", "false", "false", "false", "true"]);
    });

    it("changing the per-site budget input persists it (in seconds) and leaves other sites alone", async () => {
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com" }, { domain: "reddit.com", budgetSeconds: 300 }],
        budgetSeconds: 3600
      });
      dash.expanded.add("youtube.com");
      await dash.load();
      const input = row("youtube.com").querySelector(".site-budget");
      input.value = "12.5";
      input.dispatchEvent(new Event("change"));
      await flush();
      const sites = getStore().focusSites;
      expect(sites[0].budgetSeconds).toBe(750);
      expect(sites[0]).toEqual({ domain: "youtube.com", budgetSeconds: 750, lockoutSeconds: null, rules: [] });
      expect(sites[1].budgetSeconds).toBe(300);
    });

    it("switching lockout mode persists minutes-as-seconds, and back to 'until midnight' as null", async () => {
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com" }],
        budgetSeconds: 3600
      });
      dash.expanded.add("youtube.com");
      await dash.load();
      let editor = row("youtube.com").querySelector(".site-editor");
      const mode = editor.querySelector(".lockout-mode");
      editor.querySelector(".lockout-min").value = "90";
      mode.value = "minutes";
      mode.dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().focusSites[0].lockoutSeconds).toBe(5400);

      editor = row("youtube.com").querySelector(".site-editor");
      const mode2 = editor.querySelector(".lockout-mode");
      mode2.value = "midnight";
      mode2.dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().focusSites[0].lockoutSeconds).toBeNull();
    });

    it("adding, editing, toggling days on, and removing a schedule rule all persist", async () => {
      // The default new rule blocks Mon-Fri 09:00-17:00. Pin the clock to a
      // Wednesday evening so adding it doesn't lock the site (and therefore
      // freeze its editor) partway through this test.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 20, 0, 0));
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com" }],
        budgetSeconds: 3600
      });
      dash.expanded.add("youtube.com");
      await dash.load();

      row("youtube.com").querySelector(".add-rule").click();
      await flush();
      expect(getStore().focusSites[0].rules).toEqual([
        { type: "block", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", touchedAt: Date.now() }
      ]);

      // While the rule is a block window that isn't active (it's 20:00), the
      // site is unlocked and its editor is live.
      let rule = row("youtube.com").querySelector(".rule-row");
      rule.querySelectorAll(".day-toggle")[0].click(); // Sunday on
      await flush();
      expect(getStore().focusSites[0].rules[0].days).toEqual([0, 1, 2, 3, 4, 5]);

      rule = row("youtube.com").querySelector(".rule-row");
      const end = rule.querySelector(".rule-end");
      end.value = "18:30";
      end.dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().focusSites[0].rules[0].end).toBe("18:30");

      row("youtube.com").querySelector(".remove-rule").click();
      await flush();
      expect(getStore().focusSites[0].rules).toEqual([]);

      // Switching a rule to "allow only" at 20:00 immediately locks the site
      // (outside its window). The edit persists and the editor freezes —
      // except the just-changed rule itself, which stays live for its grace
      // window so a fumble can be undone.
      row("youtube.com").querySelector(".add-rule").click();
      await flush();
      rule = row("youtube.com").querySelector(".rule-row");
      const type = rule.querySelector(".rule-type");
      type.value = "allow";
      type.dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().focusSites[0].rules[0].type).toBe("allow");
      expect(row("youtube.com").classList.contains("locked")).toBe(true);
      expect(row("youtube.com").querySelector(".site-budget").disabled).toBe(true);
      expect(row("youtube.com").querySelector(".add-rule").disabled).toBe(true);
      expect(row("youtube.com").querySelector(".rule-type").disabled).toBe(false);
      expect(row("youtube.com").querySelector(".rule-row").classList.contains("grace")).toBe(true);
    });

    it("a just-added rule that locked the site can still be removed within 60s (undo a fumble); older rules can't", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00 — both rules below are active
      const { dash, getStore } = await loadDashboard({
        focusSites: [
          {
            domain: "youtube.com",
            rules: [
              { type: "block", days: [3], start: "09:00", end: "17:00", touchedAt: Date.now() - 2 * 60_000 }, // old
              { type: "block", days: [3], start: "09:30", end: "12:00", touchedAt: Date.now() - 10_000 } // just added
            ]
          }
        ],
        budgetSeconds: 3600
      });
      dash.expanded.add("youtube.com");
      await dash.load();
      const rows = row("youtube.com").querySelectorAll(".rule-row");
      expect(row("youtube.com").classList.contains("locked")).toBe(true);
      expect(rows[0].querySelector(".remove-rule").disabled).toBe(true);
      expect(rows[1].querySelector(".remove-rule").disabled).toBe(false);
      expect(row("youtube.com").querySelector(".locked-note").textContent).toMatch(/stays editable/);

      // Old rule: refused even via the API.
      expect(await dash.updateSite("youtube.com", (s) => ({ ...s, rules: s.rules.slice(1) }), { ruleIndex: 0 })).toBe(false);
      // Non-rule edits stay refused while locked.
      expect(await dash.updateSite("youtube.com", (s) => ({ ...s, budgetSeconds: 999 }))).toBe(false);

      rows[1].querySelector(".remove-rule").click();
      await flush();
      expect(getStore().focusSites[0].rules).toHaveLength(1);
      expect(getStore().focusSites[0].rules[0].start).toBe("09:00");

      // Once the grace window passes, the survivor is frozen too.
      vi.setSystemTime(Date.now() + 61_000);
      expect(dash.ruleInGrace({ touchedAt: Date.now() - 61_000 })).toBe(false);
      // A future-dated stamp is not a perpetual grace.
      expect(dash.ruleInGrace({ touchedAt: Date.now() + 5_000 })).toBe(false);
    });

    it("editing a rule that is still in grace refreshes its stamp (you keep only the rule you're actively fixing)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00, rule below is active -> site locked
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00", touchedAt: Date.now() - 50_000 }] }],
        budgetSeconds: 3600
      });
      dash.expanded.add("youtube.com");
      await dash.load();
      expect(row("youtube.com").classList.contains("locked")).toBe(true);
      const end = row("youtube.com").querySelector(".rule-end");
      expect(end.disabled).toBe(false);
      end.value = "11:00";
      end.dispatchEvent(new Event("change"));
      await flush();
      const saved = getStore().focusSites[0].rules[0];
      expect(saved.end).toBe("11:00");
      expect(saved.touchedAt).toBe(Date.now()); // refreshed from 50s-old
      // 55s after the ORIGINAL stamp it would have expired; after the refresh it's still live.
      vi.setSystemTime(Date.now() + 15_000);
      await dash.load();
      expect(row("youtube.com").querySelector(".rule-row").classList.contains("grace")).toBe(true);
    });

    it("updateSite() refuses to change a locked site (anti-bypass), re-checking live state", async () => {
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60 }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      const ok = await dash.updateSite("youtube.com", (s) => ({ ...s, budgetSeconds: 999_999 }));
      expect(ok).toBe(false);
      expect(getStore().focusSites[0].budgetSeconds).toBe(60);
    });

    it("updateSite()/removeSite() are keyed by domain, so a concurrent removal can't redirect an edit to a neighbour", async () => {
      const { dash, getStore, setStore } = await loadDashboard({
        focusSites: [{ domain: "a.com" }, { domain: "b.com" }],
        budgetSeconds: 3600
      });
      // Simulate another popup removing a.com after b.com's editor was rendered.
      setStore({ focusSites: [{ domain: "b.com" }] });
      const ok = await dash.updateSite("b.com", (s) => ({ ...s, budgetSeconds: 600 }));
      expect(ok).toBe(true);
      expect(getStore().focusSites).toEqual([{ domain: "b.com", budgetSeconds: 600, lockoutSeconds: null, rules: [] }]);
      expect(await dash.updateSite("a.com", (s) => s)).toBe(false); // gone -> refused, nothing written
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

    it("removeSite() refuses a schedule-locked site even with zero usage (lock check, not just budget math)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00, inside the block window
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      await dash.removeSite("youtube.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com"]);
    });

    it("rejects a per-site budget of 0 (it would lock the site instantly with no way back) and renders despite a corrupt rule entry", async () => {
      const { dash, getStore } = await loadDashboard({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 600, rules: [null, { type: "block", days: [1], start: "09:00", end: "10:00" }] }],
        budgetSeconds: 3600
      });
      dash.expanded.add("youtube.com");
      await dash.load();
      // The null rule was dropped at normalization; only the real one rendered.
      expect(row("youtube.com").querySelectorAll(".rule-row")).toHaveLength(1);

      const input = row("youtube.com").querySelector(".site-budget");
      input.value = "0";
      input.dispatchEvent(new Event("change"));
      await flush();
      expect(getStore().focusSites[0].budgetSeconds).toBe(600);
    });

    it("adding a site stores it with per-site defaults filled in", async () => {
      const { dash, getStore } = await loadDashboard({ budgetSeconds: 3600 });
      document.getElementById("domainInput").value = "https://www.Reddit.com/r/all";
      await dash.addSite({ preventDefault() {} });
      expect(getStore().focusSites).toEqual([{ domain: "reddit.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }]);
    });

    it("the header shows the global cap, and the global-cap field locks once the cap is spent", async () => {
      await loadDashboard({
        focusSites: [{ domain: "youtube.com" }],
        budgetSeconds: 60,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      expect(document.getElementById("remaining").textContent).toBe("🔒 Total cap reached");
      expect(document.getElementById("budgetInput").disabled).toBe(true);
      expect(row("youtube.com").querySelector(".budget").textContent).toMatch(/^🔒 /);
    });
  });
});

// --- Global schedule: off-hours rows and blackout rows. ---
describe("dashboard.js global schedule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const officeHours = { enabled: true, days: allDays, windows: [{ start: "09:00", end: "17:00" }], blackouts: [] };

  it("off-hours a site's row reads 'off-hours' (no countdown), isn't locked, and can be removed", async () => {
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
    expect(dash.describeStatus({ locked: false, free: true, remainingMs: 600_000 })).toBe("off-hours");

    await dash.removeSite("youtube.com");
    expect(getStore().focusSites).toEqual([]);
  });

  it("inside the enforcement window the row shows the countdown as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
    await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } },
      schedule: officeHours
    });
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("9:00 left");
  });

  it("during a global blackout every site reads as scheduled-locked until the blackout ends, and can't be removed or edited", async () => {
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
      expect(li.querySelector(".remove").disabled).toBe(true);
    }
    const ok = await dash.updateSite("youtube.com", (s) => ({ ...s, budgetSeconds: 60_000 }));
    expect(ok).toBe(false);
    expect(getStore().focusSites[0].budgetSeconds).toBe(600);
  });

  it("a schedule change in storage re-renders the list (and is not swallowed by an open editor)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 20, 0, 0));
    const { dash, listeners, setStore } = await loadDashboard({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600
    });
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("10:00 left");
    dash.expanded.add("youtube.com");
    await dash.load();
    row("youtube.com").querySelector(".site-budget").focus();

    setStore({ schedule: officeHours });
    listeners.onChanged.forEach((fn) => fn({ schedule: { newValue: officeHours } }, "local"));
    await flush();
    expect(row("youtube.com").querySelector(".budget").textContent).toBe("off-hours");
  });
});
