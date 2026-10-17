import { describe, expect, it } from "vitest";
import * as pill from "../companion/pill.js";

// Wed 2026-01-14 local time.
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 0, 14 + dayOffset, h, m, 0, 0).getTime();
const NOW = at(12);

describe("companion/pill.js", () => {
  it("fmtUntil() renders same-day times, the daily reset as 'midnight', and other days with a weekday", () => {
    expect(pill.fmtUntil(at(17), NOW)).toBe("17:00");
    expect(pill.fmtUntil(at(0, 0, 1), NOW)).toBe("midnight");
    expect(pill.fmtUntil(at(18, 0, 1), NOW)).toBe("Thu 18:00");
    expect(pill.fmtUntil(null, NOW)).toBe("");
  });

  it("describeLocked() lists only locked sites, most recently blocked first, with until and reason", () => {
    const lines = pill.describeLocked(
      {
        locked: true,
        lastBlocked: "reddit.com",
        sites: {
          "youtube.com": { locked: true, reason: "lockout", until: at(14, 30), remainingMs: 0 },
          "reddit.com": { locked: true, reason: "schedule", until: at(17), remainingMs: 0 },
          "news.example": { locked: false, reason: null, until: null, remainingMs: 60_000 }
        }
      },
      NOW
    );
    expect(lines).toEqual(["reddit.com until 17:00 (schedule)", "youtube.com until 14:30"]);
  });

  // Issue #18 TC7: a hand-written state.json with a reserved key.
  it("describeLocked() tolerates a crafted \"__proto__\" site key without throwing or polluting Object.prototype", () => {
    const state = { locked: true, sites: JSON.parse('{"__proto__":{"locked":true}}') };
    let lines;
    expect(() => {
      lines = pill.describeLocked(state, NOW);
    }).not.toThrow();
    // Either the literal name or nothing — never a crash, never a pollution.
    expect(lines.every((l) => typeof l === "string")).toBe(true);
    expect(({}).locked).toBeUndefined();
    expect(Object.prototype.locked).toBeUndefined();
  });

  it("falls back to the legacy single lastBlocked field when no per-site snapshot exists", () => {
    expect(pill.describeLocked({ locked: true, lastBlocked: "youtube.com" }, NOW)).toEqual(["youtube.com"]);
    expect(pill.describeLocked({ locked: false }, NOW)).toEqual([]);
    expect(pill.describeLocked(null, NOW)).toEqual([]);
  });
});
