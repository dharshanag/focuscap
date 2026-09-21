import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the pure parsing/sanitizing functions are unit-tested here.
// native-host/host.js's actual write to the shared state file happens via a
// plain CJS require("../state-store") — since this file always runs as
// plain CJS (even under Chrome), that resolves through Node's own
// require.cache, which is a different cache than this test file's dynamic
// import()/vi.mock() machinery and isn't cleared by vi.resetModules(). That
// mismatch caused flaky, import-order-dependent failures when a test here
// tried to verify the writeState side effect directly. The real write path
// is instead covered by the manual end-to-end test in
// native-host/README.md (real wire-protocol bytes through the real host.js,
// checked against the real state file) — see also state-store.test.js for
// state-store.js's own read/write behavior in isolation.
describe("native-host/host.js", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("extractFrames()", () => {
    it("extracts a single complete frame and leaves no remainder", async () => {
      const host = await import("../native-host/host.js");
      const buf = host.encodeFrame({ a: 1 });
      const { frames, rest } = host.extractFrames(buf);
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0].toString("utf8"))).toEqual({ a: 1 });
      expect(rest.length).toBe(0);
    });

    it("extracts multiple frames packed into one chunk (Chrome can coalesce writes)", async () => {
      const host = await import("../native-host/host.js");
      const buf = Buffer.concat([host.encodeFrame({ n: 1 }), host.encodeFrame({ n: 2 })]);
      const { frames, rest } = host.extractFrames(buf);
      expect(frames.map((f) => JSON.parse(f.toString("utf8")))).toEqual([{ n: 1 }, { n: 2 }]);
      expect(rest.length).toBe(0);
    });

    it("leaves a partial trailing frame in `rest` instead of dropping or misparsing it", async () => {
      const host = await import("../native-host/host.js");
      const full = host.encodeFrame({ n: 1 });
      const partialNext = host.encodeFrame({ n: 2 }).subarray(0, 3); // header not even complete
      const buf = Buffer.concat([full, partialNext]);

      const { frames, rest } = host.extractFrames(buf);
      expect(frames.map((f) => JSON.parse(f.toString("utf8")))).toEqual([{ n: 1 }]);
      expect(rest.equals(partialNext)).toBe(true);
    });

    it("returns no frames and the whole buffer as rest when even the length header is incomplete", async () => {
      const host = await import("../native-host/host.js");
      const buf = Buffer.from([1, 2]); // less than the 4-byte length prefix
      const { frames, rest } = host.extractFrames(buf);
      expect(frames).toHaveLength(0);
      expect(rest.equals(buf)).toBe(true);
    });

    // Regression guard for a real gap an adversarial QA pass found: the
    // length check must compare against `4 + length` (header + body), not
    // just `length`. Get that wrong and a frame whose header is complete but
    // whose body is still a few bytes short gets silently treated as
    // "complete" — sliced short instead of held back in `rest` — corrupting
    // the stream's byte alignment for every frame after it.
    it("holds back a frame whose header is complete but whose body hasn't fully arrived, instead of misparsing it as complete", async () => {
      const host = await import("../native-host/host.js");
      const full = host.encodeFrame({ n: 1 });
      const buf = full.subarray(0, full.length - 2); // header intact, body short by 2 bytes

      const { frames, rest } = host.extractFrames(buf);
      expect(frames).toHaveLength(0);
      expect(rest.equals(buf)).toBe(true);
    });
  });

  describe("sanitizeStatePatch()", () => {
    it("passes through well-typed fields", async () => {
      const host = await import("../native-host/host.js");
      const patch = host.sanitizeStatePatch({
        locked: true,
        remainingMs: 5000,
        budgetMs: 1_800_000,
        focusSites: [{ domain: "example.com" }],
        lastBlocked: "example.com"
      });
      expect(patch).toEqual({
        locked: true,
        remainingMs: 5000,
        budgetMs: 1_800_000,
        focusSites: [{ domain: "example.com" }],
        lastBlocked: "example.com"
      });
    });

    it("drops wrong-typed fields instead of forwarding them to the shared state file", async () => {
      const host = await import("../native-host/host.js");
      const patch = host.sanitizeStatePatch({
        locked: "yes", // truthy -> coerced, since it's the one field only ever read as a boolean
        remainingMs: "soon", // not a number -> dropped
        budgetMs: null, // -> dropped
        focusSites: "not-an-array", // -> dropped
        lastBlocked: 12345 // not a string -> dropped
      });
      expect(patch).toEqual({ locked: true });
    });

    it("omits absent fields (partial patch) so a block-time {locked, lastBlocked} message can't wipe budget/sites reported earlier", async () => {
      const host = await import("../native-host/host.js");
      const patch = host.sanitizeStatePatch({ locked: true, lastBlocked: "example.com" });
      expect(patch).toEqual({ locked: true, lastBlocked: "example.com" });
      expect(patch).not.toHaveProperty("budgetMs");
      expect(patch).not.toHaveProperty("focusSites");
      expect(patch).not.toHaveProperty("remainingMs");
    });

    it("handles a completely empty/undefined message without throwing", async () => {
      const host = await import("../native-host/host.js");
      expect(host.sanitizeStatePatch(undefined)).toEqual({});
      expect(host.sanitizeStatePatch(null)).toEqual({});
      expect(host.sanitizeStatePatch("not an object")).toEqual({});
    });
  });
});
