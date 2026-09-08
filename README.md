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

## Load it

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this `focus-guard/` folder.
4. Pin the extension, click it, set a daily limit, and add your sites.

To test quickly: set the daily limit to `0.1` min (6 s), then actively scroll a
distraction site — the lock should appear within seconds. (Reset by bumping the
limit back up, or wait for local midnight.)

## Files

- `manifest.json` — MV3 config.
- `background.js` — timing accountant + navigation guard (redirects to the
  blocked page when locked).
- `content.js` — engagement detection and time reporting.
- `time-is-up.html/.js` — the standalone "time's up" page you're redirected to.
- `dashboard.html/.css/.js` — the popup dashboard.

## Ideas for next

- Whole-screen (OS-level) overlay via a companion Electron/menubar app.
- Per-site stats and a daily summary.
- Scheduled auto-start sessions (e.g. every weekday 9–12).
