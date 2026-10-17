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

  // Issue #16: state.json carries an explicit schema version.
  it("writeState() stamps every write with STATE_SCHEMA_VERSION, even if the patch tries to override it", async () => {
    const store = await import("../state-store.js");
    expect(store.STATE_SCHEMA_VERSION).toBe(1);
    expect(store.DEFAULT_STATE.schemaVersion).toBe(store.STATE_SCHEMA_VERSION);
    const written = store.writeState({ locked: true, schemaVersion: 42 });
    expect(written.schemaVersion).toBe(store.STATE_SCHEMA_VERSION);
    const onDisk = JSON.parse(fs.readFileSync(store.STATE_FILE, "utf8"));
    expect(onDisk.schemaVersion).toBe(store.STATE_SCHEMA_VERSION);
    expect(store.readState().schemaVersion).toBe(store.STATE_SCHEMA_VERSION);
  });

  it("readState() tolerates a state file written before schemaVersion existed (fills it in, keeps the data)", async () => {
    const store = await import("../state-store.js");
    fs.mkdirSync(store.STATE_DIR, { recursive: true });
    const legacy = { locked: true, remainingMs: 0, budgetMs: 60_000, focusSites: [], sites: { "example.com": { locked: true, reason: "lockout", until: 5, remainingMs: 0 } }, lastBlocked: "example.com", updatedAt: 1 };
    fs.writeFileSync(store.STATE_FILE, JSON.stringify(legacy));
    const read = store.readState();
    expect(read.schemaVersion).toBe(store.STATE_SCHEMA_VERSION);
    expect(read.locked).toBe(true);
    expect(read.sites).toEqual(legacy.sites);
    expect(read.lastBlocked).toBe("example.com");
    // The next write upgrades the file in place.
    store.writeState({ locked: false });
    expect(JSON.parse(fs.readFileSync(store.STATE_FILE, "utf8")).schemaVersion).toBe(store.STATE_SCHEMA_VERSION);
  });

  // Issue #10: the state file names the site the user was just blocked on;
  // keep it out of other local accounts' reach. Mode bits are meaningless on
  // Windows, where the calls are a documented no-op.
  it.skipIf(process.platform === "win32")("writeState() creates ~/.focuscap as 0700 and state.json as 0600, whatever the umask", async () => {
    const store = await import("../state-store.js");
    const prev = process.umask(0o022); // a permissive umask must not widen them
    try {
      store.writeState({});
    } finally {
      process.umask(prev);
    }
    expect(fs.statSync(store.STATE_DIR).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.STATE_FILE).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("writeState() tightens a pre-existing world-readable directory and file (mode is ignored for existing paths)", async () => {
    const store = await import("../state-store.js");
    fs.mkdirSync(store.STATE_DIR, { recursive: true, mode: 0o755 });
    fs.chmodSync(store.STATE_DIR, 0o755);
    fs.writeFileSync(store.STATE_FILE, JSON.stringify({ locked: false }), { mode: 0o644 });
    fs.chmodSync(store.STATE_FILE, 0o644);
    expect(fs.statSync(store.STATE_DIR).mode & 0o777).toBe(0o755);
    expect(fs.statSync(store.STATE_FILE).mode & 0o777).toBe(0o644);

    store.writeState({ locked: true });
    expect(fs.statSync(store.STATE_DIR).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.STATE_FILE).mode & 0o777).toBe(0o600);
    expect(store.readState().locked).toBe(true);
  });

  it.skipIf(process.platform === "win32")("writeState() still succeeds when chmod fails (the tightening is best-effort)", async () => {
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    try {
      const store = await import("../state-store.js");
      expect(() => store.writeState({ locked: true })).not.toThrow();
      expect(chmod).toHaveBeenCalled();
      expect(store.readState().locked).toBe(true);
    } finally {
      chmod.mockRestore();
    }
  });

  it("writeState() bumps updatedAt on every call", async () => {
    const store = await import("../state-store.js");
    const first = store.writeState({ locked: true });
    const second = store.writeState({ locked: true });
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });
});
