// Show/hide logic for the companion's corner pill, kept free of Electron so
// it can be unit-tested (test/companion-pill-controller.test.js).
//
// The pill window is created once, hidden, and then only shown and hidden
// for the rest of the app's life. Building a fresh BrowserWindow and loading
// pill.html on every lock used to cost a cold renderer start: on a 2-vCPU
// Windows Server 2022 sandbox the first pill after ~47 idle minutes appeared
// 11.7 s after the lock (more than half of a 20 s cool-down), versus ~1 s
// once warm.
//
// A reused window still holds the PREVIOUS lock's text, so showing it is a
// two-step handshake: ask the renderer to refresh, and show only once it
// reports "rendered" (or after FALLBACK_MS, so a hung renderer can't keep
// the pill hidden). A hide that arrives during that wait wins.
const FALLBACK_MS = 750;

function createPillController({ createWindow, setTimer = setTimeout, clearTimer = clearTimeout, fallbackMs = FALLBACK_MS }) {
  let win = null;
  let ready = false; // the renderer has loaded and reported at least once
  let wantVisible = false;
  let fallback = null;

  function cancelFallback() {
    if (fallback !== null) {
      clearTimer(fallback);
      fallback = null;
    }
  }

  function alive() {
    return win && !(typeof win.isDestroyed === "function" && win.isDestroyed());
  }

  function ensureWindow() {
    if (alive()) return win;
    ready = false;
    win = createWindow();
    return win;
  }

  function reveal() {
    cancelFallback();
    if (wantVisible && alive()) win.showInactive();
  }

  return {
    // Pre-create the hidden window at startup so the first lock is warm too.
    warm() {
      ensureWindow();
    },

    show() {
      wantVisible = true;
      ensureWindow();
      if (ready) win.requestRefresh();
      // Not ready yet: the renderer refreshes on load and reports rendered.
      cancelFallback();
      fallback = setTimer(reveal, fallbackMs);
    },

    hide() {
      wantVisible = false;
      cancelFallback();
      if (alive()) win.hide();
    },

    // The renderer finished painting the current state.
    rendered() {
      ready = true;
      if (wantVisible) reveal();
    },

    // The window was closed or its renderer died: forget it, rebuild lazily.
    // `handle` is the object createWindow() returned; a late event from an
    // already-replaced window is ignored so it can't orphan the new one.
    windowGone(handle) {
      if (handle !== undefined && handle !== win) return;
      cancelFallback();
      win = null;
      ready = false;
      if (wantVisible) {
        ensureWindow();
        fallback = setTimer(reveal, fallbackMs);
      }
    },

    // For tests and diagnostics.
    get state() {
      return { hasWindow: Boolean(alive()), ready, wantVisible, pendingFallback: fallback !== null };
    }
  };
}

module.exports = { createPillController, FALLBACK_MS };
