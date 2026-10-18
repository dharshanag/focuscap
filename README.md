# Focus Cap

A Chrome/Edge (Manifest V3) extension that gives each of your distraction
sites its own **daily time budget, cool-down and schedule**, puts a global
**daily limit and schedule** over all of them, and locks a site once its
rules say so. Everything is enforced locally and nothing leaves your device.

## What it does

### Per-site rules

- Add distraction domains (e.g. `youtube.com`); subdomains are covered
  automatically. Each site gets its own rules, edited from the ⚙ next to it
  on the **Dashboard** (the options page — **⚙️ Dashboard & schedule** in the
  popup, or `chrome://extensions` → Details → Extension options):
  - a **daily budget** (default 30 min);
  - what happens **after the limit**: blocked until midnight, or a
    **cool-down** of N minutes after which the site gets a fresh allowance;
  - **schedule rules** — *block* windows (e.g. Mon–Fri 09:00–17:00) that lock
    the site regardless of budget, and *allow-only* windows outside of which
    it's blocked. An active block window always wins; if a site has any allow
    windows, it's blocked outside all of them; otherwise budgets decide.
- No session to start. The rules are always in force.

### The global layer

- One **Daily limit** on top: a global cap (1 min – 2 h) across every tracked
  site, whichever runs out first. Set from the popup or the Dashboard.
- A **global schedule** (stored as `schedule`, off by default = always on),
  edited in the Dashboard's **Schedule** card:
  - **Enforcement days and windows** — *when* the limits apply. Outside them
    every tracked site is **free**: the popup and Dashboard rows read
    "off-hours", no badge is shown, and nothing is charged to any budget
    (daily stats still accrue). Empty days/windows mean every day / all day.
  - **Blackouts** — time windows (with their own days) during which every
    tracked site is **hard-blocked** outright, whatever its budget. Overnight
    ranges (22:00–06:00) work.
  - Precedence: a blackout outranks everything; a site's own block/allow
    rules outrank off-hours; then the site's lockout, its budget, and the
    global cap.

### What counts as time

- Time only accrues while a distraction site is the **visible tab** and
  **you're engaged**:
  - **Recent input counts** — any mouse, keyboard, scroll or touch within the
    idle threshold (45 s by default) keeps the clock running, *without*
    requiring window focus, so a browser menu or the Focus Cap popup stealing
    keyboard focus doesn't pause you.
  - **Playing media counts only while the window is focused**, so a video
    left running after you alt-tab away stops draining time.
  - **No pause on blur.** Switching windows doesn't stop the clock by itself;
    going idle (or hiding the tab) does. Background music in another tab never
    counts, because a backgrounded tab is hidden.
  - **Idle pausing can be turned off** in the Dashboard's **Advanced** card
    (and the idle threshold tuned there; both need an explicit Save), in
    which case all visible time counts.
- A small **countdown badge** in the corner of each listed site shows how much
  time *that site* has left today (amber under 2 min, red under 1 min). It's
  hidden off-hours and on untracked pages.
- Usage **resets automatically at local midnight**.

### Popup vs Dashboard

- The **popup** (toolbar icon) is the quick view: time left on the global
  cap with a bar, the Daily limit as h/m fields, one status line per site
  ("4:12 left", "🔒 locked until 14:05", "🔒 scheduled until 17:00",
  "🔒 total cap reached", "off-hours") with a remove button, an add-site form, a theme toggle,
  and buttons to **📊 Daily stats** and **⚙️ Dashboard & schedule**.
- The **Dashboard** (options page, opens in a tab) has everything:
  first-run **onboarding** (preset sites + daily limit), the **Blocked sites**
  list with each site's ⚙ per-site editor (budget, after-limit mode,
  block/allow rules with day toggles and times), the **Daily limit** (h/m),
  the global **Schedule** (enable, enforcement days, time windows, blackouts),
  and **Advanced** (idle pausing on/off, idle threshold, explicit Save).
  Everything else autosaves. It opens once by itself on first install.

### Stats, block page, theme

- **Daily stats** for every site, not just the blocked ones: each page's
  engaged time is recorded per domain per day. The **📊 Daily stats** page
  shows today's active / distraction / productive totals, a per-site
  breakdown, a 7-day distraction trend, and "Consider blocking" suggestions
  (distraction sites with a minute or more today that you haven't blocked)
  with a one-click Block. "Distraction" and "productive" come from a small
  **static classifier** (`classify.js`, curated domain lists; unknown domains
  are neutral) — no network lookups.
- When a site locks, opening it **redirects you to a standalone block page**
  that says why — "Cooling down / Back in 42m", "Blocked right now / Unblocks
  in 3h" (schedule rule or blackout), or "Blocked for the day" — with a live
  countdown to the actual unlock; a stale tab left open past the unlock reads
  "You can go back now." From the second block of the day onwards it adds a
  short encouraging message. It doesn't just cover the site, it replaces it.
- **Light/dark theme** toggle (☀️/🌙) on the popup, Dashboard and stats
  pages; the block page has no toggle but follows the same theme. The choice
  is stored locally and follows the OS until you pick.
- Toolbar/extension **icons** at 16/32/48/128 px (`icons/`).

### No bypass

- A locked site's settings are read-only until it unlocks, you can't raise
  the total cap once it's spent, and you can't remove a site during the
  **last 5 minutes** of its budget (or once locked). The one forgiveness: a
  schedule rule you **just added or edited** stays editable for **60 seconds**
  even if it locked the site, so a fumbled hour isn't a multi-hour lockout.
- Navigation to a locked site is intercepted before the page renders.

## Privacy

- Everything is kept in the browser's extension storage on this device —
  `chrome.storage.local` for your site list and rules, the daily limit, the
  schedule, settings, today's usage, and a **14-day local log of engaged time
  per domain for every site you visit** (`stats`, keyed by day, oldest days
  pruned automatically); plus two small items in the extension pages' own
  `localStorage` (the theme cache and the block page's daily view counter).
  The log is what the stats page reads; it is never uploaded, synced or sent
  anywhere. A small integer `schemaVersion` marks the layout of that storage
  (and of `~/.focuscap/state.json`) so an update can upgrade old data in
  place; it carries no personal information.
- There is no account, no server, no telemetry. The extension makes no
  network requests of its own. The optional desktop companion reads a local
  file (`~/.focuscap/state.json`) written by the local native host — also
  never off the device.
- To wipe everything, remove the extension (Chrome deletes its storage) and
  delete `~/.focuscap` if you used the companion.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this repo folder.
4. On first install the Dashboard opens with a short onboarding (pick preset
   sites, set the daily limit). Pin the extension and click it for the quick
   view; open **⚙️ Dashboard & schedule** and each site's ⚙ to set its
   budget, cool-down and schedule (and adjust the daily limit if you like).

To test quickly: add a site, open its ⚙ on the Dashboard and set its daily
budget to `0.5` min (30 s — the smallest value the field's 0.5-min step
accepts), then actively scroll it — the block page should appear within half
a minute. Set "After limit" to "block for 1 min" to watch it unlock again.

## Files

- `manifest.json` — MV3 config (the `"key"` pins a stable extension ID so the
  native host's `allowed_origins` keeps working across reloads); declares the
  popup, the options page (`options_ui`, opens in a tab) and the icons.
- `background.js` — per-site timing accountant + navigation guard (redirects
  to the block page when a site's rules, the global schedule or the cap lock
  it); accrues the per-domain daily stats; pushes lock state to the native
  host and arms `chrome.alarms` for midnight and each unlock time; on
  install and browser startup runs the storage schema migration (stamps
  `schemaVersion`, upgrades older data in place, leaves data from a newer
  build alone with a console warning).
- `content.js` — engagement detection, heartbeats from every page, and the
  in-page badge (shown only on tracked, unlocked, enforced sites).
- `shared.js` — the pure evaluation (`matchSite`, `normalizeSite`,
  `normalizeUsage`, `evaluateSite`, `usageAccrues`, per-site schedule-rule
  helpers, the global schedule's `scheduleStateAt` / `scheduleBlackoutUntil`)
  plus small formatting helpers (`todayKey`/`dayKey`, `fmtClock`, `fmtUntil`,
  `describeStatus`, `parseIntOr`, the 60 s rule grace), shared by
  background.js / content.js / dashboard.js / options.js / stats.js so the
  popup, Dashboard, badge and enforcement can never disagree.
- `classify.js` — curated distraction / productive domain lists for the stats
  page; unknown domains are neutral.
- `dashboard.html/.css/.js` — the popup: daily limit, one status line per
  site, add/remove, theme toggle, and buttons to the stats page and the
  Dashboard.
- `options.html/.css/.js` — the Dashboard (options page): onboarding, the
  blocked-sites list with each site's ⚙ editor (budget, cool-down, schedule
  rules), the daily limit, the global schedule, and Advanced (idle pausing).
- `stats.html/.css/.js` — the daily stats page (totals, per-site list, 7-day
  trend, block suggestions).
- `time-is-up.html/.js` — the standalone block page you're redirected to; it
  says why the site is locked, counts down to the actual unlock, and from the
  second block of the day onwards adds a short encouraging message.
- `theme.js` — light/dark theme (applies the cached choice instantly, then
  reads `chrome.storage.local.theme`); loaded in the `<head>` of every page.
- `icons/` — extension icons (16/32/48/128 px) and their source.
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

### Storage keys

`focusSites` (sites + rules), `budgetSeconds` (global cap), `schedule`,
`settings` (`idleEnabled`, `idleSeconds`), `usage` (today's per-site and total
ms, with `date`), `stats` (`{ "YYYY-MM-DD": { domain: ms } }`), `theme`,
`onboarded`, `welcomed`, and `lastBlocked*` for the block page. **Date keys
are zero-padded local dates, `YYYY-MM-DD`** (e.g. `2026-10-05`), produced by
`todayKey()` / `dayKey()` in shared.js; a `usage.date` that doesn't match
today is treated as a new day.

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
an hour across DST or wrong for adjacent windows (#15); in a packed/store
build Chrome (120+; 1 min before) clamps `chrome.alarms` to a 30-second
minimum, so a cool-down shorter than 30 s is still enforced on time by the
extension but the
companion pill may be told up to 30 s late — the service worker also fires a
timer at the real unlock time while it is still alive, so this only shows
after a worker shutdown — and the editor's cool-down field is whole minutes
(minimum 1), so it can only be reached by writing `lockoutSeconds` to
storage directly (#17).
Not yet filed: a scheduled blackout or enforcement-window *start* doesn't
proactively redirect already-open tabs or push a companion snapshot — the
next heartbeat or navigation handles it; likewise, when a site becomes free
because an enforcement window *ended* (rather than through a cool-down or
unlock alarm), the companion snapshot's `lastBlocked` isn't cleared until
the next unlock alarm or midnight, so the pill can show a stale "last
blocked" (`sites[domain].locked` is correct throughout). Two UI-only limits
of the per-site editor: its cool-down field takes whole minutes (minimum 1)
and its budget field steps by 0.5 min — storage itself accepts any integer
`lockoutSeconds` / `budgetSeconds`, so a sub-minute budget such as 3 s can
be typed (`0.05`) and is stored exactly, but the field flags it as out of
step and displays it to one decimal (`0.1`). The native host's
`~/.focuscap/state.json` is one file per OS user, so run the extension in
one browser profile at a time (see `native-host/README.md`).

**Dev-dependency audit.** Neither the repo root nor `companion/` ships a
runtime npm dependency, so `npm audit --omit=dev` is clean in both. The
root's test tooling (`vitest`, `jsdom`) is on versions with no open
advisories. `companion/` still reports six that only `electron@44` (a major
upgrade, not yet verified by launching the companion) would clear, all in
Electron 32 itself or its download/install tooling: `electron` 32.3.3
(high; the direct dependency — 37 advisories, all fixed only by the
`electron@44` major; `cd companion && npm audit` lists them), `extract-zip`
(high; GHSA-jmr9-qjv8-65gv,
GHSA-7pqw-9j4j-h8q3), `sprintf-js` (moderate; GHSA-hp3w-g68c-fv3c) and its
dependents `roarr`, `global-agent`, `@electron/get` (moderate, same
advisory). None of them is reachable from the extension or the native host.

## Ideas for next

- Site-aware enforcement outside the browser: have the companion react only
  when a tracked site is actually in the foreground (needs foreground-window
  detection — see issue #8).
- Reliable in-app updates for the extension, native host and companion
  (issue #12).
- Stats-driven nudges (e.g. a weekly digest) on top of the daily stats page.
