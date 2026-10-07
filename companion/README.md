# Focus Cap companion

A menubar/tray app that surfaces the extension's lock state at the OS level
— a small, **non-blocking**, always-on-top corner pill listing which tracked
sites are locked and until when (cool-down end, schedule window end, or
midnight), visible no matter what app is in front.

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
`locked` (true when *any* tracked site is locked) shows/hides the pill;
`sites` (`{ [domain]: { locked, reason, until, remainingMs } }`) is what the
pill lists, most recently blocked first; `lastBlocked` is a legacy fallback.
`native-host/host.js` writes that file from messages the extension sends via
`chrome.runtime.connectNative()`; the extension also arms an alarm at each
lock's end so the file is updated when a site unlocks even if nothing is
being browsed.

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
