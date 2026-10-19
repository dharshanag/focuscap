import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, createControllableStorage, flush, microtasks, stubSharedGlobals } from "./helpers/chrome-mock.js";

// background.js keeps top-level state (e.g. its `chrome` reference is
// resolved once at import time), so every test gets a fresh module instance
// wired to its own chrome mock.
// The stats fallback flush is a real setTimeout when a test isn't faking
// timers; `loaded` lets afterEach cancel it so an instance armed by one test
// can never fire into a later test's chrome mock.
const loaded = [];
async function loadBackground(initialStorage) {
  vi.resetModules();
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const bg = await import("../background.js");
  loaded.push(bg);
  return { bg, ...mock };
}
function cancelStatsTimers() {
  while (loaded.length) {
    const bg = loaded.pop();
    bg.cancelStatsFlushTimer();
    bg.cancelUnlockTimers();
  }
}

function localTodayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("background.js", () => {
  afterEach(() => {
    cancelStatsTimers();
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
    const todayKey = localTodayKey(fakeToday.getTime());

    const storage = createControllableStorage({
      focusSites: [{ domain: "youtube.com" }],
      budgetSeconds: 1800,
      // lastTickAt is tracked per site (usage.sites[domain]), not globally.
      usage: { date: todayKey, totalMs: 0, sites: { "youtube.com": { totalMs: 0, lastTickAt: baseNow } } }
    });
    stubSharedGlobals(await import("../shared.js"));
    vi.stubGlobal("chrome", {
      storage: { local: { get: storage.get, set: storage.set }, onChanged: { addListener: () => {} } },
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve({}),
        getURL: (p) => p
      },
      tabs: { update: () => Promise.resolve() },
      webNavigation: { onBeforeNavigate: { addListener: () => {} }, onHistoryStateUpdated: { addListener: () => {} } },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
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

  // Same race, other entry point: a navigation-time budget lock discovered by
  // guardNavigation() also does a read-modify-write of `usage` (to persist the
  // cool-down). It must queue behind an in-flight heartbeat, not read a stale
  // snapshot and then stomp the heartbeat's increment. Found while writing the
  // test cases for issue #4.
  it("guardNavigation() queues its usage write behind an in-flight heartbeat instead of clobbering it", async () => {
    const baseNow = 1_000_000;
    const todayKey = localTodayKey(baseNow);
    const storage = createControllableStorage({
      // 60s budget, 59s already used, 10-minute cool-down: the heartbeat below
      // takes it over the line.
      focusSites: [{ domain: "youtube.com", budgetSeconds: 60, lockoutSeconds: 600 }],
      budgetSeconds: 3600,
      usage: { date: todayKey, totalMs: 59_000, sites: { "youtube.com": { totalMs: 59_000, lastTickAt: baseNow } } }
    });
    stubSharedGlobals(await import("../shared.js"));
    const tabUpdates = [];
    vi.stubGlobal("chrome", {
      storage: { local: { get: storage.get, set: storage.set }, onChanged: { addListener: () => {} } },
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve({}),
        getURL: (p) => p
      },
      tabs: { update: (id, opts) => { tabUpdates.push([id, opts]); return Promise.resolve(); } },
      webNavigation: { onBeforeNavigate: { addListener: () => {} }, onHistoryStateUpdated: { addListener: () => {} } },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    });
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);
    const bg = await import("../background.js");

    // A heartbeat is mid-flight (its get() issued, nothing resolved yet)...
    const heartbeat = bg.handle({ type: "heartbeat", hostname: "youtube.com" });
    await microtasks();
    expect(storage.pendingGetCount()).toBe(1);
    // ...when a navigation to the same site arrives in another tab.
    const nav = bg.guardNavigation({ frameId: 0, tabId: 9, url: "https://youtube.com/" });
    await microtasks();
    // Serialized: the navigation guard has NOT issued its own read yet.
    expect(storage.pendingGetCount()).toBe(1);

    // Heartbeat completes 2s later: 59s + 2s = over budget -> cool-down starts.
    vi.setSystemTime(baseNow + 2000);
    storage.releaseNextGet();
    await microtasks();
    expect(storage.pendingSetCount()).toBe(1);
    storage.releaseNextSet();
    await microtasks();
    await heartbeat;
    expect(storage.getStore().usage.sites["youtube.com"].totalMs).toBe(61_000);

    // Only now does the guard read — and it sees the fresh record.
    expect(storage.pendingGetCount()).toBe(1);
    storage.releaseNextGet();
    await microtasks();
    // lockedUntil already matches what the heartbeat persisted, so the guard
    // has nothing to write to `usage`; it must not re-write a stale copy.
    while (storage.pendingSetCount()) { storage.releaseNextSet(); await microtasks(); }
    await nav;

    const { usage } = storage.getStore();
    expect(usage.sites["youtube.com"].totalMs).toBe(61_000); // heartbeat's increment survived
    expect(usage.sites["youtube.com"].lockedUntil).toBe(baseNow + 2000 + 600_000);
    expect(tabUpdates).toEqual([[9, { url: "time-is-up.html" }]]);
  });

  // --- Issue #3: redirectToBlock() isn't awaited in the onMessage handler ---
  // https://github.com/dharshanag/focuscap/issues/3
  it("a rejected redirectToBlock() should not escape as an unhandled rejection", async () => {
    const today = new Date();
    const todayKey = localTodayKey(today.getTime());

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

  // --- Native messaging bridge to the desktop companion app (native-host/, companion/) ---
  // Entirely optional: the extension must keep working with zero setup when
  // the native host isn't installed/registered.
  describe("notifyNativeHost()", () => {
    it("no-ops silently when chrome.runtime.connectNative doesn't exist (default, no host installed)", async () => {
      const { bg } = await loadBackground({});
      expect(() => bg.notifyNativeHost({ locked: true })).not.toThrow();
    });

    it("no-ops silently when connectNative throws (host manifest missing/invalid)", async () => {
      const { bg, chrome } = await loadBackground({});
      chrome.runtime.connectNative = () => {
        throw new Error("Specified native messaging host not found.");
      };
      expect(() => bg.notifyNativeHost({ locked: true })).not.toThrow();
    });

    it("forwards the patch to the native host port when connectNative succeeds", async () => {
      const { bg, chrome } = await loadBackground({});
      const posted = [];
      const port = {
        postMessage: (msg) => posted.push(msg),
        onDisconnect: { addListener: () => {} }
      };
      chrome.runtime.connectNative = () => port;

      bg.notifyNativeHost({ locked: true, remainingMs: 0 });
      bg.notifyNativeHost({ locked: false, remainingMs: 42 });

      expect(posted).toEqual([
        { locked: true, remainingMs: 0 },
        { locked: false, remainingMs: 42 }
      ]);
    });

    // Chrome logs "Unchecked runtime.lastError: Specified native messaging
    // host not found." at ERROR level for every disconnect whose listener
    // never reads chrome.runtime.lastError — one per notifyNativeHost() call
    // when the host isn't registered (11 per 30 s run in the e2e harness).
    it("reads chrome.runtime.lastError when the port disconnects, logs at most one debug line and reconnects on the next notify", async () => {
      const { bg, chrome } = await loadBackground({});
      const disconnectListeners = [];
      let connects = 0;
      chrome.runtime.connectNative = () => {
        connects += 1;
        return { postMessage: () => {}, onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) } };
      };
      let lastErrorReads = 0;
      Object.defineProperty(chrome.runtime, "lastError", {
        configurable: true,
        get() {
          lastErrorReads += 1;
          return { message: "Specified native messaging host not found." };
        }
      });
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      bg.notifyNativeHost({ locked: true });
      expect(connects).toBe(1);
      expect(disconnectListeners).toHaveLength(1);
      expect(lastErrorReads).toBe(0);

      disconnectListeners[0]();
      expect(lastErrorReads).toBe(1);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0][0]).toMatch(/Specified native messaging host not found/);

      // The port was dropped, so the next notify connects afresh; a second
      // disconnect still reads lastError but doesn't log again.
      bg.notifyNativeHost({ locked: false });
      expect(connects).toBe(2);
      expect(disconnectListeners).toHaveLength(2);
      disconnectListeners[1]();
      expect(lastErrorReads).toBe(2);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();

      debug.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    });
  });

  // --- Issue #12 phase 1 / #16: the host's replies carry a protocolVersion ---
  describe("native host protocol handshake", () => {
    function portWithReplies(chrome) {
      const replies = [];
      const port = {
        postMessage: () => {},
        onDisconnect: { addListener: () => {} },
        onMessage: { addListener: (fn) => replies.push(fn) }
      };
      chrome.runtime.connectNative = () => port;
      return { port, reply: (msg) => replies.forEach((fn) => fn(msg)) };
    }

    it("warns exactly once per connection when the host replies with a different protocolVersion", async () => {
      const { bg, chrome } = await loadBackground({});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { reply } = portWithReplies(chrome);
      bg.notifyNativeHost({ locked: false });
      expect(bg.NATIVE_PROTOCOL_VERSION).toBe(1);
      reply({ ok: true, version: "9.9.9", protocolVersion: 2 });
      reply({ ok: true, version: "9.9.9", protocolVersion: 2 });
      reply({ ok: false, error: "x", version: "9.9.9", protocolVersion: 2 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/protocolVersion 2/);
      expect(warn.mock.calls[0][0]).toMatch(/expected 1/);
      warn.mockRestore();
    });

    it("warns about a host too old to send a protocolVersion, and stays silent when it matches", async () => {
      const old = await loadBackground({});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      old.bg.notifyNativeHost({ locked: false });
      portWithReplies(old.chrome).reply({ ok: true });
      // The port above was created before connectNative was swapped, so
      // connect again on a fresh module to get the reply-capturing port.
      const fresh = await loadBackground({});
      const legacy = portWithReplies(fresh.chrome);
      fresh.bg.notifyNativeHost({ locked: false });
      legacy.reply({ ok: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/predates protocol versioning/);

      warn.mockClear();
      const ok = await loadBackground({});
      const matching = portWithReplies(ok.chrome);
      ok.bg.notifyNativeHost({ locked: false });
      matching.reply({ ok: true, version: "0.1.0", protocolVersion: 1 });
      matching.reply("not an object");
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("tolerates a port without onMessage (older mocks / stubs) and still posts", async () => {
      const { bg, chrome } = await loadBackground({});
      const posted = [];
      chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });
      bg.notifyNativeHost({ locked: true });
      expect(posted).toEqual([{ locked: true }]);
    });
  });

  // --- Per-site rules: budgets, cool-down lockouts, schedules, global cap ---
  describe("per-site rules", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Drive N one-second heartbeats for a hostname, with the fake clock
    // advancing 1s each time, returning the last response.
    async function beat(bg, hostname, seconds) {
      let res;
      for (let i = 0; i < seconds; i++) {
        vi.setSystemTime(Date.now() + 1000);
        res = await bg.handle({ type: "heartbeat", hostname });
      }
      return res;
    }

    function fixedClock(hour = 12) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, hour, 0, 0)); // Wed Jan 14 2026
    }

    it("normalizeSite() fills defaults for legacy { domain } entries (implicit migration)", async () => {
      const { bg } = await loadBackground({});
      expect(bg.normalizeSite({ domain: "youtube.com" })).toEqual({
        domain: "youtube.com",
        budgetSeconds: 1800,
        lockoutSeconds: null,
        rules: []
      });
      expect(bg.normalizeSite({ domain: "x.com", budgetSeconds: 600, lockoutSeconds: 3600, rules: [{ type: "block", days: [1], start: "09:00", end: "17:00" }] }).budgetSeconds).toBe(600);
    });

    it("exhausting one site's budget locks only that site; another site keeps tracking", async () => {
      fixedClock();
      const { bg, getStore } = await loadBackground({
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 3 },
          { domain: "reddit.com", budgetSeconds: 60 }
        ],
        budgetSeconds: 3600 // global cap well above both
      });
      await bg.handle({ type: "entering", hostname: "youtube.com" });
      const yt = await beat(bg, "youtube.com", 3);
      expect(yt.overlay).toBe(true);
      expect(yt.reason).toBe("budget");

      await bg.handle({ type: "entering", hostname: "reddit.com" });
      const rd = await beat(bg, "reddit.com", 2);
      expect(rd.overlay).toBe(false);
      expect(rd.remainingMs).toBe(58_000);

      const { usage } = getStore();
      expect(usage.sites["youtube.com"].totalMs).toBe(3000);
      expect(usage.sites["reddit.com"].totalMs).toBe(2000);
      expect(usage.totalMs).toBe(5000); // global total across both
    });

    it("the global cap locks every site once total usage across sites hits it", async () => {
      fixedClock();
      const { bg } = await loadBackground({
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 600 },
          { domain: "reddit.com", budgetSeconds: 600 }
        ],
        budgetSeconds: 4 // global cap: 4s total
      });
      await bg.handle({ type: "entering", hostname: "youtube.com" });
      await beat(bg, "youtube.com", 3);
      await bg.handle({ type: "entering", hostname: "reddit.com" });
      const rd = await beat(bg, "reddit.com", 1);
      expect(rd.overlay).toBe(true);
      expect(rd.reason).toBe("global");
      // Even a site that never got used is locked by the cap.
      const yt = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(yt.overlay).toBe(true);
      expect(yt.reason).toBe("global");
    });

    it("remainingMs reports the tighter of the site budget and the global cap", async () => {
      fixedClock();
      const { bg } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
        budgetSeconds: 10
      });
      const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(res.remainingMs).toBe(10_000);
      expect(res.budgetMs).toBe(10_000);
    });

    it("a cool-down lockout expires and hands the site a fresh allowance instead of re-locking", async () => {
      fixedClock();
      const { bg, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 2, lockoutSeconds: 60 }],
        budgetSeconds: 3600
      });
      await bg.handle({ type: "entering", hostname: "youtube.com" });
      const locked = await beat(bg, "youtube.com", 2);
      expect(locked.overlay).toBe(true);
      expect(locked.reason).toBe("budget");
      expect(locked.until).toBe(Date.now() + 60_000);
      expect(getStore().usage.sites["youtube.com"].lockedUntil).toBe(locked.until);

      // 30s later: still in the cool-down.
      vi.setSystemTime(Date.now() + 30_000);
      const still = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(still.overlay).toBe(true);
      expect(still.reason).toBe("lockout");

      // Past the cool-down: usable again with the full budget back.
      vi.setSystemTime(Date.now() + 31_000);
      const again = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(again.overlay).toBe(false);
      expect(again.remainingMs).toBe(2000);
      expect(getStore().usage.sites["youtube.com"].totalMs).toBe(0);
    });

    it("without a lockout, exhausting the budget locks until local midnight", async () => {
      fixedClock(12);
      const { bg } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 1 }],
        budgetSeconds: 3600
      });
      await bg.handle({ type: "entering", hostname: "youtube.com" });
      const res = await beat(bg, "youtube.com", 1);
      expect(res.overlay).toBe(true);
      expect(res.until).toBe(new Date(2026, 0, 15, 0, 0, 0, 0).getTime());
    });

    it("an active block window locks the site regardless of budget and reports when it ends", async () => {
      fixedClock(10); // Wed 10:00
      const { bg, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 3600, rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(res.overlay).toBe(true);
      expect(res.reason).toBe("schedule");
      expect(res.until).toBe(new Date(2026, 0, 14, 17, 0, 0, 0).getTime());
      // Being schedule-blocked must not start a budget lockout.
      expect(getStore().usage.sites["youtube.com"].lockedUntil).toBeUndefined();
    });

    it("with allow-only rules, the site is blocked outside its allow window and free inside it", async () => {
      const rules = [{ type: "allow", days: [3], start: "18:00", end: "20:00" }];
      fixedClock(12);
      const { bg } = await loadBackground({
        focusSites: [{ domain: "youtube.com", rules }],
        budgetSeconds: 3600
      });
      const noon = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(noon.overlay).toBe(true);
      expect(noon.reason).toBe("schedule");
      expect(noon.until).toBe(new Date(2026, 0, 14, 18, 0, 0, 0).getTime());

      vi.setSystemTime(new Date(2026, 0, 14, 19, 0, 0));
      const evening = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(evening.overlay).toBe(false);
    });

    it("a new calendar day wipes per-site usage and lockouts", async () => {
      fixedClock(23);
      const { bg, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 1 }],
        budgetSeconds: 3600
      });
      await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect((await beat(bg, "youtube.com", 1)).overlay).toBe(true);

      vi.setSystemTime(new Date(2026, 0, 15, 0, 0, 1));
      const next = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(next.overlay).toBe(false);
      expect(getStore().usage.date).toBe(localTodayKey());
      expect(getStore().usage.totalMs).toBe(0);
    });

    it("an active block window outranks an exhausted global cap in the reported reason/until", async () => {
      // QA found no test pinned this precedence: both lock, but reason/until
      // are persisted (lastBlockedReason/lastBlockedUntil) and shown to the user.
      fixedClock(10);
      const { bg } = await loadBackground({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 1,
        usage: { date: localTodayKey(), totalMs: 5000, sites: {} } // global cap already blown
      });
      const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(res.overlay).toBe(true);
      expect(res.reason).toBe("schedule");
      expect(res.until).toBe(new Date(2026, 0, 14, 17, 0, 0, 0).getTime());
    });

    it("treats a zero or negative lockoutSeconds as 'until midnight' (no unbounded-budget loophole)", async () => {
      fixedClock(12);
      const { bg } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 1, lockoutSeconds: 0 }],
        budgetSeconds: 3600
      });
      expect(bg.normalizeSite({ domain: "x", lockoutSeconds: 0 }).lockoutSeconds).toBeNull();
      expect(bg.normalizeSite({ domain: "x", lockoutSeconds: -5 }).lockoutSeconds).toBeNull();

      await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect((await beat(bg, "youtube.com", 1)).overlay).toBe(true);
      // Ten minutes later it must STILL be locked, not handed a fresh budget.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const later = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(later.overlay).toBe(true);
      expect(later.until).toBe(new Date(2026, 0, 15, 0, 0, 0, 0).getTime());
    });

    it("a heartbeat arriving while schedule-blocked does not consume site or global budget", async () => {
      fixedClock(10);
      const { bg, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      await bg.handle({ type: "entering", hostname: "youtube.com" });
      await beat(bg, "youtube.com", 3);
      expect(getStore().usage.sites["youtube.com"].totalMs).toBe(0);
      expect(getStore().usage.totalMs).toBe(0);
    });

    it("tolerates a corrupted per-site usage entry instead of throwing (which would leave navigation unblocked)", async () => {
      fixedClock(12);
      const { bg } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60 }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 0, sites: { "youtube.com": null, "reddit.com": "garbage" } }
      });
      const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(res.track).toBe(true);
      expect(res.overlay).toBe(false);
    });

    it("guardNavigation() starts the cool-down when it discovers a budget lock (e.g. budget lowered below usage)", async () => {
      fixedClock(12);
      const { bg, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 1, lockoutSeconds: 120 }],
        budgetSeconds: 3600,
        // Usage already exceeds the (lowered) budget, but no lockedUntil was ever set.
        usage: { date: localTodayKey(), totalMs: 5000, sites: { "youtube.com": { totalMs: 5000 } } }
      });
      await bg.guardNavigation({ frameId: 0, tabId: 1, url: "https://youtube.com/" });
      expect(getStore().usage.sites["youtube.com"].lockedUntil).toBe(Date.now() + 120_000);
      expect(getStore().lastBlockedReason).toBe("budget");
    });

    it("isLocked()/guardNavigation() use the same per-site rules as heartbeats", async () => {
      fixedClock(10);
      const { bg, chrome, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      const status = await bg.isLocked("m.youtube.com");
      expect(status.locked).toBe(true);
      expect(status.reason).toBe("schedule");
      expect((await bg.isLocked("example.com")).locked).toBe(false);

      await bg.guardNavigation({ frameId: 0, tabId: 7, url: "https://m.youtube.com/watch?v=1" });
      expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: expect.stringContaining("time-is-up.html") });
      expect(getStore().lastBlocked).toBe("m.youtube.com");
      expect(getStore().lastBlockedReason).toBe("schedule");
      expect(getStore().lastBlockedUntil).toBe(new Date(2026, 0, 14, 17, 0, 0, 0).getTime());
    });

    it("each block tells the companion when it happened (blockedAt), so the pill flashes per block", async () => {
      fixedClock(10);
      const { bg, chrome } = await loadBackground({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      const posted = [];
      chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });
      await bg.guardNavigation({ frameId: 0, tabId: 7, url: "https://m.youtube.com/watch?v=1" });
      const blockMsgs = posted.filter((m) => m && m.lastBlocked === "m.youtube.com" && m.locked === true);
      expect(blockMsgs).toHaveLength(1);
      expect(blockMsgs[0].blockedAt).toBe(Date.now());
      // A second attempt is a new block with its own stamp.
      vi.setSystemTime(Date.now() + 5000);
      await bg.guardNavigation({ frameId: 0, tabId: 7, url: "https://m.youtube.com/" });
      const again = posted.filter((m) => m && m.lastBlocked === "m.youtube.com" && m.locked === true);
      expect(again).toHaveLength(2);
      expect(again[1].blockedAt).toBe(again[0].blockedAt + 5000);
    });
  });

  // --- Midnight unlock push: without this, the companion app's overlay can
  // stay stuck "locked" past the actual local-midnight reset if nothing is
  // actively heartbeating right at midnight. ---
  describe("daily reset alarm", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("nextLocalMidnightMs() returns the very next local midnight, not today's or one further out", async () => {
      const { bg } = await loadBackground({});
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 15, 15, 30, 0)); // Jan 15, 2026, 3:30pm local
      expect(bg.nextLocalMidnightMs()).toBe(new Date(2026, 0, 16, 0, 0, 0, 0).getTime());
    });

    it("scheduleMidnightAlarm() creates a recurring daily alarm timed for the next local midnight", async () => {
      const { bg, chrome } = await loadBackground({});
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 15, 9, 0, 0));

      bg.scheduleMidnightAlarm();

      expect(chrome.alarms.create).toHaveBeenCalledWith(bg.DAILY_RESET_ALARM, {
        when: new Date(2026, 0, 16, 0, 0, 0, 0).getTime(),
        periodInMinutes: 24 * 60
      });
    });

    it("schedules the alarm on both extension install and browser startup", async () => {
      const { bg, listeners, chrome } = await loadBackground({});
      void bg;

      await listeners.onInstalled[0]();
      expect(chrome.alarms.create).toHaveBeenCalledTimes(1);

      listeners.onStartup[0]();
      expect(chrome.alarms.create).toHaveBeenCalledTimes(2);
    });

    it("firing the alarm pushes an unlocked notification with today's budget/sites, regardless of activity", async () => {
      // budgetSeconds is deliberately NOT DEFAULTS.budgetSeconds (1800) — if
      // the handler ever regressed to using a hardcoded/default value
      // instead of a fresh storage read, this assertion would catch it
      // (it wouldn't if the fixture happened to equal the default).
      const { bg, chrome, listeners } = await loadBackground({
        focusSites: [{ domain: "youtube.com" }],
        budgetSeconds: 900
      });
      void bg;
      const posted = [];
      chrome.runtime.connectNative = () => ({
        postMessage: (msg) => posted.push(msg),
        onDisconnect: { addListener: () => {} }
      });

      await listeners.onAlarm[0]({ name: bg.DAILY_RESET_ALARM });

      // Sites are sent normalized (per-site defaults filled in) so the
      // companion sees the full rule set, plus a per-site lock snapshot.
      expect(posted).toEqual([
        {
          locked: false,
          remainingMs: 900_000,
          budgetMs: 900_000,
          focusSites: [{ domain: "youtube.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }],
          sites: { "youtube.com": { locked: false, reason: null, until: null, remainingMs: 900_000 } },
          lastBlocked: ""
        }
      ]);
    });

    it("heartbeats push a per-site snapshot (which sites are locked, why, until when) to the companion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const { bg, chrome } = await loadBackground({
        focusSites: [
          { domain: "youtube.com", budgetSeconds: 1, lockoutSeconds: 600 },
          { domain: "reddit.com", budgetSeconds: 600 }
        ],
        budgetSeconds: 3600
      });
      const posted = [];
      chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });

      await bg.handle({ type: "entering", hostname: "youtube.com" });
      vi.setSystemTime(Date.now() + 1000);
      await bg.handle({ type: "heartbeat", hostname: "youtube.com" });

      const last = posted[posted.length - 1];
      expect(last.locked).toBe(true);
      // The snapshot is taken after the cool-down is recorded, so the site
      // reports as an in-progress "lockout" (what the companion should show),
      // not the momentary "budget" trigger.
      expect(last.sites["youtube.com"]).toEqual({ locked: true, reason: "lockout", until: Date.now() + 600_000, remainingMs: 0 });
      expect(last.sites["reddit.com"]).toEqual({ locked: false, reason: null, until: null, remainingMs: 600_000 });
      // ...and an unlock alarm is armed for the cool-down's end.
      expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: Date.now() + 600_000 });
    });

    it("an unlock alarm persists the fresh allowance and tells the companion the site is free", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const lockedUntil = Date.now() + 600_000;
      const { bg, chrome, listeners, getStore } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60, lockoutSeconds: 600 }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000, lockedUntil } } }
      });
      const posted = [];
      chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });

      vi.setSystemTime(lockedUntil); // the alarm fires exactly at the cool-down end
      await listeners.onAlarm[0]({ name: bg.UNLOCK_ALARM_PREFIX + "youtube.com" });

      expect(posted[0].locked).toBe(false);
      expect(posted[0].sites["youtube.com"]).toEqual({ locked: false, reason: null, until: null, remainingMs: 60_000 });
      expect(posted[posted.length - 1]).toEqual({ lastBlocked: "" });
      // The reset is durable, not just recomputed on this read.
      expect(getStore().usage.sites["youtube.com"].totalMs).toBe(0);
      expect(getStore().usage.sites["youtube.com"].lockedUntil).toBeUndefined();
    });

    // --- Issue #17: a packed/store build clamps chrome.alarms to a 30 s
    // minimum, so a cool-down shorter than that would reach the companion
    // late. The alarm is still created at the real `until` (the durable
    // backstop; Chrome clamps it itself in a packed build), and a plain timer
    // at the real unlock time does the same push while the worker is alive.
    // https://github.com/dharshanag/focuscap/issues/17
    describe("sub-30 s cool-downs (#17)", () => {
      async function loadLockedFor(lockoutMs) {
        vi.useFakeTimers(); // Date AND setTimeout, so advancing the clock fires the timer
        vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
        const lockedUntil = Date.now() + lockoutMs;
        const loadedBg = await loadBackground({
          focusSites: [{ domain: "youtube.com", budgetSeconds: 60, lockoutSeconds: 600 }],
          budgetSeconds: 3600,
          usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000, lockedUntil } } }
        });
        const posted = [];
        loadedBg.chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });
        return { ...loadedBg, posted, lockedUntil };
      }

      it("ALARM_MIN_DELAY_MS is Chrome's 30-second packed-build floor", async () => {
        const { bg } = await loadBackground({});
        expect(bg.ALARM_MIN_DELAY_MS).toBe(30_000);
      });

      it("a cool-down ending in < 30 s arms the alarm at the real end and a timer that pushes the unlock on time", async () => {
        const { bg, chrome, posted, lockedUntil, getStore } = await loadLockedFor(20_000);
        const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
        expect(res.overlay).toBe(true);
        // The alarm is NOT floored to 30 s — unpacked builds honour it, and a
        // packed build clamps it by itself.
        expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: lockedUntil });
        const before = posted.length;

        await vi.advanceTimersByTimeAsync(19_999);
        expect(posted.length).toBe(before); // nothing early

        await vi.advanceTimersByTimeAsync(1);
        await microtasks();
        expect(Date.now()).toBe(lockedUntil);
        const snap = posted[before];
        expect(snap.locked).toBe(false);
        expect(snap.sites["youtube.com"]).toEqual({ locked: false, reason: null, until: null, remainingMs: 60_000 });
        expect(posted[posted.length - 1]).toEqual({ lastBlocked: "" });
        // Same durable reset as the alarm path.
        expect(getStore().usage.sites["youtube.com"].totalMs).toBe(0);
        expect(getStore().usage.sites["youtube.com"].lockedUntil).toBeUndefined();
      });

      it("a cool-down ending in >= 30 s arms only the alarm (no timer)", async () => {
        const { bg, chrome, posted, lockedUntil } = await loadLockedFor(30_000);
        await bg.handle({ type: "entering", hostname: "youtube.com" });
        expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: lockedUntil });
        const before = posted.length;

        await vi.advanceTimersByTimeAsync(60_000);
        await microtasks();
        // Only the (real, clamped-or-not) alarm can report this one.
        expect(posted.length).toBe(before);
      });

      it("re-arming the same domain replaces the pending timer, so the unlock is pushed once", async () => {
        const { bg, posted, lockedUntil } = await loadLockedFor(20_000);
        await bg.handle({ type: "entering", hostname: "youtube.com" });
        await vi.advanceTimersByTimeAsync(5_000);
        await bg.handle({ type: "entering", hostname: "youtube.com" }); // same lock, armed again
        const before = posted.length;

        await vi.advanceTimersByTimeAsync(lockedUntil - Date.now());
        await microtasks();
        // Exactly one snapshot + one lastBlocked clear — not two of each.
        expect(posted.slice(before)).toEqual([expect.objectContaining({ locked: false }), { lastBlocked: "" }]);
      });

      it("when the unlock alarm fires first, the pending timer is cancelled", async () => {
        const { bg, listeners, posted, lockedUntil } = await loadLockedFor(20_000);
        await bg.handle({ type: "entering", hostname: "youtube.com" });
        const before = posted.length;

        vi.setSystemTime(lockedUntil); // Date only — the fake timer is still pending
        await listeners.onAlarm[0]({ name: bg.UNLOCK_ALARM_PREFIX + "youtube.com" });
        expect(posted.slice(before)).toEqual([expect.objectContaining({ locked: false }), { lastBlocked: "" }]);
        const afterAlarm = posted.length;

        await vi.advanceTimersByTimeAsync(60_000);
        await microtasks();
        expect(posted.length).toBe(afterAlarm);
      });
    });

    it("does not arm an unlock alarm for a lock whose end is unknown or already past", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 12, 0, 0));
      const { bg, chrome } = await loadBackground({
        // Allow-only rule whose days never match -> blocked with until: null
        focusSites: [{ domain: "youtube.com", rules: [{ type: "allow", days: [], start: "09:00", end: "10:00" }] }],
        budgetSeconds: 3600
      });
      const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
      expect(res.overlay).toBe(true);
      expect(res.until).toBeNull();
      const unlockCalls = chrome.alarms.create.mock.calls.filter(([name]) => String(name).startsWith("unlock:"));
      expect(unlockCalls).toHaveLength(0);
    });

    it("an unlock alarm for a site still locked for another reason keeps lastBlocked and re-arms the later unlock", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00, inside a 09-17 block window
      const lockedUntil = Date.now() + 60_000; // cool-down ends at 10:01, but the schedule runs to 17:00
      const { bg, chrome, listeners } = await loadBackground({
        focusSites: [{ domain: "youtube.com", budgetSeconds: 60, lockoutSeconds: 600, rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600,
        usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000, lockedUntil } } }
      });
      const posted = [];
      chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });

      vi.setSystemTime(lockedUntil);
      await listeners.onAlarm[0]({ name: bg.UNLOCK_ALARM_PREFIX + "youtube.com" });

      const windowEnd = new Date(2026, 0, 14, 17, 0, 0, 0).getTime();
      expect(posted[0].sites["youtube.com"]).toEqual({ locked: true, reason: "schedule", until: windowEnd, remainingMs: 60_000 });
      // Still locked -> lastBlocked must NOT be cleared...
      expect(posted.some((m) => m.lastBlocked === "")).toBe(false);
      // ...and the companion is told about the later unlock.
      expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: windowEnd });
    });

    it("guardNavigation() arms an unlock alarm and pushes the snapshot (no heartbeat will follow a nav-time block)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 14, 10, 0, 0)); // Wed 10:00
      const { bg, chrome } = await loadBackground({
        focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "09:00", end: "17:00" }] }],
        budgetSeconds: 3600
      });
      const posted = [];
      chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });

      await bg.guardNavigation({ frameId: 0, tabId: 1, url: "https://youtube.com/" });

      const windowEnd = new Date(2026, 0, 14, 17, 0, 0, 0).getTime();
      expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: windowEnd });
      expect(posted[0].sites["youtube.com"]).toEqual({ locked: true, reason: "schedule", until: windowEnd, remainingMs: 1_800_000 });
    });

    it("ignores alarms with a different name (doesn't touch storage or the native host)", async () => {
      const { bg, chrome, listeners } = await loadBackground({});
      void bg;
      chrome.runtime.connectNative = () => {
        throw new Error("should not be called for an unrelated alarm");
      };

      await expect(listeners.onAlarm[0]({ name: "some-other-alarm" })).resolves.toBeUndefined();
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
    });
  });
});

// --- Per-domain daily stats: every page's engaged time, written throttled ---
describe("background.js per-domain stats", () => {
  afterEach(() => {
    cancelStatsTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function fixedClock(date = new Date(2026, 9, 16, 12, 0, 0)) {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  }

  // Drive N one-second heartbeats, advancing the fake clock 1s each time.
  async function beat(bg, hostname, seconds) {
    let res;
    for (let i = 0; i < seconds; i++) {
      vi.setSystemTime(Date.now() + 1000);
      res = await bg.handle({ type: "heartbeat", hostname });
    }
    return res;
  }

  const statsWrites = (chrome) => chrome.storage.local.set.mock.calls.filter(([obj]) => obj && obj.stats);

  it("an untracked page accrues stats per domain and never touches usage", async () => {
    fixedClock();
    const { bg, chrome, getStore, setStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com" }],
      budgetSeconds: 1800
    });
    const enter = await bg.handle({ type: "entering", hostname: "docs.example.org" });
    // Every reply carries `free` (the global schedule's off-hours flag); an
    // untracked page is never "free" — it's simply not on the list.
    expect(enter).toEqual({ track: true, tracked: false, overlay: false, free: false, settings: { idleEnabled: true, idleSeconds: 45 } });

    const res = await beat(bg, "docs.example.org", 3);
    expect(res.track).toBe(true);
    expect(res.tracked).toBe(false);
    expect(res.overlay).toBe(false);
    // Heartbeat replies carry settings too, so an untracked page keeps up
    // with idle changes made while it's open (content.js only re-reads them
    // from replies).
    expect(res.settings).toEqual({ idleEnabled: true, idleSeconds: 45 });
    setStore({ settings: { idleEnabled: false, idleSeconds: 20 } });
    const later = await beat(bg, "docs.example.org", 1);
    expect(later.settings).toEqual({ idleEnabled: false, idleSeconds: 20 });
    await bg.handle({ type: "leaving", hostname: "docs.example.org" });

    const store = getStore();
    expect(store.stats[localTodayKey()]).toEqual({ "docs.example.org": 4000 });
    expect(store.usage).toBeUndefined();
    const usageWrites = chrome.storage.local.set.mock.calls.filter(([obj]) => obj && "usage" in obj);
    expect(usageWrites).toHaveLength(0);
  });

  it("a tracked site accrues stats AND usage, and the reply says tracked:true", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 1800
    });
    const enter = await bg.handle({ type: "entering", hostname: "www.youtube.com" });
    expect(enter.track).toBe(true);
    expect(enter.tracked).toBe(true);
    expect(enter.settings).toEqual({ idleEnabled: true, idleSeconds: 45 });
    await beat(bg, "www.youtube.com", 2);
    await bg.handle({ type: "leaving", hostname: "www.youtube.com" });

    const store = getStore();
    expect(store.stats[localTodayKey()]).toEqual({ "youtube.com": 2000 });
    expect(store.usage.sites["youtube.com"].totalMs).toBe(2000);
    expect(store.usage.totalMs).toBe(2000);
  });

  it("strips a leading www. and lowercases the stats key; subdomains stay distinct", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({});
    for (const host of ["www.Example.com", "example.com", "m.example.com"]) {
      await bg.handle({ type: "entering", hostname: host });
    }
    await beat(bg, "www.Example.com", 1);
    await beat(bg, "example.com", 1);
    await beat(bg, "m.example.com", 1);
    await bg.handle({ type: "leaving", hostname: "example.com" });

    const day = getStore().stats[localTodayKey()];
    // www.Example.com and example.com share one clock, so their beats are
    // credited to one key; m.example.com is its own domain.
    expect(Object.keys(day).sort()).toEqual(["example.com", "m.example.com"]);
    expect(bg.statsDomain("WWW.Foo.Bar")).toBe("foo.bar");
    expect(bg.statsDomain("wwwfoo.bar")).toBe("wwwfoo.bar");
    expect(bg.statsDomain("")).toBe("");
    expect(bg.statsDomain(undefined)).toBe("");
  });

  it("a page with no usable hostname (file://, about:blank) is told track:false and writes nothing", async () => {
    fixedClock();
    const { bg, chrome } = await loadBackground({});
    expect(await bg.handle({ type: "entering", hostname: "" })).toEqual({ track: false });
    expect(await bg.handle({ type: "heartbeat", hostname: "" })).toEqual({ track: false });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("caps a single heartbeat's credit at 5s (worker-sleep gaps don't over-count)", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" });
    vi.setSystemTime(Date.now() + 60_000);
    await bg.handle({ type: "heartbeat", hostname: "example.com" });
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(5000);
  });

  it("a heartbeat with no prior tick for its domain (fresh worker) credits nothing", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({});
    await bg.handle({ type: "heartbeat", hostname: "example.com" });
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(getStore().stats).toBeUndefined();
    // ...but it did start the clock: the next beat counts normally.
    await beat(bg, "example.com", 1);
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(1000);
  });

  it("throttles: heartbeats within 5s of the last flush are held in memory; the next beat at >=5s writes them all", async () => {
    fixedClock();
    const { bg, chrome, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" });
    // First beat: nothing flushed yet this session -> written straight away.
    await beat(bg, "example.com", 1);
    expect(statsWrites(chrome)).toHaveLength(1);
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(1000);

    // Two more beats inside the 5s window: accumulated, not written.
    await beat(bg, "example.com", 2);
    expect(statsWrites(chrome)).toHaveLength(1);
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(1000);

    // 5s after the last flush: one write carrying everything since.
    await beat(bg, "example.com", 2); // now = flush + 4s
    expect(statsWrites(chrome)).toHaveLength(1);
    await beat(bg, "example.com", 1); // now = flush + 5s
    expect(statsWrites(chrome)).toHaveLength(2);
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(6000);
  });

  it("a flush inside a tracked heartbeat shares that heartbeat's single storage write", async () => {
    fixedClock();
    const { bg, chrome } = await loadBackground({ focusSites: [{ domain: "youtube.com" }] });
    await bg.handle({ type: "entering", hostname: "youtube.com" });
    chrome.storage.local.set.mockClear();
    await beat(bg, "youtube.com", 1);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(Object.keys(chrome.storage.local.set.mock.calls[0][0]).sort()).toEqual(["stats", "usage"]);
  });

  it("a tracked site's stats are throttled like everyone else's: usage every beat, stats once per 5s", async () => {
    fixedClock();
    const { bg, chrome, getStore } = await loadBackground({ focusSites: [{ domain: "youtube.com" }] });
    await bg.handle({ type: "entering", hostname: "youtube.com" });
    chrome.storage.local.set.mockClear();
    await beat(bg, "youtube.com", 5); // beat 1 flushes (first of the session); 2..5 are within 5s of it
    const writes = chrome.storage.local.set.mock.calls.map(([obj]) => obj);
    expect(writes).toHaveLength(5);
    expect(writes.every((w) => "usage" in w)).toBe(true);
    expect(writes.filter((w) => "stats" in w)).toHaveLength(1);
    expect(getStore().usage.sites["youtube.com"].totalMs).toBe(5000);
    expect(getStore().stats[localTodayKey()]["youtube.com"]).toBe(1000); // 4s still pending
    await beat(bg, "youtube.com", 1); // 5s after the flush -> everything since lands
    expect(statsWrites(chrome)).toHaveLength(2);
    expect(getStore().stats[localTodayKey()]["youtube.com"]).toBe(6000);
  });

  // The fallback timer's flush is a read-modify-write of `stats`, so it must
  // wait its turn in handleQueue: if it could run while a heartbeat's own
  // read-modify-write is in flight, the two could interleave on storage
  // (the Issue #1 class of bug). Controllable storage makes the interleaving
  // deterministic: the timer fires while a heartbeat's set() is still
  // pending, and its get() must not be issued until that set() has landed.
  it("the fallback flush timer waits behind an in-flight heartbeat (serialized through the handle queue)", async () => {
    const baseNow = new Date(2026, 9, 16, 12, 0, 0).getTime();
    const storage = createControllableStorage({ focusSites: [{ domain: "youtube.com" }] });
    stubSharedGlobals(await import("../shared.js"));
    vi.stubGlobal("chrome", {
      storage: { local: { get: storage.get, set: storage.set }, onChanged: { addListener: () => {} } },
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve({}),
        getURL: (p) => p
      },
      tabs: { update: () => Promise.resolve() },
      webNavigation: { onBeforeNavigate: { addListener: () => {} }, onHistoryStateUpdated: { addListener: () => {} } },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    });
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);
    const bg = await import("../background.js");
    loaded.push(bg);

    // Fully drive one message through controllable storage.
    async function run(msg, sets) {
      const p = bg.handle(msg);
      await microtasks();
      storage.releaseNextGet();
      await microtasks();
      for (let i = 0; i < sets; i++) {
        storage.releaseNextSet();
        await microtasks();
      }
      return p;
    }
    await run({ type: "entering", hostname: "youtube.com" }, 1);
    vi.setSystemTime(baseNow + 1000);
    await run({ type: "heartbeat", hostname: "youtube.com" }, 1); // stats flush #1 (1000) + usage
    vi.setSystemTime(baseNow + 2000);
    await run({ type: "heartbeat", hostname: "youtube.com" }, 1); // 1000 pending; timer armed for +6s
    expect(storage.getStore().stats[localTodayKey(baseNow)]["youtube.com"]).toBe(1000);

    // Heartbeat 3: its get() resolves, its set({ usage }) is left hanging.
    vi.setSystemTime(baseNow + 3000);
    const p3 = bg.handle({ type: "heartbeat", hostname: "youtube.com" });
    await microtasks();
    storage.releaseNextGet();
    await microtasks();
    expect(storage.pendingSetCount()).toBe(1);
    expect(storage.pendingGetCount()).toBe(0);

    // The fallback timer fires now. Serialized: its get() is NOT issued
    // while heartbeat 3's write is still in flight.
    await vi.advanceTimersByTimeAsync(4000);
    await microtasks();
    expect(storage.pendingGetCount()).toBe(0);
    expect(storage.pendingSetCount()).toBe(1);

    // Only once heartbeat 3's write lands does the timer's read begin.
    storage.releaseNextSet();
    await microtasks();
    await p3;
    expect(storage.pendingGetCount()).toBe(1);
    storage.releaseNextGet();
    await microtasks();
    expect(storage.pendingSetCount()).toBe(1);
    storage.releaseNextSet();
    await microtasks();
    expect(storage.pendingGetCount()).toBe(0);
    expect(storage.pendingSetCount()).toBe(0);
    expect(storage.getStore().stats[localTodayKey(baseNow)]["youtube.com"]).toBe(3000);
    expect(storage.getStore().usage.sites["youtube.com"].totalMs).toBe(3000);
  });

  it("a second tab 'entering' between another tab's heartbeats on the same domain doesn't drop the interval", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" }); // tab A
    await beat(bg, "example.com", 1); // A: +1s (1000)
    vi.setSystemTime(Date.now() + 500);
    await bg.handle({ type: "entering", hostname: "example.com" }); // tab B, mid-interval
    vi.setSystemTime(Date.now() + 500);
    await bg.handle({ type: "heartbeat", hostname: "example.com" }); // A: +2s
    await bg.handle({ type: "leaving", hostname: "example.com" });
    // Coverage stays continuous: 2s of wall-clock engagement -> 2000ms, not
    // 1500 (which is what resetting the clock on B's entering would give).
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(2000);
  });

  it("re-entering a domain after a long gap restarts its clock: the gap is never credited", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 1);
    await bg.handle({ type: "leaving", hostname: "example.com" });
    vi.setSystemTime(Date.now() + 60_000); // tab hidden for a minute
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 1);
    await bg.handle({ type: "leaving", hostname: "example.com" });
    // 1000 before + 1000 after; neither the gap nor a capped 5s of it.
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(2000);
    // Just past the live window (no other tab ticking) also restarts cleanly.
    vi.setSystemTime(Date.now() + bg.TICK_LIVE_MS + 1);
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 1);
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(3000);
  });

  it("'leaving' flushes whatever is pending immediately", async () => {
    fixedClock();
    const { bg, chrome, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 3); // 1 write (first beat) + 2s pending
    expect(statsWrites(chrome)).toHaveLength(1);
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(statsWrites(chrome)).toHaveLength(2);
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(3000);
    // Nothing pending -> a second leaving writes nothing.
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(statsWrites(chrome)).toHaveLength(2);
  });

  it("pending stats reach storage within 5s even with no further message (fallback timer)", async () => {
    fixedClock();
    const { bg, chrome, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 3);
    expect(statsWrites(chrome)).toHaveLength(1);
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(1000);

    await vi.advanceTimersByTimeAsync(5000);
    expect(statsWrites(chrome)).toHaveLength(2);
    expect(getStore().stats[localTodayKey()]["example.com"]).toBe(3000);
  });

  it("merges into existing stored stats rather than replacing other domains or days", async () => {
    fixedClock();
    const today = localTodayKey();
    const { bg, getStore } = await loadBackground({
      stats: { "2026-10-15": { "youtube.com": 90_000 }, [today]: { "example.com": 4000, "other.org": 1000 } }
    });
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 2);
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(getStore().stats).toEqual({
      "2026-10-15": { "youtube.com": 90_000 },
      [today]: { "example.com": 6000, "other.org": 1000 }
    });
  });

  it("a day rollover writes the pending deltas under the OLD day key before starting the new one", async () => {
    fixedClock(new Date(2026, 9, 16, 23, 59, 57));
    const { bg, getStore } = await loadBackground({});
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 2); // 23:59:58 (written), 23:59:59 (pending)
    vi.setSystemTime(new Date(2026, 9, 17, 0, 0, 1));
    // The 2s delta straddles midnight; by design it's credited wholly to the
    // new day rather than split (documented approximation, <= 5s per rollover).
    await bg.handle({ type: "heartbeat", hostname: "example.com" }); // 2s delta, new day
    await bg.handle({ type: "leaving", hostname: "example.com" });
    expect(getStore().stats).toEqual({
      "2026-10-16": { "example.com": 2000 },
      "2026-10-17": { "example.com": 2000 }
    });
  });

  it("every flush prunes to the 14 most recent day keys (zero-padded keys sort chronologically)", async () => {
    fixedClock();
    const { bg, getStore } = await loadBackground({
      stats: {
        "2026-10-15": { a: 1 }, "2026-10-02": { a: 1 }, "2026-10-10": { a: 1 }, "2026-10-01": { a: 1 },
        "2026-10-03": { a: 1 }, "2026-10-04": { a: 1 }, "2026-10-05": { a: 1 }, "2026-10-06": { a: 1 },
        "2026-10-07": { a: 1 }, "2026-10-08": { a: 1 }, "2026-10-09": { a: 1 }, "2026-10-11": { a: 1 },
        "2026-10-12": { a: 1 }, "2026-10-13": { a: 1 }, "2026-09-30": { a: 1 }, "2026-10-14": { a: 1 }
      }
    });
    await bg.handle({ type: "entering", hostname: "example.com" });
    await beat(bg, "example.com", 1);
    const keys = Object.keys(getStore().stats).sort();
    expect(keys).toHaveLength(bg.STATS_DAYS);
    expect(keys[0]).toBe("2026-10-03");
    expect(keys[keys.length - 1]).toBe("2026-10-16");
    expect(keys).not.toContain("2026-09-30");
    expect(keys).not.toContain("2026-10-01");
    expect(keys).not.toContain("2026-10-02");

    // pruneStats on its own: oldest first out, nothing dropped at exactly 14.
    const fourteen = Object.fromEntries(keys.map((k) => [k, {}]));
    expect(Object.keys(bg.pruneStats({ ...fourteen })).length).toBe(14);
    const fifteen = { ...fourteen, "2026-10-17": {} };
    expect(Object.keys(bg.pruneStats(fifteen)).sort()[0]).toBe("2026-10-04");
  });

  it("settings in the reply default idleEnabled=true for a stored record that predates the flag", async () => {
    fixedClock();
    const { bg } = await loadBackground({ settings: { idleSeconds: 20 } });
    const res = await bg.handle({ type: "entering", hostname: "example.com" });
    expect(res.settings).toEqual({ idleEnabled: true, idleSeconds: 20 });
    const off = await loadBackground({ settings: { idleEnabled: false, idleSeconds: 20 } });
    expect((await off.bg.handle({ type: "entering", hostname: "example.com" })).settings).toEqual({ idleEnabled: false, idleSeconds: 20 });
  });

  it("on first install, onInstalled sets welcomed:true and opens options.html exactly once", async () => {
    const { listeners, chrome, getStore } = await loadBackground({});
    await listeners.onInstalled[0]({ reason: "install" });
    expect(getStore().welcomed).toBe(true);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test-extension-id/options.html" });

    // A second "install" (e.g. a dev reload with storage intact) doesn't reopen it.
    await listeners.onInstalled[0]({ reason: "install" });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("onInstalled does not open the options page on update, when already welcomed, or with no details", async () => {
    const upd = await loadBackground({});
    await upd.listeners.onInstalled[0]({ reason: "update" });
    expect(upd.chrome.tabs.create).not.toHaveBeenCalled();
    expect(upd.getStore().welcomed).toBeUndefined();

    const seen = await loadBackground({ welcomed: true });
    await seen.listeners.onInstalled[0]({ reason: "install" });
    expect(seen.chrome.tabs.create).not.toHaveBeenCalled();

    const bare = await loadBackground({});
    await bare.listeners.onInstalled[0]();
    expect(bare.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("a rejected tabs.create on first install is swallowed (defaults are still seeded)", async () => {
    const { listeners, chrome, getStore } = await loadBackground({});
    // A plain function, NOT vi.fn: vitest's spy attaches its own handler to
    // the returned promise (for mock.settledResults), which marks the
    // rejection as handled and would make this test pass even without the
    // .catch in background.js.
    let createCalls = 0;
    chrome.tabs.create = () => {
      createCalls++;
      return Promise.reject(new Error("no window"));
    };
    const rejections = [];
    const onUnhandled = (r) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      await listeners.onInstalled[0]({ reason: "install" });
      await flush();
      expect(createCalls).toBe(1);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(getStore().welcomed).toBe(true);
    expect(getStore().schedule).toEqual({ enabled: false, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [] });
  });

  it("onInstalled seeds stats:{} and the idleEnabled default without clobbering existing keys", async () => {
    const { bg, listeners, getStore } = await loadBackground({ settings: { idleEnabled: false, idleSeconds: 30 } });
    void bg;
    await listeners.onInstalled[0]();
    expect(getStore().stats).toEqual({});
    expect(getStore().settings).toEqual({ idleEnabled: false, idleSeconds: 30 });
    expect(bg.DEFAULTS.settings).toEqual({ idleEnabled: true, idleSeconds: 45 });
  });
});

// --- Global schedule (main's enforcement windows + blackouts) layered over
// the per-site rules: a blackout outranks everything; off-hours nothing is
// charged to any budget (stats still accrue). ---
describe("background.js global schedule", () => {
  afterEach(() => {
    cancelStatsTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const WED = (h, m = 0, s = 0) => new Date(2026, 0, 14, h, m, s); // Wed Jan 14 2026
  function fixedClock(date) {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  }
  async function beat(bg, hostname, seconds) {
    let res;
    for (let i = 0; i < seconds; i++) {
      vi.setSystemTime(Date.now() + 1000);
      res = await bg.handle({ type: "heartbeat", hostname });
    }
    return res;
  }
  function captureHost(chrome) {
    const posted = [];
    chrome.runtime.connectNative = () => ({ postMessage: (m) => posted.push(m), onDisconnect: { addListener: () => {} } });
    return posted;
  }

  const blackoutNoon = { enabled: true, days: allDays, windows: [], blackouts: [{ start: "09:00", end: "11:00" }] };
  const officeHours = { enabled: true, days: allDays, windows: [{ start: "09:00", end: "17:00" }], blackouts: [] };

  it("a blackout outranks an allow window, a cool-down and a full budget: reason 'schedule' until the blackout ends, no cool-down started", async () => {
    fixedClock(WED(10));
    const { bg, chrome, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 3600, lockoutSeconds: 600, rules: [{ type: "allow", days: [3], start: "08:00", end: "20:00" }] }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 0, sites: { "youtube.com": { totalMs: 0, lockedUntil: WED(10, 30).getTime() } } },
      schedule: blackoutNoon
    });
    const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
    expect(res.tracked).toBe(true);
    expect(res.overlay).toBe(true);
    expect(res.free).toBe(false);
    expect(res.reason).toBe("schedule");
    expect(res.until).toBe(WED(11).getTime());
    // The in-progress cool-down is untouched (still the earlier time), and no
    // budget lockout was started by the blackout.
    expect(getStore().usage.sites["youtube.com"].lockedUntil).toBe(WED(10, 30).getTime());
    expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: WED(11).getTime() });
  });

  it("heartbeats during a blackout accrue stats but neither site nor global usage", async () => {
    fixedClock(WED(10));
    const { bg, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 3600 }],
      budgetSeconds: 3600,
      schedule: blackoutNoon
    });
    await bg.handle({ type: "entering", hostname: "youtube.com" });
    const res = await beat(bg, "youtube.com", 3);
    expect(res.overlay).toBe(true);
    expect(res.reason).toBe("schedule");
    await bg.handle({ type: "leaving", hostname: "youtube.com" });
    const store = getStore();
    expect(store.usage.sites["youtube.com"].totalMs).toBe(0);
    expect(store.usage.totalMs).toBe(0);
    expect(store.stats[localTodayKey()]).toEqual({ "youtube.com": 3000 });
  });

  it("the companion snapshot carries every site locked with reason 'schedule' during a blackout", async () => {
    fixedClock(WED(10));
    const { bg, chrome } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }, { domain: "reddit.com", budgetSeconds: 120 }],
      budgetSeconds: 3600,
      schedule: blackoutNoon
    });
    const posted = captureHost(chrome);
    await bg.handle({ type: "entering", hostname: "youtube.com" });
    const snap = posted[posted.length - 1];
    expect(snap.locked).toBe(true);
    expect(snap.sites["youtube.com"]).toEqual({ locked: true, reason: "schedule", until: WED(11).getTime(), remainingMs: 600_000 });
    expect(snap.sites["reddit.com"]).toEqual({ locked: true, reason: "schedule", until: WED(11).getTime(), remainingMs: 120_000 });

    // The alarm-driven snapshot (pushSnapshot) reads the schedule too.
    const alarmSnap = await bg.pushSnapshot();
    expect(alarmSnap.sites["reddit.com"].reason).toBe("schedule");
  });

  it("guardNavigation() redirects to the block page during a blackout, recording reason and until", async () => {
    fixedClock(WED(10));
    const { bg, chrome, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 3600 }],
      budgetSeconds: 3600,
      schedule: blackoutNoon
    });
    const status = await bg.isLocked("m.youtube.com");
    expect(status.locked).toBe(true);
    expect(status.reason).toBe("schedule");

    const posted = captureHost(chrome);
    await bg.guardNavigation({ frameId: 0, tabId: 5, url: "https://m.youtube.com/watch?v=1" });
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: expect.stringContaining("time-is-up.html") });
    expect(getStore().lastBlocked).toBe("m.youtube.com");
    expect(getStore().lastBlockedReason).toBe("schedule");
    expect(getStore().lastBlockedUntil).toBe(WED(11).getTime());
    expect(chrome.alarms.create).toHaveBeenCalledWith("unlock:youtube.com", { when: WED(11).getTime() });
    // No heartbeat follows a navigation-time block, so the per-site snapshot
    // guardNavigation() pushes to the companion must already reflect the
    // blackout — every tracked site locked with reason "schedule" until it
    // ends, not an all-unlocked map with fresh budgets.
    const snaps = posted.filter((m) => m && m.sites);
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps[snaps.length - 1].sites["youtube.com"]).toEqual({
      locked: true, reason: "schedule", until: WED(11).getTime(), remainingMs: 3_600_000
    });

    // Once the blackout is over the same navigation sails through.
    vi.setSystemTime(WED(11));
    chrome.tabs.update.mockClear();
    await bg.guardNavigation({ frameId: 0, tabId: 5, url: "https://m.youtube.com/watch?v=1" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("off-hours a tracked site is free (not locked, full allowance) and heartbeats charge nothing — stats still accrue", async () => {
    fixedClock(WED(20));
    const { bg, chrome, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } },
      schedule: officeHours
    });
    const posted = captureHost(chrome);
    const enter = await bg.handle({ type: "entering", hostname: "youtube.com" });
    expect(enter.tracked).toBe(true);
    expect(enter.overlay).toBe(false);
    expect(enter.free).toBe(true);
    expect(enter.remainingMs).toBe(600_000);
    const res = await beat(bg, "youtube.com", 4);
    expect(res.free).toBe(true);
    expect(res.overlay).toBe(false);
    await bg.handle({ type: "leaving", hostname: "youtube.com" });

    const store = getStore();
    expect(store.usage.sites["youtube.com"].totalMs).toBe(60_000);
    expect(store.usage.totalMs).toBe(60_000);
    expect(store.stats[localTodayKey()]).toEqual({ "youtube.com": 4000 });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    const snap = posted[posted.length - 1];
    expect(snap.locked).toBe(false);
    expect(snap.sites["youtube.com"]).toEqual({ locked: false, reason: null, until: null, remainingMs: 600_000 });
    // Off-hours never navigates to the block page either.
    await bg.guardNavigation({ frameId: 0, tabId: 1, url: "https://youtube.com/" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("off-hours a site whose budget is already spent is still free (no lock, no redirect)", async () => {
    fixedClock(WED(20));
    const { bg, chrome } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 60 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { "youtube.com": { totalMs: 60_000 } } },
      schedule: officeHours
    });
    const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
    expect(res.overlay).toBe(false);
    expect(res.free).toBe(true);
    await bg.guardNavigation({ frameId: 0, tabId: 1, url: "https://youtube.com/" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("once the enforcement window opens again, accrual resumes from that moment (off-hours seconds are never back-charged)", async () => {
    fixedClock(WED(8, 59, 56));
    const { bg, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      schedule: officeHours
    });
    await bg.handle({ type: "entering", hostname: "youtube.com" });
    const off = await beat(bg, "youtube.com", 3); // 08:59:57 .. 08:59:59
    expect(off.free).toBe(true);
    expect(getStore().usage.totalMs).toBe(0);

    const on = await beat(bg, "youtube.com", 2); // 09:00:00, 09:00:01
    expect(on.free).toBe(false);
    expect(on.overlay).toBe(false);
    expect(on.remainingMs).toBe(598_000);
    expect(getStore().usage.sites["youtube.com"].totalMs).toBe(2000);
    expect(getStore().usage.totalMs).toBe(2000);
  });

  it("a per-site block window still locks the site off-hours (per-site rules outrank 'free')", async () => {
    fixedClock(WED(20));
    const { bg } = await loadBackground({
      focusSites: [{ domain: "youtube.com", rules: [{ type: "block", days: [3], start: "19:00", end: "21:00" }] }],
      budgetSeconds: 3600,
      schedule: officeHours
    });
    const res = await bg.handle({ type: "entering", hostname: "youtube.com" });
    expect(res.overlay).toBe(true);
    expect(res.free).toBe(false);
    expect(res.reason).toBe("schedule");
    expect(res.until).toBe(WED(21).getTime());
  });

  it("a disabled schedule (the default) changes nothing: replies say free:false and budgets apply", async () => {
    fixedClock(WED(20));
    const { bg, getStore } = await loadBackground({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 600 }],
      budgetSeconds: 3600,
      schedule: { ...officeHours, enabled: false }
    });
    await bg.handle({ type: "entering", hostname: "youtube.com" });
    const res = await beat(bg, "youtube.com", 2);
    expect(res.free).toBe(false);
    expect(getStore().usage.totalMs).toBe(2000);
  });

  it("onInstalled seeds the disabled default schedule without clobbering a stored one", async () => {
    const fresh = await loadBackground({});
    await fresh.listeners.onInstalled[0]();
    expect(fresh.getStore().schedule).toEqual({ enabled: false, days: allDays, windows: [], blackouts: [] });

    const kept = await loadBackground({ schedule: officeHours });
    await kept.listeners.onInstalled[0]();
    expect(kept.getStore().schedule).toEqual(officeHours);
  });
});
