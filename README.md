# Focus Cap

A Chrome/Edge (Manifest V3) extension that gives each of your distraction
sites its own **daily time budget, cool-down and schedule**, then locks the
site once its rules say so.

## What it does

- Add distraction domains (e.g. `youtube.com`). Each site gets its own rules,
  edited from the ⚙ next to it in the popup:
  - a **daily budget** (default 30 min);
  - what happens **after the limit**: blocked until midnight, or a
    **cool-down** of N minutes after which the site gets a fresh allowance;
  - **schedule rules** — *block* windows (e.g. Mon–Fri 09:00–17:00) that lock
    the site regardless of budget, and *allow-only* windows outside of which
    it's blocked. An active block window always wins; if a site has any allow
    windows, it's blocked outside all of them; otherwise budgets decide.
- One **total cap, all sites** on top: a global daily limit across every
  tracked site, whichever runs out first.
- No session to start. The rules are always in force.
- A small **countdown badge** in the corner of each listed site shows how much
  time *that site* has left today (amber under 2 min, red under 1 min).
- Time only accrues while a distraction site is the **active tab**, the
  **browser window is focused**, and **you're not idle** (a foreground video
  that's playing counts even without input). Background music in another tab
  never counts, because a backgrounded tab is hidden.
- When a site locks, opening it **redirects you to a standalone block page**
  that says why — "Cooling down / Back in 42m", "Blocked right now / Unblocks
  in 3h", or "Blocked for the day" — with a live countdown to the actual
  unlock. It doesn't just cover the site, it replaces it.
- No bypass. A locked site's settings are read-only until it unlocks, you
  can't raise the total cap once it's spent, and you can't remove a site during
  the **last 5 minutes** of its budget (or once locked). The one forgiveness: a
  schedule rule you **just added or edited** stays editable for **60 seconds**
  even if it locked the site, so a fumbled hour isn't a multi-hour lockout.
- Usage **resets automatically at local midnight**.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this repo folder.
4. Pin the extension, click it, add your sites, then open each site's ⚙ to
   set its budget, cool-down and schedule (and adjust the total cap if you
   like).

To test quickly: add a site, open its ⚙ and set its daily budget to `0.1` min
(6 s), then actively scroll it — the block page should appear within seconds.
Set "After limit" to "block for 1 min" to watch it unlock again.

## Files

- `manifest.json` — MV3 config (the `"key"` pins a stable extension ID so the
  native host's `allowed_origins` keeps working across reloads).
- `background.js` — per-site timing accountant + navigation guard (redirects
  to the block page when a site's rules lock it); pushes lock state to the
  native host and arms `chrome.alarms` for midnight and each unlock time.
- `content.js` — engagement detection, heartbeats, and the in-page badge.
- `shared.js` — the pure per-site evaluation (`matchSite`, `normalizeSite`,
  `normalizeUsage`, `evaluateSite`, schedule-rule helpers) plus small
  formatting helpers, shared by background.js / content.js / dashboard.js so
  the popup, badge and enforcement can never disagree.
- `time-is-up.html/.js` — the standalone block page you're redirected to; it
  says why the site is locked and counts down to the actual unlock.
- `dashboard.html/.css/.js` — the popup: total cap, per-site rows and the ⚙
  per-site editor.
- `test/` — Vitest + jsdom test suite (`npm test`); `.github/workflows/test.yml`
  runs it in CI.
- `companion/` — a desktop menubar app (Electron) that shows a small,
  non-blocking, always-on-top corner pill at the OS level listing which
  tracked sites are locked and until when — the extension alone is only
  visible inside the browser. See its README.
- `native-host/` — the Chrome Native Messaging host that bridges the
  extension to `companion/`; wired end to end once registered with the
  per-OS install scripts (see its README).
- `state-store.js` — the small `~/.focuscap/state.json` file the native host
  writes and the companion polls.

## Desktop companion (optional)

The extension's lock is browser-only by design — it can't see what you do in
a different browser or app. `companion/` adds an OS-level, non-blocking
corner pill for that, fed by `native-host/` over Chrome's Native Messaging
API. The full chain (extension → native host → companion) works end to end
once the host is registered; site-aware enforcement outside the browser is
planned. See `companion/README.md` and `native-host/README.md`.

## Known gaps

Tracked as GitHub issues so they aren't lost: the per-site heartbeat path and
the companion pill's rendering haven't been re-verified end to end in a headed
browser since the per-site rewrite (#13); `install-windows.ps1` registers only
stable Chrome and has never been run (#14); "unblocks at" times can be off by
an hour across DST or wrong for adjacent windows (#15); storage has no schema
version yet (#16); sub-minute cool-downs may be reported late in a packed
build (#17); low-severity hardening from two security reviews (#9, #10, #18).

## Ideas for next

- Site-aware enforcement outside the browser: have the companion react only
  when a tracked site is actually in the foreground (needs foreground-window
  detection — see issue #8).
- Reliable in-app updates for the extension, native host and companion
  (issue #12).
- Per-site stats and a daily summary.
