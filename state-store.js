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

// Version of the state.json layout. writeState() stamps it on every write
// and readState() fills it in for a file written before it existed, so the
// companion can tell which shape it is reading. Bump on incompatible changes.
const STATE_SCHEMA_VERSION = 1;

const DEFAULT_STATE = {
  schemaVersion: STATE_SCHEMA_VERSION,
  locked: false, // true when ANY tracked site is currently locked
  remainingMs: 0,
  budgetMs: 0,
  focusSites: [],
  // Per-site lock state: { [domain]: { locked, reason, until, remainingMs } }
  sites: {},
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
  // The version marker is ours, never the caller's: a patch can't downgrade it.
  const next = { ...readState(), ...partial, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: Date.now() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { STATE_DIR, STATE_FILE, STATE_SCHEMA_VERSION, DEFAULT_STATE, readState, writeState };
