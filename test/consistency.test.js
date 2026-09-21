import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, stubSharedGlobals } from "./helpers/chrome-mock.js";
// Imported once, outside of any vi.resetModules() cycle, so every stub below
// points at the exact same todayKey/fmtClock function objects -- otherwise
// each vi.resetModules() + re-import of shared.js would hand back a distinct
// (if behaviorally identical) function, and the reference-equality
// assertions below would fail for a reason that has nothing to do with
// whether background.js/content.js/dashboard.js truly share one copy.
import * as shared from "../shared.js";

// --- Issue #4: todayKey()/fmtClock() are copy-pasted across three files ---
// https://github.com/dharshanag/focuscap/issues/5
//
// background.js, content.js, and dashboard.js now all delegate to the single
// shared.js implementation instead of keeping their own copies, so this test
// asserts not just that outputs match but that they're literally the same
// function reference — proving there's one source of truth, not just
// currently-matching independent copies. If someone edits the day-key or
// clock format in shared.js, this test should be the thing that turns red
// if a file falls out of sync (e.g. by reintroducing a local copy).
describe("todayKey()/fmtClock() stay consistent across background.js, dashboard.js, content.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubShared() {
    stubSharedGlobals(shared);
  }

  it("todayKey() produces the same string in every copy", async () => {
    vi.resetModules();
    vi.stubGlobal("chrome", createChromeMock({}).chrome);
    stubShared();
    const bg = await import("../background.js");

    vi.resetModules();
    document.body.innerHTML = `
      <form id="addForm"><input id="domainInput" /></form>
      <input id="budgetInput" /><input id="idleInput" />
      <ul id="siteList"></ul><span id="statusPill"></span>
      <div id="remaining"></div><div id="barFill"></div><div id="budgetNote"></div>
    `;
    vi.stubGlobal("chrome", createChromeMock({}).chrome);
    stubShared();
    const dash = await import("../dashboard.js");

    vi.resetModules();
    vi.stubGlobal("chrome", createChromeMock({}).chrome);
    stubShared();
    const content = await import("../content.js");

    expect(dash.todayKey()).toBe(bg.todayKey());
    expect(content.todayKey()).toBe(bg.todayKey());

    // Not just equal output — the same underlying function, proving all
    // three files delegate to shared.js rather than keeping their own copy.
    expect(dash.todayKey).toBe(bg.todayKey);
    expect(content.todayKey).toBe(bg.todayKey);
  });

  it("fmtClock() formats the same ms value identically in dashboard.js and content.js", async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <form id="addForm"><input id="domainInput" /></form>
      <input id="budgetInput" /><input id="idleInput" />
      <ul id="siteList"></ul><span id="statusPill"></span>
      <div id="remaining"></div><div id="barFill"></div><div id="budgetNote"></div>
    `;
    vi.stubGlobal("chrome", createChromeMock({}).chrome);
    stubShared();
    const dash = await import("../dashboard.js");

    vi.resetModules();
    vi.stubGlobal("chrome", createChromeMock({}).chrome);
    stubShared();
    const content = await import("../content.js");

    for (const ms of [0, 1000, 59_000, 61_500, 3_599_000]) {
      expect(content.fmtClock(ms)).toBe(dash.fmtClock(ms));
    }

    // Same underlying function, not just matching output.
    expect(content.fmtClock).toBe(dash.fmtClock);
  });
});
