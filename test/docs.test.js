import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

// The Markdown makes concrete claims about the code (which pages carry a
// theme toggle, how many days of stats are kept, which permissions the
// manifest asks for, what value the per-site editor accepts, how many tests
// there are). None of that is visible to a behavioural test, so these checks
// read the docs and compare them with the real files/UI: when either side
// changes without the other, the suite turns red instead of the docs
// quietly drifting.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const parsePage = (p) => new JSDOM(read(p)).window.document;
const README = read("README.md");
const FLYER = read("FLYER.md");

// Same loader as options.test.js: options.js renders at import time into the
// real options.html markup.
let lastOpts = null;
async function loadOptions(initialStorage) {
  vi.resetModules();
  const page = parsePage("options.html");
  page.querySelectorAll("script").forEach((s) => s.remove());
  document.body.innerHTML = page.body.innerHTML;
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const opts = await import("../options.js");
  lastOpts = opts;
  await flush();
  return { opts, ...mock };
}

describe("README.md claims match the code", () => {
  afterEach(() => {
    if (lastOpts) lastOpts.stopRetick();
    lastOpts = null;
    vi.unstubAllGlobals();
  });

  it("the theme-toggle sentence names exactly the pages that have a .theme-toggle button", () => {
    // "…toggle (☀️/🌙) on the popup, Dashboard and stats pages; the block page…"
    const m = README.match(/\*\*Light\/dark theme\*\* toggle[^;]*/);
    expect(m, "README no longer has the theme-toggle sentence").not.toBeNull();
    const clause = m[0];
    const pages = {
      popup: "dashboard.html",
      Dashboard: "options.html",
      stats: "stats.html",
      "block page": "time-is-up.html"
    };
    for (const [name, file] of Object.entries(pages)) {
      const hasToggle = parsePage(file).querySelector(".theme-toggle") !== null;
      expect(clause.includes(name), `${file} ${hasToggle ? "has" : "has no"} toggle but README's toggle clause ${clause.includes(name) ? "names" : "omits"} "${name}"`).toBe(hasToggle);
    }
    // The block page is still described as following the theme, and does.
    expect(README).toMatch(/block page has no toggle but follows the same theme/);
    expect(parsePage("time-is-up.html").querySelector('head script[src="theme.js"]')).not.toBeNull();
  });

  it("the stats-retention claim (14-day log) equals background.js's STATS_DAYS in README and FLYER", async () => {
    vi.resetModules();
    vi.stubGlobal("chrome", createChromeMock({}).chrome);
    stubSharedGlobals(await import("../shared.js"));
    const bg = await import("../background.js");
    bg.cancelStatsFlushTimer();
    const days = bg.STATS_DAYS;
    expect(typeof days).toBe("number");
    const readmeDays = [...README.matchAll(/(\d+)-day (?:local )?log/g)].map((x) => Number(x[1]));
    const flyerDays = [...FLYER.matchAll(/(\d+)-day log/g)].map((x) => Number(x[1]));
    expect(readmeDays.length).toBeGreaterThan(0);
    expect(flyerDays.length).toBeGreaterThan(0);
    for (const n of [...readmeDays, ...flyerDays]) expect(n).toBe(days);
  });

  it("the quick-test budget the docs recommend is accepted by the per-site editor's min/step, and the cool-down field is whole minutes", async () => {
    const readmeBudget = README.match(/set its daily\s+budget to `([\d.]+)` min/);
    const flyerBudget = FLYER.match(/Set a site's budget to `([\d.]+)` minutes/);
    expect(readmeBudget, "README quick-test sentence missing").not.toBeNull();
    expect(flyerBudget, "FLYER quick-start sentence missing").not.toBeNull();

    const { opts } = await loadOptions({ onboarded: true, focusSites: [{ domain: "example.com", budgetSeconds: 1800 }] });
    opts.expanded.add("example.com");
    await opts.load();
    const editor = document.querySelector('#siteList li[data-domain="example.com"] .site-editor');
    const budget = editor.querySelector(".site-budget");
    const min = Number(budget.min);
    const step = Number(budget.step);
    expect(min).toBeGreaterThan(0);
    expect(step).toBeGreaterThan(0);
    for (const v of [Number(readmeBudget[1]), Number(flyerBudget[1])]) {
      expect(v).toBeGreaterThanOrEqual(min);
      // On the field's step grid (so the browser doesn't flag it :invalid).
      expect(Math.abs(v / step - Math.round(v / step))).toBeLessThan(1e-9);
    }
    // README's "0.5-min step" wording.
    expect(README).toContain(`the field's ${step}-min step`);
    // README Known gaps: the cool-down field takes whole minutes (minimum 1).
    const lockout = editor.querySelector(".lockout-min");
    expect(lockout.min).toBe("1");
    expect(lockout.step).toBe("1");
    expect(README).toMatch(/cool-down field takes whole minutes \(minimum 1\)/);
  });
});

describe("FLYER.md claims match the code", () => {
  it("the Permissions row names every manifest permission, including host access to every page", () => {
    const manifest = JSON.parse(read("manifest.json"));
    const row = FLYER.split("\n").find((l) => l.startsWith("| **Permissions** |"));
    expect(row).toBeDefined();
    const wording = {
      storage: /storage/i,
      webNavigation: /navigation/i,
      alarms: /alarms/i,
      nativeMessaging: /native messaging/i,
      "<all_urls>": /every page|all_urls/i
    };
    const declared = [...manifest.permissions, ...manifest.host_permissions];
    expect(declared).toEqual(expect.arrayContaining(["<all_urls>"]));
    for (const perm of declared) {
      expect(wording[perm], `no FLYER wording known for manifest permission "${perm}"`).toBeDefined();
      expect(row, `FLYER Permissions row omits "${perm}"`).toMatch(wording[perm]);
    }
  });

  it("the Tested row's 'N+ automated tests' is a true lower bound that is not stale by a hundred or more", () => {
    const m = FLYER.match(/\| \*\*Tested\*\* \| (\d+)\+ automated tests/);
    expect(m, "FLYER Tested row must read 'N+ automated tests'").not.toBeNull();
    const claimed = Number(m[1]);
    // Static count of it()/test() declarations — a lower bound on the real
    // total, since tests declared inside loops run more than once.
    let declared = 0;
    for (const f of readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.js"))) {
      declared += (read(join("test", f)).match(/^\s*(?:it|test)\(/gm) || []).length;
    }
    expect(claimed % 100, "round the claim down to a hundred").toBe(0);
    expect(declared).toBeGreaterThanOrEqual(claimed);
    expect(declared, `suite has grown to ${declared} tests; bump FLYER's "${claimed}+"`).toBeLessThan(claimed + 100);
  });
});
