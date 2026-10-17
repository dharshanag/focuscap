import { describe, expect, it } from "vitest";
import * as shared from "../shared.js";

// Local-time helper: Wednesday 2026-01-14 at HH:MM. (getDay(): Sun=0 ... Wed=3)
const WED = 3;
const TUE = 2;
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 0, 14 + dayOffset, h, m, 0, 0);

describe("shared.js matchSite()", () => {
  const sites = [{ domain: "YouTube.com" }, { domain: "" }, null, { domain: "www.reddit.com" }];

  it("matches the bare domain, www., and subdomains, case-insensitively", () => {
    expect(shared.matchSite("youtube.com", sites).domain).toBe("YouTube.com");
    expect(shared.matchSite("WWW.YOUTUBE.COM", sites).domain).toBe("YouTube.com");
    expect(shared.matchSite("m.youtube.com", sites).domain).toBe("YouTube.com");
    expect(shared.matchSite("reddit.com", sites).domain).toBe("www.reddit.com");
  });

  it("does not match look-alike domains, and skips empty/null entries without throwing", () => {
    expect(shared.matchSite("notyoutube.com", sites)).toBeUndefined();
    expect(shared.matchSite("youtube.com.evil.example", sites)).toBeUndefined();
    expect(shared.matchSite("", sites)).toBeUndefined();
    expect(shared.matchSite("anything.example", [{ domain: "" }])).toBeUndefined();
    expect(shared.matchSite("x.example", undefined)).toBeUndefined();
  });
});

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

// --- Global schedule (main's model): enforcement windows + blackouts, layered
// over the per-site rules above. Semantics ported from main's schedule.js. ---
// Issue #15: "unblocks at" times were computed by adding 24h multiples and
// took only the active window's end. Across a DST change a local day is 23
// or 25 hours, and back-to-back windows should report the end of the run.
describe("scheduleBlockedUntil() / scheduleBlackoutUntil() — adjacent windows and DST (issue #15)", () => {
  // First local day of the year whose UTC offset differs from the next day's,
  // i.e. the day before a DST transition. null when the host TZ has no DST
  // (CI runners are UTC) — those cases are skipped there, not faked.
  function dayBeforeDstChange(year) {
    for (let m = 0; m < 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const a = new Date(year, m, d, 12);
        const b = new Date(year, m, d + 1, 12);
        if (a.getMonth() !== m) break;
        if (a.getTimezoneOffset() !== b.getTimezoneOffset()) return a;
      }
    }
    return null;
  }
  const dstEve = dayBeforeDstChange(2026);
  const hasDst = dstEve !== null;
  const local = (base, dayOffset, h, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, m, 0, 0);

  it("adjacent block windows report the end of the whole run, not the first window's end", () => {
    const rules = [
      { type: "block", days: [WED], start: "09:00", end: "12:00" },
      { type: "block", days: [WED], start: "12:00", end: "17:00" }
    ];
    expect(shared.scheduleBlockedUntil(rules, at(10))).toBe(at(17).getTime());
    // Asked inside the second window it's the same answer.
    expect(shared.scheduleBlockedUntil(rules, at(14))).toBe(at(17).getTime());
    // A gap between windows ends the run.
    const gapped = [rules[0], { type: "block", days: [WED], start: "12:30", end: "17:00" }];
    expect(shared.scheduleBlockedUntil(gapped, at(10))).toBe(at(12).getTime());
  });

  it("a block window that ends where an allow-only stretch begins keeps walking to the next allow start", () => {
    const rules = [
      { type: "block", days: [WED], start: "09:00", end: "12:00" },
      { type: "allow", days: [WED], start: "18:00", end: "20:00" }
    ];
    // 09-12 blocked by the window, 12-18 blocked for being outside the allow window.
    expect(shared.scheduleBlockedUntil(rules, at(10))).toBe(at(18).getTime());
  });

  it("returns null (indefinite) when no allow window can ever match, instead of a bogus time", () => {
    expect(shared.scheduleBlockedUntil([{ type: "allow", days: [], start: "09:00", end: "10:00" }], at(12))).toBeNull();
  });

  it("adjacent blackouts report the end of the whole run", () => {
    const s = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [{ start: "12:00", end: "13:00" }, { start: "13:00", end: "15:00" }] };
    expect(shared.scheduleBlackoutUntil(s, at(12, 30))).toBe(at(15).getTime());
  });

  it.skipIf(!hasDst)("a block window entered before a DST change ends at the wall-clock time, not 24h-arithmetic off by an hour", () => {
    // Overnight block window 22:00-06:00 on the eve of the transition: the
    // end is 06:00 wall-clock the next morning, which is 23 or 25 hours later.
    const eveDow = dstEve.getDay();
    const rules = [{ type: "block", days: [eveDow], start: "22:00", end: "06:00" }];
    const askedAt = local(dstEve, 0, 23);
    const expected = local(dstEve, 1, 6).getTime();
    expect(shared.scheduleBlockedUntil(rules, askedAt)).toBe(expected);
    // Sanity: the old arithmetic would have been exactly an hour off.
    expect(Math.abs(askedAt.getTime() + 7 * 3600_000 - expected)).toBe(3600_000);
  });

  it.skipIf(!hasDst)("the next allow start across a DST change is resolved on the wall clock", () => {
    // Allow-only tomorrow 09:00; asked today at noon, where "today" is the eve.
    const tomorrowDow = (dstEve.getDay() + 1) % 7;
    const rules = [{ type: "allow", days: [tomorrowDow], start: "09:00", end: "10:00" }];
    expect(shared.scheduleBlockedUntil(rules, local(dstEve, 0, 12))).toBe(local(dstEve, 1, 9).getTime());
  });

  it.skipIf(!hasDst)("an overnight blackout across a DST change ends at the wall-clock time", () => {
    const s = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [{ start: "22:00", end: "06:00" }] };
    expect(shared.scheduleBlackoutUntil(s, local(dstEve, 0, 23))).toBe(local(dstEve, 1, 6).getTime());
  });
});

describe("shared.js global schedule", () => {
  const SAT = 3; // day offset from Wed Jan 14 -> Sat Jan 17 (getDay() 6)
  const THU = 1; // -> Thu Jan 15 (getDay() 4)
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const enabled = (over = {}) => ({ enabled: true, days: allDays, windows: [], blackouts: [], ...over });

  describe("scheduleStateAt()", () => {
    it("a disabled or absent schedule always enforces and never blacks out (the 24/7 default)", () => {
      expect(shared.scheduleStateAt(undefined, at(12))).toEqual({ enforcing: true, blackout: false });
      expect(shared.scheduleStateAt(null, at(12))).toEqual({ enforcing: true, blackout: false });
      expect(shared.scheduleStateAt(shared.SCHEDULE_DEFAULTS, at(12))).toEqual({ enforcing: true, blackout: false });
      // Even a blackout that would match right now is inert while disabled.
      const off = { enabled: false, days: [], windows: [], blackouts: [{ start: "00:00", end: "23:59" }] };
      expect(shared.scheduleStateAt(off, at(12))).toEqual({ enforcing: true, blackout: false });
    });

    it("enforces only on the listed days when there are no windows (all day on those days)", () => {
      const weekdays = enabled({ days: [1, 2, 3, 4, 5] });
      expect(shared.scheduleStateAt(weekdays, at(0, 0))).toEqual({ enforcing: true, blackout: false });
      expect(shared.scheduleStateAt(weekdays, at(23, 59))).toEqual({ enforcing: true, blackout: false });
      expect(shared.scheduleStateAt(weekdays, at(12, 0, SAT))).toEqual({ enforcing: false, blackout: false });
    });

    it("an empty days list means every day (main's fallback), not never", () => {
      expect(shared.scheduleStateAt(enabled({ days: [] }), at(12, 0, SAT)).enforcing).toBe(true);
    });

    it("with windows, enforces only inside one of them (start inclusive, end exclusive)", () => {
      const s = enabled({ windows: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "17:00" }] });
      expect(shared.scheduleStateAt(s, at(8, 59)).enforcing).toBe(false);
      expect(shared.scheduleStateAt(s, at(9, 0)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(11, 59)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(12, 0)).enforcing).toBe(false); // the gap
      expect(shared.scheduleStateAt(s, at(15, 0)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(17, 0)).enforcing).toBe(false);
      // A window on a non-enforce day doesn't enforce.
      expect(shared.scheduleStateAt({ ...s, days: [1, 2, 3, 4, 5] }, at(10, 0, SAT)).enforcing).toBe(false);
    });

    it("supports overnight windows (22:00-06:00) on both sides of midnight", () => {
      const s = enabled({ windows: [{ start: "22:00", end: "06:00" }] });
      expect(shared.scheduleStateAt(s, at(23, 0)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(2, 0)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(5, 59)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(6, 0)).enforcing).toBe(false);
      expect(shared.scheduleStateAt(s, at(12, 0)).enforcing).toBe(false);
    });

    it("start === end is an empty window, so such a schedule never enforces", () => {
      const s = enabled({ windows: [{ start: "09:00", end: "09:00" }] });
      expect(shared.scheduleStateAt(s, at(9, 0)).enforcing).toBe(false);
      expect(shared.scheduleStateAt(s, at(12, 0)).enforcing).toBe(false);
      // ...and an empty blackout never fires.
      const b = enabled({ blackouts: [{ start: "12:00", end: "12:00" }] });
      expect(shared.scheduleStateAt(b, at(12, 0)).blackout).toBe(false);
    });

    it("a blackout with days fires only on those days; without days (empty/absent) it fires every day", () => {
      const wedOnly = enabled({ blackouts: [{ start: "12:00", end: "13:00", days: [WED] }] });
      expect(shared.scheduleStateAt(wedOnly, at(12, 30))).toEqual({ enforcing: true, blackout: true });
      expect(shared.scheduleStateAt(wedOnly, at(13, 0)).blackout).toBe(false);
      expect(shared.scheduleStateAt(wedOnly, at(12, 30, THU)).blackout).toBe(false);

      const daily = enabled({ blackouts: [{ start: "12:00", end: "13:00", days: [] }] });
      expect(shared.scheduleStateAt(daily, at(12, 30, THU)).blackout).toBe(true);
      const noDays = enabled({ blackouts: [{ start: "12:00", end: "13:00" }] });
      expect(shared.scheduleStateAt(noDays, at(12, 30, SAT)).blackout).toBe(true);
    });

    it("a blackout is independent of enforcement: it fires on a non-enforce day and outside windows", () => {
      const s = enabled({ days: [1, 2, 3, 4, 5], windows: [{ start: "09:00", end: "17:00" }], blackouts: [{ start: "20:00", end: "22:00" }] });
      expect(shared.scheduleStateAt(s, at(21, 0, SAT))).toEqual({ enforcing: false, blackout: true });
      expect(shared.scheduleStateAt(s, at(21, 0))).toEqual({ enforcing: false, blackout: true });
    });

    it("an overnight blackout (23:00-01:00) matches before and after midnight", () => {
      const s = enabled({ blackouts: [{ start: "23:00", end: "01:00" }] });
      expect(shared.scheduleStateAt(s, at(23, 30)).blackout).toBe(true);
      expect(shared.scheduleStateAt(s, at(0, 30)).blackout).toBe(true);
      expect(shared.scheduleStateAt(s, at(1, 0)).blackout).toBe(false);
    });

    it("tolerates malformed entries (null items, missing times) instead of throwing", () => {
      const s = enabled({ windows: [null, { start: "09:00" }], blackouts: [undefined, "junk", { end: "13:00" }] });
      // { start: "09:00" } with no end -> 09:00-00:00, an overnight window.
      expect(shared.scheduleStateAt(s, at(12)).enforcing).toBe(true);
      expect(shared.scheduleStateAt(s, at(8)).enforcing).toBe(false);
      // { end: "13:00" } with no start -> 00:00-13:00.
      expect(shared.scheduleStateAt(s, at(12)).blackout).toBe(true);
      expect(shared.scheduleStateAt(s, at(14)).blackout).toBe(false);
      expect(shared.scheduleStateAt({ enabled: true, days: "weekdays", windows: "x", blackouts: 5 }, at(12))).toEqual({ enforcing: true, blackout: false });
    });

    it("defaults to the current time when no date is given, and exposes day abbreviations", () => {
      expect(shared.scheduleStateAt(undefined)).toEqual({ enforcing: true, blackout: false });
      expect(shared.SCHED_DAY_ABBR).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
      expect(shared.SCHEDULE_DEFAULTS).toEqual({ enabled: false, days: allDays, windows: [], blackouts: [] });
    });
  });

  describe("scheduleBlackoutUntil()", () => {
    it("is null when disabled or when no blackout is active right now", () => {
      expect(shared.scheduleBlackoutUntil(undefined, at(12))).toBeNull();
      const s = enabled({ blackouts: [{ start: "12:00", end: "13:00" }] });
      expect(shared.scheduleBlackoutUntil({ ...s, enabled: false }, at(12, 30))).toBeNull();
      expect(shared.scheduleBlackoutUntil(s, at(13, 0))).toBeNull();
      expect(shared.scheduleBlackoutUntil(enabled({ blackouts: [{ start: "12:00", end: "13:00", days: [THU] }] }), at(12, 30))).toBeNull();
    });

    it("for a same-day blackout, returns its end today", () => {
      const s = enabled({ blackouts: [{ start: "12:00", end: "13:00" }] });
      expect(shared.scheduleBlackoutUntil(s, at(12, 30))).toBe(at(13).getTime());
    });

    it("for an overnight blackout, the end is tomorrow before midnight and today after it", () => {
      const s = enabled({ blackouts: [{ start: "22:00", end: "02:00" }] });
      expect(shared.scheduleBlackoutUntil(s, at(23, 0))).toBe(at(2, 0, 1).getTime());
      expect(shared.scheduleBlackoutUntil(s, at(1, 0))).toBe(at(2, 0).getTime());
    });

    it("with overlapping blackouts, reports the latest end", () => {
      const s = enabled({ blackouts: [{ start: "12:00", end: "13:00" }, { start: "12:30", end: "15:00" }] });
      expect(shared.scheduleBlackoutUntil(s, at(12, 45))).toBe(at(15).getTime());
    });
  });

  describe("evaluateSite() with the global schedule", () => {
    const site = { domain: "youtube.com", budgetSeconds: 600, lockoutSeconds: null, rules: [] };
    const fresh = () => ({ date: "2026-01-14", totalMs: 0, sites: {} });
    const noon = at(12).getTime();

    it("absent schedule: same result as before, with free:false", () => {
      expect(shared.evaluateSite(site, fresh(), 3_600_000, noon)).toEqual({
        locked: false, free: false, reason: null, until: null, remainingMs: 600_000, budgetMs: 600_000
      });
    });

    it("a blackout outranks a per-site allow window, an active cool-down and a spent budget: reason 'schedule' until it ends", () => {
      const schedule = enabled({ blackouts: [{ start: "09:00", end: "11:00" }] });
      const allowed = { ...site, rules: [{ type: "allow", days: [WED], start: "08:00", end: "20:00" }] };
      const usage = { date: "2026-01-14", totalMs: 3_600_000, sites: { "youtube.com": { totalMs: 600_000, lockedUntil: at(18).getTime() } } };
      const status = shared.evaluateSite(allowed, usage, 3_600_000, at(10).getTime(), schedule);
      expect(status).toEqual({ locked: true, free: false, reason: "schedule", until: at(11).getTime(), remainingMs: 0, budgetMs: 600_000 });
    });

    it("off-hours (outside the enforcement windows) the site is free with its full allowance, whatever its usage or cool-down", () => {
      const schedule = enabled({ windows: [{ start: "09:00", end: "17:00" }] });
      const usage = { date: "2026-01-14", totalMs: 700_000, sites: { "youtube.com": { totalMs: 600_000, lockedUntil: at(23).getTime() } } };
      expect(shared.evaluateSite(site, usage, 3_600_000, at(20).getTime(), schedule)).toEqual({
        locked: false, free: true, reason: null, until: null, remainingMs: 600_000, budgetMs: 600_000
      });
      // The allowance is the tighter of the site budget and the global cap.
      expect(shared.evaluateSite(site, usage, 300_000, at(20).getTime(), schedule).remainingMs).toBe(300_000);
      // ...and on a non-enforce day, all day.
      const weekdays = enabled({ days: [1, 2, 3, 4, 5] });
      expect(shared.evaluateSite(site, usage, 3_600_000, at(12, 0, SAT).getTime(), weekdays).free).toBe(true);
    });

    it("a per-site block window still locks the site off-hours (per-site rules outrank 'free')", () => {
      const schedule = enabled({ windows: [{ start: "09:00", end: "17:00" }] });
      const blocked = { ...site, rules: [{ type: "block", days: [WED], start: "19:00", end: "21:00" }] };
      const status = shared.evaluateSite(blocked, fresh(), 3_600_000, at(20).getTime(), schedule);
      expect(status.locked).toBe(true);
      expect(status.free).toBe(false);
      expect(status.reason).toBe("schedule");
      expect(status.until).toBe(at(21).getTime());
    });

    it("inside the enforcement window the usual budget/lockout/global order applies", () => {
      const schedule = enabled({ windows: [{ start: "09:00", end: "17:00" }] });
      const spent = { date: "2026-01-14", totalMs: 600_000, sites: { "youtube.com": { totalMs: 600_000 } } };
      const status = shared.evaluateSite(site, spent, 3_600_000, noon, schedule);
      expect(status.locked).toBe(true);
      expect(status.free).toBe(false);
      expect(status.reason).toBe("budget");
    });
  });

  describe("usageAccrues()", () => {
    const site = { domain: "youtube.com", budgetSeconds: 600, lockoutSeconds: null, rules: [] };

    it("charges the budget only while enforcing, not in a blackout, not off-hours, not in a per-site block window", () => {
      expect(shared.usageAccrues(site, at(12).getTime(), undefined)).toBe(true);
      const windows = enabled({ windows: [{ start: "09:00", end: "17:00" }] });
      expect(shared.usageAccrues(site, at(12).getTime(), windows)).toBe(true);
      expect(shared.usageAccrues(site, at(20).getTime(), windows)).toBe(false);
      const blackout = enabled({ blackouts: [{ start: "11:00", end: "13:00" }] });
      expect(shared.usageAccrues(site, at(12).getTime(), blackout)).toBe(false);
      const blocked = { ...site, rules: [{ type: "block", days: [WED], start: "09:00", end: "17:00" }] };
      expect(shared.usageAccrues(blocked, at(12).getTime(), undefined)).toBe(false);
      expect(shared.usageAccrues(blocked, at(18).getTime(), undefined)).toBe(true);
    });
  });
});
