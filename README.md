# Focus Cap

A Chrome/Edge (Manifest V3) extension that gives you a **daily time budget**
for distraction sites, then locks them once you've spent it — until tomorrow.

## What it does

- Add distraction domains (e.g. `youtube.com`) and set one **daily limit** —
  the total time you're allowed on them per day.
- No session to start. The limit is always in force.
- A small **countdown badge** in the corner of each listed site shows how much
  daily time you have left (amber under 2 min, red under 1 min).
- Time only accrues while a distraction site is the **active tab**, the
  **browser window is focused**, and **you're not idle** (a foreground video
  that's playing counts even without input). Background music in another tab
  never counts, because a backgrounded tab is hidden.
- Usage pools across **all** distraction sites combined. When today's budget is
  gone, opening any blocked site **redirects you to a standalone "Blocked for
  the day" page** (with a live countdown to the reset) — it doesn't just cover
  the site, it replaces it. Running out while you're already on a site redirects
  you too.
- No bypass. While locked you can't raise the daily limit, and you can't remove
  a blocked site during the **last 5 minutes** of your budget (or once locked) —
  the window you'd be tempted to game. Usage **resets automatically at local
  midnight**.

## Daily stats & suggestions

- Focus Cap also tracks per-domain active time on **every** site (not just
  blocked ones) so it can show you where your day went. This data is stored
  **locally only** (`chrome.storage.local`), kept for 14 days, and never leaves
  your machine.
- **View daily stats** from the popup opens a full page with: today's totals
  (active / distraction / productive), a per-site breakdown with category chips,
  a 7-day distraction-time trend, and one-click **Block** buttons.
- A built-in classifier (`classify.js`) buckets well-known domains into
  **distraction**, **productive**, or **neutral**. Sites you spend real time on
  but haven't blocked surface under **"Consider blocking."**

## Scheduling

Open the **Dashboard** (⚙️ button in the popup, or the extension's options page)
to control *when* the limit applies:

- **Enforcement schedule** — pick the days, and optionally the hours, when the
  daily limit is active. Outside those times, blocked sites open freely and don't
  spend any budget.
- **Blackout windows** — time ranges (with their own day selection) when blocked
  sites are **fully off-limits regardless of remaining budget** — e.g. study
  hours or bedtime. The block page explains it's a scheduled block, not a spent
  budget.
- With scheduling **off**, the limit is enforced 24/7 (the original behavior).

The dashboard is also home to **first-run onboarding** (pick common sites +
set a limit), full blocked-site management, and advanced settings.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this `focus-cap/` folder.
4. Pin the extension, click it, set a daily limit, and add your sites.

To test quickly: set the daily limit to `1` min, then actively scroll a
distraction site — the lock should appear within a minute. (Reset by bumping the
limit back up, or wait for local midnight.)

## Files

- `manifest.json` — MV3 config.
- `background.js` — timing accountant (per-domain stats + budget usage) and
  navigation guard (redirects to the blocked page when locked).
- `content.js` — engagement detection and time reporting.
- `classify.js` — buckets domains into distraction / productive / neutral.
- `stats.html/.css/.js` — the daily-stats page.
- `time-is-up.html/.js` — the standalone "time's up" page you're redirected to.
- `dashboard.html/.css/.js` — the compact toolbar popup.
- `options.html/.css/.js` — the full dashboard (sites, limit, schedule, onboarding).
- `schedule.js` — shared schedule evaluator (background + dashboard).

## Ideas for next

- Whole-screen (OS-level) overlay via a companion Electron/menubar app.
- Weekly summary; editable site categories; streaks / focus score.
