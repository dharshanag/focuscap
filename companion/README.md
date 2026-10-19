# Focus Cap companion

A menubar/tray app that surfaces the extension's blocks at the OS level — a
small, **non-blocking**, always-on-top corner pill that flashes for about
3.5 seconds each time you get blocked (a site's time runs out, or you try to
open a site that is still locked), listing which tracked sites are locked and
until when (cool-down end, schedule rule or global blackout end, or
midnight), visible no matter what app is in front. It does not stay up for
the whole lock.

It deliberately does **not** cover the screen. The extension's promise is
"distraction *sites* are locked", not "your computer is locked", and until
the companion can detect a tracked site in the foreground (outside Chrome),
it can't know whether blocking anything is warranted. The pill is
click-through and never takes keyboard focus, so it can't get in the way of
unrelated work. Site-aware enforcement is planned once foreground-window
detection lands (see GitHub issue #8).

## Run it

```
cd companion
npm install
npm start
```

You'll get a tray icon (no dock/taskbar entry). Right-click it for a menu.

## Try the pill without wiring up the extension yet

The real hand-off from the Chrome extension goes through
`native-host/` (a Chrome Native Messaging host — see its README), which
isn't registered by default. Until you've set that up, use the tray menu's
**Simulate lock (dev)** / **Simulate unlock (dev)** items to exercise the
pill end to end (the simulated state carries only a site name, so the pill
shows it without an unlock time).

## How state flows in

This app never talks to the extension directly — it just polls a small JSON
file (`~/.focuscap/state.json`, see `../state-store.js`) once a second.
`blockedAt` (stamped by the extension on every block) flashes the pill for
`FLASH_MS` (3.5 s) once it is on screen, then it hides itself; `locked` (true
when *any* tracked site is locked) going false hides it early. Blocks from
before the companion started are not replayed, and a writer without
`blockedAt` still flashes on the unlocked -> locked change;
`sites` (`{ [domain]: { locked, reason, until, remainingMs } }`) is what the
pill lists, most recently blocked first; `lastBlocked` is a legacy fallback.
The file also carries `schemaVersion` (an integer, currently 1, stamped by
`state-store.js` on every write) and `updatedAt`; `readState()` fills in
`schemaVersion` for a file written before it existed, so an older
`state.json` still renders.
`native-host/host.js` writes that file from messages the extension sends via
`chrome.runtime.connectNative()`; the extension also arms an alarm at each
lock's end so the file is updated when a site unlocks even if nothing is
being browsed. `writeState()` creates `~/.focuscap` as `0700` and
`state.json` as `0600` (and re-tightens a pre-existing dir/file on every
write), so another local account can't read which site you were just blocked
on; this app runs as the same user, so it reads the file normally. On
Windows the mode bits are a no-op.

## Status

The pill, tray plumbing, and extension → native-host → state file → pill
chain work end to end: verified in a real, focused browser through the
heartbeat path, including a real `chrome.alarms` unlock making the pill
disappear, and the pill's rendered text/layout checked by rendering
`pill.html` with a stubbed multi-site state (see GitHub issue #13). One
honest caveat: its click-through / never-takes-focus behaviour comes from
Electron flags (`focusable: false`, `setIgnoreMouseEvents(true)`) rather
than observation. `main.js` itself has no automated tests.

Still to come: site-aware enforcement — reacting only when a tracked site is
actually in the foreground — which needs foreground-window detection (GitHub
issue #8 covers the native-bindings discussion).
