import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, flush } from "./helpers/chrome-mock.js";

// Wed 2026-01-14 local time.
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 0, 14 + dayOffset, h, m, 0, 0).getTime();

async function loadPage(initialStorage) {
  vi.resetModules();
  document.body.innerHTML = `
    <h1 id="heading"></h1>
    <p><span id="domain">This site</span><span id="body"></span></p>
    <div><span id="resetLabel"></span> <b id="countdown">—</b></div>
  `;
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  const page = await import("../time-is-up.js");
  await flush();
  return { page, ...mock };
}

describe("time-is-up.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
      // Unknown end (e.g. an allow rule whose days never match): fall back to midnight.
      expect(page.describeBlock("schedule", null, at(12)).until).toBe(at(0, 0, 1));
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

  it("renders the blocked domain, reason and a countdown to the stored unlock time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
    await loadPage({
      lastBlocked: "youtube.com",
      lastBlockedReason: "lockout",
      lastBlockedUntil: at(13, 30)
    });
    expect(document.getElementById("domain").textContent).toBe("youtube.com");
    expect(document.getElementById("heading").textContent).toBe("Cooling down");
    expect(document.getElementById("resetLabel").textContent).toBe("Back in");
    expect(document.getElementById("countdown").textContent).toBe("1h 30m 00s");
    expect(document.title).toBe("youtube.com — cooling down");
  });

  it("a tab left open past the unlock time shows a plain 'go back' instead of a negative countdown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
    await loadPage({ lastBlocked: "youtube.com", lastBlockedReason: "lockout", lastBlockedUntil: at(11) });
    expect(document.getElementById("resetLabel").textContent).toBe("");
    expect(document.getElementById("countdown").textContent).toBe("You can go back now.");
  });
});
