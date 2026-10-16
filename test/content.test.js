import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

// content.js captures location.hostname at load; under jsdom that's
// "localhost", so the tracked site in these tests is "localhost".
async function loadContent(initialStorage) {
  vi.resetModules();
  document.body.innerHTML = "";
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const content = await import("../content.js");
  await flush();
  return { content, ...mock };
}

function localTodayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("content.js badge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows THIS site's remaining time (tighter of its own budget and the global cap), not the global total", async () => {
    const { content } = await loadContent({
      focusSites: [
        { domain: "localhost", budgetSeconds: 600 },
        { domain: "other.example", budgetSeconds: 60 }
      ],
      budgetSeconds: 3600,
      usage: {
        date: localTodayKey(),
        totalMs: 200_000, // global usage includes time on other sites
        sites: { localhost: { totalMs: 60_000 }, "other.example": { totalMs: 140_000 } }
      }
    });
    content.showBadge();
    await content.refreshBadge();
    // 600s budget - 60s used = 9:00, even though 200s of global usage exists
    expect(content.badgeText()).toBe("9:00");
  });

  it("caps the badge by the global cap when that's the tighter limit", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "localhost", budgetSeconds: 3600 }],
      budgetSeconds: 300,
      usage: { date: localTodayKey(), totalMs: 120_000, sites: { localhost: { totalMs: 120_000 } } }
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("3:00");
  });

  it("shows 0:00 while the site is locked (the redirect is already in flight)", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "localhost", budgetSeconds: 60 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { localhost: { totalMs: 60_000 } } }
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("0:00");
  });

  it("leaves the badge untouched when this page isn't a tracked site", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "other.example" }],
      budgetSeconds: 3600
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("–:––"); // initial placeholder
  });

  it("degrades safely on malformed storage (non-array focusSites, non-numeric budgetSeconds)", async () => {
    const bad = await loadContent({ focusSites: "not-an-array", budgetSeconds: 3600 });
    bad.content.showBadge();
    await expect(bad.content.refreshBadge()).resolves.toBeUndefined();
    expect(bad.content.badgeText()).toBe("–:––");

    const nan = await loadContent({
      focusSites: [{ domain: "localhost", budgetSeconds: 600 }],
      budgetSeconds: "lots",
      usage: { date: localTodayKey(), totalMs: 0, sites: {} }
    });
    nan.content.showBadge();
    await nan.content.refreshBadge();
    expect(nan.content.badgeText()).toBe("10:00"); // falls back to the default cap, never "NaN:NaN"
  });

  it("handles a legacy usage record (no sites map) and a legacy { domain } site", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "localhost" }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 0 }
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("30:00"); // SITE_DEFAULTS budget
  });
});

// --- Engagement policy (main's): visible tab required; input counts without
// focus; media needs focus; idleEnabled=false counts all visible time; a plain
// window blur never stops the loop. ---
describe("content.js engagement policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Fake only the clock + intervals: flush() still needs a real setTimeout.
  function fakeClock() {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 16, 12, 0, 0));
  }

  function setVisibility(state) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  }

  function setFocus(focused) {
    vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  }

  function addPlayingVideo() {
    const v = document.createElement("video");
    Object.defineProperty(v, "paused", { get: () => false });
    Object.defineProperty(v, "ended", { get: () => false });
    Object.defineProperty(v, "readyState", { get: () => 4 });
    document.body.appendChild(v);
    return v;
  }

  // Background reply for a page: track:true for everyone, `tracked` only for
  // sites on the list.
  const reply = (over = {}) => ({ track: true, tracked: false, overlay: false, settings: { idleEnabled: true, idleSeconds: 45 }, ...over });

  async function loadWithReply(res, storage = {}) {
    const loaded = await loadContent(storage);
    loaded.chrome.runtime.sendMessage.mockImplementation(() => Promise.resolve(res));
    // The import-time evaluate() already fired against the default {} reply;
    // re-run it now that the background "answers".
    loaded.content.evaluate();
    await flush();
    return loaded;
  }

  const sentTypes = (chrome) => chrome.runtime.sendMessage.mock.calls.map(([m]) => m.type);

  it("recent input counts even when the document does NOT have focus (extensions menu / popup open)", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(false);
    const { content } = await loadWithReply(reply());
    window.dispatchEvent(new Event("mousemove"));
    expect(content.isEngaged()).toBe(true);
    // ...until the idle window (45s) elapses with no further input.
    vi.setSystemTime(Date.now() + 45_000);
    expect(content.isEngaged()).toBe(false);
  });

  it("a hidden tab never counts, whatever else is going on", async () => {
    fakeClock();
    setVisibility("hidden");
    setFocus(true);
    const { content } = await loadWithReply(reply({ settings: { idleEnabled: false, idleSeconds: 45 } }));
    window.dispatchEvent(new Event("keydown"));
    addPlayingVideo();
    expect(content.isEngaged()).toBe(false);
  });

  it("idleEnabled=false counts all visible time, with no input for ages and no focus", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(false);
    const { content } = await loadWithReply(reply({ settings: { idleEnabled: false, idleSeconds: 45 } }));
    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000); // three idle hours later
    expect(content.isEngaged()).toBe(true);
  });

  it("a missing idleEnabled (settings saved before the flag) means idle-pausing is ON", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(true);
    const { content } = await loadWithReply(reply({ settings: { idleSeconds: 10 } }));
    window.dispatchEvent(new Event("scroll"));
    expect(content.isEngaged()).toBe(true);
    vi.setSystemTime(Date.now() + 10_000);
    expect(content.isEngaged()).toBe(false);
  });

  it("playing media counts only while the page actually has focus", async () => {
    fakeClock();
    setVisibility("visible");
    const { content } = await loadWithReply(reply());
    vi.setSystemTime(Date.now() + 60_000); // past the idle window, no input
    addPlayingVideo();
    setFocus(false);
    expect(content.isEngaged()).toBe(false); // alt-tabbed away: video doesn't drain time
    setFocus(true);
    expect(content.isEngaged()).toBe(true);
  });

  it("a window blur does not stop the loop or send 'leaving'; hiding the tab does", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(true);
    const { content, chrome } = await loadWithReply(reply({ tracked: true }), {
      focusSites: [{ domain: "localhost", budgetSeconds: 600 }],
      budgetSeconds: 3600
    });
    expect(content.isRunning()).toBe(true);
    expect(content.badgeText()).not.toBeNull();

    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(content.isRunning()).toBe(true);
    expect(content.badgeText()).not.toBeNull();
    expect(sentTypes(chrome)).not.toContain("leaving");

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(content.isRunning()).toBe(false);
    expect(content.badgeText()).toBeNull();
    expect(sentTypes(chrome)).toContain("leaving");
  });

  it("an untracked page still sends entering + heartbeats (for stats) but shows no badge", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(false);
    const { content, chrome } = await loadWithReply(reply({ tracked: false }));
    expect(content.isRunning()).toBe(true);
    expect(content.badgeText()).toBeNull();

    window.dispatchEvent(new Event("mousemove"));
    vi.advanceTimersByTime(1000);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();

    expect(sentTypes(chrome).filter((t) => t === "heartbeat")).toHaveLength(2);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "heartbeat", hostname: "localhost" });
    expect(content.badgeText()).toBeNull();
  });

  it("no heartbeat is sent while not engaged (idle past the window), and the loop stays attached", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(true);
    const { content, chrome } = await loadWithReply(reply());
    vi.setSystemTime(Date.now() + 60_000); // idle
    vi.advanceTimersByTime(3000);
    await flush();
    expect(sentTypes(chrome).filter((t) => t === "heartbeat")).toHaveLength(0);
    expect(content.isRunning()).toBe(true);
  });

  it("a tracked but locked page (overlay: the redirect is in flight) shows no badge", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(true);
    const { content } = await loadWithReply(reply({ tracked: true, overlay: true, reason: "budget" }), {
      focusSites: [{ domain: "localhost", budgetSeconds: 60 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { localhost: { totalMs: 60_000 } } }
    });
    expect(content.isRunning()).toBe(true);
    expect(content.badgeText()).toBeNull();
  });

  it("the badge appears on a heartbeat once the page becomes tracked, and clears once it locks", async () => {
    fakeClock();
    setVisibility("visible");
    setFocus(true);
    const { content, chrome } = await loadWithReply(reply({ tracked: false }), {
      focusSites: [{ domain: "localhost", budgetSeconds: 600 }],
      budgetSeconds: 3600
    });
    expect(content.badgeText()).toBeNull();

    chrome.runtime.sendMessage.mockImplementation(() => Promise.resolve(reply({ tracked: true })));
    window.dispatchEvent(new Event("mousemove"));
    vi.advanceTimersByTime(1000);
    await flush();
    expect(content.badgeText()).toBe("10:00");

    chrome.runtime.sendMessage.mockImplementation(() => Promise.resolve(reply({ tracked: true, overlay: true })));
    vi.advanceTimersByTime(1000);
    await flush();
    expect(content.badgeText()).toBeNull();
  });

  it("a track:false reply (no usable hostname) means no loop at all", async () => {
    fakeClock();
    setVisibility("visible");
    const { content, chrome } = await loadWithReply({ track: false });
    expect(content.isRunning()).toBe(false);
    vi.advanceTimersByTime(2000);
    await flush();
    expect(sentTypes(chrome).filter((t) => t === "heartbeat")).toHaveLength(0);
  });
});
