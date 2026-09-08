// Focus Cap — content script (runs on every top-level page).
// Sole job: measure genuine engagement time on distraction sites and report it.
// Time only counts while the tab is visible, the window is focused, and you're
// not idle. Enforcement (redirecting to the blocked page) lives in background.js.

(() => {
  const hostname = location.hostname;

  let running = false;
  let loop = null;
  let lastInputAt = Date.now();
  let settings = { idleSeconds: 45 };
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
    // Must be the tab you're actually looking at, in a focused window.
    // (A backgrounded music tab is hidden → never counts. That case still holds.)
    if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
    // Recent interaction counts...
    if (Date.now() - lastInputAt < settings.idleSeconds * 1000) return true;
    // ...and so does passively watching a playing video in the foreground.
    return mediaPlaying();
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
    if (!res || !res.track) return; // not a distraction site
    settings = res.settings || settings;
    running = true;
    showBadge();
    refreshBadge();
    loop = setInterval(tick, 1000);
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
    // Idle / hidden / unfocused → pause counting, but stay attached.
    if (!isEngaged()) return;
    const res = await send("heartbeat");
    if (!res || !res.track) {
      stop();
      return;
    }
    settings = res.settings || settings;
    refreshBadge();
    // If res.overlay is true, background is already redirecting this tab away.
  }

  // ---- Corner badge: how much daily time is left on this site ----

  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  // Compute remaining daily time straight from storage — independent of the
  // message reply, so the badge is robust to background/version mismatches.
  async function refreshBadge() {
    if (!badgeEl) return;
    let store;
    try {
      store = await chrome.storage.local.get(["budgetSeconds", "usage"]);
    } catch (_) {
      return; // extension context invalidated
    }
    const budgetMs = (store.budgetSeconds ?? 1800) * 1000;
    const usage = store.usage;
    const usedMs = usage && usage.date === todayKey() ? usage.totalMs || 0 : 0;
    updateBadge(Math.max(0, budgetMs - usedMs));
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

  // Only bother starting when the page is actually in front of the user.
  function evaluate() {
    if (document.visibilityState === "visible" && document.hasFocus()) start();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") evaluate();
    else stop();
  });
  window.addEventListener("blur", stop); // switched to another app
  window.addEventListener("focus", evaluate);

  // React to dashboard changes (site list or daily budget edits).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.focusSites || changes.budgetSeconds) {
      stop();
      evaluate();
    }
    // Keep the badge's countdown current as usage/budget changes.
    if (changes.usage || changes.budgetSeconds) refreshBadge();
  });

  // Kick things off on load.
  evaluate();
})();
