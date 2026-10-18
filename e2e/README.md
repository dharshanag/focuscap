# Focus Cap end-to-end harness (real Chrome + native host)

`run.mjs` launches the **real** browser binary you point it at, loads the
extension, serves a throwaway "distraction site" on `localhost`, and walks the
whole chain — budget lock → block page → native host → `state.json` → unlock
alarm → fresh allowance — plus the hardening checks from issues #10, #16,
#17 and #18. It prints one line per check and writes a machine-readable JSON
report. Every check keeps running after a failure; the exit code is 1 if any
check fails. It is meant to be run unattended (CI runners, EC2 instances,
other agents): headless by default, no browser download, nothing outside the
directories you pass on the command line.

The only dependency is `puppeteer-core` (pinned; it never downloads a
browser). Unpacked loading goes through DevTools' `Extensions.loadUnpacked`
(`--enable-unsafe-extension-debugging` + `--remote-debugging-pipe`), which
works in branded Google Chrome where the old `--load-extension` flag is
ignored (Chrome 137+).

## Prerequisite: register the native host for the browser you launch

`protocol-handshake` and everything downstream of it can only pass if the
browser can find and start `native-host/host.js`. The registration is per OS
user (and, on Linux, per profile directory):

| OS | Register with | Notes |
|---|---|---|
| Linux | `./native-host/install-linux.sh <extension-id> <user-data-dir>` | Chrome on Linux resolves user-level host manifests from `<user-data-dir>/NativeMessagingHosts`, **not** from `~/.config`, so the second argument must be the exact directory you pass as `--user-data-dir`. Run it with the same `HOME` you pass as `--home` if you want its `~/.config/*` copies to land there too. No restart needed. |
| macOS | `./native-host/install-mac.sh <extension-id>` | Writes to `~/Library/Application Support/{Google/Chrome,…}/NativeMessagingHosts` of the user running the script, which must be the user that launches Chrome. |
| Windows | `.\native-host\install-windows.ps1 -ExtensionId <extension-id>` | Writes `HKCU\Software\…\NativeMessagingHosts\com.focuscap.host`; run it as the same Windows user that launches Chrome. `node` must be on that user's `PATH` (Chrome starts `host.bat`). |

`node` must resolve from the environment Chrome inherits — the harness passes
its own `process.env` (with `HOME`/`USERPROFILE` overridden) to Chrome, and
Chrome passes that on to the host.

The host writes `state.json` under `os.homedir()/.focuscap`. The harness
hands Chrome `HOME=<--home>` and `USERPROFILE=<--home>`, so the file lands at
`<--home>/.focuscap/state.json` and your real home directory is never
touched. Run one browser profile at a time per `--home`: two hosts writing
the same `state.json` make `host-wrote-state` / `unlock-reported` meaningless.

## Run it

```
cd e2e && npm ci        # once; installs puppeteer-core only
node run.mjs --chrome <browser binary> --home <dir> --user-data-dir <fresh dir> --out <report.json> [options]
```

Linux (as root, e.g. an EC2 instance):

```
./native-host/install-linux.sh oladakapegoiphmpicedkgnieanibbbe /tmp/fc-profile
cd e2e && node run.mjs --chrome /usr/bin/google-chrome --no-sandbox \
  --home /tmp/fc-home --user-data-dir /tmp/fc-profile --out /tmp/fc-report.json
```

macOS:

```
./native-host/install-mac.sh
cd e2e && node run.mjs --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --home "$TMPDIR/fc-home" --user-data-dir "$TMPDIR/fc-profile" --out "$TMPDIR/fc-report.json"
```

Windows (PowerShell, same user that will run Chrome):

```
.\native-host\install-windows.ps1
cd e2e; node run.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --home $env:TEMP\fc-home --user-data-dir $env:TEMP\fc-profile --out $env:TEMP\fc-report.json
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--chrome <path>` | required | the real browser binary |
| `--repo <dir>` | `..` (the repo root) | extension root to load unpacked |
| `--home <dir>` | required | `HOME`/`USERPROFILE` for Chrome and the host it spawns |
| `--user-data-dir <dir>` | required | Chrome profile; use a fresh one per run |
| `--out <file>` | required | JSON report path |
| `--budget-seconds <n>` | 5 | per-site budget for the `localhost` fixture |
| `--lockout-seconds <n>` | 20 | cool-down after the budget is spent |
| `--port <n>` | 8765 | local fixture port (the tracked domain is `localhost`) |
| `--packed` | off | don't load unpacked; wait (60 s) for a policy-installed build with `--extension-id` |
| `--extension-id <id>` | `oladakapegoiphmpicedkgnieanibbbe` | expected ID (pinned by `manifest.json`'s `key`) |
| `--no-sandbox` | off | adds `--no-sandbox` (required when running as root on Linux) |
| `--headed` | off | show a window (default is headless) |
| `--skip <ids>` | | comma-separated check ids to skip; dependants are skipped too |
| `--timeout-ms <n>` | 90000 | per-check cap and browser launch timeout |
| `--verbose` | off | echo Chrome's own stderr (native messaging failures are logged there) |

`--packed` mode expects the extension to have been force-installed by policy
(e.g. `ExtensionInstallForcelist` / `ExtensionSettings`) before the run; it
has not been exercised locally.

## What each check proves

| id | Proves |
|---|---|
| `extension-loaded` | The extension's service worker is running and `chrome.runtime.id` is the pinned ID (so the host manifest's `allowed_origins` applies). Also waits for `onInstalled` to stamp `schemaVersion`. In `--packed` mode waits up to 60 s. |
| `protocol-handshake` | From the service worker, `chrome.runtime.connectNative("com.focuscap.host")` + `postMessage({})` gets `{ok:true, protocolVersion:1}` within 5 s and no `onDisconnect` with `chrome.runtime.lastError`. **This single check proves the per-OS installer, the manifest/registry entry, `host.bat`/`host.js` and `node` on `PATH` all work for the launched browser** (#14 TC3/TC4/TC7). A failure reports the exact error text, e.g. `Specified native messaging host not found.` |
| `lock` | With `focusSites: [{domain:"localhost", budgetSeconds, lockoutSeconds}]` seeded from the service worker, the fixture page is redirected to `time-is-up.html` within `budget + 5` s. Records `tLock`, `lockedUntil` and the block page text. |
| `alarm-scheduled` | `chrome.alarms.getAll()` has `unlock:localhost`; reports `scheduledTime − lockedUntil` (0 unpacked; ≥ ~30 000 when a packed build is clamped, #17). Fails only if the alarm is missing. |
| `host-wrote-state` | Within 5 s of the lock `<home>/.focuscap/state.json` has `schemaVersion:1`, `locked:true`, `sites.localhost.{locked:true, reason:"lockout"}`, `lastBlocked:"localhost"` and an `updatedAt` from this run. On POSIX also requires mode bits `0700` on `.focuscap` and `0600` on `state.json` (#10). |
| `unlock-reported` | `state.json` flips to `locked:false` / `sites.localhost.locked:false`; the measured delay from the lock is reported prominently (`unlockDelayMs`, also in top-level `timings`). Passes within `lockout + 45` s (unpacked ≈ lockout; packed builds may clamp to 30 s). |
| `block-page-countdown` | The block page's reset line reads `You can go back now.` by `lockout + 3` s. |
| `renavigate` | Opening the site again after the unlock stays on `localhost` (no redirect) and `usage.sites.localhost.totalMs === 0` — the lazy re-evaluation handed out a fresh allowance (#17 TC3). |
| `options-reserved-names` | Through the real Dashboard add-site form (`options.html`), `__proto__`, `constructor`, `prototype` and `https://__proto__/x` add nothing to `focusSites`, while `proto.example.com` is accepted (#18 TC1). |
| `proto-pollution` | In the service worker, feeding `sites: {"__proto__": {totalMs: 1}}` through `normalizeUsage` + `siteUsage` leaves `({}).totalMs` and `Object.prototype.lastTickAt` undefined and the `"__proto__"` lookup neither throws nor returns `Object.prototype` (#18 TC2). |
| `schema-version` | `chrome.storage.local.schemaVersion === 1` and `state.json.schemaVersion === 1` (#16). |
| `sw-console-clean` | No `error`-level console message or uncaught exception in the service worker during the run (warnings are reported, not failed). Any text matching `/native|protocol|Specified native/i` is surfaced in the detail. A canary message proves the capture itself is wired. |

Dependencies: `lock` needs `extension-loaded`; `alarm-scheduled`,
`host-wrote-state`, `block-page-countdown`, `renavigate` need `lock`;
`unlock-reported` needs `host-wrote-state`. A check whose prerequisite failed
is reported as failed with that reason; one whose prerequisite was skipped is
skipped.

## The report

```json
{
  "startedAt": "…", "finishedAt": "…", "pass": true,
  "chromeVersion": "Chrome/155.0.8059.39", "platform": "linux 7.0.0-38-generic x64", "node": "v24.11.1",
  "extensionId": "oladakapegoiphmpicedkgnieanibbbe", "mode": "unpacked", "headless": true,
  "home": "…", "stateFile": "…/.focuscap/state.json", "userDataDir": "…",
  "hostManifestLocation": { "expected": "<user-data-dir>/NativeMessagingHosts/com.focuscap.host.json", "present": true, "note": "…" },
  "fixture": { "url": "http://localhost:8765/", "budgetSeconds": 5, "lockoutSeconds": 20 },
  "timings": { "tLock": "…", "lockedUntil": "…", "unlockDelayMs": 20068, "lockoutMs": 20000 },
  "checks": [ { "id": "…", "title": "…", "pass": true, "detail": "…", "ms": 12, "…": "check-specific extras" } ],
  "summary": { "passed": 12, "failed": 0, "skipped": 0 },
  "error": null
}
```

`pass` on a skipped check is `null` with `skipped: true`. Top-level `pass` is
true only when no check failed and the harness itself did not error.

## Caveats

- Nothing but the two directories you pass (`--home`, `--user-data-dir`) and
  the report file is written. The fixture site listens on `127.0.0.1` and
  `::1` only.
- The budget is spent by real heartbeats from `content.js` (the harness also
  wiggles the mouse), so `lock` takes about `budget + 0.2` s.
- The DevTools session keeps the service worker alive for the whole run, so
  the sub-30 s early-push timer of #17 and the alarm both fire; a worker
  shutdown between lock and unlock is not simulated.
