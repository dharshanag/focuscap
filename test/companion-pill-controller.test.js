import { describe, expect, it } from "vitest";
import { createPillController, FALLBACK_MS } from "../companion/pill-controller.js";

// A fake BrowserWindow handle (the shape main.js's createPillWindow() returns)
// that records every call, plus manual timers so the fallback is deterministic.
function harness() {
  const windows = [];
  const timers = [];
  const createWindow = () => {
    const w = { calls: [], destroyed: false };
    w.showInactive = () => w.calls.push("show");
    w.hide = () => w.calls.push("hide");
    w.requestRefresh = () => w.calls.push("refresh");
    w.isDestroyed = () => w.destroyed;
    windows.push(w);
    return w;
  };
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => {
    t.cleared = true;
  };
  const fireTimers = () => timers.filter((t) => !t.cleared).forEach((t) => ((t.cleared = true), t.fn()));
  const pill = createPillController({ createWindow, setTimer, clearTimer });
  return { pill, windows, timers, fireTimers };
}

describe("companion/pill-controller.js", () => {
  it("creates the window once at warm-up and reuses it for every lock (no cold renderer start per lock)", () => {
    const { pill, windows } = harness();
    pill.warm();
    pill.rendered(); // initial load painted
    for (let i = 0; i < 3; i++) {
      pill.show();
      pill.rendered();
      pill.hide();
    }
    expect(windows).toHaveLength(1);
    expect(windows[0].calls).toEqual(["refresh", "show", "hide", "refresh", "show", "hide", "refresh", "show", "hide"]);
  });

  it("hiding never closes or destroys the window", () => {
    const { pill, windows } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    pill.rendered();
    pill.hide();
    expect(windows[0].calls).not.toContain("close");
    expect(pill.state).toMatchObject({ hasWindow: true, wantVisible: false });
  });

  it("shows only after the renderer reports the refreshed state, so the previous lock's text never flashes", () => {
    const { pill, windows } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    expect(windows[0].calls).toEqual(["refresh"]); // asked to repaint, not yet shown
    pill.rendered();
    expect(windows[0].calls).toEqual(["refresh", "show"]);
  });

  it("a hide that arrives while waiting for the repaint wins: the pill is not shown afterwards", () => {
    const { pill, windows, fireTimers } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    pill.hide();
    pill.rendered(); // the late repaint report
    fireTimers(); // and the (cancelled) fallback
    expect(windows[0].calls).toEqual(["refresh", "hide"]);
  });

  it("falls back to showing after FALLBACK_MS if the renderer never reports (a hung renderer can't hide the pill)", () => {
    const { pill, windows, timers, fireTimers } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    expect(timers.at(-1).ms).toBe(FALLBACK_MS);
    fireTimers();
    expect(windows[0].calls).toEqual(["refresh", "show"]);
  });

  it("a lock before the first load completes shows once the initial render reports, without a refresh request", () => {
    const { pill, windows } = harness();
    pill.warm(); // still loading pill.html
    pill.show();
    expect(windows[0].calls).toEqual([]); // nothing to refresh yet; the load itself paints the current state
    pill.rendered();
    expect(windows[0].calls).toEqual(["show"]);
  });

  it("show() without warm() creates the window lazily", () => {
    const { pill, windows } = harness();
    pill.show();
    pill.rendered();
    expect(windows).toHaveLength(1);
    expect(windows[0].calls).toEqual(["show"]);
  });

  it("rebuilds the window after it is gone (renderer crash) and still shows it while locked", () => {
    const { pill, windows, fireTimers } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    pill.rendered();
    windows[0].destroyed = true;
    pill.windowGone(windows[0]);
    expect(windows).toHaveLength(2);
    pill.rendered(); // the replacement loaded
    expect(windows[1].calls).toEqual(["show"]);
    fireTimers();
    expect(windows[1].calls).toEqual(["show"]); // fallback was cancelled by the reveal
  });

  it("after the window is gone while unlocked, the next lock builds a fresh one lazily", () => {
    const { pill, windows } = harness();
    pill.warm();
    pill.rendered();
    windows[0].destroyed = true;
    pill.windowGone(windows[0]);
    expect(windows).toHaveLength(1); // not rebuilt while nothing needs showing
    pill.show();
    expect(windows).toHaveLength(2);
  });

  it("ignores a late 'gone' event from an already-replaced window, so it cannot orphan the new one", () => {
    const { pill, windows } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    const first = windows[0];
    first.destroyed = true;
    pill.windowGone(first); // rebuilds windows[1]
    pill.windowGone(first); // duplicate/late event for the old window
    expect(windows).toHaveLength(2);
    expect(pill.state.hasWindow).toBe(true);
    pill.rendered();
    expect(windows[1].calls).toEqual(["show"]);
  });

  it("repeated show() calls keep a single pending fallback", () => {
    const { pill, timers } = harness();
    pill.warm();
    pill.rendered();
    pill.show();
    pill.show();
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
  });
});
