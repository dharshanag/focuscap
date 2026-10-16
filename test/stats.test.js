import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Mount the REAL stats.html markup (minus its script tags, which jsdom would
// not resolve anyway) so the ids/classes stats.js renders into are the ones
// that ship, not a hand-copied approximation.
function mountStatsDom() {
  const page = new JSDOM(readFileSync(join(root, "stats.html"), "utf8")).window.document;
  page.querySelectorAll("script").forEach((s) => s.remove());
  document.body.innerHTML = page.body.innerHTML;
}

// stats.js uses shared.js (todayKey/dayKey/matchSite/normalizeSite) and
// classify.js (classifyDomain) as bare globals, like the script tags provide.
async function loadStats(initialStorage) {
  vi.resetModules();
  mountStatsDom();
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  vi.stubGlobal("classifyDomain", (await import("../classify.js")).classifyDomain);
  const stats = await import("../stats.js");
  await flush(); // let the import-time load() finish rendering
  return { stats, ...mock };
}

// Fixed "today" so day keys in fixtures are deterministic. Only Date is faked:
// flush() needs a real setTimeout.
const TODAY = new Date(2026, 9, 16, 15, 0, 0); // Fri Oct 16 2026
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return keyOf(d);
};

const text = (sel) => document.querySelector(sel).textContent;
const all = (sel) => [...document.querySelectorAll(sel)];

describe("stats.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function freezeToday() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  }

  it("fmtDur() formats seconds, minutes and zero-padded hours", async () => {
    const { stats } = await loadStats({});
    expect(stats.fmtDur(0)).toBe("0s");
    expect(stats.fmtDur(42_000)).toBe("42s");
    expect(stats.fmtDur(59_499)).toBe("59s");
    expect(stats.fmtDur(60_000)).toBe("1m");
    expect(stats.fmtDur(7 * 60_000 + 30_000)).toBe("7m");
    expect(stats.fmtDur(65 * 60_000)).toBe("1h 05m");
    expect(stats.fmtDur(2 * 60 * 60_000)).toBe("2h 00m");
  });

  it("tiles total today's active, distraction (classified OR blocked) and productive time", async () => {
    freezeToday();
    await loadStats({
      focusSites: [{ domain: "news.example" }], // user-blocked, not in the curated list
      stats: {
        [daysAgo(0)]: {
          "youtube.com": 10 * 60_000, // distraction by classification
          "news.example": 5 * 60_000, // distraction because blocked
          "github.com": 20 * 60_000, // productive
          "example.com": 3 * 60_000, // neutral: counts as active only
          "noise.example": 500 // sub-second: ignored everywhere
        },
        [daysAgo(1)]: { "youtube.com": 60 * 60_000 } // yesterday: not in tiles
      }
    });
    expect(text("#totalActive")).toBe("38m");
    expect(text("#totalDistraction")).toBe("15m");
    expect(text("#totalProductive")).toBe("20m");
    expect(text("#today")).toContain("October 16");
  });

  it("an empty day shows zeroed tiles, the empty note, and no suggestions", async () => {
    freezeToday();
    await loadStats({});
    expect(text("#totalActive")).toBe("0s");
    expect(document.getElementById("emptyToday").hidden).toBe(false);
    expect(document.getElementById("suggestBox").hidden).toBe(true);
    expect(all("#siteList li")).toHaveLength(0);
    expect(all("#trend .day")).toHaveLength(7);
  });

  describe("'Consider blocking' suggestions", () => {
    it("lists unblocked distraction sites with >= 60s, biggest first, capped at 5", async () => {
      freezeToday();
      await loadStats({
        focusSites: [{ domain: "reddit.com" }],
        stats: {
          [daysAgo(0)]: {
            "reddit.com": 50 * 60_000, // distraction but already blocked
            "github.com": 40 * 60_000, // productive
            "example.com": 30 * 60_000, // neutral
            "tiktok.com": 59_000, // distraction but under a minute
            "youtube.com": 9 * 60_000,
            "twitter.com": 8 * 60_000,
            "instagram.com": 7 * 60_000,
            "facebook.com": 6 * 60_000,
            "twitch.tv": 5 * 60_000,
            "netflix.com": 60_000 // 6th eligible: cut by the cap
          }
        }
      });
      expect(document.getElementById("suggestBox").hidden).toBe(false);
      expect(all("#suggestList li .domain").map((e) => e.textContent)).toEqual([
        "youtube.com", "twitter.com", "instagram.com", "facebook.com", "twitch.tv"
      ]);
      expect(all("#suggestList li .time").map((e) => e.textContent)).toEqual(["9m", "8m", "7m", "6m", "5m"]);
      expect(all("#suggestList li .block-btn")).toHaveLength(5);
    });

    it("hides the box when nothing qualifies", async () => {
      freezeToday();
      await loadStats({
        focusSites: [{ domain: "youtube.com" }],
        stats: { [daysAgo(0)]: { "youtube.com": 30 * 60_000, "github.com": 30 * 60_000, "tiktok.com": 30_000 } }
      });
      expect(document.getElementById("suggestBox").hidden).toBe(true);
      expect(all("#suggestList li")).toHaveLength(0);
    });

    it("a www. subdomain of a blocked site counts as blocked (not re-suggested)", async () => {
      freezeToday();
      await loadStats({
        focusSites: [{ domain: "youtube.com" }],
        stats: { [daysAgo(0)]: { "m.youtube.com": 30 * 60_000 } }
      });
      expect(document.getElementById("suggestBox").hidden).toBe(true);
      expect(text("#siteList li .chip")).toBe("blocked");
    });

    it("Block writes the site to focusSites via normalizeSite (full per-site defaults), then re-renders", async () => {
      freezeToday();
      const { getStore } = await loadStats({
        focusSites: [{ domain: "reddit.com", budgetSeconds: 600, lockoutSeconds: 300, rules: [] }],
        stats: { [daysAgo(0)]: { "youtube.com": 10 * 60_000, "reddit.com": 60_000 } }
      });
      document.querySelector("#suggestList li .block-btn").click();
      await flush();
      expect(getStore().focusSites).toEqual([
        { domain: "reddit.com", budgetSeconds: 600, lockoutSeconds: 300, rules: [] },
        { domain: "youtube.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }
      ]);
      // Now blocked: gone from suggestions, tagged in the list, counted as distraction still.
      expect(document.getElementById("suggestBox").hidden).toBe(true);
      expect(document.querySelector('#siteList li[data-domain="youtube.com"] .blocked-tag').textContent).toBe("✓ blocked");
      expect(text("#totalDistraction")).toBe("11m");
    });

    it("Block is a no-op for a domain that is already on the list", async () => {
      freezeToday();
      const { stats, getStore, chrome } = await loadStats({
        focusSites: [{ domain: "youtube.com" }],
        stats: { [daysAgo(0)]: {} }
      });
      chrome.storage.local.set.mockClear();
      await stats.blockSite("youtube.com");
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect(getStore().focusSites).toEqual([{ domain: "youtube.com" }]);
    });

    it("Block de-duplicates with the same matching rule as enforcement (www./subdomain forms)", async () => {
      freezeToday();
      const { stats, getStore, chrome } = await loadStats({
        focusSites: [{ domain: "www.youtube.com" }, { domain: "reddit.com" }],
        stats: { [daysAgo(0)]: {} }
      });
      chrome.storage.local.set.mockClear();
      await stats.blockSite("youtube.com"); // already covered by the www. entry
      await stats.blockSite("old.reddit.com"); // already covered by the parent domain
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect(getStore().focusSites).toEqual([{ domain: "www.youtube.com" }, { domain: "reddit.com" }]);
      // A genuinely new domain still gets added.
      await stats.blockSite("x.com");
      expect(getStore().focusSites.map((s) => s.domain)).toEqual(["www.youtube.com", "reddit.com", "x.com"]);
    });
  });

  describe("today's site list", () => {
    it("orders by time desc, meters relative to the top site, chips by category/blocked, Block only where sensible", async () => {
      freezeToday();
      await loadStats({
        focusSites: [{ domain: "reddit.com" }],
        stats: {
          [daysAgo(0)]: {
            "example.com": 2 * 60_000,
            "github.com": 8 * 60_000,
            "reddit.com": 4 * 60_000,
            "youtube.com": 1 * 60_000
          }
        }
      });
      const rows = all("#siteList li");
      expect(rows.map((li) => li.dataset.domain)).toEqual(["github.com", "reddit.com", "example.com", "youtube.com"]);
      expect(rows.map((li) => li.querySelector(".time").textContent)).toEqual(["8m", "4m", "2m", "1m"]);
      expect(rows.map((li) => li.querySelector(".chip").textContent)).toEqual(["productive", "blocked", "neutral", "distraction"]);
      expect(rows.map((li) => li.querySelector(".meter-fill").style.width)).toEqual(["100%", "50%", "25%", "12.5%"]);
      expect(rows.map((li) => li.querySelector(".meter-fill").className)).toEqual([
        "meter-fill productive", "meter-fill distraction", "meter-fill neutral", "meter-fill distraction"
      ]);
      // Productive: no Block button. Blocked: a tag. Neutral/distraction: a Block button.
      expect(rows[0].querySelector(".block-btn")).toBeNull();
      expect(rows[1].querySelector(".blocked-tag")).not.toBeNull();
      expect(rows[2].querySelector(".block-btn")).not.toBeNull();
      expect(rows[3].querySelector(".block-btn")).not.toBeNull();
      expect(document.getElementById("emptyToday").hidden).toBe(true);
    });

    it("never renders more than 25 rows, and a tiny site still gets a visible 2% meter", async () => {
      freezeToday();
      const day = {};
      for (let i = 0; i < 30; i++) day[`site${i}.example`] = (30 - i) * 60_000;
      day["tiny.example"] = 1000; // 1s against 30m
      await loadStats({ stats: { [daysAgo(0)]: day } });
      const rows = all("#siteList li");
      expect(rows).toHaveLength(25);
      expect(rows[0].dataset.domain).toBe("site0.example");
      // tiny.example is rank 31 -> cut by the cap; check the floor via a smaller fixture instead.
      await loadStats({ stats: { [daysAgo(0)]: { "big.example": 30 * 60_000, "tiny.example": 1000 } } });
      expect(document.querySelector('#siteList li[data-domain="tiny.example"] .meter-fill').style.width).toBe("2%");
    });
  });

  describe("7-day trend", () => {
    it("sums distraction time (classified or blocked) per day for the last 7 days, oldest first, today highlighted", async () => {
      freezeToday();
      await loadStats({
        focusSites: [{ domain: "news.example" }],
        stats: {
          [daysAgo(8)]: { "youtube.com": 99 * 60_000 }, // outside the window
          [daysAgo(6)]: { "youtube.com": 5 * 60_000, "github.com": 30 * 60_000 },
          [daysAgo(3)]: { "news.example": 7 * 60_000, "example.com": 60 * 60_000 },
          [daysAgo(1)]: { "youtube.com": 30_000 }, // under a minute: bar but no label
          [daysAgo(0)]: { "youtube.com": 10 * 60_000, "reddit.com": 2 * 60_000 }
        }
      });
      const cols = all("#trend .day");
      expect(cols).toHaveLength(7);
      expect(cols.map((c) => c.dataset.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(daysAgo));
      expect(cols.map((c) => Number(c.dataset.ms))).toEqual([5 * 60_000, 0, 0, 7 * 60_000, 0, 30_000, 12 * 60_000]);
      expect(cols.map((c) => c.querySelector(".bar-val").textContent)).toEqual(["5m", "", "", "7m", "", "", "12m"]);
      // Heights scale against the busiest day (today: 90px); quiet days keep a 3px stub.
      expect(cols[6].querySelector(".bar").style.height).toBe("90px");
      expect(cols[3].querySelector(".bar").style.height).toBe(`${Math.round((7 / 12) * 90)}px`);
      expect(cols[1].querySelector(".bar").style.height).toBe("3px");
      expect(cols[6].querySelector(".bar").classList.contains("today")).toBe(true);
      expect(cols.slice(0, 6).some((c) => c.querySelector(".bar").classList.contains("today"))).toBe(false);
    });
  });

  describe("live refresh", () => {
    it("re-renders when stats or focusSites change in local storage, and ignores other keys/areas", async () => {
      freezeToday();
      const { listeners, setStore, chrome } = await loadStats({ stats: { [daysAgo(0)]: { "youtube.com": 60_000 } } });
      expect(text("#totalActive")).toBe("1m");
      expect(listeners.onChanged).toHaveLength(1);
      const onChanged = listeners.onChanged[0];

      setStore({ stats: { [daysAgo(0)]: { "youtube.com": 5 * 60_000 } } });
      onChanged({ stats: {} }, "local");
      await flush();
      expect(text("#totalActive")).toBe("5m");
      expect(document.getElementById("suggestBox").hidden).toBe(false);

      setStore({ focusSites: [{ domain: "youtube.com" }] });
      onChanged({ focusSites: {} }, "local");
      await flush();
      expect(document.getElementById("suggestBox").hidden).toBe(true);
      expect(text("#siteList li .chip")).toBe("blocked");

      chrome.storage.local.get.mockClear();
      onChanged({ usage: {} }, "local");
      onChanged({ stats: {} }, "sync");
      await flush();
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
    });
  });

  it("degrades safely on malformed storage (non-object stats, non-array focusSites, junk values)", async () => {
    freezeToday();
    await loadStats({
      focusSites: "nope",
      stats: { [daysAgo(0)]: { "youtube.com": "lots", "github.com": 120_000, "": 5000 }, [daysAgo(2)]: 42 }
    });
    expect(text("#totalActive")).toBe("2m");
    expect(all("#siteList li").map((li) => li.dataset.domain)).toEqual(["github.com"]);
    expect(all("#trend .day")).toHaveLength(7);
    const bad = await loadStats({ stats: [] });
    expect(text("#totalActive")).toBe("0s");
    void bad;
  });
});
