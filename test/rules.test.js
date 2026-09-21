import { describe, expect, it } from "vitest";
import * as shared from "../shared.js";

// Local-time helper: Wednesday 2026-01-14 at HH:MM. (getDay(): Sun=0 ... Wed=3)
const WED = 3;
const TUE = 2;
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 0, 14 + dayOffset, h, m, 0, 0);

describe("shared.js schedule rules", () => {
  describe("parseHHMM()", () => {
    it("parses HH:MM into minutes since midnight", () => {
      expect(shared.parseHHMM("00:00")).toBe(0);
      expect(shared.parseHHMM("09:30")).toBe(570);
      expect(shared.parseHHMM("9:05")).toBe(545);
      expect(shared.parseHHMM("24:00")).toBe(1440);
    });

    it("rejects malformed or out-of-range input instead of guessing", () => {
      expect(shared.parseHHMM("")).toBeNull();
      expect(shared.parseHHMM(undefined)).toBeNull();
      expect(shared.parseHHMM("9")).toBeNull();
      expect(shared.parseHHMM("12:60")).toBeNull();
      expect(shared.parseHHMM("25:00")).toBeNull();
      expect(shared.parseHHMM("noon")).toBeNull();
    });
  });

  describe("ruleActiveAt()", () => {
    const workHours = { type: "block", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

    it("is active inside the window on a listed day (start inclusive, end exclusive)", () => {
      expect(shared.ruleActiveAt(workHours, at(9, 0))).toBe(true);
      expect(shared.ruleActiveAt(workHours, at(12, 30))).toBe(true);
      expect(shared.ruleActiveAt(workHours, at(16, 59))).toBe(true);
      expect(shared.ruleActiveAt(workHours, at(17, 0))).toBe(false);
    });

    it("is inactive outside the window or on an unlisted day", () => {
      expect(shared.ruleActiveAt(workHours, at(8, 59))).toBe(false);
      // 2026-01-17 is a Saturday (day 6), not in Mon-Fri.
      expect(shared.ruleActiveAt(workHours, at(12, 0, 3))).toBe(false);
    });

    it("handles windows that wrap past midnight (22:00-02:00)", () => {
      const night = { type: "block", days: [TUE], start: "22:00", end: "02:00" };
      // Tuesday 23:00 -> in the pre-midnight part
      expect(shared.ruleActiveAt(night, at(23, 0, -1))).toBe(true);
      // Wednesday 01:00 -> post-midnight tail of Tuesday's window
      expect(shared.ruleActiveAt(night, at(1, 0))).toBe(true);
      // Wednesday 03:00 -> over
      expect(shared.ruleActiveAt(night, at(3, 0))).toBe(false);
      // Wednesday 23:00 -> Wednesday isn't a listed day
      expect(shared.ruleActiveAt(night, at(23, 0))).toBe(false);
    });

    it("treats a rule with no days or unparseable times as never active", () => {
      expect(shared.ruleActiveAt({ type: "block", days: [], start: "09:00", end: "17:00" }, at(12))).toBe(false);
      expect(shared.ruleActiveAt({ type: "block", days: [WED], start: "bogus", end: "17:00" }, at(12))).toBe(false);
      expect(shared.ruleActiveAt(null, at(12))).toBe(false);
    });
  });

  describe("scheduleVerdict()", () => {
    it("has no opinion with no rules", () => {
      expect(shared.scheduleVerdict([], at(12))).toBeNull();
      expect(shared.scheduleVerdict(undefined, at(12))).toBeNull();
    });

    it("an active block window wins even over an active allow window", () => {
      const rules = [
        { type: "allow", days: [WED], start: "08:00", end: "20:00" },
        { type: "block", days: [WED], start: "12:00", end: "13:00" }
      ];
      expect(shared.scheduleVerdict(rules, at(12, 30))).toBe("block");
      expect(shared.scheduleVerdict(rules, at(14, 0))).toBe("allow");
    });

    it("with only allow rules, everything outside them is blocked", () => {
      const rules = [{ type: "allow", days: [WED], start: "18:00", end: "20:00" }];
      expect(shared.scheduleVerdict(rules, at(12, 0))).toBe("block");
      expect(shared.scheduleVerdict(rules, at(19, 0))).toBe("allow");
    });

    it("with only block rules, outside them the schedule has no opinion (budgets decide)", () => {
      const rules = [{ type: "block", days: [WED], start: "09:00", end: "17:00" }];
      expect(shared.scheduleVerdict(rules, at(20, 0))).toBeNull();
    });
  });

  describe("scheduleBlockedUntil()", () => {
    it("returns null when the schedule isn't what's blocking", () => {
      expect(shared.scheduleBlockedUntil([], at(12))).toBeNull();
      const rules = [{ type: "block", days: [WED], start: "09:00", end: "17:00" }];
      expect(shared.scheduleBlockedUntil(rules, at(20))).toBeNull();
    });

    it("for an active block window, returns that window's end today", () => {
      const rules = [{ type: "block", days: [WED], start: "09:00", end: "17:00" }];
      expect(shared.scheduleBlockedUntil(rules, at(12))).toBe(at(17).getTime());
    });

    it("for a wrapped block window entered before midnight, the end is tomorrow", () => {
      const rules = [{ type: "block", days: [WED], start: "22:00", end: "02:00" }];
      expect(shared.scheduleBlockedUntil(rules, at(23))).toBe(at(2, 0, 1).getTime());
    });

    it("outside every allow window, returns the next allow window's start (even across days)", () => {
      // Allowed only Thursday 18:00-20:00; asked on Wednesday noon.
      const rules = [{ type: "allow", days: [4], start: "18:00", end: "20:00" }];
      expect(shared.scheduleBlockedUntil(rules, at(12))).toBe(at(18, 0, 1).getTime());
      // Asked Wednesday 19:00 with an allow window later today.
      const today = [{ type: "allow", days: [WED], start: "21:00", end: "22:00" }];
      expect(shared.scheduleBlockedUntil(today, at(19))).toBe(at(21).getTime());
    });
  });
});
