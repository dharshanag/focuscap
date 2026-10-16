import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// Static wiring checks for things no behavioural test can see: the real HTML
// pages (dashboard.test.js mounts a synthetic DOM), the manifest (never read
// by the extension's JS), and dashboard.css (never loaded in jsdom). Each of
// these is a "breaks at load time in the browser, suite still green" class
// of regression, so the assertions are deliberately literal.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const parsePage = (p) => new JSDOM(read(p)).window.document;

describe("manifest.json", () => {
  const manifest = JSON.parse(read("manifest.json"));

  it("declares icons {16,32,48,128} and action.default_icon {16,32} as on main", () => {
    expect(manifest.icons).toEqual({
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png"
    });
    expect(manifest.action.default_icon).toEqual({
      16: "icons/icon16.png",
      32: "icons/icon32.png"
    });
  });

  it("every declared icon path resolves to a real PNG on disk", () => {
    const paths = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
    for (const p of paths) {
      expect(existsSync(join(root, p)), `${p} missing`).toBe(true);
      // PNG magic bytes -- catches an empty/placeholder file, not just a missing one.
      const head = readFileSync(join(root, p)).subarray(0, 8);
      expect(head.toString("hex"), `${p} is not a PNG`).toBe("89504e470d0a1a0a");
    }
  });

  it("keeps the gopinaath key, permissions, and content_scripts intact", () => {
    expect(typeof manifest.key).toBe("string");
    expect(manifest.permissions).toEqual(["storage", "webNavigation", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].js).toEqual(["shared.js", "content.js"]);
    expect(manifest.action.default_popup).toBe("dashboard.html");
    expect(manifest.background.service_worker).toBe("background.js");
  });
});

describe("theme.js page wiring", () => {
  for (const page of ["dashboard.html", "time-is-up.html"]) {
    it(`${page} loads theme.js in <head> before any other script`, () => {
      const doc = parsePage(page);
      const scripts = [...doc.querySelectorAll("script")];
      expect(scripts.length, "no <script> tags at all").toBeGreaterThan(0);
      const first = scripts[0];
      expect(first.getAttribute("src")).toBe("theme.js");
      expect(first.closest("head"), "theme.js must be in <head> so the theme applies before paint").not.toBeNull();
      expect(scripts.filter((s) => s.getAttribute("src") === "theme.js")).toHaveLength(1);
    });
  }

  it("theme.js exists and is a plain script (no import/export)", () => {
    const src = read("theme.js");
    expect(src).not.toMatch(/^\s*(import|export)\b/m);
    expect(src).toContain('matchMedia("(prefers-color-scheme: dark)")');
  });

  it("dashboard.html has exactly one .theme-toggle button inside the popup header", () => {
    const doc = parsePage("dashboard.html");
    const toggles = doc.querySelectorAll(".theme-toggle");
    expect(toggles).toHaveLength(1);
    const btn = toggles[0];
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.closest("header")).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBeTruthy();
  });

  it("dashboard.html still loads shared.js before dashboard.js (bare-global order)", () => {
    const srcs = [...parsePage("dashboard.html").querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
    expect(srcs.indexOf("shared.js")).toBeGreaterThan(-1);
    expect(srcs.indexOf("shared.js")).toBeLessThan(srcs.indexOf("dashboard.js"));
  });
});

describe("light-theme CSS overrides", () => {
  // Pull the custom properties declared in a `selector { ... }` block.
  function varsIn(css, selectorRe) {
    const m = css.match(new RegExp(selectorRe.source + "\\s*\\{([^}]*)\\}"));
    if (!m) return null;
    return new Set([...m[1].matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]));
  }

  it("dashboard.css: :root[data-theme=\"light\"] redefines every variable the dark :root declares", () => {
    const css = read("dashboard.css");
    const dark = varsIn(css, /:root/);
    const light = varsIn(css, /:root\[data-theme="light"\]/);
    expect(light, "missing :root[data-theme=\"light\"] block").not.toBeNull();
    expect(dark.size).toBeGreaterThan(0);
    for (const v of dark) expect(light.has(v), `${v} has no light-mode value`).toBe(true);
    // main's variable set, which gopinaath adopts on top of its own.
    for (const v of ["--bg", "--panel", "--text", "--muted", "--accent", "--danger", "--green", "--edge", "--hover"]) {
      expect(dark.has(v), `${v} missing from dark :root`).toBe(true);
    }
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
  });

  it("dashboard.css: component colours come from theme variables, not literal tints", () => {
    const css = read("dashboard.css");
    // Strip the two :root blocks, then nothing else may hard-code a colour.
    const body = css.replace(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g, "");
    const literals = body.match(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/gi) || [];
    expect(literals, "hard-coded colours outside :root").toEqual([]);
  });

  it("time-is-up.html: inline light-theme vars mirror the dark :root set", () => {
    const html = read("time-is-up.html");
    const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
    expect(style, "no inline <style>").toBeTruthy();
    const dark = varsIn(style, /:root/);
    const light = varsIn(style, /:root\[data-theme="light"\]/);
    expect(light, "missing :root[data-theme=\"light\"] block").not.toBeNull();
    for (const v of dark) expect(light.has(v), `${v} has no light-mode value`).toBe(true);
  });
});
