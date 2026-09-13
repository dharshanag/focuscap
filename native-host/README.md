# Focus Cap native messaging host

The "server side" bridge between the Chrome extension and the desktop
companion app (`../companion/`). Chrome's
[Native Messaging](https://developer.chrome.com/docs/apps/nativeMessaging/)
API lets an extension launch and talk to a local process over stdio — that
process is `host.js` here. It just relays whatever lock-state the extension
sends into `../state-store.js`'s shared JSON file, which the companion app
polls.

Currently plain Node — see GitHub issue #8 for a note on possibly rewriting
this in Rust once the overall architecture is validated (smaller/no-runtime
binary, safer native OS bindings if this process ever grows beyond relaying
JSON).

## Requirements

`node` must be on `PATH` (Chrome launches this host as a subprocess using
the exact command in the registered manifest — it does not use your shell's
environment, so make sure `node` resolves from a plain, non-interactive
shell).

## Register it

You need your unpacked extension's ID first: load the extension (see the
repo root README), then open `chrome://extensions` with Developer mode on
and copy the ID shown under "Focus Cap".

- **macOS:** `./install-mac.sh <EXTENSION_ID>`
- **Ubuntu/Linux:** `./install-linux.sh <EXTENSION_ID>`
- **Windows:** `.\install-windows.ps1 -ExtensionId <EXTENSION_ID>` (PowerShell)

Each writes a `com.focuscap.host.json` native messaging host manifest to the
right per-OS location (see each script) pointing at `host.js`
(`host.bat` wrapper on Windows, since Chrome can't run a `.js` shebang
directly there) and restricts `allowed_origins` to your extension ID. Restart
Chrome afterwards.

## What's NOT wired up yet

The extension itself doesn't call `chrome.runtime.connectNative()` yet —
`manifest.json` doesn't request the `nativeMessaging` permission, and
`background.js` doesn't send state over. That's the next step once this
host + the companion app are both confirmed working (via the companion's
"Simulate lock/unlock" dev menu items).

## Test the host manually, without Chrome at all

Native messaging's wire format is a 4-byte little-endian length prefix
followed by that many bytes of JSON, on both stdin and stdout. Node's `-e`
scripting can build one:

```
node -e '
  const b = Buffer.from(JSON.stringify({ locked: true, lastBlocked: "example.com" }));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([h, b]));
' | node host.js
```

Then check `~/.focuscap/state.json` — it should show `"locked": true` and
`"lastBlocked": "example.com"`. With the companion app running, its overlay
should appear within a second (polling interval).
