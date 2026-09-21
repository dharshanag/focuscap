import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, stubSharedGlobals } from "./helpers/chrome-mock.js";

// dashboard.js wires up its DOM listeners and calls load() as soon as it's
// imported, so the required elements + chrome mock must exist first.
function mountDashboardDom() {
  document.body.innerHTML = `
    <form id="addForm"><input id="domainInput" /></form>
    <input id="budgetInput" />
    <input id="idleInput" />
    <ul id="siteList"></ul>
    <span id="statusPill"></span>
    <div id="remaining"></div>
    <div id="barFill"></div>
    <div id="budgetNote"></div>
  `;
}

async function loadDashboard(initialStorage) {
  vi.resetModules();
  mountDashboardDom();
  const mock = createChromeMock(initialStorage);
  vi.stubGlobal("chrome", mock.chrome);
  stubSharedGlobals(await import("../shared.js"));
  const dash = await import("../dashboard.js");
  return { dash, ...mock };
}

describe("dashboard.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- Issue #2: parseInt(...) || default treats an explicit 0 as falsy ---
  // https://github.com/dharshanag/focuscap/issues/2
  it("saving idleSeconds=0 should clamp to the 5s minimum, not silently reset to the 45s default", async () => {
    const { dash, getStore } = await loadDashboard({});

    document.getElementById("idleInput").value = "0";
    await dash.saveSettings();

    const { settings } = getStore();
    // removalLocked-style clamping intent per the source comment: Math.max(5, value).
    expect(settings.idleSeconds).toBe(5);
  });

  it("saves a normal idleSeconds value unchanged", async () => {
    const { dash, getStore } = await loadDashboard({});

    document.getElementById("idleInput").value = "30";
    await dash.saveSettings();

    const { settings } = getStore();
    expect(settings.idleSeconds).toBe(30);
  });

  it("removalLocked() forbids removal once locked or within the last 5 minutes of budget", async () => {
    const { dash } = await loadDashboard({});
    const budgetMs = 30 * 60 * 1000;
    expect(dash.removalLocked(budgetMs, budgetMs)).toBe(true); // fully locked
    expect(dash.removalLocked(budgetMs - 60_000, budgetMs)).toBe(true); // 1 min left
    expect(dash.removalLocked(budgetMs - 10 * 60_000, budgetMs)).toBe(false); // 10 min left
  });

  it("normalizeDomain() strips protocol, www, path, and port", async () => {
    const { dash } = await loadDashboard({});
    expect(dash.normalizeDomain("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(dash.normalizeDomain("reddit.com:443/r/all")).toBe("reddit.com");
  });
});
