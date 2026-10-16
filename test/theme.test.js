import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createChromeMock } from "./helpers/chrome-mock.js";

// theme.js is an IIFE that registers document-level listeners the moment it
// runs, so every case gets a brand-new JSDOM window (fresh document,
// localStorage, and matchMedia) instead of re-importing into the shared
// test document -- otherwise each import would stack another click handler
// and a single toggle click would flip the theme twice.
function fakeMatchMedia(prefersDark) {
  const listeners = [];
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((type, fn) => listeners.push(fn)),
    addListener: vi.fn((fn) => listeners.push(fn))
  };
  return {
    matchMedia: vi.fn(() => mql),
    // Simulate the OS flipping its colour scheme.
    setPrefersDark(v) {
      mql.matches = v;
      listeners.forEach((fn) => fn({ matches: v }));
    }
  };
}

async function loadTheme({ prefersDark = true, storage = {}, cachedTheme = null, matchMedia = "stub", deferStorage = false } = {}) {
  vi.resetModules();
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body>
       <button class="theme-toggle" aria-label="Toggle light/dark">☀️</button>
     </body></html>`,
    // jsdom treats chrome-extension:// as an opaque origin (no localStorage),
    // so use a plain http origin; theme.js never looks at the URL.
    { url: "http://localhost/dashboard.html" }
  );
  const { window } = dom;
  const media = fakeMatchMedia(prefersDark);
  if (matchMedia === "stub") window.matchMedia = media.matchMedia;
  else window.matchMedia = undefined;
  if (cachedTheme) window.localStorage.setItem("fc_theme", cachedTheme);

  const mock = createChromeMock(storage);
  // Simulate chrome.storage still being in flight: never answer the read.
  if (deferStorage) mock.chrome.storage.local.get.mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("chrome", mock.chrome);

  await import("../theme.js");
  return { window, document: window.document, media, ...mock };
}

const themeOf = (document) => document.documentElement.getAttribute("data-theme");
const toggle = (document) => document.querySelector(".theme-toggle");

describe("theme.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("with no stored choice it follows prefers-color-scheme", () => {
    it("OS dark -> dark", async () => {
      const { document } = await loadTheme({ prefersDark: true });
      expect(themeOf(document)).toBe("dark");
    });

    it("OS light -> light", async () => {
      const { document } = await loadTheme({ prefersDark: false });
      expect(themeOf(document)).toBe("light");
    });

    it("follows the OS live while the user hasn't picked", async () => {
      const { document, media } = await loadTheme({ prefersDark: true });
      expect(themeOf(document)).toBe("dark");
      media.setPrefersDark(false);
      expect(themeOf(document)).toBe("light");
    });
  });

  it("a stored 'light' choice in chrome.storage wins over OS dark", async () => {
    const { document } = await loadTheme({ prefersDark: true, storage: { theme: "light" } });
    expect(themeOf(document)).toBe("light");
  });

  it("a cached localStorage choice applies instantly, before chrome.storage answers", async () => {
    const { document } = await loadTheme({ prefersDark: true, cachedTheme: "light", deferStorage: true });
    expect(themeOf(document)).toBe("light");
  });

  it("chrome.storage is authoritative: an empty store overrides a stale localStorage cache", async () => {
    const { document } = await loadTheme({ prefersDark: true, cachedTheme: "light", storage: {} });
    expect(themeOf(document)).toBe("dark");
  });

  it("an explicit choice is not overridden by a later OS change", async () => {
    // Start with the OS agreeing with the stored pick, then flip the OS to the
    // opposite value: the only thing keeping the theme on "dark" is the
    // "ignore OS changes once the user has chosen" guard.
    const { document, media } = await loadTheme({ prefersDark: true, storage: { theme: "dark" } });
    expect(themeOf(document)).toBe("dark");
    media.setPrefersDark(false);
    expect(themeOf(document)).toBe("dark");

    // And the mirror image: a stored "light" pick survives the OS going dark.
    const other = await loadTheme({ prefersDark: false, storage: { theme: "light" } });
    expect(themeOf(other.document)).toBe("light");
    other.media.setPrefersDark(true);
    expect(themeOf(other.document)).toBe("light");
  });

  describe("clicking .theme-toggle", () => {
    it("flips data-theme and persists to chrome.storage.local.theme and localStorage fc_theme", async () => {
      const { document, window, chrome, getStore } = await loadTheme({ prefersDark: true });
      expect(themeOf(document)).toBe("dark");

      toggle(document).click();
      expect(themeOf(document)).toBe("light");
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ theme: "light" });
      expect(getStore().theme).toBe("light");
      expect(window.localStorage.getItem("fc_theme")).toBe("light");

      toggle(document).click();
      expect(themeOf(document)).toBe("dark");
      expect(getStore().theme).toBe("dark");
      expect(window.localStorage.getItem("fc_theme")).toBe("dark");
    });

    it("the toggle advertises the mode you'll switch TO", async () => {
      const { document } = await loadTheme({ prefersDark: true });
      expect(toggle(document).textContent).toBe("☀️");
      expect(toggle(document).title).toBe("Switch to light mode");
      toggle(document).click();
      expect(toggle(document).textContent).toBe("🌙");
      expect(toggle(document).title).toBe("Switch to dark mode");
    });

    it("works for a toggle added after load (event delegation)", async () => {
      const { document } = await loadTheme({ prefersDark: true });
      toggle(document).remove();
      const late = document.createElement("button");
      late.className = "theme-toggle";
      document.body.appendChild(late);
      late.click();
      expect(themeOf(document)).toBe("light");
    });
  });

  describe("storage.onChanged from another page", () => {
    it("applies a new explicit theme live", async () => {
      const { document, listeners } = await loadTheme({ prefersDark: true });
      expect(listeners.onChanged.length).toBeGreaterThan(0);
      listeners.onChanged.forEach((fn) => fn({ theme: { oldValue: undefined, newValue: "light" } }, "local"));
      expect(themeOf(document)).toBe("light");
    });

    it("clearing the choice elsewhere falls back to the OS setting", async () => {
      const { document, listeners } = await loadTheme({ prefersDark: true, storage: { theme: "light" } });
      expect(themeOf(document)).toBe("light");
      listeners.onChanged.forEach((fn) => fn({ theme: { oldValue: "light", newValue: undefined } }, "local"));
      expect(themeOf(document)).toBe("dark");
    });

    it("ignores changes to other keys and other storage areas", async () => {
      const { document, listeners } = await loadTheme({ prefersDark: true });
      listeners.onChanged.forEach((fn) => fn({ budgetSeconds: { newValue: 5 } }, "local"));
      listeners.onChanged.forEach((fn) => fn({ theme: { newValue: "light" } }, "sync"));
      expect(themeOf(document)).toBe("dark");
    });
  });

  it("does not throw when matchMedia is undefined, and defaults to light", async () => {
    let loaded;
    await expect((async () => { loaded = await loadTheme({ matchMedia: "none" }); })()).resolves.toBeUndefined();
    expect(themeOf(loaded.document)).toBe("light");
    // The toggle still works without an OS hint.
    toggle(loaded.document).click();
    expect(themeOf(loaded.document)).toBe("dark");
  });
});
