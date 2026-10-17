import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, createControllableStorage, flush, microtasks, stubSharedGlobals } from "./helpers/chrome-mock.js";

// GitHub issue #16: an explicit schemaVersion in chrome.storage.local and a
// migration runner that upgrades stored data in place on install and on
// browser startup. Each test drives the real onInstalled / onStartup
// listener from the chrome mock, so a step that stops running (or runs
// against the wrong keys) turns these red rather than silently relying on
// the read-time normalizers.
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

function localToday(ms = Date.now()) {
  const d = new Date(ms);
  return {
    padded: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    unpadded: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  };
}

// A store that already carries every DEFAULTS key, so onInstalled's default
// seeding has nothing to write and any set() can only come from the runner.
function fullStore(extra) {
  return {
    focusSites: [],
    settings: { idleEnabled: true, idleSeconds: 45 },
    budgetSeconds: 1800,
    usage: { date: "", totalMs: 0, sites: {} },
    stats: {},
    schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], windows: [], blackouts: [] },
    ...extra
  };
}

describe("storage schema migration (issue #16)", () => {
  afterEach(() => {
    while (loaded.length) loaded.pop().cancelStatsFlushTimer();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("a fresh install is stamped with the current SCHEMA_VERSION", async () => {
    const { bg, listeners, getStore } = await loadBackground({});
    await listeners.onInstalled[0]({ reason: "install" });
    expect(bg.SCHEMA_VERSION).toBe(1);
    expect(getStore().schemaVersion).toBe(bg.SCHEMA_VERSION);
  });

  // TC2: a day written under the old unpadded key on a day the padded build
  // has ALSO written is merged, not dropped; today's usage keeps counting.
  it("TC2: pads legacy unpadded day keys, merging a padded and an unpadded bucket for the same day, and keeps today's usage", async () => {
    // A fixed date with single-digit month and day so the unpadded spelling
    // actually differs from the padded one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0)); // Mon Oct 5 2026
    const today = localToday();
    expect(today.unpadded).toBe("2026-10-5");
    const { bg, listeners, getStore } = await loadBackground(
      fullStore({
        stats: {
          "2026-9-5": { "a.com": 1000, "both.com": 10 },
          "2026-09-05": { "b.com": 2000, "both.com": 5 },
          "2026-9-30": { "c.com": 3 },
          "2026-10-01": { "d.com": 4 }
        },
        usage: { date: today.unpadded, totalMs: 5000, sites: { "example.com": { totalMs: 5000 } } }
      })
    );
    await listeners.onInstalled[0]({ reason: "update" });

    const store = getStore();
    expect(store.stats).toEqual({
      "2026-09-05": { "a.com": 1000, "b.com": 2000, "both.com": 15 },
      "2026-09-30": { "c.com": 3 },
      "2026-10-01": { "d.com": 4 }
    });
    expect(store.usage).toEqual({ date: today.padded, totalMs: 5000, sites: { "example.com": { totalMs: 5000 } } });
    expect(store.schemaVersion).toBe(1);
    // The padded date is what the normalizer compares against today, so the
    // 5 s already spent survive instead of being reset by the key change.
    expect(bg.normalizeUsage(store.usage, Date.now()).totalMs).toBe(5000);
  });

  it("TC2 (pure): mergePaddedStats() leaves an already-padded stats object alone and never mutates its input", async () => {
    const { bg } = await loadBackground({});
    const stats = { "2026-09-05": { "a.com": 1 } };
    expect(bg.mergePaddedStats(stats)).toBeNull();
    const legacy = { "2026-9-5": { "a.com": 1 }, "2026-09-05": { "a.com": 2 } };
    const snapshot = JSON.stringify(legacy);
    expect(bg.mergePaddedStats(legacy)).toEqual({ "2026-09-05": { "a.com": 3 } });
    expect(JSON.stringify(legacy)).toBe(snapshot);
    // Keys that aren't day keys at all are passed through untouched.
    expect(bg.mergePaddedStats({ junk: { "a.com": 1 }, "2026-1-2": {} })).toEqual({ junk: { "a.com": 1 }, "2026-01-02": {} });
  });

  // TC3: the stored entry itself gains the defaults, not just the in-memory
  // copy normalizeSite() hands enforcement.
  it("TC3: materialises legacy { domain }-only sites in storage and leaves fully-specified ones byte-identical", async () => {
    const full = { domain: "x.com", budgetSeconds: 600, lockoutSeconds: 3600, rules: [{ type: "block", days: [1], start: "09:00", end: "17:00", touchedAt: 5 }] };
    const { listeners, getStore } = await loadBackground(fullStore({ focusSites: [{ domain: "reddit.com" }, full] }));
    await listeners.onInstalled[0]({ reason: "update" });
    expect(getStore().focusSites).toEqual([{ domain: "reddit.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }, full]);
    expect(getStore().schemaVersion).toBe(1);
  });

  it("TC3: garbage focusSites entries are dropped by the migration, not persisted as empty-domain sites", async () => {
    // Read-time normalisation used to ignore these; baking them into storage
    // would render empty rows in the popup and Dashboard forever.
    const { listeners, getStore } = await loadBackground(fullStore({ focusSites: [null, "junk", { nope: 1 }, { domain: "" }, { domain: "a.com" }] }));
    await listeners.onInstalled[0]({ reason: "update" });
    expect(getStore().focusSites).toEqual([{ domain: "a.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }]);
  });

  // TC4: a run on a store that is already current performs NO write at all
  // (so no storage.onChanged event fires, and the data is byte-identical).
  it("TC4: a second run on an up-to-date store performs zero chrome.storage.local.set() calls", async () => {
    const { bg, chrome, listeners, getStore } = await loadBackground(
      fullStore({ stats: { "2026-9-5": { "a.com": 1 } }, focusSites: [{ domain: "reddit.com" }] })
    );
    await listeners.onInstalled[0]({ reason: "update" });
    const after = getStore();
    expect(after.schemaVersion).toBe(1);

    chrome.storage.local.set.mockClear();
    expect(await bg.migrateStorage()).toBe("current");
    await listeners.onInstalled[0]({ reason: "update" });
    listeners.onStartup[0]();
    await flush();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(getStore()).toEqual(after);
  });

  // TC5: data from a newer build is never rewritten or wiped; the read-time
  // normalizers still make enforcement work on whatever shape is there.
  it("TC5: a store stamped with a newer schemaVersion is left untouched, warned about, and still enforced via the read-time normalizers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seeded = fullStore({
      schemaVersion: 99,
      stats: { "2026-9-5": { "a.com": 1 } },
      focusSites: [{ domain: "reddit.com" }],
      usage: { date: localToday().unpadded, totalMs: 7, sites: {} }
    });
    const { bg, chrome, listeners, getStore } = await loadBackground(seeded);
    await listeners.onInstalled[0]({ reason: "update" });
    listeners.onStartup[0]();
    await flush();

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(getStore()).toEqual(seeded);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/schemaVersion 99/);
    expect(warn.mock.calls[0][0]).toMatch(/newer/);
    // Safety net: the legacy { domain } site is still matched and evaluated.
    const status = await bg.isLocked("www.reddit.com");
    expect(status.site).toEqual({ domain: "reddit.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] });
    expect(status.locked).toBe(false);
  });

  it("planMigration() reports a malformed schemaVersion as a pre-versioning store and never writes a bare version stamp for a current one", async () => {
    const { bg } = await loadBackground({});
    expect(bg.planMigration({ schemaVersion: "1" }).status).toBe("upgrade");
    expect(bg.planMigration({ schemaVersion: -3 }).status).toBe("upgrade");
    expect(bg.planMigration({}).patch).toEqual({ schemaVersion: 1 });
    expect(bg.planMigration({ schemaVersion: 1 })).toEqual({ status: "current", from: 1, patch: null });
    expect(bg.planMigration({ schemaVersion: 2 })).toEqual({ status: "newer", from: 2, patch: null });
    expect(bg.MIGRATIONS).toHaveLength(bg.SCHEMA_VERSION);
  });

  it("onStartup also runs the migration (an update applied while the browser was closed never fires onInstalled)", async () => {
    const { listeners, getStore } = await loadBackground(fullStore({ stats: { "2026-9-5": { "a.com": 1 } }, focusSites: [{ domain: "reddit.com" }] }));
    listeners.onStartup[0]();
    await flush();
    const store = getStore();
    expect(store.schemaVersion).toBe(1);
    expect(store.stats).toEqual({ "2026-09-05": { "a.com": 1 } });
    expect(store.focusSites[0].budgetSeconds).toBe(1800);
  });

  // The rewrite goes through the same queue as heartbeats: it must not read
  // a stale usage snapshot while a heartbeat is mid read-modify-write and
  // then stomp the heartbeat's increment with the padded copy.
  it("the migration's read-modify-write is serialized behind an in-flight heartbeat", async () => {
    const baseNow = new Date(2026, 9, 5, 12, 0, 0).getTime();
    const today = localToday(baseNow);
    const storage = createControllableStorage({
      focusSites: [{ domain: "youtube.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }],
      budgetSeconds: 1800,
      stats: {},
      usage: { date: today.unpadded, totalMs: 0, sites: { "youtube.com": { totalMs: 0, lastTickAt: baseNow } } }
    });
    stubSharedGlobals(await import("../shared.js"));
    const listeners = { onStartup: [] };
    vi.stubGlobal("chrome", {
      storage: { local: { get: storage.get, set: storage.set }, onChanged: { addListener: () => {} } },
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
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

    // normalizeUsage() sees the unpadded date as "not today" and starts a
    // fresh record — exactly the wipe the migration exists to prevent — so
    // the heartbeat credits from a zero base here; what matters is that its
    // write is not clobbered by the migration's padded copy of the OLD record.
    const beat = bg.handle({ type: "heartbeat", hostname: "youtube.com" });
    await microtasks();
    listeners.onStartup[0]();
    await microtasks();
    expect(storage.pendingGetCount()).toBe(1); // the migration's get() is still queued

    vi.setSystemTime(baseNow + 1000);
    storage.releaseNextGet();
    await microtasks();
    storage.releaseNextSet();
    await microtasks();
    await beat;
    // Only now does the migration read — and it sees the heartbeat's write.
    expect(storage.pendingGetCount()).toBe(1);
    storage.releaseNextGet();
    await microtasks();
    expect(storage.pendingSetCount()).toBe(1);
    storage.releaseNextSet();
    await microtasks();

    const { usage, schemaVersion } = storage.getStore();
    expect(schemaVersion).toBe(1);
    expect(usage.date).toBe(today.padded);
    expect(usage.sites["youtube.com"].lastTickAt).toBe(baseNow + 1000);
  });
});
