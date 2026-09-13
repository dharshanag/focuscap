// Focus Cap — shared lock-state file used to bridge the Chrome extension
// (via native-host/host.js) and the desktop companion app (companion/main.js).
// Both are separate Node/Electron processes, so a small JSON file under the
// user's home directory is the simplest cross-platform hand-off — no need
// for a socket/port until that stops being enough.
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_DIR = path.join(os.homedir(), ".focuscap");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const DEFAULT_STATE = {
  locked: false,
  remainingMs: 0,
  budgetMs: 0,
  focusSites: [],
  lastBlocked: "",
  updatedAt: 0
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULT_STATE };
  }
}

function writeState(partial) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readState(), ...partial, updatedAt: Date.now() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { STATE_DIR, STATE_FILE, DEFAULT_STATE, readState, writeState };
