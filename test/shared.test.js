import { afterEach, describe, expect, it, vi } from "vitest";
import { dayKey, fmtClock, todayKey } from "../shared.js";

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
