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

let buffer = Buffer.alloc(0);

function send(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function handleMessage(msg) {
  // The extension sends its current lock-relevant state whenever it changes.
  // Only pick known fields — never trust/forward arbitrary extension input
  // straight into the shared state file.
  const { locked, remainingMs, budgetMs, focusSites, lastBlocked } = msg || {};
  writeState({
    locked: !!locked,
    remainingMs: typeof remainingMs === "number" ? remainingMs : 0,
    budgetMs: typeof budgetMs === "number" ? budgetMs : 0,
    focusSites: Array.isArray(focusSites) ? focusSites : [],
    lastBlocked: typeof lastBlocked === "string" ? lastBlocked : ""
  });
  send({ ok: true });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // A single chunk can contain multiple (or partial) messages.
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break; // wait for the rest
    const body = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    try {
      handleMessage(JSON.parse(body.toString("utf8")));
    } catch (err) {
      send({ ok: false, error: String(err && err.message) });
    }
  }
});

// Chrome closes stdin when the extension disconnects (or is unloaded) —
// exit cleanly rather than lingering as an orphaned process.
process.stdin.on("end", () => process.exit(0));
