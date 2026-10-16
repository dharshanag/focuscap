import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

// options.js wires up its DOM listeners and calls load() as soon as it's
// imported, so the real options.html markup (minus script tags) + the chrome
// mock must exist first.
function mountOptionsDom() {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "options.html"), "utf8");
  const page = new JSDOM(html).window.document;
  page.querySelectorAll("script").forEach((s) => s.remove());
  document.body.innerHTML = page.body.innerHTML;
}

async function loadOptions(initialStorage) {
  vi.resetModules();
  mountOptionsDom();
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const opts = await import("../options.js");
  await flush(); // let the import-time load() finish rendering
  return { opts, ...mock };
}

function localTodayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const el = (id) => document.getElementById(id);
const row = (domain) => document.querySelector(`#siteList li[data-domain="${domain}"]`);
const change = (node) => node.dispatchEvent(new Event("change"));
const allDays = [0, 1, 2, 3, 4, 5, 6];
const onboarded = { onboarded: true };

describe("options.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // --- Header ---
  it("the Daily stats link opens stats.html in a new tab without navigating, and a rejected tabs.create is swallowed", async () => {
    const { chrome } = await loadOptions(onboarded);
    const e = new Event("click", { cancelable: true });
    el("statsLink").dispatchEvent(e);
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test-extension-id/stats.html" });

    const rejections = [];
    const onUnhandled = (r) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      chrome.tabs.create = () => Promise.reject(new Error("nope"));
      el("statsLink").click();
      await flush();
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // --- Onboarding ---
  describe("onboarding", () => {
    it("shows the welcome card with the preset chips until onboarded, then hides it", async () => {
      const { getStore } = await loadOptions({});
      expect(el("onboard").hidden).toBe(false);
      const chips = [...document.querySelectorAll("#presetSites .preset")];
      expect(chips.map((c) => c.dataset.domain)).toContain("youtube.com");
      expect(chips).toHaveLength(8);
      el("obSkip").click();
      await flush();
      expect(getStore().onboarded).toBe(true);
      expect(el("onboard").hidden).toBe(true);
    });

    it("is hidden on load once onboarded", async () => {
      await loadOptions(onboarded);
      expect(el("onboard").hidden).toBe(true);
    });

    it("Save & get started adds the chosen presets as normalized sites and sets the global cap from h + m", async () => {
      const { getStore } = await loadOptions({ focusSites: [{ domain: "reddit.com", budgetSeconds: 300 }] });
      const chip = (d) => document.querySelector(`#presetSites .preset[data-domain="${d}"]`);
      chip("youtube.com").click();
      chip("reddit.com").click(); // already listed: must not duplicate
      chip("tiktok.com").click();
      chip("tiktok.com").click(); // toggled back off
      expect(chip("youtube.com").getAttribute("aria-pressed")).toBe("true");
      expect(chip("tiktok.com").classList.contains("on")).toBe(false);
      el("obHours").value = "1";
      el("obMinutes").value = "15";
      el("obStart").click();
      await flush();
      const store = getStore();
      expect(store.onboarded).toBe(true);
      expect(store.budgetSeconds).toBe(4500);
      expect(store.focusSites).toEqual([
        { domain: "reddit.com", budgetSeconds: 300 }, // untouched existing entry
        { domain: "youtube.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }
      ]);
      expect(el("onboard").hidden).toBe(true);
      expect(row("youtube.com")).not.toBeNull();
    });

    it("clamps the onboarding limit to [1 min, 2 h] and treats blank fields as 0", async () => {
      const { getStore } = await loadOptions({});
      el("obHours").value = "5";
      el("obMinutes").value = "";
      el("obStart").click();
      await flush();
      expect(getStore().budgetSeconds).toBe(7200);
      expect(getStore().focusSites).toEqual([]);
    });

    it("Skip for now sets onboarded without touching sites or the cap", async () => {
      const { getStore } = await loadOptions({ budgetSeconds: 900 });
      document.querySelector('#presetSites .preset[data-domain="youtube.com"]').click();
      el("obSkip").click();
      await flush();
      expect(getStore()).toEqual({ budgetSeconds: 900, onboarded: true });
    });
  });

  // --- Blocked sites: status rows, add, remove ---
  describe("site rows", () => {
    it("renders each site's own remaining time from the shared evaluation", async () => {
      await loadOptions({
        ...onboarded,
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 600 },
          { domain: "reddit.com", budgetSeconds: 120 }
        ],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      expect(row("youtube.com").querySelector(".budget").textContent).toBe("9:00 left");
      expect(row("reddit.com").querySelector(".budget").textContent).toBe("2:00 left");
      expect(document.querySelector("#siteList .empty")).toBeNull();
    });

    it("shows the empty hint with no sites", async () => {
      await loadOptions(onboarded);
      expect(document.querySelector("#siteList .empty").textContent).toMatch(/No sites yet/);
    });

    it("shows a locked site as locked with its unlock time, and disables removal and editing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const lockedUntil = new Date(2026, 0, 14, 14, 30, 0).getTime();
      const { opts } = await loadOptions({
        ...onboarded,
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

      // Open the editor: everything in it is read-only while locked.
      opts.expanded.add("youtube.com");
      await opts.load();
      const editor = row("youtube.com").querySelector(".site-editor");
      expect(editor.querySelector(".locked-note").textContent).toBe("Locked — settings can't be changed until it unlocks.");
      expect(editor.querySelector(".site-budget").disabled).toBe(true);
      expect(editor.querySelector(".lockout-mode").disabled).toBe(true);
      expect(editor.querySelector(".add-rule").disabled).toBe(true);
    });

    it("adding a site stores it with per-site defaults filled in; blanks and duplicates are ignored", async () => {
      const { opts, getStore } = await loadOptions({ ...onboarded, budgetSeconds: 3600 });
      el("domainInput").value = "https://www.Reddit.com/r/all";
      await opts.addSite({ preventDefault() {} });
      expect(getStore().focusSites).toEqual([{ domain: "reddit.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }]);
      expect(el("domainInput").value).toBe("");
      expect(row("reddit.com")).not.toBeNull();
      el("domainInput").value = "reddit.com";
      el("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      el("domainInput").value = " ";
      el("addForm").dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      expect(getStore().focusSites).toHaveLength(1);
    });

    it("removeSite() refuses while locked or in the last 5 minutes of the site's budget, allows otherwise", async () => {
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 60 },
          { domain: "reddit.com", budgetSeconds: 1800 },
          { domain: "x.com", budgetSeconds: 1800 }
        ],
        budgetSeconds: 7200,
        usage: {
          date: localTodayKey(),
          totalMs: 60_000,
          sites: { "youtube.com": { totalMs: 60_000 }, "x.com": { totalMs: 1_620_000 } }
        }
      });
      expect(row("x.com").querySelector(".remove").disabled).toBe(true);
      expect(row("x.com").querySelector(".remove").title).toBe("Can't remove in the last 5 minutes of its budget");
      await opts.removeSite("youtube.com");
      await opts.removeSite("x.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com", "reddit.com", "x.com"]);
      row("reddit.com").querySelector(".remove").click();
      await flush();
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com", "x.com"]);
    });

    it("removeSite() refuses a schedule-locked site even with zero usage, and the hover text names the rule", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00, inside the block window
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      expect(row("youtube.com").querySelector(".budget").textContent).toBe("🔒 scheduled until 17:00");
      expect(row("youtube.com").querySelector(".budget").title).toBe("Blocked by a schedule rule");
      await opts.removeSite("youtube.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["youtube.com"]);
    });

    it("off-hours rows read 'off-hours'; a blackout locks every row with the blackout's end", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 20, 0, 0));
      await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
        budgetSeconds: 3600,
        schedule: { enabled: true, days: allDays, windows: [{ start: "09:00", end: "17:00" }], blackouts: [] }
      });
      expect(row("youtube.com").querySelector(".budget").textContent).toBe("off-hours");
      expect(row("youtube.com").classList.contains("locked")).toBe(false);

      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }, { domain: "reddit.com" }],
        budgetSeconds: 3600,
        schedule: { enabled: true, days: allDays, windows: [], blackouts: [{ start: "11:00", end: "13:30" }] }
      });
      for (const d of ["youtube.com", "reddit.com"]) {
        expect(row(d).querySelector(".budget").textContent).toBe("🔒 scheduled until 13:30");
        expect(row(d).querySelector(".budget").title).toBe("Blocked by your global blackout");
      }
      expect(await opts.updateSite("youtube.com", (s) => ({ ...s, budgetSeconds: 60_000 }))).toBe(false);
      expect(getStore().focusSites[0].budgetSeconds).toBe(600);
    });
  });

  // --- Per-site editor (ported from the popup) ---
  describe("per-site editor", () => {
    it("clicking ⚙ opens the editor pre-filled with the site's current settings, and again closes it", async () => {
      await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", budgetSeconds: 900, lockoutSeconds: 7200, rules: [{ type: "allow", days: [0, 6], start: "10:00", end: "12:00" }] }],
        budgetSeconds: 3600
      });
      const gear = row("youtube.com").querySelector(".edit");
      expect(gear.getAttribute("aria-expanded")).toBe("false");
      gear.click();
      await flush();
      const editor = row("youtube.com").querySelector(".site-editor");
      expect(editor).not.toBeNull();
      expect(row("youtube.com").querySelector(".edit").getAttribute("aria-expanded")).toBe("true");
      expect(editor.querySelector(".site-budget").value).toBe("15");
      expect(editor.querySelector(".lockout-mode").value).toBe("minutes");
      expect(editor.querySelector(".lockout-min").value).toBe("120");
      expect(editor.querySelector(".lockout-min").hidden).toBe(false);
      const rule = editor.querySelector(".rule-row");
      expect(rule.querySelector(".rule-type").value).toBe("allow");
      expect(rule.querySelector(".rule-start").value).toBe("10:00");
      expect(rule.querySelector(".rule-end").value).toBe("12:00");
      const pressed = [...rule.querySelectorAll(".day-toggle")].map((b) => b.getAttribute("aria-pressed"));
      expect(pressed).toEqual(["true", "false", "false", "false", "false", "false", "true"]);

      row("youtube.com").querySelector(".edit").click();
      await flush();
      expect(row("youtube.com").querySelector(".site-editor")).toBeNull();
    });

    it("a site with no rules says so, and 'until midnight' hides the minutes field", async () => {
      const { opts } = await loadOptions({ ...onboarded, focusSites: [{ domain: "youtube.com" }] });
      opts.expanded.add("youtube.com");
      await opts.load();
      const editor = row("youtube.com").querySelector(".site-editor");
      expect(editor.querySelector(".rules-head").textContent).toMatch(/none/);
      expect(editor.querySelector(".lockout-mode").value).toBe("midnight");
      expect(editor.querySelector(".lockout-min").hidden).toBe(true);
      expect(editor.querySelector(".locked-note")).toBeNull();
    });

    it("changing the per-site budget input persists it (in seconds) and leaves other sites alone", async () => {
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com" }, { domain: "reddit.com", budgetSeconds: 300 }],
        budgetSeconds: 3600
      });
      opts.expanded.add("youtube.com");
      await opts.load();
      const input = row("youtube.com").querySelector(".site-budget");
      input.value = "12.5";
      change(input);
      await flush();
      const sites = getStore().focusSites;
      expect(sites[0]).toEqual({ domain: "youtube.com", budgetSeconds: 750, lockoutSeconds: null, rules: [] });
      expect(sites[1].budgetSeconds).toBe(300);
      // The editor stays open across the re-render and shows the new value.
      expect(row("youtube.com").querySelector(".site-budget").value).toBe("12.5");
    });

    it("switching lockout mode persists minutes-as-seconds, and back to 'until midnight' as null", async () => {
      const { opts, getStore } = await loadOptions({ ...onboarded, focusSites: [{ domain: "youtube.com" }], budgetSeconds: 3600 });
      opts.expanded.add("youtube.com");
      await opts.load();
      let editor = row("youtube.com").querySelector(".site-editor");
      const mode = editor.querySelector(".lockout-mode");
      editor.querySelector(".lockout-min").value = "90";
      mode.value = "minutes";
      change(mode);
      await flush();
      expect(getStore().focusSites[0].lockoutSeconds).toBe(5400);

      editor = row("youtube.com").querySelector(".site-editor");
      const min = editor.querySelector(".lockout-min");
      expect(min.hidden).toBe(false);
      min.value = "45";
      change(min);
      await flush();
      expect(getStore().focusSites[0].lockoutSeconds).toBe(2700);

      editor = row("youtube.com").querySelector(".site-editor");
      const mode2 = editor.querySelector(".lockout-mode");
      mode2.value = "midnight";
      change(mode2);
      await flush();
      expect(getStore().focusSites[0].lockoutSeconds).toBeNull();
    });

    it("ignores a non-positive cool-down length", async () => {
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", lockoutSeconds: 600 }],
        budgetSeconds: 3600
      });
      opts.expanded.add("youtube.com");
      await opts.load();
      const min = row("youtube.com").querySelector(".lockout-min");
      min.value = "0";
      change(min);
      await flush();
      expect(getStore().focusSites[0].lockoutSeconds).toBe(600);
    });

    it("adding, editing, toggling days on, and removing a schedule rule all persist", async () => {
      // The default new rule blocks Mon-Fri 09:00-17:00. Pin the clock to a
      // Wednesday evening so adding it doesn't lock the site (and therefore
      // freeze its editor) partway through this test.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 20, 0, 0));
      const { opts, getStore } = await loadOptions({ ...onboarded, focusSites: [{ domain: "youtube.com" }], budgetSeconds: 3600 });
      opts.expanded.add("youtube.com");
      await opts.load();

      row("youtube.com").querySelector(".add-rule").click();
      await flush();
      expect(getStore().focusSites[0].rules).toEqual([
        { type: "block", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", touchedAt: Date.now() }
      ]);
      expect(row("youtube.com").querySelector(".rules-head").textContent).toBe("Schedule");

      let rule = row("youtube.com").querySelector(".rule-row");
      rule.querySelectorAll(".day-toggle")[0].click(); // Sunday on
      await flush();
      expect(getStore().focusSites[0].rules[0].days).toEqual([0, 1, 2, 3, 4, 5]);

      rule = row("youtube.com").querySelector(".rule-row");
      rule.querySelectorAll(".day-toggle")[3].click(); // Wednesday off
      await flush();
      expect(getStore().focusSites[0].rules[0].days).toEqual([0, 1, 2, 4, 5]);

      rule = row("youtube.com").querySelector(".rule-row");
      const end = rule.querySelector(".rule-end");
      end.value = "18:30";
      change(end);
      await flush();
      expect(getStore().focusSites[0].rules[0].end).toBe("18:30");

      rule = row("youtube.com").querySelector(".rule-row");
      const start = rule.querySelector(".rule-start");
      start.value = "08:15";
      change(start);
      await flush();
      expect(getStore().focusSites[0].rules[0].start).toBe("08:15");

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
      change(type);
      await flush();
      expect(getStore().focusSites[0].rules[0].type).toBe("allow");
      expect(row("youtube.com").classList.contains("locked")).toBe(true);
      expect(row("youtube.com").querySelector(".site-budget").disabled).toBe(true);
      expect(row("youtube.com").querySelector(".add-rule").disabled).toBe(true);
      expect(row("youtube.com").querySelector(".rule-type").disabled).toBe(false);
      expect(row("youtube.com").querySelector(".rule-row").classList.contains("grace")).toBe(true);
      expect(row("youtube.com").querySelector(".locked-note").textContent).toMatch(/stays editable/);
    });

    it("a just-added rule that locked the site can still be removed within 60s (undo a fumble); older rules can't", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00 — both rules below are active
      const { opts, getStore } = await loadOptions({
        ...onboarded,
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
      opts.expanded.add("youtube.com");
      await opts.load();
      const rows = row("youtube.com").querySelectorAll(".rule-row");
      expect(row("youtube.com").classList.contains("locked")).toBe(true);
      expect(rows[0].querySelector(".remove-rule").disabled).toBe(true);
      expect(rows[0].querySelector(".rule-end").disabled).toBe(true);
      expect(rows[0].classList.contains("grace")).toBe(false);
      expect(rows[1].querySelector(".remove-rule").disabled).toBe(false);
      expect(rows[1].classList.contains("grace")).toBe(true);
      expect(row("youtube.com").querySelector(".locked-note").textContent).toMatch(/stays editable/);

      // Old rule: refused even via the API.
      expect(await opts.updateSite("youtube.com", (s) => ({ ...s, rules: s.rules.slice(1) }), { ruleIndex: 0 })).toBe(false);
      // Non-rule edits stay refused while locked.
      expect(await opts.updateSite("youtube.com", (s) => ({ ...s, budgetSeconds: 999 }))).toBe(false);
      expect(getStore().focusSites[0].rules).toHaveLength(2);

      rows[1].querySelector(".remove-rule").click();
      await flush();
      expect(getStore().focusSites[0].rules).toHaveLength(1);
      expect(getStore().focusSites[0].rules[0].start).toBe("09:00");

      // Once the grace window passes, the survivor is frozen too.
      vi.setSystemTime(Date.now() + 61_000);
      await opts.load();
      expect(row("youtube.com").querySelector(".rule-row").classList.contains("grace")).toBe(false);
      expect(row("youtube.com").querySelector(".locked-note").textContent).not.toMatch(/stays editable/);
    });

    it("a future-dated touchedAt stamp (clock skew) is not a perpetual grace", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0));
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00", touchedAt: Date.now() + 5_000 }] }],
        budgetSeconds: 3600
      });
      opts.expanded.add("youtube.com");
      await opts.load();
      expect(row("youtube.com").querySelector(".rule-row").classList.contains("grace")).toBe(false);
      expect(row("youtube.com").querySelector(".remove-rule").disabled).toBe(true);
      expect(await opts.updateSite("youtube.com", (s) => ({ ...s, rules: [] }), { ruleIndex: 0 })).toBe(false);
      expect(getStore().focusSites[0].rules).toHaveLength(1);
    });

    it("editing a rule that is still in grace refreshes its stamp (you keep only the rule you're actively fixing)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00, rule below is active -> site locked
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00", touchedAt: Date.now() - 50_000 }] }],
        budgetSeconds: 3600
      });
      opts.expanded.add("youtube.com");
      await opts.load();
      expect(row("youtube.com").classList.contains("locked")).toBe(true);
      const end = row("youtube.com").querySelector(".rule-end");
      expect(end.disabled).toBe(false);
      end.value = "11:00";
      change(end);
      await flush();
      const saved = getStore().focusSites[0].rules[0];
      expect(saved.end).toBe("11:00");
      expect(saved.touchedAt).toBe(Date.now()); // refreshed from 50s-old
      // 55s after the ORIGINAL stamp it would have expired; after the refresh it's still live.
      vi.setSystemTime(Date.now() + 15_000);
      await opts.load();
      expect(row("youtube.com").querySelector(".rule-row").classList.contains("grace")).toBe(true);
    });

    it("updateSite() refuses to change a locked site (anti-bypass), re-checking live state", async () => {
      const { opts, getStore, setStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60 }],
        budgetSeconds: 3600
      });
      opts.expanded.add("youtube.com");
      await opts.load();
      expect(row("youtube.com").querySelector(".site-budget").disabled).toBe(false);
      // The site locks after the editor was rendered; the stale, enabled input must not get through.
      setStore({ usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } } });
      const input = row("youtube.com").querySelector(".site-budget");
      input.value = "9999";
      change(input);
      await flush();
      expect(getStore().focusSites[0].budgetSeconds).toBe(60);
      expect(await opts.updateSite("youtube.com", (s) => ({ ...s, budgetSeconds: 999_999 }))).toBe(false);
      // ...and the re-render now shows the editor as locked.
      expect(row("youtube.com").querySelector(".site-budget").disabled).toBe(true);
    });

    it("updateSite()/removeSite() are keyed by domain, so a concurrent removal can't redirect an edit to a neighbour", async () => {
      const { opts, getStore, setStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "a.com" }, { domain: "b.com" }],
        budgetSeconds: 3600
      });
      // Simulate the popup removing a.com after b.com's editor was rendered.
      setStore({ focusSites: [{ domain: "b.com" }] });
      expect(await opts.updateSite("b.com", (s) => ({ ...s, budgetSeconds: 600 }))).toBe(true);
      expect(getStore().focusSites).toEqual([{ domain: "b.com", budgetSeconds: 600, lockoutSeconds: null, rules: [] }]);
      expect(await opts.updateSite("a.com", (s) => s)).toBe(false); // gone -> refused, nothing written
      await opts.removeSite("a.com");
      expect(getStore().focusSites).toHaveLength(1);
    });

    it("rejects a per-site budget of 0 (it would lock the site instantly with no way back) and renders despite a corrupt rule entry", async () => {
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com", budgetSeconds: 600, rules: [null, { type: "block", days: [1], start: "09:00", end: "10:00" }] }],
        budgetSeconds: 3600
      });
      opts.expanded.add("youtube.com");
      await opts.load();
      // The null rule was dropped at normalization; only the real one rendered.
      expect(row("youtube.com").querySelectorAll(".rule-row")).toHaveLength(1);

      for (const bad of ["0", "-3", "abc"]) {
        const input = row("youtube.com").querySelector(".site-budget");
        input.value = bad;
        change(input);
        await flush();
        expect(getStore().focusSites[0].budgetSeconds).toBe(600);
        expect(row("youtube.com").querySelector(".site-budget").value).toBe("10"); // reverted
      }
    });
  });

  // --- Daily limit (global cap) ---
  describe("daily limit", () => {
    it("renders the global cap as hours + minutes with the remaining time", async () => {
      await loadOptions({ ...onboarded, budgetSeconds: 5400, usage: { date: localTodayKey(), totalMs: 600_000, sites: {} } });
      expect(el("budgetHours").value).toBe("1");
      expect(el("budgetMinutes").value).toBe("30");
      expect(el("remaining").textContent).toBe("80:00 left today");
      expect(el("remaining").className).toBe("remaining live");
      expect(el("budgetNote").hidden).toBe(true);
    });

    it("saves h + m as seconds, clamped to [1 min, 2 h], on change of either field", async () => {
      const { getStore } = await loadOptions({ ...onboarded, budgetSeconds: 1800 });
      el("budgetHours").value = "1";
      el("budgetMinutes").value = "20";
      change(el("budgetMinutes"));
      await flush();
      expect(getStore().budgetSeconds).toBe(4800);
      el("budgetHours").value = "4";
      change(el("budgetHours"));
      await flush();
      expect(getStore().budgetSeconds).toBe(7200);
      expect(el("budgetHours").value).toBe("2");
      expect(el("budgetMinutes").value).toBe("0");
      el("budgetHours").value = "0";
      el("budgetMinutes").value = "0";
      change(el("budgetMinutes"));
      await flush();
      expect(getStore().budgetSeconds).toBe(60);
    });

    it("locks the fields once the cap is spent and refuses to raise it", async () => {
      const { opts, getStore } = await loadOptions({
        ...onboarded,
        focusSites: [{ domain: "youtube.com" }],
        budgetSeconds: 60,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } }
      });
      expect(el("remaining").textContent).toBe("🔒 Daily limit reached");
      expect(el("remaining").className).toBe("remaining empty");
      expect(el("budgetHours").disabled).toBe(true);
      expect(el("budgetMinutes").disabled).toBe(true);
      expect(el("budgetNote").hidden).toBe(false);
      el("budgetHours").value = "2";
      await opts.saveBudget();
      expect(getStore().budgetSeconds).toBe(60);
      expect(el("budgetHours").value).toBe("0");
      expect(el("budgetMinutes").value).toBe("1");
    });
  });

  // --- Global schedule editor ---
  describe("schedule", () => {
    it("is collapsed with the 24/7 note while disabled; enabling persists and reveals the editor with every day on", async () => {
      const { getStore } = await loadOptions(onboarded);
      expect(el("schedEnabled").checked).toBe(false);
      expect(el("schedBody").hidden).toBe(true);
      expect(el("schedOff").hidden).toBe(false);

      el("schedEnabled").checked = true;
      change(el("schedEnabled"));
      await flush();
      expect(getStore().schedule).toEqual({ enabled: true, days: allDays, windows: [], blackouts: [] });
      expect(el("schedBody").hidden).toBe(false);
      expect(el("schedOff").hidden).toBe(true);
      const days = [...document.querySelectorAll("#enforceDays .day-btn")];
      expect(days.map((b) => b.textContent)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
      expect(days.every((b) => b.classList.contains("on"))).toBe(true);

      el("schedEnabled").checked = false;
      change(el("schedEnabled"));
      await flush();
      expect(getStore().schedule.enabled).toBe(false);
      expect(el("schedBody").hidden).toBe(true);
    });

    it("toggling enforcement days persists a sorted day list", async () => {
      const { getStore } = await loadOptions({ ...onboarded, schedule: { enabled: true, days: allDays, windows: [], blackouts: [] } });
      document.querySelectorAll("#enforceDays .day-btn")[0].click(); // Sun off
      await flush();
      document.querySelectorAll("#enforceDays .day-btn")[6].click(); // Sat off
      await flush();
      expect(getStore().schedule.days).toEqual([1, 2, 3, 4, 5]);
      expect(document.querySelectorAll("#enforceDays .day-btn")[0].classList.contains("on")).toBe(false);
      document.querySelectorAll("#enforceDays .day-btn")[0].click(); // Sun back on -> sorted first
      await flush();
      expect(getStore().schedule.days).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("adds, edits and removes enforcement windows", async () => {
      const { getStore } = await loadOptions({ ...onboarded, schedule: { enabled: true, days: allDays, windows: [], blackouts: [] } });
      el("addWindow").click();
      await flush();
      expect(getStore().schedule.windows).toEqual([{ start: "09:00", end: "17:00" }]);
      el("addWindow").click();
      await flush();
      expect(getStore().schedule.windows).toHaveLength(2);
      expect(document.querySelectorAll("#windowList li")).toHaveLength(2);

      const second = document.querySelectorAll("#windowList li")[1];
      const end = second.querySelector(".win-end");
      end.value = "21:30";
      change(end);
      await flush();
      expect(getStore().schedule.windows[1]).toEqual({ start: "09:00", end: "21:30" });
      const start = document.querySelectorAll("#windowList li")[1].querySelector(".win-start");
      start.value = "19:00";
      change(start);
      await flush();
      expect(getStore().schedule.windows[1]).toEqual({ start: "19:00", end: "21:30" });

      document.querySelectorAll("#windowList li")[0].querySelector(".row-remove").click();
      await flush();
      expect(getStore().schedule.windows).toEqual([{ start: "19:00", end: "21:30" }]);
      expect(document.querySelectorAll("#windowList li")).toHaveLength(1);
    });

    it("adds, edits, day-toggles and removes blackouts", async () => {
      const { getStore } = await loadOptions({ ...onboarded, schedule: { enabled: true, days: allDays, windows: [], blackouts: [] } });
      el("addBlackout").click();
      await flush();
      expect(getStore().schedule.blackouts).toEqual([{ start: "22:00", end: "06:00", days: allDays }]);

      let li = document.querySelector("#blackoutList li");
      const dayBtns = li.querySelectorAll(".blackout-days .day-btn");
      expect(dayBtns).toHaveLength(7);
      expect([...dayBtns].map((b) => b.textContent).join("")).toBe("SMTWTFS");
      expect(dayBtns[0].title).toBe("Sun");
      dayBtns[0].click(); // Sunday off
      await flush();
      expect(getStore().schedule.blackouts[0].days).toEqual([1, 2, 3, 4, 5, 6]);
      li = document.querySelector("#blackoutList li");
      expect(li.querySelectorAll(".blackout-days .day-btn")[0].classList.contains("on")).toBe(false);
      li.querySelectorAll(".blackout-days .day-btn")[0].click(); // back on, sorted
      await flush();
      expect(getStore().schedule.blackouts[0].days).toEqual(allDays);

      li = document.querySelector("#blackoutList li");
      const end = li.querySelector(".win-end");
      end.value = "07:30";
      change(end);
      await flush();
      expect(getStore().schedule.blackouts[0]).toEqual({ start: "22:00", end: "07:30", days: allDays });

      document.querySelector("#blackoutList li .row-remove").click();
      await flush();
      expect(getStore().schedule.blackouts).toEqual([]);
    });

    it("a stored blackout with no days renders as every day and toggling one persists the explicit list", async () => {
      const { getStore } = await loadOptions({
        ...onboarded,
        schedule: { enabled: true, days: allDays, windows: [], blackouts: [{ start: "12:00", end: "13:00" }] }
      });
      const btns = document.querySelectorAll("#blackoutList .blackout-days .day-btn");
      expect([...btns].every((b) => b.classList.contains("on"))).toBe(true);
      btns[3].click();
      await flush();
      expect(getStore().schedule.blackouts[0].days).toEqual([0, 1, 2, 4, 5, 6]);
    });

    it("a schedule change written elsewhere (e.g. the background) re-renders the editor", async () => {
      const { listeners, setStore } = await loadOptions(onboarded);
      const sched = { enabled: true, days: [1, 2, 3], windows: [{ start: "08:00", end: "12:00" }], blackouts: [] };
      setStore({ schedule: sched });
      listeners.onChanged.forEach((fn) => fn({ schedule: { newValue: sched } }, "local"));
      await flush();
      expect(el("schedEnabled").checked).toBe(true);
      expect(document.querySelectorAll("#windowList li")).toHaveLength(1);
      expect([...document.querySelectorAll("#enforceDays .day-btn")].filter((b) => b.classList.contains("on")).map((b) => b.textContent)).toEqual(["Mon", "Tue", "Wed"]);
    });
  });

  // --- Advanced: explicit Save ---
  describe("advanced", () => {
    it("renders the stored idle settings, defaulting to on / 45 s", async () => {
      await loadOptions(onboarded);
      expect(el("idleEnabled").checked).toBe(true);
      expect(el("idleInput").value).toBe("45");
      expect(el("idleInput").disabled).toBe(false);

      await loadOptions({ ...onboarded, settings: { idleEnabled: false, idleSeconds: 20 } });
      expect(el("idleEnabled").checked).toBe(false);
      expect(el("idleInput").value).toBe("20");
      expect(el("idleInput").disabled).toBe(true);
      expect(el("idleSecondsRow").classList.contains("disabled")).toBe(true);
    });

    it("nothing persists until Save; Save writes both fields and shows the Saved indicator", async () => {
      const { getStore } = await loadOptions({ ...onboarded, settings: { idleEnabled: true, idleSeconds: 45 } });
      el("idleEnabled").checked = false;
      change(el("idleEnabled"));
      el("idleInput").value = "30";
      change(el("idleInput"));
      await flush();
      expect(getStore().settings).toEqual({ idleEnabled: true, idleSeconds: 45 });
      expect(el("idleInput").disabled).toBe(true); // reflected visually, not saved
      expect(el("advancedSaved").hidden).toBe(true);

      el("saveAdvanced").click();
      await flush();
      expect(getStore().settings).toEqual({ idleEnabled: false, idleSeconds: 30 });
      expect(el("advancedSaved").hidden).toBe(false);
    });

    // --- Issue #2: parseInt(...) || default treats an explicit 0 as falsy ---
    it("saving idleSeconds=0 clamps to the 5 s minimum, not the 45 s default; blank falls back to 45", async () => {
      const { opts, getStore } = await loadOptions(onboarded);
      el("idleInput").value = "0";
      await opts.saveAdvanced();
      expect(getStore().settings).toEqual({ idleEnabled: true, idleSeconds: 5 });
      el("idleInput").value = "";
      await opts.saveAdvanced();
      expect(getStore().settings.idleSeconds).toBe(45);
      el("idleInput").value = "3";
      await opts.saveAdvanced();
      expect(getStore().settings.idleSeconds).toBe(5);
    });

    it("a schedule edit does not wipe an unsaved Advanced edit in progress", async () => {
      await loadOptions(onboarded);
      el("idleInput").value = "90";
      el("schedEnabled").checked = true;
      change(el("schedEnabled"));
      await flush();
      expect(el("idleInput").value).toBe("90");
    });

    it("a settings change written elsewhere refreshes the card", async () => {
      const { listeners, setStore } = await loadOptions(onboarded);
      const settings = { idleEnabled: false, idleSeconds: 15 };
      setStore({ settings });
      listeners.onChanged.forEach((fn) => fn({ settings: { newValue: settings } }, "local"));
      await flush();
      expect(el("idleEnabled").checked).toBe(false);
      expect(el("idleInput").value).toBe("15");
    });
  });

  // --- Live refresh ---
  it("a usage tick refreshes the countdown and rows but doesn't drop focus from an open site editor", async () => {
    const { listeners, setStore } = await loadOptions({
      ...onboarded,
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }, { domain: "reddit.com", budgetSeconds: 600 }],
      budgetSeconds: 3600
    });
    row("youtube.com").querySelector(".edit").click();
    await flush();
    const input = row("youtube.com").querySelector(".site-budget");
    input.focus();
    expect(document.activeElement).toBe(input);

    const usage = { date: localTodayKey(), totalMs: 60_000, sites: { "reddit.com": { totalMs: 60_000 } } };
    setStore({ usage });
    listeners.onChanged.forEach((fn) => fn({ usage: { newValue: usage } }, "local"));
    await flush();
    expect(el("remaining").textContent).toBe("59:00 left today");
    expect(document.activeElement).toBe(input); // same node, no re-render of the list
    expect(row("reddit.com").querySelector(".budget").textContent).toBe("10:00 left"); // stale until focus leaves

    input.blur();
    listeners.onChanged.forEach((fn) => fn({ usage: { newValue: usage } }, "local"));
    await flush();
    expect(row("reddit.com").querySelector(".budget").textContent).toBe("9:00 left");
    expect(row("youtube.com").querySelector(".site-editor")).not.toBeNull(); // still open
  });

  it("a focusSites change written by the popup re-renders the list", async () => {
    const { listeners, setStore } = await loadOptions({ ...onboarded, focusSites: [{ domain: "youtube.com" }] });
    const focusSites = [{ domain: "youtube.com" }, { domain: "reddit.com" }];
    setStore({ focusSites });
    listeners.onChanged.forEach((fn) => fn({ focusSites: { newValue: focusSites } }, "local"));
    await flush();
    expect(row("reddit.com")).not.toBeNull();
  });
});
