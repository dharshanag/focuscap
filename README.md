# Focus Cap

A Chrome/Edge (Manifest V3) extension that gives each of your distraction
sites its own **daily time budget, cool-down and schedule**, then locks the
site once its rules say so.

## What it does

- Add distraction domains (e.g. `youtube.com`). Each site gets its own rules,
  edited from the ⚙ next to it on the **Dashboard** (the options page —
  **⚙️ Dashboard & schedule** in the popup, or `chrome://extensions` →
  Details → Extension options):
  - a **daily budget** (default 30 min);
  - what happens **after the limit**: blocked until midnight, or a
    **cool-down** of N minutes after which the site gets a fresh allowance;
  - **schedule rules** — *block* windows (e.g. Mon–Fri 09:00–17:00) that lock
    the site regardless of budget, and *allow-only* windows outside of which
    it's blocked. An active block window always wins; if a site has any allow
    windows, it's blocked outside all of them; otherwise budgets decide.
- One **Daily limit** on top: a global cap (1 min – 2 h) across every tracked
  site, whichever runs out first. Set from the popup or the Dashboard.
- A **global schedule** over all of that (stored as `schedule`, off by
  default = always on): *enforcement days/windows* outside of which every
  site is free — the popup row reads "off-hours", no badge, nothing is
  charged to any budget (daily stats still accrue) — and *blackouts* during
  which every tracked site is blocked outright, whatever its budget. A
  blackout outranks everything; a site's own block/allow rules outrank
  off-hours. Edited in the Dashboard's **Schedule** card (enable, enforcement
  days, time windows, blackouts with their own days).
- No session to start. The rules are always in force.
- A small **countdown badge** in the corner of each listed site shows how much
  time *that site* has left today (amber under 2 min, red under 1 min).
- Time only accrues while a distraction site is the **visible tab** and
  **you're not idle**. Recent input counts even if a browser menu or the
  Focus Cap popup briefly stole keyboard focus; a playing video counts only
  while the window is actually focused, so alt-tabbing away stops the drain.
  Idle-pausing can be turned off in the Dashboard's **Advanced** card (and
  the idle threshold tuned there; both need an explicit Save), in which case
  all visible time counts. Background music in another tab never counts,
  because a backgrounded tab is hidden.
- **Daily stats** for every site, not just the blocked ones: each page's
  engaged time is recorded per domain per day (`stats`, 14 days kept). The
  **📊 Daily stats** button (popup and Dashboard) opens a page with today's active /
  distraction / productive totals, a per-site breakdown, a 7-day distraction
  trend, and "Consider blocking" suggestions (distraction sites with a minute
  or more today that you haven't blocked) with a one-click Block.
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
4. On first install the Dashboard opens with a short onboarding (pick preset
   sites, set the daily limit). Pin the extension and click it for the quick
   view; open **⚙️ Dashboard & schedule** and each site's ⚙ to set its
   budget, cool-down and schedule (and adjust the daily limit if you like).

To test quickly: add a site, open its ⚙ on the Dashboard and set its daily
budget to `0.1` min (6 s), then actively scroll it — the block page should
appear within seconds. Set "After limit" to "block for 1 min" to watch it
unlock again.

## Files

- `manifest.json` — MV3 config (the `"key"` pins a stable extension ID so the
  native host's `allowed_origins` keeps working across reloads).
- `background.js` — per-site timing accountant + navigation guard (redirects
  to the block page when a site's rules lock it); pushes lock state to the
  native host and arms `chrome.alarms` for midnight and each unlock time.
- `content.js` — engagement detection, heartbeats from every page, and the
  in-page badge (shown only on tracked, unlocked sites).
- `classify.js` — curated distraction / productive domain lists for the stats
  page; unknown domains are neutral.
- `stats.html/.css/.js` — the daily stats page (totals, per-site list, 7-day
  trend, block suggestions).
- `shared.js` — the pure per-site evaluation (`matchSite`, `normalizeSite`,
  `normalizeUsage`, `evaluateSite`, per-site schedule-rule helpers, the
  global schedule's `scheduleStateAt` / `scheduleBlackoutUntil`) plus small
  formatting helpers (`fmtClock`, `fmtUntil`, `describeStatus`, the 60 s
  rule grace), shared by background.js / content.js / dashboard.js /
  options.js so the popup, Dashboard, badge and enforcement can never
  disagree.
- `time-is-up.html/.js` — the standalone block page you're redirected to; it
  says why the site is locked and counts down to the actual unlock.
- `dashboard.html/.css/.js` — the popup: daily limit, one status line per
  site, add/remove, and buttons to the stats page and the Dashboard.
- `options.html/.css/.js` — the Dashboard (options page): onboarding, the
  blocked-sites list with each site's ⚙ editor (budget, cool-down, schedule
  rules), the daily limit, the global schedule, and Advanced (idle pausing).
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

Tracked as GitHub issues so they aren't lost: the companion pill's
click-through / never-takes-focus behaviour is asserted from Electron flags,
not observed (#13, closed — the heartbeat path and the pill's rendered text
are now verified); `install-windows.ps1` registers only
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
- Stats-driven nudges (e.g. a weekly digest) on top of the daily stats page.
