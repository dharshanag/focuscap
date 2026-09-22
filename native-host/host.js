#!/usr/bin/env node
// Focus Cap native messaging host — the "server side" bridge between the
// Chrome extension (via chrome.runtime.connectNative()) and the desktop
// companion app. Chrome launches this as a child process and talks to it
// over stdin/stdout using the Native Messaging wire protocol: each message
// is a 4-byte little-endian length prefix followed by that many bytes of
// UTF-8 JSON. See:
// https://developer.chrome.com/docs/apps/nativeMessaging/#native-messaging-host-protocol
//
// See GitHub issue #8 for a note on possibly rewriting this in Rust later —
// intentionally plain Node for the initial MVP.
const { writeState } = require("../state-store");

// Pulls complete length-prefixed frames out of a buffer that may hold zero,
// one, or several messages (plus a trailing partial one still being
// received). Pure and stateless so it's testable without a real stdin.
function extractFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.length - offset < 4 + length) break; // rest hasn't arrived yet
    frames.push(buffer.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function encodeFrame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Only pick known, correctly-typed fields — never trust/forward arbitrary
// extension input straight into the shared state file. This is a PARTIAL
// patch: fields that are absent or wrong-typed are omitted rather than
// defaulted, so writeState()'s merge keeps the last-known value. (The
// extension's block-time notification only sends {locked, lastBlocked};
// defaulting the rest to 0/[] here used to wipe budgetMs/focusSites that an
// earlier heartbeat had already reported.)
function sanitizeStatePatch(msg) {
  const src = msg && typeof msg === "object" ? msg : {};
  const patch = {};
  if ("locked" in src) patch.locked = !!src.locked;
  if (typeof src.remainingMs === "number") patch.remainingMs = src.remainingMs;
  if (typeof src.budgetMs === "number") patch.budgetMs = src.budgetMs;
  if (Array.isArray(src.focusSites)) patch.focusSites = src.focusSites;
  if (typeof src.lastBlocked === "string") patch.lastBlocked = src.lastBlocked;
  if (src.sites && typeof src.sites === "object" && !Array.isArray(src.sites)) {
    patch.sites = sanitizeSites(src.sites);
  }
  return patch;
}

// Per-site lock snapshot: { [domain]: { locked, reason, until, remainingMs } }.
// Only known fields, only sane types; entries that aren't objects are dropped.
function sanitizeSites(sites) {
  const out = {};
  for (const [domain, raw] of Object.entries(sites)) {
    if (!domain || !raw || typeof raw !== "object") continue;
    out[domain] = {
      locked: !!raw.locked,
      reason: typeof raw.reason === "string" ? raw.reason : null,
      until: typeof raw.until === "number" ? raw.until : null,
      remainingMs: typeof raw.remainingMs === "number" ? raw.remainingMs : 0
    };
  }
  return out;
}

// The only side-effecting step (writing to the shared state file) lives
// here, deliberately kept out of the pure functions above. Testing this
// integration by requiring state-store.js from a test would cross a real
// Node require() (this file always runs as plain CJS, even under Chrome) vs.
// the test's own dynamic import() — two different module caches that don't
// share a vi.resetModules()/mock lifecycle, which caused flaky, order-
// dependent test failures. The manual end-to-end test in native-host/README.md
// (real wire-protocol bytes through the real host.js, checked against the
// real state file) covers this instead.
function runStdioLoop() {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = extractFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      let response;
      try {
        writeState(sanitizeStatePatch(JSON.parse(frame.toString("utf8"))));
        response = { ok: true };
      } catch (err) {
        response = { ok: false, error: String(err && err.message) };
      }
      process.stdout.write(encodeFrame(response));
    }
  });

  // Chrome closes stdin when the extension disconnects (or is unloaded) —
  // exit cleanly rather than lingering as an orphaned process.
  process.stdin.on("end", () => process.exit(0));
}

// Only wire up real stdio when Chrome (or a human) runs this file directly —
// not when a test requires it just to reach the pure functions above.
if (require.main === module) {
  runStdioLoop();
}

module.exports = { extractFrames, encodeFrame, sanitizeStatePatch, sanitizeSites };
