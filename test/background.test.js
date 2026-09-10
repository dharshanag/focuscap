import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, createControllableStorage, flush, microtasks } from "./helpers/chrome-mock.js";

// background.js keeps top-level state (e.g. its `chrome` reference is
// resolved once at import time), so every test gets a fresh module instance
// wired to its own chrome mock.
async function loadBackground(initialStorage) {
  vi.resetModules();
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  const shared = await import("../shared.js");
  vi.stubGlobal("todayKey", shared.todayKey);
  vi.stubGlobal("fmtClock", shared.fmtClock);
  const bg = await import("../background.js");
  return { bg, ...mock };
}

describe("background.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // --- Issue #1 / #5: storage read-modify-write race loses usage updates ---
  // https://github.com/dharshanag/focuscap/issues/1
  // https://github.com/dharshanag/focuscap/issues/4
  //
  // handle() does `const stored = await get(...)` then, later, `await set({usage})`.
  // Without serialization, if two heartbeats' get()s both resolve before
  // either set() lands, both compute their delta from the same stale base,
  // and whichever set() lands LAST wins outright — it doesn't merge with the
  // other write, it replaces it. handle() now routes every call through a
  // promise queue (handleQueue) so only one is ever mid-flight against
  // storage at a time: a second call's read cannot even begin until the
  // first call's write has landed. This test controls storage's
  // get()/set() resolution directly (real timing jitter between two
  // truly-simultaneous heartbeats is only a few ms, too small to assert on
  // reliably) to make that serialization deterministic and unmissable, and
  // proves no delta gets lost even when two heartbeats fire back to back.
  it("a heartbeat that lands last does not clobber a larger, more-elapsed delta from another in-flight heartbeat", async () => {
    const baseNow = 1_000_000;
    // Must match what background.js's own todayKey() computes once the fake
    // clock is set to baseNow — not the real current date.
    const fakeToday = new Date(baseNow);
    const todayKey = `${fakeToday.getFullYear()}-${fakeToday.getMonth() + 1}-${fakeToday.getDate()}`;

    const storage = createControllableStorage({
      focusSites: [{ domain: "youtube.com" }],
      budgetSeconds: 1800,
      usage: { date: todayKey, totalMs: 0, lastTickAt: baseNow }
    });
    const shared = await import("../shared.js");
    vi.stubGlobal("todayKey", shared.todayKey);
    vi.stubGlobal("fmtClock", shared.fmtClock);
    vi.stubGlobal("chrome", {
      storage: { local: { get: storage.get, set: storage.set }, onChanged: { addListener: () => {} } },
      runtime: {
        onInstalled: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve({}),
        getURL: (p) => p
      },
      tabs: { update: () => Promise.resolve() },
      webNavigation: { onBeforeNavigate: { addListener: () => {} }, onHistoryStateUpdated: { addListener: () => {} } }
    });
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);
    const bg = await import("../background.js");

    // Two tabs' heartbeats fire back to back, before either has a chance to
    // resolve.
    const p1 = bg.handle({ type: "heartbeat", hostname: "youtube.com" });
    const p2 = bg.handle({ type: "heartbeat", hostname: "youtube.com" });
    await microtasks();
    // Serialization in action: call 2's handler hasn't even reached its own
    // get() yet — it's queued behind call 1's entire read-modify-write.
    expect(storage.pendingGetCount()).toBe(1);

    // Call 1 resumes as if 1s of real time had passed -> a 1000ms delta.
    vi.setSystemTime(baseNow + 1000);
    storage.releaseNextGet();
    await microtasks();
    expect(storage.pendingSetCount()).toBe(1);
    storage.releaseNextSet();
    await microtasks();

    // Only now, after call 1's write has landed, does call 2's read begin —
    // so it reads the up-to-date (not stale) base.
    expect(storage.pendingGetCount()).toBe(1);
    // Call 2 resumes as if 3s of real time had passed since call 1 landed.
    vi.setSystemTime(baseNow + 3000);
    storage.releaseNextGet();
    await microtasks();
    storage.releaseNextSet();
    await microtasks();

    await Promise.all([p1, p2]);

    const { usage } = storage.getStore();
    // Correct behavior: call 1's 1000ms delta and call 2's 2000ms delta
    // (baseNow+3000 minus the baseNow+1000 lastTickAt call 1 left behind)
    // both land — nothing is lost to a clobbered write.
    // Buggy (unserialized) behavior would have call 2 read the same stale
    // snapshot as call 1 and let its write stomp call 1's entirely.
    expect(usage.totalMs).toBe(3000);
  });

  // --- Issue #3: redirectToBlock() isn't awaited in the onMessage handler ---
  // https://github.com/dharshanag/focuscap/issues/3
  it("a rejected redirectToBlock() should not escape as an unhandled rejection", async () => {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

    const { bg, chrome, listeners } = await loadBackground({
      focusSites: [{ domain: "youtube.com" }],
      budgetSeconds: 1800,
      // Already over budget, so handle() returns overlay: true and background.js
      // will try to redirect the tab that just reported in.
      usage: { date: todayKey, totalMs: 1_800_000, lastTickAt: Date.now() }
    });
    void bg; // module import registers the onMessage listener as a side effect

    // Simulate the tab having closed just before chrome.tabs.update runs.
    // Deliberately a plain function, not vi.fn(): vi.fn()'s own bookkeeping
    // attaches a handler to whatever promise it returns, which would mask
    // the very rejection we're trying to detect here.
    let updateCalls = 0;
    chrome.tabs.update = () => {
      updateCalls++;
      return Promise.reject(new Error("No tab with id: 1"));
    };

    const rejections = [];
    const onUnhandledRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const onMessageHandler = listeners.onMessage[0];
      const responses = [];
      const sendResponse = (res) => responses.push(res);
      onMessageHandler({ type: "heartbeat", hostname: "youtube.com" }, { tab: { id: 1 } }, sendResponse);

      await flush();

      expect(updateCalls).toBe(1);
      expect(responses).toHaveLength(1);
      // Guard the test's own premise: if overlay isn't true, redirectToBlock()
      // never runs and the assertions below would pass vacuously.
      expect(responses[0]).toEqual(expect.objectContaining({ overlay: true }));
      // redirectToBlock() now awaits chrome.tabs.update() and swallows its
      // rejection internally, so it never escapes as an unhandled rejection.
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("matchSite() matches bare, www-, and subdomain forms of a tracked site", async () => {
    const { bg } = await loadBackground({});
    const sites = [{ domain: "youtube.com" }];
    expect(bg.matchSite("youtube.com", sites)).toBeTruthy();
    expect(bg.matchSite("www.youtube.com", sites)).toBeTruthy();
    expect(bg.matchSite("m.youtube.com", sites)).toBeTruthy();
    expect(bg.matchSite("notyoutube.com", sites)).toBeUndefined();
  });
});
