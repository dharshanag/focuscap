import { afterEach, describe, expect, it, vi } from "vitest";
import { dayKey, describeStatus, evaluateSite, fmtClock, fmtUntil, normalizeDomain, normalizeUsage, padDayKey, parseIntOr, RULE_GRACE_MS, ruleInGrace, SCHEMA_VERSION, siteUsage, todayKey } from "../shared.js";

describe("shared.js", () => {
  describe("fmtClock()", () => {
    it("formats 0ms as 0:00", () => {
      expect(fmtClock(0)).toBe("0:00");
    });

    it("formats exact minute boundaries", () => {
      expect(fmtClock(60_000)).toBe("1:00");
      expect(fmtClock(120_000)).toBe("2:00");
    });

    it("rounds sub-second remainders to the nearest second", () => {
      // 61,499ms rounds to 61s -> 1:01; 61,500ms rounds to 62s -> 1:02.
      expect(fmtClock(61_499)).toBe("1:01");
      expect(fmtClock(61_500)).toBe("1:02");
    });

    it("clamps negative input to 0:00", () => {
      expect(fmtClock(-5000)).toBe("0:00");
    });
  });

  describe("parseIntOr()", () => {
    it("keeps an explicit 0 instead of falling back (the `|| default` bug)", () => {
      expect(parseIntOr("0", 45)).toBe(0);
      expect(parseIntOr(0, 45)).toBe(0);
    });

    it("falls back only when the input isn't a number", () => {
      expect(parseIntOr("", 45)).toBe(45);
      expect(parseIntOr("abc", 45)).toBe(45);
      expect(parseIntOr(undefined, 7)).toBe(7);
      expect(parseIntOr("30", 45)).toBe(30);
      expect(parseIntOr("12.9", 45)).toBe(12);
    });
  });

  // --- Status wording shared by the popup rows and the options page. ---
  describe("fmtUntil() / describeStatus()", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fmtUntil() says 'midnight' for the daily reset, a clock time today, and 'Thu 18:00' on another day", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0)); // Wed
      expect(fmtUntil(new Date(2026, 0, 15, 0, 0, 0, 0).getTime())).toBe("midnight");
      expect(fmtUntil(new Date(2026, 0, 14, 17, 0, 0, 0).getTime())).toBe("17:00");
      expect(fmtUntil(new Date(2026, 0, 14, 9, 5, 0, 0).getTime())).toBe("09:05");
      expect(fmtUntil(new Date(2026, 0, 15, 18, 0, 0, 0).getTime())).toBe("Thu 18:00");
      expect(fmtUntil(null)).toBe("");
      expect(fmtUntil(undefined)).toBe("");
    });

    it("describes schedule, global-cap and budget/lockout locks distinctly, with the unlock time", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      expect(describeStatus({ locked: true, reason: "schedule", until: null })).toBe("🔒 scheduled");
      expect(describeStatus({ locked: true, reason: "schedule", until: new Date(2026, 0, 14, 13, 30).getTime() })).toBe("🔒 scheduled until 13:30");
      expect(describeStatus({ locked: true, reason: "global", until: null })).toBe("🔒 total cap reached");
      expect(describeStatus({ locked: true, reason: "budget", until: new Date(2026, 0, 15, 0, 0, 0, 0).getTime() })).toBe("🔒 locked until midnight");
      expect(describeStatus({ locked: true, reason: "lockout", until: new Date(2026, 0, 14, 14, 30).getTime() })).toBe("🔒 locked until 14:30");
    });

    it("shows a countdown when unlocked and 'off-hours' when the global schedule isn't enforcing", () => {
      expect(describeStatus({ locked: false, remainingMs: 90_000 })).toBe("1:30 left");
      expect(describeStatus({ locked: false, free: true, remainingMs: 600_000 })).toBe("off-hours");
    });
  });

  describe("ruleInGrace()", () => {
    it("is true only within RULE_GRACE_MS (60 s) after the rule was touched", () => {
      const now = 1_700_000_000_000;
      expect(RULE_GRACE_MS).toBe(60_000);
      expect(ruleInGrace({ touchedAt: now - 10_000 }, now)).toBe(true);
      expect(ruleInGrace({ touchedAt: now - 59_999 }, now)).toBe(true);
      expect(ruleInGrace({ touchedAt: now - 60_000 }, now)).toBe(false);
      expect(ruleInGrace({ touchedAt: now - 61_000 }, now)).toBe(false);
    });

    it("never grants grace to a future-dated stamp, a missing stamp, or a missing rule", () => {
      const now = 1_700_000_000_000;
      expect(ruleInGrace({ touchedAt: now + 5_000 }, now)).toBe(false);
      expect(ruleInGrace({ type: "block" }, now)).toBe(false);
      expect(ruleInGrace({ touchedAt: "recent" }, now)).toBe(false);
      expect(ruleInGrace(null, now)).toBe(false);
      expect(ruleInGrace(undefined)).toBe(false);
    });

    it("defaults `now` to the current clock", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      expect(ruleInGrace({ touchedAt: Date.now() - 30_000 })).toBe(true);
      expect(ruleInGrace({ touchedAt: Date.now() - 90_000 })).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("todayKey()", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns a zero-padded YYYY-MM-DD key for the current local date", () => {
      const key = todayKey();
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      expect(key).toBe(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
    });

    it("zero-pads single-digit months and days (2026-01-05, not 2026-1-5)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0));
      expect(todayKey()).toBe("2026-01-05");

      vi.setSystemTime(new Date(2026, 11, 25, 12, 0, 0));
      expect(todayKey()).toBe("2026-12-25");
    });

    it("dayKey(date) keys an arbitrary date the same way todayKey() keys now (local, zero-padded)", () => {
      expect(dayKey(new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
      expect(dayKey(new Date(2026, 9, 16, 0, 0, 0).getTime())).toBe("2026-10-16"); // ms timestamp works too
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 7, 9, 0, 0));
      expect(dayKey(new Date())).toBe(todayKey());
    });

    it("keys sort chronologically as plain strings (what stats pruning relies on)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0)); // Sep 30
      const sep = todayKey();
      vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0)); // Oct 5
      const oct = todayKey();
      expect([oct, sep].sort()).toEqual([sep, oct]);
    });
  });
});

describe("schema versioning helpers (issue #16)", () => {
  it("SCHEMA_VERSION is a positive integer", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("padDayKey() zero-pads legacy day keys and leaves everything else untouched", () => {
    expect(padDayKey("2026-9-5")).toBe("2026-09-05");
    expect(padDayKey("2026-10-5")).toBe("2026-10-05");
    expect(padDayKey("2026-9-25")).toBe("2026-09-25");
    expect(padDayKey("2026-09-05")).toBe("2026-09-05");
    expect(padDayKey("junk")).toBe("junk");
    expect(padDayKey("2026-9-5T00")).toBe("2026-9-5T00");
    expect(padDayKey(42)).toBe(42);
  });
});

// Issue #18: reserved property names as domains / crafted usage records.
describe("reserved names and prototype safety (issue #18)", () => {
  describe("normalizeDomain()", () => {
    it("strips protocol, www, path and port and lowercases", () => {
      expect(normalizeDomain("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
      expect(normalizeDomain("reddit.com:443/r/all")).toBe("reddit.com");
      expect(normalizeDomain("  Example.COM  ")).toBe("example.com");
      expect(normalizeDomain("")).toBe("");
      expect(normalizeDomain(undefined)).toBe("");
      expect(normalizeDomain(null)).toBe("");
    });

    it("rejects the Object.prototype names __proto__ / constructor / prototype, after the strip", () => {
      for (const raw of ["__proto__", "constructor", "prototype", "https://__proto__/x", "WWW.CONSTRUCTOR:443", " prototype "]) {
        expect(normalizeDomain(raw), raw).toBe("");
      }
    });

    it("still accepts a real label that merely contains the word", () => {
      expect(normalizeDomain("proto.example.com")).toBe("proto.example.com");
      expect(normalizeDomain("constructor.example.com")).toBe("constructor.example.com");
      expect(normalizeDomain("__proto__.example.com")).toBe("__proto__.example.com");
    });
  });

  describe("normalizeUsage() / siteUsage() use own-property, null-prototype maps", () => {
    it("a crafted {\"__proto__\": {...}} key in stored usage neither pollutes Object.prototype nor resolves to it", () => {
      const now = Date.now();
      const u = normalizeUsage({ date: todayKey(), totalMs: 0, sites: JSON.parse('{"__proto__":{"totalMs":1}}') }, now);
      const rec = siteUsage(u, "example.com");
      expect(rec).toEqual({ totalMs: 0 });
      expect(Object.prototype.totalMs).toBeUndefined();
      expect(({}).totalMs).toBeUndefined();
      expect(Object.getPrototypeOf(u.sites)).toBeNull();
      expect(Object.hasOwn(u.sites, "__proto__")).toBe(true);
      const proto = siteUsage(u, "__proto__");
      expect(proto).not.toBe(Object.prototype);
      expect(proto).toEqual({ totalMs: 1, lastTickAt: undefined, lockedUntil: undefined });
      // A normal site's evaluation is unaffected.
      const status = evaluateSite({ domain: "example.com", budgetSeconds: 60, lockoutSeconds: null, rules: [] }, u, 1_800_000, now);
      expect(status.locked).toBe(false);
      expect(status.remainingMs).toBe(60_000);
    });

    it("siteUsage() on a plain-object map never hands out Object.prototype for \"__proto__\"", () => {
      const u = { date: todayKey(), totalMs: 0, sites: {} };
      const rec = siteUsage(u, "__proto__");
      expect(rec).not.toBe(Object.prototype);
      expect(rec).toEqual({ totalMs: 0 });
      expect(Object.hasOwn(u.sites, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(u.sites)).toBe(Object.prototype); // the map's prototype was not swapped
      expect(Object.prototype.totalMs).toBeUndefined();
      // Mutations land on the own entry, as for any other domain.
      rec.totalMs += 5;
      expect(siteUsage(u, "__proto__").totalMs).toBe(5);
      expect(siteUsage(u, "constructor")).toEqual({ totalMs: 0 });
    });

    it("the normalized map still JSON-round-trips like a plain object (what chrome.storage / the mock do)", () => {
      const u = normalizeUsage({ date: todayKey(), totalMs: 7, sites: { "a.com": { totalMs: 3 } } }, Date.now());
      siteUsage(u, "b.com").totalMs = 4;
      const back = JSON.parse(JSON.stringify(u));
      expect(back).toEqual({ date: todayKey(), totalMs: 7, sites: { "a.com": { totalMs: 3 }, "b.com": { totalMs: 4 } } });
      // And a round-tripped record normalizes again without losing entries.
      expect(Object.keys(normalizeUsage(back, Date.now()).sites).sort()).toEqual(["a.com", "b.com"]);
    });
  });
});
