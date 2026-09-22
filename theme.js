// Focus Cap — shared light/dark theme controller. Loaded in <head> on every
// page so the theme applies before paint. Resolution order:
//   1. an explicit choice the user made (stored in chrome.storage / localStorage)
//   2. otherwise the OS setting (prefers-color-scheme), followed live
// The choice is mirrored to localStorage for an instant, flash-free apply, and
// all extension pages share one origin so the preference stays consistent.

(function () {
  const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function systemTheme() {
    return mql && mql.matches ? "dark" : "light";
  }

  let userChoice = null; // explicit pick, or null to follow the system
  let current = systemTheme(); // the theme actually applied right now

  function iconFor(theme) {
    // Show the mode you'll switch TO.
    return theme === "light" ? "🌙" : "☀️";
  }

  function apply(theme) {
    current = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", current);
    document.querySelectorAll(".theme-toggle").forEach((b) => {
      b.textContent = iconFor(current);
      b.title = "Switch to " + (current === "light" ? "dark" : "light") + " mode";
    });
  }

  function resolve() {
    return userChoice || systemTheme();
  }

  function setTheme(theme) {
    userChoice = theme === "light" ? "light" : "dark";
    apply(userChoice);
    try { localStorage.setItem("fc_theme", userChoice); } catch (_) {}
    try { chrome.storage.local.set({ theme: userChoice }); } catch (_) {}
  }

  // 0) Apply the resolved default immediately so there's no flash.
  apply(resolve());

  // 1) Instant apply from the synchronous localStorage cache.
  try {
    const cached = localStorage.getItem("fc_theme");
    if (cached) { userChoice = cached; apply(cached); }
  } catch (_) {}

  // 2) Reconcile with the authoritative value in chrome.storage.
  try {
    chrome.storage.local.get("theme", ({ theme }) => {
      userChoice = theme || null;
      apply(resolve());
    });
  } catch (_) {}

  // Follow OS changes while the user hasn't made an explicit choice.
  if (mql) {
    const onSystemChange = () => { if (!userChoice) apply(systemTheme()); };
    if (mql.addEventListener) mql.addEventListener("change", onSystemChange);
    else if (mql.addListener) mql.addListener(onSystemChange);
  }

  // Re-apply once the DOM is ready so toggle buttons get their icon/title.
  document.addEventListener("DOMContentLoaded", () => apply(resolve()));

  // Keep every open page in sync when the theme changes anywhere.
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.theme) {
        userChoice = c.theme.newValue || null;
        apply(resolve());
      }
    });
  } catch (_) {}

  // Any element with class "theme-toggle" flips the theme (event delegation,
  // so buttons added after load still work).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".theme-toggle");
    if (btn) setTheme(current === "light" ? "dark" : "light");
  });
})();
