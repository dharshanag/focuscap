import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, flush, stubSharedGlobals } from "./helpers/chrome-mock.js";

// content.js captures location.hostname at load; under jsdom that's
// "localhost", so the tracked site in these tests is "localhost".
async function loadContent(initialStorage) {
  vi.resetModules();
  document.body.innerHTML = "";
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const content = await import("../content.js");
  await flush();
  return { content, ...mock };
}

function localTodayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("content.js badge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows THIS site's remaining time (tighter of its own budget and the global cap), not the global total", async () => {
    const { content } = await loadContent({
      focusSites: [
        { domain: "localhost", budgetSeconds: 600 },
        { domain: "other.example", budgetSeconds: 60 }
      ],
      budgetSeconds: 3600,
      usage: {
        date: localTodayKey(),
        totalMs: 200_000, // global usage includes time on other sites
        sites: { localhost: { totalMs: 60_000 }, "other.example": { totalMs: 140_000 } }
      }
    });
    content.showBadge();
    await content.refreshBadge();
    // 600s budget - 60s used = 9:00, even though 200s of global usage exists
    expect(content.badgeText()).toBe("9:00");
  });

  it("caps the badge by the global cap when that's the tighter limit", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "localhost", budgetSeconds: 3600 }],
      budgetSeconds: 300,
      usage: { date: localTodayKey(), totalMs: 120_000, sites: { localhost: { totalMs: 120_000 } } }
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("3:00");
  });

  it("shows 0:00 while the site is locked (the redirect is already in flight)", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "localhost", budgetSeconds: 60 }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 60_000, sites: { localhost: { totalMs: 60_000 } } }
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("0:00");
  });

  it("leaves the badge untouched when this page isn't a tracked site", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "other.example" }],
      budgetSeconds: 3600
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("–:––"); // initial placeholder
  });

  it("degrades safely on malformed storage (non-array focusSites, non-numeric budgetSeconds)", async () => {
    const bad = await loadContent({ focusSites: "not-an-array", budgetSeconds: 3600 });
    bad.content.showBadge();
    await expect(bad.content.refreshBadge()).resolves.toBeUndefined();
    expect(bad.content.badgeText()).toBe("–:––");

    const nan = await loadContent({
      focusSites: [{ domain: "localhost", budgetSeconds: 600 }],
      budgetSeconds: "lots",
      usage: { date: localTodayKey(), totalMs: 0, sites: {} }
    });
    nan.content.showBadge();
    await nan.content.refreshBadge();
    expect(nan.content.badgeText()).toBe("10:00"); // falls back to the default cap, never "NaN:NaN"
  });

  it("handles a legacy usage record (no sites map) and a legacy { domain } site", async () => {
    const { content } = await loadContent({
      focusSites: [{ domain: "localhost" }],
      budgetSeconds: 3600,
      usage: { date: localTodayKey(), totalMs: 0 }
    });
    content.showBadge();
    await content.refreshBadge();
    expect(content.badgeText()).toBe("30:00"); // SITE_DEFAULTS budget
  });
});
