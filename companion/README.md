# Focus Cap companion

A menubar/tray app that shows an OS-level, always-on-top full-screen overlay
once the daily budget is spent — so the lock isn't limited to the browser
window (see the main README's "Ideas for next").

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
overlay end to end.

## How state flows in

This app never talks to the extension directly — it just polls a small JSON
file (`~/.focuscap/state.json`, see `../state-store.js`) once a second and
shows/hides the overlay based on its `locked` field. `native-host/host.js` is
what actually writes that file, on messages relayed from the extension via
`chrome.runtime.connectNative()`.

## Status

This is a scaffold: the overlay and tray plumbing work today; the extension
side isn't wired to `native-host/` yet (see `native-host/README.md` for what's
left, and GitHub issue #8 for a note on possibly rewriting the native host in
Rust once this MVP is validated).
