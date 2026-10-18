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

// Every reply carries the host's own version and the wire protocol version
// it speaks, so the extension can spot a stale or too-new host (GitHub
// issue #12, phase 1: the extension only warns on a mismatch for now).
// HOST_VERSION tracks the repo's package.json; PROTOCOL_VERSION is bumped
// by hand whenever the message shapes change incompatibly.
const PROTOCOL_VERSION = 1;
const HOST_VERSION = (() => {
  try {
    const v = require("../package.json").version;
    return typeof v === "string" && v ? v : "0.1.0";
  } catch (_) {
    return "0.1.0";
  }
})();

// The reply to one frame: { ok: true, version, protocolVersion } on success,
// { ok: false, error, version, protocolVersion } when the frame couldn't be
// parsed or written. Pure so the shape is unit-testable without stdio.
//
// `error` is always the same fixed string (issue #9). The real reason is
// never put on the wire: an fs error embeds the absolute state-file path
// (and so the OS username), and a JSON.parse error echoes the malformed
// input back. handleFrame() logs the detail to stderr instead, which stays
// on this machine (Chrome collects a native host's stderr into its own log).
// Anything other than null/undefined counts as a failure, so a thrown
// string — even an empty one — still answers ok: false.
const GENERIC_ERROR = "internal error";
function buildReply(err) {
  const base = { version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION };
  if (err === null || err === undefined) return { ok: true, ...base };
  return { ok: false, error: GENERIC_ERROR, ...base };
}

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
  if (Array.isArray(src.focusSites)) patch.focusSites = sanitizeFocusSites(src.focusSites);
  if (typeof src.lastBlocked === "string") patch.lastBlocked = src.lastBlocked;
  if (src.sites && typeof src.sites === "object" && !Array.isArray(src.sites)) {
    patch.sites = sanitizeSites(src.sites);
  }
  return patch;
}

// The tracked-site list: [{ domain, budgetSeconds, lockoutSeconds, rules }],
// whitelisted field by field like sanitizeSites() so an arbitrary extension
// payload can't park extra keys in the state file (issue #18). Entries that
// aren't objects, or have no domain, are dropped. Defaults mirror
// shared.js's SITE_DEFAULTS / normalizeSite() — this file is plain CJS run
// straight by Chrome and can't load shared.js, so they are restated here;
// keep the two in sync.
const SITE_DEFAULTS = { budgetSeconds: 1800, lockoutSeconds: null, rules: [] };
function sanitizeFocusSites(list) {
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (typeof raw.domain !== "string" || !raw.domain) continue;
    out.push({
      domain: raw.domain,
      budgetSeconds: typeof raw.budgetSeconds === "number" && raw.budgetSeconds >= 0 ? raw.budgetSeconds : SITE_DEFAULTS.budgetSeconds,
      lockoutSeconds: typeof raw.lockoutSeconds === "number" && raw.lockoutSeconds > 0 ? raw.lockoutSeconds : SITE_DEFAULTS.lockoutSeconds,
      rules: Array.isArray(raw.rules) ? raw.rules.filter((r) => r && typeof r === "object" && !Array.isArray(r)) : SITE_DEFAULTS.rules.slice()
    });
  }
  return out;
}

// Per-site lock snapshot: { [domain]: { locked, reason, until, remainingMs } }.
// Only known fields, only sane types; entries that aren't objects are dropped.
// Keyed by domain, so the map is null-prototype: a key named "__proto__"
// becomes an ordinary own entry instead of swapping the object's prototype.
function sanitizeSites(sites) {
  const out = Object.create(null);
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

// One frame in, one reply object out — parse, sanitize, write. Never throws:
// whatever goes wrong (malformed JSON, an fs error from writeState, a
// non-Error throwable) is logged in full through `deps.log` (stderr by
// default — local-only) and answered with the generic reply, so the loop
// keeps serving the frames that follow. `deps` lets a test substitute the
// writer and the logger: the real writeState() is reached via a plain CJS
// require (this file always runs as CJS, even under Chrome), which lives in
// a different module cache than a test's dynamic import()/vi.mock() and is
// not reset by vi.resetModules() — trying to observe the real write from a
// test caused flaky, order-dependent failures. The manual end-to-end test in
// native-host/README.md (real wire-protocol bytes through the real host.js,
// checked against the real state file) covers that integration instead.
function handleFrame(frame, deps = {}) {
  const write = typeof deps.writeState === "function" ? deps.writeState : writeState;
  const log = typeof deps.log === "function" ? deps.log : (...args) => console.error(...args);
  try {
    const text = Buffer.isBuffer(frame) ? frame.toString("utf8") : String(frame);
    write(sanitizeStatePatch(JSON.parse(text)));
    return buildReply(null);
  } catch (err) {
    // Rendering the detail must not be able to throw either (an exotic
    // throwable with a throwing .stack/.message getter or toString would
    // otherwise escape this catch and take the whole stdio loop down).
    let detail;
    try {
      detail = err instanceof Error ? err.stack || err.message : String(err);
    } catch (_) {
      detail = "(unprintable error)";
    }
    try {
      log(`focuscap host: frame failed: ${detail}`);
    } catch (_) {
      // a failing logger is never worth a dropped reply
    }
    return buildReply(err === null || err === undefined ? new Error("unknown error") : err);
  }
}

// The only stdio-touching step lives here, deliberately kept out of the pure
// functions above.
function runStdioLoop() {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = extractFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      process.stdout.write(encodeFrame(handleFrame(frame)));
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

module.exports = { extractFrames, encodeFrame, sanitizeStatePatch, sanitizeSites, sanitizeFocusSites, buildReply, handleFrame, GENERIC_ERROR, HOST_VERSION, PROTOCOL_VERSION };
