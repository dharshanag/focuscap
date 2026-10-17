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

// The file names the site the user was just blocked on and their lock
// timing — nothing secret, but nothing another local account needs to read
// either, so the directory is 0700 and the file 0600 (issue #10). `mode` on
// mkdirSync/writeFileSync only applies to paths this call creates, hence the
// explicit chmod afterwards for a dir/file that already existed with looser
// bits. The chmod is best-effort: on Windows the mode bits are a no-op (and
// chmod may throw EPERM), and a read-only edge case must not turn a write
// that already succeeded into a failure.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function tightenMode(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (_) {
    // best-effort: see above
  }
}

function writeState(partial) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: DIR_MODE });
  // The version marker is ours, never the caller's: a patch can't downgrade it.
  const next = { ...readState(), ...partial, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: Date.now() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: FILE_MODE });
  tightenMode(STATE_DIR, DIR_MODE);
  tightenMode(STATE_FILE, FILE_MODE);
  return next;
}

module.exports = { STATE_DIR, STATE_FILE, STATE_SCHEMA_VERSION, DEFAULT_STATE, readState, writeState };
