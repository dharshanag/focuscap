import { describe, expect, it } from "vitest";
import { fmtClock, todayKey } from "../shared.js";

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
    it("returns a string matching the YYYY-M-D pattern for the current date", () => {
      const key = todayKey();
      expect(key).toMatch(/^\d{4}-\d{1,2}-\d{1,2}$/);

      const now = new Date();
      expect(key).toBe(`${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`);
    });
  });
});
