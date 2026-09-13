import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// state-store.js resolves its STATE_DIR from os.homedir() at import time, so
// each test spies on homedir() to point at a throwaway directory *before*
// importing (fresh, via vi.resetModules()) — never touch the real ~/.focuscap.
describe("state-store.js", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "focuscap-test-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("readState() returns DEFAULT_STATE when no state file exists yet", async () => {
    const store = await import("../state-store.js");
    expect(store.readState()).toEqual(store.DEFAULT_STATE);
  });

  it("readState() tolerates a missing state directory entirely (not just a missing file)", async () => {
    const store = await import("../state-store.js");
    fs.rmSync(store.STATE_DIR, { recursive: true, force: true });
    expect(store.readState()).toEqual(store.DEFAULT_STATE);
  });

  it("readState() tolerates a corrupt (non-JSON) state file", async () => {
    const store = await import("../state-store.js");
    fs.mkdirSync(store.STATE_DIR, { recursive: true });
    fs.writeFileSync(store.STATE_FILE, "{not valid json");
    expect(store.readState()).toEqual(store.DEFAULT_STATE);
  });

  it("writeState() persists a patch that a later readState() picks up", async () => {
    const store = await import("../state-store.js");
    store.writeState({ locked: true, lastBlocked: "example.com" });

    const read = store.readState();
    expect(read.locked).toBe(true);
    expect(read.lastBlocked).toBe("example.com");
    expect(typeof read.updatedAt).toBe("number");
  });

  it("writeState() merges onto the previous state instead of replacing it wholesale", async () => {
    const store = await import("../state-store.js");
    store.writeState({ locked: true, lastBlocked: "example.com", budgetMs: 1_800_000 });
    const second = store.writeState({ locked: false });

    expect(second.locked).toBe(false);
    // Fields not touched by the second patch must survive from the first.
    expect(second.lastBlocked).toBe("example.com");
    expect(second.budgetMs).toBe(1_800_000);
  });

  it("writeState() bumps updatedAt on every call", async () => {
    const store = await import("../state-store.js");
    const first = store.writeState({ locked: true });
    const second = store.writeState({ locked: true });
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });
});
