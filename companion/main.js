// Focus Cap companion — a menubar/tray app that surfaces the extension's lock
// state at the OS level, so it's visible no matter what app is in front.
//
// It shows a small, NON-BLOCKING, always-on-top corner pill while a tracked
// site is locked. It deliberately does not cover the screen: the extension's
// promise is "distraction *sites* are locked", not "your computer is locked",
// and until the companion can detect a tracked site in the foreground
// (outside Chrome), it has no way to know whether blocking anything is even
// warranted. It informs; it never gets in the way of unrelated work.
//
// State hand-off: the Chrome extension has no filesystem access, so it can't
// write here directly. native-host/host.js is the actual bridge (a Chrome
// Native Messaging host the extension talks to); it writes to the same
// state-store.js file this app polls. Until that host is registered (see
// native-host/README.md), use the tray menu's "Simulate lock/unlock" items
// to exercise the pill.
const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen } = require("electron");
const path = require("path");
const { readState, writeState } = require("../state-store");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const POLL_MS = 1000;
const PILL_WIDTH = 360;
const PILL_HEIGHT = 56;
const PILL_MARGIN = 16;

// A minimal 16x16 dot so the tray icon works with zero extra asset files.
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4AWNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwUAEAB0AAQEFsCVOAAAAAElFTkSuQmCC";

let tray = null;
let pillWindow = null;
let pollTimer = null;
let wasLocked = false;

// Bottom-right corner of the primary display's work area (excludes the
// taskbar/dock), matching where the in-page badge sits in content.js.
function pillPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - PILL_WIDTH - PILL_MARGIN,
    y: workArea.y + workArea.height - PILL_HEIGHT - PILL_MARGIN
  };
}

function showPill() {
  if (pillWindow) {
    pillWindow.showInactive();
    return;
  }
  const { x, y } = pillPosition();
  pillWindow = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // never steals keyboard focus from whatever you're doing
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  pillWindow.setAlwaysOnTop(true, "floating");
  // Click-through: clicks land on whatever is underneath, so the pill can't
  // block interaction with the app behind it either.
  pillWindow.setIgnoreMouseEvents(true);
  pillWindow.loadFile(path.join(__dirname, "pill.html"));
  pillWindow.once("ready-to-show", () => pillWindow && pillWindow.showInactive());
  pillWindow.on("closed", () => {
    pillWindow = null;
  });
}

function hidePill() {
  if (pillWindow) {
    pillWindow.close();
    pillWindow = null;
  }
}

function poll() {
  const state = readState();
  if (state.locked && !wasLocked) showPill();
  if (!state.locked && wasLocked) hidePill();
  wasLocked = state.locked;
  if (tray) tray.setToolTip(state.locked ? `Focus Cap — ${state.lastBlocked || "a tracked site"} is locked` : "Focus Cap");
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
