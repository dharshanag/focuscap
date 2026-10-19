import { describe, expect, it } from "vitest";
import { createPillController, FALLBACK_MS, FLASH_MS } from "../companion/pill-controller.js";

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
  it("flash() shows the pill and hides it FLASH_MS after it is actually on screen", () => {
    const { pill, windows, timers } = harness();
    pill.warm();
    pill.rendered();
    pill.flash();
    expect(timers.filter((t) => !t.cleared && t.ms === FLASH_MS)).toHaveLength(0); // not visible yet: no countdown
    pill.rendered(); // repainted -> shown
    const hideT = timers.filter((t) => !t.cleared && t.ms === FLASH_MS);
    expect(hideT).toHaveLength(1);
    expect(windows[0].calls).toEqual(["refresh", "show"]);
    hideT[0].cleared = true;
    hideT[0].fn();
    expect(windows[0].calls).toEqual(["refresh", "show", "hide"]);
    expect(pill.state).toMatchObject({ wantVisible: false, pendingHide: false });
  });

  it("a second flash while the pill is up restarts the countdown instead of stacking timers", () => {
    const { pill, timers } = harness();
    pill.warm();
    pill.rendered();
    pill.flash();
    pill.rendered();
    pill.flash(); // e.g. a second site got blocked
    pill.rendered();
    expect(timers.filter((t) => !t.cleared && t.ms === FLASH_MS)).toHaveLength(1);
  });

  it("hide() during a flash cancels the countdown (unlock wins)", () => {
    const { pill, windows, timers } = harness();
    pill.warm();
    pill.rendered();
    pill.flash();
    pill.rendered();
    pill.hide();
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
    expect(windows[0].calls.at(-1)).toBe("hide");
  });

  it("the flash fallback still starts the countdown when the renderer never reports", () => {
    const { pill, timers } = harness();
    pill.warm();
    pill.rendered();
    pill.flash(2000);
    timers.filter((t) => !t.cleared && t.ms === FALLBACK_MS).forEach((t) => ((t.cleared = true), t.fn()));
    expect(timers.filter((t) => !t.cleared && t.ms === 2000)).toHaveLength(1);
  });
});

