import { vi } from "vitest";

// A minimal chrome.* mock, close enough to real behavior for these tests:
// - storage.local.get/set operate on an in-memory store and deep-clone on
//   read/write, matching chrome.storage's structured-clone semantics (this
//   matters for the race-condition test — real storage never hands out a
//   live reference callers could mutate).
export function createChromeMock(initialStorage = {}) {
  let store = clone(initialStorage);
  const listeners = {
    onInstalled: [],
    onStartup: [],
    onMessage: [],
    onChanged: [],
    onBeforeNavigate: [],
    onHistoryStateUpdated: [],
    onAlarm: []
  };

  const chrome = {
    storage: {
      local: {
        // Supports both the promise form and the callback form (theme.js
        // uses the latter), like the real API.
        get: vi.fn((keys, cb) => {
          const result = pick(store, keys);
          if (typeof cb === "function") cb(result);
          return Promise.resolve(result);
        }),
        set: vi.fn((obj) => {
          store = { ...store, ...clone(obj) };
          return Promise.resolve();
        })
      },
      onChanged: { addListener: vi.fn((fn) => listeners.onChanged.push(fn)) }
    },
    runtime: {
      onInstalled: { addListener: vi.fn((fn) => listeners.onInstalled.push(fn)) },
      onStartup: { addListener: vi.fn((fn) => listeners.onStartup.push(fn)) },
      onMessage: { addListener: vi.fn((fn) => listeners.onMessage.push(fn)) },
      sendMessage: vi.fn(() => Promise.resolve({})),
      getURL: vi.fn((path) => `chrome-extension://test-extension-id/${path}`)
    },
    tabs: {
      update: vi.fn(() => Promise.resolve())
    },
    webNavigation: {
      onBeforeNavigate: { addListener: vi.fn((fn) => listeners.onBeforeNavigate.push(fn)) },
      onHistoryStateUpdated: { addListener: vi.fn((fn) => listeners.onHistoryStateUpdated.push(fn)) }
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn((fn) => listeners.onAlarm.push(fn)) }
    }
  };

  return {
    chrome,
    listeners,
    getStore: () => clone(store),
    setStore: (obj) => {
      store = { ...store, ...clone(obj) };
    }
  };
}

function pick(obj, keys) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const result = {};
  for (const k of keyList) {
    if (obj[k] !== undefined) result[k] = obj[k];
  }
  return clone(result);
}

function clone(obj) {
  return obj === undefined ? obj : JSON.parse(JSON.stringify(obj));
}

// background.js/content.js/dashboard.js call shared.js's helpers as bare
// globals (importScripts / script-tag load order provides them in the
// browser). Stub every export so a newly added helper can't be silently
// missing in one test file.
export function stubSharedGlobals(shared) {
  for (const [name, value] of Object.entries(shared)) {
    if (name !== "default") vi.stubGlobal(name, value);
  }
}

// Flushes pending microtasks/macrotasks so async chains (including ones we
// don't hold a reference to, like fire-and-forget promises) get a chance to
// settle before we assert on side effects.
export async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Same idea as flush(), but using only microtasks (no timers) — needed under
// vi.useFakeTimers(), where setTimeout no longer advances on its own.
export async function microtasks(times = 4) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// A chrome.storage.local stand-in whose get()/set() calls don't resolve on
// their own — the test releases them one at a time, in whatever order it
// wants, to deterministically reproduce a specific interleaving of two
// concurrent read-modify-write calls instead of hoping real timing lines up.
export function createControllableStorage(initialStore = {}) {
  let store = clone(initialStore);
  const pendingGets = [];
  const pendingSets = [];

  const get = (keys) =>
    new Promise((resolve) => {
      pendingGets.push(() => resolve(pick(store, keys)));
    });

  const set = (obj) =>
    new Promise((resolve) => {
      pendingSets.push(() => {
        store = { ...store, ...clone(obj) };
        resolve();
      });
    });

  const releaseNext = (queue, label) => {
    const fn = queue.shift();
    if (!fn) throw new Error(`no pending ${label} to release`);
    fn();
  };

  return {
    get,
    set,
    releaseNextGet: () => releaseNext(pendingGets, "get"),
    releaseNextSet: () => releaseNext(pendingSets, "set"),
    pendingGetCount: () => pendingGets.length,
    pendingSetCount: () => pendingSets.length,
    getStore: () => clone(store)
  };
}
