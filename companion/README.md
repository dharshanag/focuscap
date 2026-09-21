# Focus Cap companion

A menubar/tray app that surfaces the extension's lock state at the OS level
— a small, **non-blocking**, always-on-top corner pill saying which tracked
site is out of time, visible no matter what app is in front.

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

## Try the overlay without wiring up the extension yet

The real hand-off from the Chrome extension goes through
`native-host/` (a Chrome Native Messaging host — see its README), which
isn't registered by default. Until you've set that up, use the tray menu's
**Simulate lock (dev)** / **Simulate unlock (dev)** items to exercise the
pill end to end.

## How state flows in

This app never talks to the extension directly — it just polls a small JSON
file (`~/.focuscap/state.json`, see `../state-store.js`) once a second and
shows/hides the pill based on its `locked` field. `native-host/host.js` is
what actually writes that file, on messages relayed from the extension via
`chrome.runtime.connectNative()`.

## Status

The pill, tray plumbing, and extension → native-host → state file chain all
work end to end (verified in a real browser). What's still to come is
site-aware enforcement — reacting only when a tracked site is actually in
the foreground — which needs foreground-window detection (GitHub issue #8
covers the native-bindings discussion).
