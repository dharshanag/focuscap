// Focus Cap companion — a menubar/tray app that shows an OS-level,
// always-on-top full-screen overlay once the daily budget is spent, so the
// lock isn't limited to the browser window (see README for why).
//
// State hand-off: the Chrome extension has no filesystem access, so it can't
// write here directly. native-host/host.js is the actual bridge (a Chrome
// Native Messaging host the extension talks to); it writes to the same
// state-store.js file this app polls. Until that host is registered (see
// native-host/README.md), use the tray menu's "Simulate lock/unlock" items
// to exercise the overlay.
const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("path");
const { readState, writeState } = require("../state-store");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const POLL_MS = 1000;

// A minimal 16x16 dot so the tray icon works with zero extra asset files.
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4AWNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwUAEAB0AAQEFsCVOAAAAAElFTkSuQmCC";

let tray = null;
let overlayWindow = null;
let pollTimer = null;
let wasLocked = false;

function showOverlay() {
  if (overlayWindow) {
    overlayWindow.show();
    return;
  }
  overlayWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    closable: false,
    resizable: false,
    kiosk: process.platform !== "darwin", // kiosk mode is flaky on macOS fullscreen transitions
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function hideOverlay() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

function poll() {
  const state = readState();
  if (state.locked && !wasLocked) showOverlay();
  if (!state.locked && wasLocked) hideOverlay();
  wasLocked = state.locked;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Focus Cap", enabled: false },
    { type: "separator" },
    {
      label: "Simulate lock (dev)",
      click: () => writeState({ locked: true, lastBlocked: "example.com", remainingMs: 0 })
    },
    {
      label: "Simulate unlock (dev)",
      click: () => writeState({ locked: false, lastBlocked: "" })
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]);
}

app.whenReady().then(() => {
  // Menubar-only: no dock icon, no taskbar entry outside the tray.
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip("Focus Cap");
  tray.setContextMenu(buildTrayMenu());

  ipcMain.handle("get-state", () => readState());

  poll();
  pollTimer = setInterval(poll, POLL_MS);
});

app.on("window-all-closed", (e) => {
  // Stay running in the tray even with no windows open.
  e.preventDefault?.();
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
});
