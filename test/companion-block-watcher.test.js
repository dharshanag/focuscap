import { describe, expect, it } from "vitest";
import { createBlockWatcher } from "../companion/block-watcher.js";

const locked = (blockedAt, extra = {}) => ({ locked: true, blockedAt, lastBlocked: "youtube.com", ...extra });
const free = { locked: false, blockedAt: 0 };

describe("companion/block-watcher.js", () => {
  it("flashes once for a new block, and not again while the same lock just persists", () => {
    const watch = createBlockWatcher(free);
    expect(watch(free)).toBe(null);
    expect(watch(locked(1000))).toBe("flash");
    // Heartbeats / unlock alarms keep rewriting the file during the cool-down.
    expect(watch(locked(1000, { updatedAt: 5 }))).toBe(null);
    expect(watch(locked(1000, { updatedAt: 6 }))).toBe(null);
  });

  it("flashes again when the user tries a locked site again or another site gets blocked", () => {
    const watch = createBlockWatcher(free);
    watch(locked(1000));
    expect(watch(locked(2500))).toBe("flash"); // re-attempt on the locked site
    expect(watch(locked(4000, { lastBlocked: "instagram.com" }))).toBe("flash"); // second site
  });

  it("does not replay a block that happened before the companion started", () => {
    const watch = createBlockWatcher(locked(1000));
    expect(watch(locked(1000))).toBe(null);
    expect(watch(locked(1500))).toBe("flash");
  });

  it("hides as soon as nothing is locked any more, once", () => {
    const watch = createBlockWatcher(free);
    watch(locked(1000));
    expect(watch({ ...free, blockedAt: 1000 })).toBe("hide");
    expect(watch({ ...free, blockedAt: 1000 })).toBe(null);
  });

  it("ignores an older blockedAt (out-of-order write) and malformed values", () => {
    const watch = createBlockWatcher(free);
    watch(locked(5000));
    expect(watch(locked(4000))).toBe(null);
    expect(watch(locked(NaN))).toBe(null);
    expect(watch(locked("9999"))).toBe(null);
  });

  it("falls back to the unlocked -> locked change for a writer that never sends blockedAt", () => {
    const watch = createBlockWatcher({ locked: false });
    expect(watch({ locked: true, lastBlocked: "youtube.com" })).toBe("flash");
    expect(watch({ locked: true, lastBlocked: "youtube.com" })).toBe(null);
    expect(watch({ locked: false })).toBe("hide");
  });

  it("tolerates a missing or empty state", () => {
    const watch = createBlockWatcher(undefined);
    expect(watch(null)).toBe(null);
    expect(watch({})).toBe(null);
  });
});
