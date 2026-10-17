import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createChromeMock, flush } from "./helpers/chrome-mock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "time-is-up.html"), "utf8");
const source = readFileSync(join(root, "time-is-up.js"), "utf8");
// The real page body, minus its <script> tags (the test imports the module itself).
const bodyMarkup = html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script[^>]*><\/script>/g, "");

// Wed 2026-01-14 local time.
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 0, 14 + dayOffset, h, m, 0, 0).getTime();
const TODAY = new Date(2026, 0, 14).toDateString();
const YESTERDAY = new Date(2026, 0, 13).toDateString();

async function loadPage(initialStorage) {
  vi.resetModules();
  document.body.innerHTML = bodyMarkup;
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  const page = await import("../time-is-up.js");
  await flush();
  return { page, ...mock };
}

const text = (id) => document.getElementById(id).textContent;

describe("time-is-up.js", () => {
  beforeEach(() => {
    localStorage.clear();
    // Fake the clock and the page's 1-second interval (not setTimeout: flush()
    // relies on it). Faking setInterval also stops a page's ticker from
    // outliving its test and scribbling on a later test's DOM.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  describe("describeBlock()", () => {
    it("a cool-down lockout counts down to the lockout end, not midnight", async () => {
      const { page } = await loadPage({});
      const info = page.describeBlock("lockout", at(14, 30), at(12));
      expect(info.heading).toBe("Cooling down");
      expect(info.resetLabel).toBe("Back in");
      expect(info.until).toBe(at(14, 30));
    });

    it("a budget lock with no cool-down (until midnight) reads as blocked for the day", async () => {
      const { page } = await loadPage({});
      const info = page.describeBlock("budget", at(0, 0, 1), at(12));
      expect(info.heading).toBe("Blocked for the day");
      expect(info.resetLabel).toBe("Resets in");
      expect(info.until).toBe(at(0, 0, 1));
    });

    it("a schedule block counts down to the window end and says why", async () => {
      const { page } = await loadPage({});
      const info = page.describeBlock("schedule", at(17), at(12));
      expect(info.heading).toBe("Blocked right now");
      expect(info.body).toMatch(/schedule/);
      expect(info.resetLabel).toBe("Unblocks in");
      expect(info.until).toBe(at(17));
    });

    it("a schedule block that runs past midnight still counts to its real end, not the daily reset", async () => {
      // 22:00-02:00 window asked at 23:00, or "next allow window is tomorrow 18:00".
      const { page } = await loadPage({});
      expect(page.describeBlock("schedule", at(2, 0, 1), at(23)).until).toBe(at(2, 0, 1));
      expect(page.describeBlock("schedule", at(18, 0, 1), at(12)).until).toBe(at(18, 0, 1));
      // Unknown end (an allow rule whose days never match): the block does not
      // end at midnight, so don't promise that — say "indefinitely" and give
      // nothing to count down to. (Issue #15.)
      const indefinite = page.describeBlock("schedule", null, at(12));
      expect(indefinite.until).toBeNull();
      expect(indefinite.resetLabel).toBe("");
      expect(indefinite.body).toMatch(/indefinitely/);
    });

    it("renders an indefinite schedule block with no countdown line", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "schedule", lastBlockedUntil: null });
      expect(document.getElementById("headline").textContent).toBe("Blocked right now");
      expect(document.getElementById("body").textContent).toMatch(/indefinitely/);
      expect(document.getElementById("resetLine").textContent).toBe("");
    });

    it("the global cap always resets at midnight and says so", async () => {
      const { page } = await loadPage({});
      const info = page.describeBlock("global", null, at(12));
      expect(info.body).toMatch(/total cap/);
      expect(info.until).toBe(at(0, 0, 1));
    });

    it("an unknown/missing reason (legacy storage) falls back to the midnight reset", async () => {
      const { page } = await loadPage({});
      const info = page.describeBlock(undefined, undefined, at(12));
      expect(info.heading).toBe("Blocked for the day");
      expect(info.until).toBe(at(0, 0, 1));
    });
  });

  it("fmtCountdown() formats hours only when needed", async () => {
    const { page } = await loadPage({});
    expect(page.fmtCountdown(2 * 3600_000 + 5 * 60_000 + 9_000)).toBe("2h 05m 09s");
    expect(page.fmtCountdown(5 * 60_000 + 9_000)).toBe("5m 09s");
    expect(page.fmtCountdown(-5)).toBe("0m 00s");
  });

  describe("rendering", () => {
    it("renders the blocked domain, reason and a countdown to the stored unlock time", async () => {
      await loadPage({
        lastBlocked: "youtube.com",
        lastBlockedReason: "lockout",
        lastBlockedUntil: at(13, 30)
      });
      expect(text("domain")).toBe("youtube.com");
      expect(text("headline")).toBe("Cooling down");
      expect(text("message")).toBe("youtube.com is out of time for now. Go do the thing you meant to do.");
      expect(text("resetLabel")).toBe("Back in");
      expect(text("countdown")).toBe("1h 30m 00s");
      expect(text("resetLine")).toBe("Back in 1h 30m 00s");
      expect(document.title).toBe("youtube.com — cooling down");
    });

    it("the countdown lives inside #resetLine so the whole line reads as one sentence", async () => {
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "schedule", lastBlockedUntil: at(17) });
      const countdown = document.getElementById("countdown");
      expect(countdown.closest("#resetLine")).not.toBeNull();
      expect(text("resetLine")).toBe("Unblocks in 5h 00m 00s");
      expect(text("headline")).toBe("Blocked right now");
    });

    it("the global cap renders its own explanation and the midnight reset", async () => {
      await loadPage({ lastBlocked: "reddit.com", lastBlockedReason: "global", lastBlockedUntil: null });
      expect(text("headline")).toBe("Blocked for the day");
      expect(text("message")).toMatch(/^reddit\.com is out of time — your total cap/);
      expect(text("resetLine")).toBe("Resets in 12h 00m 00s");
    });

    it("a tab left open past the unlock time shows a plain 'go back' instead of a negative countdown", async () => {
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "lockout", lastBlockedUntil: at(11) });
      // The whole line is one sentence: no leftover label, separator or timer.
      expect(text("resetLine")).toBe("You can go back now.");
      expect(document.getElementById("resetLine").childNodes).toHaveLength(1);
      // Nothing left to count down, so no ticker is started.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("the countdown ticks down every second while the page is open", async () => {
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "lockout", lastBlockedUntil: at(13, 30) });
      expect(text("countdown")).toBe("1h 30m 00s");
      vi.advanceTimersByTime(1000);
      expect(text("countdown")).toBe("1h 29m 59s");
      vi.advanceTimersByTime(59_000);
      expect(text("countdown")).toBe("1h 29m 00s");
      expect(text("resetLine")).toBe("Back in 1h 29m 00s");
    });

    it("when the countdown reaches zero the line flips to 'go back' and the ticker stops", async () => {
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "lockout", lastBlockedUntil: at(12, 0, 0) + 2000 });
      expect(text("resetLine")).toBe("Back in 0m 02s");
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(text("resetLine")).toBe("Back in 0m 01s");
      vi.advanceTimersByTime(1000);
      expect(text("resetLine")).toBe("You can go back now.");
      expect(vi.getTimerCount()).toBe(0);
      // A further second passing changes nothing (and throws nothing).
      vi.advanceTimersByTime(5000);
      expect(text("resetLine")).toBe("You can go back now.");
    });
  });

  describe("encouraging messages", () => {
    it("exposes exactly main's seven messages", async () => {
      const { page } = await loadPage({});
      expect(page.MESSAGES).toEqual([
        "You're doing amazing; Keep going!",
        "Keep at it, and you'll be amazed at how far you've come.",
        "Back to the grind — you've got this.",
        "You're doing so good, you got this!",
        "The more you work now, the less you'll stress later.",
        "You know this isn't what you're supposed to be doing right now. You're doing great.",
        "Lock in! You're doing awesome."
      ]);
    });

    it("pickMessage(rng) maps the rng's [0,1) range over the whole list and never returns undefined", async () => {
      const { page } = await loadPage({});
      expect(page.pickMessage(() => 0)).toBe(page.MESSAGES[0]);
      expect(page.pickMessage(() => 0.999999)).toBe(page.MESSAGES[6]);
      expect(page.pickMessage(() => 3 / 7)).toBe(page.MESSAGES[3]);
      // A broken rng is clamped rather than indexing off the end.
      expect(page.pickMessage(() => 1)).toBe(page.MESSAGES[6]);
      expect(page.pickMessage(() => -1)).toBe(page.MESSAGES[0]);
      expect(page.pickMessage(() => NaN)).toBe(page.MESSAGES[0]);
      // Default rng: always one of the seven.
      for (let i = 0; i < 50; i++) expect(page.MESSAGES).toContain(page.pickMessage());
    });

    it("shouldEncourage() is false on the first view of a day and true from the second", async () => {
      const { page } = await loadPage({});
      expect(page.shouldEncourage({ views: null, viewsDay: null }, TODAY)).toBe(false);
      expect(page.shouldEncourage({ views: "0", viewsDay: TODAY }, TODAY)).toBe(false);
      expect(page.shouldEncourage({ views: "1", viewsDay: TODAY }, TODAY)).toBe(true);
      expect(page.shouldEncourage({ views: "7", viewsDay: TODAY }, TODAY)).toBe(true);
      // Yesterday's count doesn't carry over, however high it was.
      expect(page.shouldEncourage({ views: "7", viewsDay: YESTERDAY }, TODAY)).toBe(false);
      // Garbage in storage counts as zero rather than throwing or encouraging.
      expect(page.shouldEncourage({ views: "lots", viewsDay: TODAY }, TODAY)).toBe(false);
      expect(page.shouldEncourage(undefined, TODAY)).toBe(false);
    });

    it("bumpViews() stores the count as a string under today's key, exactly as main does", async () => {
      const { page } = await loadPage({});
      expect(page.bumpViews({ views: null, viewsDay: null }, TODAY)).toEqual({ views: "1", viewsDay: TODAY });
      expect(page.bumpViews({ views: "3", viewsDay: TODAY }, TODAY)).toEqual({ views: "4", viewsDay: TODAY });
      expect(page.bumpViews({ views: "3", viewsDay: YESTERDAY }, TODAY)).toEqual({ views: "1", viewsDay: TODAY });
    });

    it("the first block-page view of the day shows no encouragement and starts the counter", async () => {
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null });
      expect(text("encouragement")).toBe("");
      expect(localStorage.getItem("views")).toBe("1");
      expect(localStorage.getItem("viewsDay")).toBe(TODAY);
      // The rest of the page still renders.
      expect(text("headline")).toBe("Blocked for the day");
      expect(text("countdown")).toBe("12h 00m 00s");
    });

    it("the second view of the day shows one of the seven messages and bumps the counter", async () => {
      localStorage.setItem("views", "1");
      localStorage.setItem("viewsDay", TODAY);
      const { page } = await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null });
      expect(page.MESSAGES).toContain(text("encouragement"));
      expect(localStorage.getItem("views")).toBe("2");
      expect(localStorage.getItem("viewsDay")).toBe(TODAY);
    });

    it("the page picks its message at random (Math.random), not a fixed one", async () => {
      const random = vi.spyOn(Math, "random");
      localStorage.setItem("views", "1");
      localStorage.setItem("viewsDay", TODAY);

      random.mockReturnValue(6 / 7);
      let { page } = await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null });
      expect(text("encouragement")).toBe(page.MESSAGES[6]);

      random.mockReturnValue(0);
      ({ page } = await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null }));
      expect(text("encouragement")).toBe(page.MESSAGES[0]);

      random.mockReturnValue(3 / 7);
      ({ page } = await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null }));
      expect(text("encouragement")).toBe(page.MESSAGES[3]);
      random.mockRestore();
    });

    it("a new day resets the counter: yesterday's many views don't earn a message today", async () => {
      localStorage.setItem("views", "9");
      localStorage.setItem("viewsDay", YESTERDAY);
      await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null });
      expect(text("encouragement")).toBe("");
      expect(localStorage.getItem("views")).toBe("1");
      expect(localStorage.getItem("viewsDay")).toBe(TODAY);
    });

    it("the message is set as plain text, never parsed as markup", async () => {
      localStorage.setItem("views", "1");
      localStorage.setItem("viewsDay", TODAY);
      const { page } = await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "budget", lastBlockedUntil: null });
      const el = document.getElementById("encouragement");
      // DOM content equals one of the raw strings and contains no element nodes.
      expect(page.MESSAGES).toContain(el.textContent);
      expect(el.childElementCount).toBe(0);
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild.nodeType).toBe(Node.TEXT_NODE);
      // And the source never assigns innerHTML from anything.
      expect(source).not.toMatch(/innerHTML\s*=/);
    });

    it("a stored domain is rendered as text too (no markup injection via lastBlocked)", async () => {
      await loadPage({ lastBlocked: "<b>evil</b>.com", lastBlockedReason: "budget", lastBlockedUntil: null });
      expect(text("domain")).toBe("<b>evil</b>.com");
      expect(document.getElementById("domain").childElementCount).toBe(0);
    });
  });
});
