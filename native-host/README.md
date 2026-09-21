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

`../manifest.json` pins a stable unpacked-extension ID via its `"key"`
field, so as long as you load the repo's own `manifest.json` unpacked (see
the root README), no manual ID lookup is needed — the install scripts
already default to the right ID.

- **macOS:** `./install-mac.sh`
- **Ubuntu/Linux:** `./install-linux.sh`
- **Windows:** `.\install-windows.ps1` (PowerShell)

(If you ever regenerate your own `"key"` in manifest.json, your extension ID
will change too — pass it explicitly, e.g. `./install-mac.sh <EXTENSION_ID>`
or `.\install-windows.ps1 -ExtensionId <EXTENSION_ID>`.)

The macOS/Linux scripts register into every Chrome channel's directory
(Stable, Beta, Canary/Unstable, Chrome for Testing, Chromium) — each channel
reads its own, and a manifest under only `google-chrome`/`Chrome` fails on the
others with "Specified native messaging host not found".

**Linux + custom `--user-data-dir`:** on Linux, Chrome resolves the
user-level `NativeMessagingHosts` directory relative to the *active
user-data-dir*, not a fixed path. The defaults above cover Chrome's default
profile location only. If you launch Chrome with a custom `--user-data-dir`
(browser-automation tools like `agent-browser --profile <dir>` do this), pass
that directory as the second argument, e.g.
`./install-linux.sh oladakapegoiphmpicedkgnieanibbbe ~/.my-chrome-profile`
(or set `CHROME_USER_DATA_DIR`). No browser restart is needed on Linux — the
lookup happens on each `connectNative()` call.

Each writes a `com.focuscap.host.json` native messaging host manifest to the
right per-OS location (see each script) pointing at `host.js`
(`host.bat` wrapper on Windows, since Chrome can't run a `.js` shebang
directly there) and restricts `allowed_origins` to the extension ID. Restart
Chrome afterwards.

## Status

`background.js` already requests the `nativeMessaging` permission and
best-effort posts lock state via `chrome.runtime.connectNative("com.focuscap.host")`
whenever it changes (see `notifyNativeHost()`). Once this host is registered
per the steps above and Chrome is restarted, that's the whole extension→host
leg — no extension code changes needed. Verify with the manual test below,
or by watching `~/.focuscap/state.json` update while browsing a tracked site
with the extension loaded.

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
