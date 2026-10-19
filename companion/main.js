// Focus Cap companion — a menubar/tray app that surfaces the extension's lock
// state at the OS level, so it's visible no matter what app is in front.
//
// It flashes a small, NON-BLOCKING, always-on-top corner pill for a few
// seconds each time the user gets blocked (see block-watcher.js), rather than
// keeping it up for the whole lock. It deliberately does not cover the screen: the extension's
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
const { createPillController } = require("./pill-controller");
const { createBlockWatcher } = require("./block-watcher");

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
let pollTimer = null;
let quitting = false;

// Bottom-right corner of the primary display's work area (excludes the
// taskbar/dock), matching where the in-page badge sits in content.js.
function pillPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - PILL_WIDTH - PILL_MARGIN,
    y: workArea.y + workArea.height - PILL_HEIGHT - PILL_MARGIN
  };
}

// One pill window for the app's whole life (see pill-controller.js): created
// hidden at startup, then shown and hidden instead of destroyed and rebuilt,
// so a lock never waits on a cold renderer start.
function createPillWindow() {
  const { x, y } = pillPosition();
  const win = new BrowserWindow({
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
  win.setAlwaysOnTop(true, "floating");
  // Click-through: clicks land on whatever is underneath, so the pill can't
  // block interaction with the app behind it either.
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, "pill.html"));
  // "closed" is the single cleanup path: a crashed renderer is destroyed here
  // and its "closed" event then tells the controller to rebuild lazily.
  win.on("closed", () => {
    if (!quitting) pill.windowGone(handle);
  });
  win.webContents.on("render-process-gone", () => {
    if (!win.isDestroyed()) win.destroy();
  });
  const handle = {
    showInactive: () => {
      // The work area can change while the pill sits hidden (display or
      // taskbar changes), so re-anchor it each time it is shown.
      const p = pillPosition();
      win.setBounds({ x: p.x, y: p.y, width: PILL_WIDTH, height: PILL_HEIGHT });
      win.showInactive();
    },
    hide: () => win.hide(),
    requestRefresh: () => win.webContents.send("focuscap:refresh"),
    isDestroyed: () => win.isDestroyed()
  };
  return handle;
}

const pill = createPillController({ createWindow: createPillWindow });

// Blocks that happened before the companion started are not replayed.
const watchBlocks = createBlockWatcher(readState());

function poll() {
  const state = readState();
  const action = watchBlocks(state);
  if (action === "flash") pill.flash();
  if (action === "hide") pill.hide();
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
  ipcMain.on("focuscap:rendered", () => pill.rendered());
  pill.warm();

  poll();
  pollTimer = setInterval(poll, POLL_MS);
});

app.on("window-all-closed", (e) => {
  // Stay running in the tray even with no windows open.
  e.preventDefault?.();
});

app.on("before-quit", () => {
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
});
