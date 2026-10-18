# Focus Cap native messaging host

The "server side" bridge between the Chrome extension and the desktop
companion app (`../companion/`). Chrome's
[Native Messaging](https://developer.chrome.com/docs/apps/nativeMessaging/)
API lets an extension launch and talk to a local process over stdio — that
process is `host.js` here. It sanitizes the lock-state messages the
extension sends (known fields and sane types only, as a partial patch) and
writes them into `../state-store.js`'s shared JSON file, which the companion
app polls.

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
- **Windows:** `.\install-windows.ps1` (Windows PowerShell 5.1 or
  PowerShell 7)

(If you ever regenerate your own `"key"` in manifest.json, your extension ID
will change too — pass it explicitly, e.g. `./install-mac.sh <EXTENSION_ID>`
or `.\install-windows.ps1 -ExtensionId <EXTENSION_ID>`.)

The macOS/Linux scripts register into every Chrome channel's directory
(Stable, Beta, Canary/Unstable, Chrome for Testing, Chromium) — each channel
reads its own, and a manifest under only `google-chrome`/`Chrome` fails on the
others with "Specified native messaging host not found".

The Windows script does the same through the registry: it writes the
manifest's path as the `(default)` value of
`<key>\NativeMessagingHosts\com.focuscap.host` under each of
`HKCU:\Software\Google\Chrome`, `Google\Chrome Beta`, `Google\Chrome SxS`
(Canary), `Google\Chrome for Testing`, `Chromium`, `Microsoft\Edge`,
`Microsoft\Edge Beta`, `Microsoft\Edge Dev` and `Microsoft\Edge SxS`
(Canary), so Edge users are covered too. Keys for browsers that aren't
installed are harmless. It refuses to run (non-zero exit, clear message) if
`node` isn't on `PATH`, since `host.bat` needs it. Windows looks the host up
in the registry globally, so there is no `--user-data-dir` caveat there.

CI (`.github/workflows/test.yml`) executes `install-windows.ps1` on
`windows-latest` (under both PowerShell 5.1 and 7, checking the manifest
and all nine registry keys, plus `host.bat` answering a real wire frame from
`cmd`) and `install-mac.sh` on `macos-latest` (checking all five
`~/Library/Application Support` manifests), alongside the Linux suite. The
one thing CI can't do is open a browser: confirming
`chrome.runtime.connectNative("com.focuscap.host")` succeeds in a real
Chrome/Edge on Windows and macOS is still a manual check (GitHub issue #14,
TC3/TC4/TC7).

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
directly there) and restricts `allowed_origins` to the extension ID. The
macOS/Linux scripts build that manifest with `node` (`JSON.stringify` over
the template object) rather than `sed`, so a checkout path or extension ID
containing `#`, `&` or `\` is written literally; the Windows script does the
same with `ConvertFrom-Json`/`ConvertTo-Json` (so every backslash in the
path is escaped) and writes it as UTF-8 without a BOM (Windows PowerShell
5.1's `Set-Content -Encoding UTF8` would add one; not every JSON parser
accepts it). On macOS/Windows restart Chrome afterwards; on Linux the
manifest is looked up on each `connectNative()` call, so no restart is
needed.

## Status

`background.js` requests the `nativeMessaging` permission and best-effort
posts a **per-site lock snapshot** via
`chrome.runtime.connectNative("com.focuscap.host")` whenever state changes —
when a page's content script reports it has become engaged ("entering"), on
every heartbeat, on a navigation-time block, at the midnight reset, and
when a per-site `unlock:<domain>` alarm fires at the end of a cool-down,
per-site schedule rule or global blackout (see `notifyNativeHost()` /
`snapshotForHost()`). The payload is `{ locked, sites: { [domain]: { locked, reason, until, remainingMs } },
remainingMs, budgetMs, focusSites, lastBlocked }`; this host keeps only the
known, correctly-typed fields. Once registered per the steps above, that's
the whole extension→host leg — no extension code changes needed. Verify
with the manual test below, or by watching `~/.focuscap/state.json` update
while browsing a tracked site with the extension loaded.

**One browser profile at a time.** The host manifest and
`~/.focuscap/state.json` are per OS user, not per browser profile. Two
browsers running the extension at once (your everyday Chrome plus a test
`--user-data-dir`, or two automation sessions) each spawn their own `host.js`,
and both read-modify-write the same `state.json` — so the file, and the
companion pill reading it, flap between the two extensions' views of the
lock state. Each write merges one sanitized patch into the file (last writer
wins; a reader that catches a half-written file falls back to defaults), so
nothing is permanently corrupted — but "the" lock state is only meaningful
while one profile is running.

`focusSites` is reduced entry by entry to
`{ domain, budgetSeconds, lockoutSeconds, rules }` with the same defaults
`shared.js`'s `normalizeSite()` applies; non-object entries and entries
without a domain are dropped. `rules` is kept as an array of plain objects
but its fields are not individually filtered (nothing reads `focusSites`
from the file yet).

## Test the host manually, without Chrome at all

Native messaging's wire format is a 4-byte little-endian length prefix
followed by that many bytes of JSON, on both stdin and stdout. Node's `-e`
scripting can build one:

```
node -e '
  const msg = { locked: true, lastBlocked: "example.com",
    sites: { "example.com": { locked: true, reason: "lockout", until: Date.now() + 600000, remainingMs: 0 } } };
  const b = Buffer.from(JSON.stringify(msg));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([h, b]));
' | node host.js
```

The reply on stdout is a length-prefixed
`{"ok":true,"version":"0.1.0","protocolVersion":1}` — `version` is the
host's own (the repo's `package.json`), `protocolVersion` the wire protocol
it speaks; a frame that can't be parsed or written gets
`{"ok":false,"error":"internal error"}` with the same two fields — the
`error` string is always that fixed text, never the underlying message (an
`fs` error would embed the absolute state-file path, a parse error the
input); the full detail goes to the host's stderr, which stays on this
machine (Chrome collects it into its own log). The extension compares
`protocolVersion` with its own expectation and logs a console warning on a
mismatch (GitHub issue #12, phase 1 — no UI yet). Then check
`~/.focuscap/state.json` — it should show `"locked": true`,
`"lastBlocked": "example.com"` and the `sites` entry. With the companion app
running, its pill should appear within a second (polling interval) reading
"example.com until HH:MM".
