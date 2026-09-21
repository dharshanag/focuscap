// Focus Cap companion corner pill — a small, non-blocking, always-on-top
// notice that a tracked site is currently locked. Deliberately NOT a
// full-screen lock: the extension's promise is "distraction *sites* are
// locked", not "your computer is locked", and without foreground-window
// detection the companion can't yet tell whether a tracked site is even in
// front of you. It only informs; it never covers your work.
async function refresh() {
  const state = await window.focusCap.getState();
  const domainEl = document.getElementById("domain");
  const labelEl = document.getElementById("label");
  if (state && state.lastBlocked) {
    domainEl.textContent = state.lastBlocked;
    labelEl.textContent = "is out of time today";
  } else {
    domainEl.textContent = "a tracked site";
    labelEl.textContent = "is out of time today";
  }
}

refresh();
setInterval(refresh, 2000);
