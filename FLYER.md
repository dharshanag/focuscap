# Focus Cap

### Give each distraction its own budget. Then let it run out.

Focus Cap is a small, open-source browser extension that puts a hard daily
time limit on the sites that eat your day — YouTube, Reddit, Twitter, news,
whatever yours are. Each site gets its own budget, its own cool-down, and its
own schedule. Focus Cap keeps the clock honest, and when a site's budget is
spent, that site is locked — until midnight, or for the cool-down you chose.
No willpower required at the moment you have the least of it.

---

## The problem it solves

Site blockers are all-or-nothing: either a site is banned (so you turn the
blocker off the first time you actually need it) or it's allowed (so you lose
an hour). Timers depend on you remembering to start them. Both fail the same
way: they leave the decision to you *in the moment of temptation*.

Focus Cap moves that decision to the morning-you who set the rules. They're
always in force. There's no session to start, nothing to remember, and — by
design — no quick way to talk yourself out of it once the clock is running
low.

---

## How it works

1. **List your distraction sites.** Add domains like `youtube.com` in the
   popup. Subdomains are covered automatically (`m.youtube.com`,
   `www.youtube.com`).
2. **Give each site its rules.** A daily budget in minutes (30 by default),
   what happens after the limit — locked until midnight, or a cool-down of N
   minutes — and optional schedule windows. A **total cap** across all sites
   sits on top, so per-site budgets can't quietly add up to an afternoon.
3. **Live your day.** A small countdown badge sits in the corner of every
   listed site showing how much time *that site* has left — amber under two
   minutes, red under one.
4. **Hit the limit, hit the wall.** Opening a locked site redirects you to a
   calm, full-page block screen that says why — "Cooling down, back in 42m",
   "Blocked right now, unblocks at 17:00", or "Blocked for the day" — with a
   live countdown to the actual unlock. It doesn't just cover the site — it
   replaces it.
5. **Reset on schedule.** A cool-down hands the site a fresh allowance when it
   ends; everything else resets automatically at local midnight. Nothing to
   reset, nothing to re-arm.

---

## What makes the clock honest

Most timers count wall-clock time and overcharge you. Focus Cap only counts
time you are **genuinely engaged**:

- The tab must be the **active tab**, in a **focused browser window**.
- You must **not be idle** (no mouse, keyboard, or scroll for a configurable
  number of seconds pauses the clock).
- **Watching a video counts** — a playing video in the foreground keeps the
  clock running even if you don't touch anything.
- **Background tabs never count.** Music playing in a tab you're not looking
  at costs you nothing.

Switch away and the clock pauses. Come back and it resumes. You're charged
for attention, not for leaving a tab open.

---

## Built to be hard to cheat (by you)

Focus Cap assumes the person most likely to sabotage it is its owner at
11:58 PM. So:

- **A locked site's settings are read-only until it unlocks.** Budget,
  cool-down and schedule freeze the moment the site locks, and the total cap
  locks once it's spent. Tomorrow-you can change them; tonight-you can't.
  The one forgiveness: a schedule rule you *just* added or edited stays
  editable for 60 seconds, so a fumbled hour isn't a lost afternoon.
- **You can't remove a site in the final five minutes.** The exact window
  you'd be tempted to "just delete it for a second" is the one window where
  removal is disabled — and it stays disabled while the site is locked.
  (Skipped for very short budgets, so tiny test limits still work.)
- **Blocking happens before the page loads.** Navigation to a locked site is
  intercepted at the browser level — there's no flash of the site, no half
  second to grab a link.
- **It survives your own bugs.** Concurrent tabs, browser sleep, and
  service-worker restarts are all handled so the clock can't be tricked into
  under-counting.

---

## Private by default

- **Everything stays on your machine.** Site list, budget, and usage live in
  the browser's local extension storage. There is no account, no sign-in, no
  server, no telemetry, no analytics.
- **Nothing leaves your device.** Focus Cap never phones home. The only
  network requests are the ones *you* make to the sites you visit.
- **Open source.** Every line is readable at
  `github.com/dharshanag/focuscap`. If you don't trust a blocker with
  permission to see every page, you shouldn't have to — read it.

---

## Optional: take the lock beyond the browser

A browser extension can only enforce inside the browser. For people who need
more, Focus Cap ships an optional **desktop companion** (macOS, Windows,
Ubuntu): a lightweight menubar/tray app that learns your lock state from the
extension through Chrome's Native Messaging bridge and surfaces it at the OS
level — a small, click-through, always-on-top notice listing which sites are
locked and until when, visible no matter what app you're in. It never covers
your work.

The companion is optional, runs at normal user privileges (no admin), and
is fully local like everything else. It's currently an early build (Linux
and macOS install scripts are exercised; Windows is not yet); see its README
for setup.

---

## At a glance

| | |
|---|---|
| **Platforms** | Chrome and Edge (Manifest V3). Companion app: macOS, Windows, Ubuntu. |
| **Install** | Load unpacked from the repo — no store account needed. |
| **Cost** | Free. Open source. |
| **Accounts** | None. |
| **Data collected** | None. |
| **Permissions** | Storage (your settings), navigation (to block before load), alarms (midnight reset and unlock timers), native messaging (companion, optional). |
| **Tested** | 110 automated tests in CI, plus end-to-end runs in a real browser through the native host to the companion. |

---

## Rules per site, not one blunt limit

Every site gets its own rules, edited right from the popup:

- **Per-site budgets** — YouTube gets 20 minutes, Reddit gets 10, each on its
  own clock.
- **Configurable cool-downs** — choose whether a site stays blocked until
  midnight or just for a set cool-down (say, two hours) after you hit its
  limit, then comes back with a fresh allowance.
- **Time-of-day schedules** — block a site during work hours, or allow it only
  in an evening window, with per-day rules. A block window always wins.
- **A total cap on top** — one daily limit across all sites, so per-site
  budgets can't quietly add up to an afternoon.
- **A 60-second undo** — a schedule rule you just added stays editable for a
  minute even if it locked the site, so a fumbled hour isn't a lost afternoon.

## Coming next

- **Site-aware desktop enforcement** — the companion will react only when a
  tracked site is actually in front of you, wherever you open it.
- **One-click updates** — update the extension, native host and companion from
  inside the app, verified and with automatic rollback.

---

## Get started in two minutes

1. Clone or download `github.com/dharshanag/focuscap`.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer
   mode**, click **Load unpacked**, and pick the repo folder.
3. Pin Focus Cap, open it, add your sites, and tune each one's budget,
   cool-down and schedule from the ⚙ next to it.

Want to feel it work right away? Set a site's budget to `0.1` minutes (six
seconds) with a one-minute cool-down, open it, and scroll. Meet the wall —
then watch it lift.

---

*Focus Cap — spend your attention on purpose.*
