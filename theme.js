// Focus Cap — shared light/dark theme controller. Loaded in <head> on every
// page so the theme applies before paint. The choice is stored in
// chrome.storage.local ("theme") and mirrored to localStorage for an
// instant, flash-free apply on repeat visits. All extension pages share one
// origin, so the preference is consistent everywhere.

(function () {
  let current = "dark";

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

  function setTheme(theme) {
    apply(theme);
    try { localStorage.setItem("fc_theme", current); } catch (_) {}
    try { chrome.storage.local.set({ theme: current }); } catch (_) {}
  }

  // 1) Instant apply from the synchronous localStorage cache (no flash).
  try {
    const cached = localStorage.getItem("fc_theme");
    if (cached) apply(cached);
  } catch (_) {}

  // 2) Reconcile with the authoritative value in chrome.storage.
  try {
    chrome.storage.local.get("theme", ({ theme }) => apply(theme || current));
  } catch (_) {}

  // Re-apply once the DOM is ready so toggle buttons get their icon/title.
  document.addEventListener("DOMContentLoaded", () => apply(current));

  // Keep every open page in sync when the theme changes anywhere.
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.theme) apply(c.theme.newValue || "dark");
    });
  } catch (_) {}

  // Any element with class "theme-toggle" flips the theme (event delegation,
  // so buttons added after load still work).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".theme-toggle");
    if (btn) setTheme(current === "light" ? "dark" : "light");
  });
})();
