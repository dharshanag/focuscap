// Focus Cap — content script (runs on every top-level page).
// Sole job: measure genuine engagement time on this page and report it. Every
// page heartbeats (that's what feeds the per-domain daily stats); only tracked
// distraction sites spend budget and show the corner badge. Time only counts
// while the tab is visible and you're not idle. Enforcement (redirecting to
// the blocked page) lives in background.js.

(() => {
  const hostname = location.hostname;

  let running = false;
  let loop = null;
  let lastInputAt = Date.now();
  let settings = { idleEnabled: true, idleSeconds: 45 };
  let badgeHost = null;
  let badgeEl = null;

  // Any real interaction resets the idle clock.
  const INPUT_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "wheel", "touchstart"];
  INPUT_EVENTS.forEach((e) =>
    window.addEventListener(e, () => (lastInputAt = Date.now()), { passive: true, capture: true })
  );

  // Is media actively playing in this page? (a foreground YouTube video, etc.)
  function mediaPlaying() {
    return [...document.querySelectorAll("video, audio")].some(
      (m) => !m.paused && !m.ended && m.readyState > 2
    );
  }

  function isEngaged() {
    // Must be the foreground, visible tab. (A backgrounded music tab is hidden
    // → never counts. That case still holds.)
    if (document.visibilityState !== "visible") return false;
    // Idle-pausing can be turned off in settings — then all foreground time
    // counts. (A missing value means "on", for settings saved before the flag.)
    if (settings.idleEnabled === false) return true;
    // Recent interaction counts — even if a browser popup/menu (or the Focus
    // Cap popup) briefly stole keyboard focus. We deliberately do NOT require
    // document.hasFocus() here, so opening the extensions menu won't pause you.
    if (Date.now() - lastInputAt < idleWindowMs()) return true;
    // Passive video counts only while the page is truly focused, so a video
    // left playing after you alt-tab to another app doesn't keep draining time.
    return document.hasFocus() && mediaPlaying();
  }

  function idleWindowMs() {
    const s = Number(settings.idleSeconds);
    return (Number.isNaN(s) ? 45 : s) * 1000;
  }

  async function send(type) {
    try {
      return await chrome.runtime.sendMessage({ type, hostname });
    } catch (_) {
      return null; // extension reloaded / context invalidated
    }
  }

  async function start() {
    if (running) return;
    const res = await send("entering");
    if (!res || !res.track) return; // no usable hostname (file://, about:blank)
    settings = res.settings || settings;
    running = true;
    syncBadge(res);
    loop = setInterval(tick, 1000);
  }

  // The countdown badge belongs only on a tracked site that is actually being
  // spent down — not on untracked pages (stats track those silently), not on
  // a locked page (background is already redirecting it away), and not
  // off-hours (the global schedule isn't enforcing, so nothing is charged).
  function badgeWanted(res) {
    return !!res.tracked && !res.overlay && !res.free;
  }

  function syncBadge(res) {
    if (badgeWanted(res)) {
      showBadge();
      refreshBadge();
    } else {
      hideBadge();
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    if (loop) clearInterval(loop);
    loop = null;
    hideBadge();
    send("leaving");
  }

  async function tick() {
    // Idle / hidden → pause counting, but stay attached.
    if (!isEngaged()) return;
    const res = await send("heartbeat");
    if (!res || !res.track) {
      stop();
      return;
    }
    settings = res.settings || settings;
    // The site may have just been added to (or removed from) the tracked
    // list, or just locked — show, refresh or clear the badge accordingly.
    syncBadge(res);
    // If res.overlay is true, background is already redirecting this tab away.
  }

  // ---- Corner badge: how much daily time is left on this site ----

  // Compute THIS site's remaining time straight from storage with the same
  // shared.js helpers background.js enforces with — independent of the
  // message reply, so the badge is robust to background/version mismatches
  // and can never disagree with what actually gets blocked. Reflects the
  // tighter of the site's own budget and the global cap.
  async function refreshBadge() {
    if (!badgeEl) return;
    let store;
    try {
      store = await chrome.storage.local.get(["focusSites", "budgetSeconds", "usage", "schedule"]);
    } catch (_) {
      return; // extension context invalidated
    }
    const now = Date.now();
    // Defensive: this runs on every tracked page, so malformed storage must
    // degrade to "no badge update", never to a thrown error or "NaN:NaN".
    const sites = Array.isArray(store.focusSites) ? store.focusSites.map(normalizeSite) : [];
    const site = matchSite(hostname, sites);
    if (!site) return;
    const globalBudgetMs = (typeof store.budgetSeconds === "number" ? store.budgetSeconds : 1800) * 1000;
    const status = evaluateSite(site, normalizeUsage(store.usage, now), globalBudgetMs, now, store.schedule);
    // Off-hours there's nothing to count down: the badge comes off, exactly
    // as it would on the next heartbeat's free:true reply.
    if (status.free) {
      hideBadge();
      return;
    }
    updateBadge(status.locked ? 0 : status.remainingMs);
  }

  // Test hooks: the badge lives in a closed shadow root, and the loop state
  // is otherwise invisible from outside.
  function badgeText() {
    return badgeEl ? badgeEl.querySelector(".time").textContent : null;
  }
  function isRunning() {
    return running;
  }

  function showBadge() {
    if (badgeHost) return;
    badgeHost = document.createElement("div");
    badgeHost.style.cssText =
      "all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;pointer-events:none;";
    const shadow = badgeHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 12px; border-radius: 999px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums;
          color: #e7e7f0; background: rgba(20, 20, 31, 0.92);
          box-shadow: 0 4px 14px rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.10);
          transition: color 0.3s ease, border-color 0.3s ease;
        }
        .pill.warn { color: #fbbf24; border-color: rgba(251,191,36,0.4); }
        .pill.low  { color: #f87171; border-color: rgba(248,113,113,0.5); }
        .dot { font-size: 12px; }
        .label { opacity: 0.65; font-weight: 500; }
      </style>
      <div class="pill"><span class="dot">⏳</span><span class="time">–:––</span><span class="label">left today</span></div>
    `;
    document.documentElement.appendChild(badgeHost);
    badgeEl = shadow.querySelector(".pill");
  }

  function updateBadge(remainingMs) {
    if (!badgeEl || typeof remainingMs !== "number") return;
    badgeEl.querySelector(".time").textContent = fmtClock(remainingMs);
    const low = remainingMs <= 60000; // under a minute
    const warn = remainingMs <= 120000; // under two minutes
    badgeEl.className = "pill" + (low ? " low" : warn ? " warn" : "");
  }

  function hideBadge() {
    if (badgeHost) {
      badgeHost.remove();
      badgeHost = null;
      badgeEl = null;
    }
  }

  // Start whenever this is the visible, foreground tab. We intentionally don't
  // gate on document.hasFocus() — otherwise opening a browser menu/popup (which
  // steals focus but leaves the tab visible) would tear the timer down.
  function evaluate() {
    if (document.visibilityState === "visible") start();
  }

  // Pause only when the tab is actually hidden (switched away / minimized) — NOT
  // on a plain window blur, which fires for the extensions menu and our popup.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") evaluate();
    else stop();
  });
  window.addEventListener("focus", evaluate); // resume promptly on return

  // React to dashboard/options changes (site list, daily budget, or the
  // global schedule): re-enter so the reply reflects the new rules.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.focusSites || changes.budgetSeconds || changes.schedule) {
      stop();
      evaluate();
    }
    // Keep the badge's countdown current as usage/budget/schedule changes.
    if (changes.usage || changes.budgetSeconds || changes.schedule) refreshBadge();
  });

  // Kick things off on load.
  evaluate();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { fmtClock, todayKey, isEngaged, mediaPlaying, showBadge, hideBadge, refreshBadge, badgeText, isRunning, stop, evaluate };
  }
})();
