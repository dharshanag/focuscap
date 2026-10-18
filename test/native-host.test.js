import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

  // Issue #16 / #12 phase 1: every reply names the host and protocol version.
  describe("buildReply()", () => {
    it("a successful frame is answered with { ok: true, version, protocolVersion }", async () => {
      const host = await import("../native-host/host.js");
      expect(host.PROTOCOL_VERSION).toBe(1);
      expect(host.HOST_VERSION).toBe(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version);
      expect(host.buildReply(null)).toEqual({ ok: true, version: host.HOST_VERSION, protocolVersion: host.PROTOCOL_VERSION });
      // The reply is what goes on the wire, so it must survive encodeFrame().
      const { frames } = host.extractFrames(host.encodeFrame(host.buildReply(null)));
      expect(JSON.parse(frames[0].toString("utf8"))).toEqual({ ok: true, version: host.HOST_VERSION, protocolVersion: 1 });
    });

    // Issue #9: the error string on the wire is fixed. An fs error's message
    // carries the absolute state-file path (and so the OS username); a
    // JSON.parse error echoes the input. Neither may leave the machine.
    it("a failed frame keeps the { ok: false, error } shape (plus the versions) with a fixed generic error, never err.message", async () => {
      const host = await import("../native-host/host.js");
      expect(host.GENERIC_ERROR).toBe("internal error");
      const reply = host.buildReply(new Error("ENOENT: open '/home/alice/.focuscap/state.json'"));
      expect(reply).toEqual({
        ok: false,
        error: "internal error",
        version: host.HOST_VERSION,
        protocolVersion: host.PROTOCOL_VERSION
      });
      expect(reply.error).not.toMatch(/alice|\.focuscap|\//);
      // Non-Error throwables (a thrown string, even an empty one) are
      // failures too — not "undefined", not the string itself, not ok: true.
      expect(host.buildReply("string-throw").error).toBe("internal error");
      expect(host.buildReply("").ok).toBe(false);
      expect(host.buildReply(0).ok).toBe(false);
      expect(host.buildReply(null).ok).toBe(true);
      expect(host.buildReply(undefined).ok).toBe(true);
    });
  });

  // Issue #9: the per-frame handler, driven without stdin. `writeState` is
  // injected so the real state file is never touched (and so the CJS
  // require-cache mismatch described at the top of this file never bites).
  describe("handleFrame()", () => {
    const decode = (host, reply) => JSON.parse(host.extractFrames(host.encodeFrame(reply)).frames[0].toString("utf8"));

    it("answers a valid frame with ok: true and hands writeState the sanitized patch", async () => {
      const host = await import("../native-host/host.js");
      const writeState = vi.fn();
      const log = vi.fn();
      const frame = host.extractFrames(host.encodeFrame({ locked: true, lastBlocked: "example.com", junk: 1 })).frames[0];
      const reply = host.handleFrame(frame, { writeState, log });
      expect(reply).toEqual({ ok: true, version: host.HOST_VERSION, protocolVersion: host.PROTOCOL_VERSION });
      expect(writeState).toHaveBeenCalledWith({ locked: true, lastBlocked: "example.com" });
      expect(log).not.toHaveBeenCalled();
    });

    it("a writeState() fs error decodes to the generic error on the wire; the path only reaches the (stderr) log", async () => {
      const host = await import("../native-host/host.js");
      const writeState = vi.fn(() => {
        throw new Error("ENOENT: open '/home/alice/.focuscap/state.json'");
      });
      const log = vi.fn();
      const frame = host.extractFrames(host.encodeFrame({ locked: true })).frames[0];
      const reply = decode(host, host.handleFrame(frame, { writeState, log }));
      expect(reply).toEqual({ ok: false, error: "internal error", version: host.HOST_VERSION, protocolVersion: host.PROTOCOL_VERSION });
      expect(reply.error).not.toMatch(/alice|\.focuscap|\//);
      expect(JSON.stringify(reply)).not.toMatch(/alice|\.focuscap|ENOENT|state\.json/);
      // The detail is still available locally for debugging.
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(/ENOENT: open '\/home\/alice\/\.focuscap\/state\.json'/);
    });

    it("a thrown string (non-Error throwable) is still the generic error, not 'undefined' or the string", async () => {
      const host = await import("../native-host/host.js");
      const writeState = vi.fn(() => {
        throw "string-throw"; // eslint-disable-line no-throw-literal
      });
      const log = vi.fn();
      const frame = host.extractFrames(host.encodeFrame({ locked: true })).frames[0];
      const reply = decode(host, host.handleFrame(frame, { writeState, log }));
      expect(reply.ok).toBe(false);
      expect(reply.error).toBe("internal error");
      expect(log.mock.calls[0][0]).toContain("string-throw");
    });

    // QA of #9: an Error whose .stack/.message getters throw used to escape
    // the catch and take the whole stdio loop down (host exit 1).
    it("a throwable whose stack/message getters throw, or a throwing logger, still yields the generic reply", async () => {
      const host = await import("../native-host/host.js");
      const evil = new Error("x");
      Object.defineProperty(evil, "stack", { get() { throw new Error("getter boom"); } });
      Object.defineProperty(evil, "message", { get() { throw new Error("getter boom"); } });
      const frame = host.extractFrames(host.encodeFrame({ locked: true })).frames[0];
      const log = vi.fn();
      const reply = decode(host, host.handleFrame(frame, { writeState: () => { throw evil; }, log }));
      expect(reply).toMatchObject({ ok: false, error: "internal error" });
      expect(log.mock.calls[0][0]).toContain("(unprintable error)");

      const throwingLog = () => { throw new Error("logger down"); };
      const reply2 = decode(host, host.handleFrame(frame, { writeState: () => { throw new Error("boom"); }, log: throwingLog }));
      expect(reply2).toMatchObject({ ok: false, error: "internal error" });
    });

    it("a malformed JSON frame gets the generic error (no SyntaxError echo) and the next valid frame on the same loop gets ok: true", async () => {
      const host = await import("../native-host/host.js");
      const writeState = vi.fn();
      const log = vi.fn();
      const body = Buffer.from("{not json", "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      const stream = Buffer.concat([header, body, host.encodeFrame({ locked: false })]);
      const { frames } = host.extractFrames(stream);
      expect(frames).toHaveLength(2);
      const replies = frames.map((f) => decode(host, host.handleFrame(f, { writeState, log })));
      expect(replies[0]).toEqual({ ok: false, error: "internal error", version: host.HOST_VERSION, protocolVersion: host.PROTOCOL_VERSION });
      expect(JSON.stringify(replies[0])).not.toMatch(/SyntaxError|Unexpected token|not json/);
      expect(replies[1]).toEqual({ ok: true, version: host.HOST_VERSION, protocolVersion: host.PROTOCOL_VERSION });
      expect(writeState).toHaveBeenCalledTimes(1);
      expect(writeState).toHaveBeenCalledWith({ locked: false });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(/SyntaxError|JSON/);
    });

    it("logs through console.error (stderr) when no logger is injected", async () => {
      const host = await import("../native-host/host.js");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const reply = host.handleFrame(Buffer.from("{not json", "utf8"), { writeState: vi.fn() });
        expect(reply.ok).toBe(false);
        expect(reply.error).toBe("internal error");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatch(/frame failed/);
      } finally {
        spy.mockRestore();
      }
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
        // A bare { domain } entry is filled with the SITE_DEFAULTS values
        // shared.js's normalizeSite() would use.
        focusSites: [{ domain: "example.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] }],
        lastBlocked: "example.com"
      });
    });

    // Issue #18: focusSites used to pass through on Array.isArray() alone.
    it("sanitizeStatePatch() keeps only {domain, budgetSeconds, lockoutSeconds, rules} per focusSites entry", async () => {
      const host = await import("../native-host/host.js");
      // The exact frame from the issue's TC4 table.
      const patch = host.sanitizeStatePatch({
        focusSites: [
          { domain: "a.com", budgetSeconds: "x", evil: 1, rules: "nope" },
          "junk",
          null,
          { domain: 5 },
          { domain: "b.com", budgetSeconds: 60, lockoutSeconds: null, rules: [] }
        ]
      });
      expect(patch).toEqual({
        focusSites: [
          { domain: "a.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [] },
          { domain: "b.com", budgetSeconds: 60, lockoutSeconds: null, rules: [] }
        ]
      });
      expect(JSON.stringify(patch)).not.toContain("evil");
      for (const site of patch.focusSites) {
        expect(Object.keys(site).sort()).toEqual(["budgetSeconds", "domain", "lockoutSeconds", "rules"]);
        expect(Array.isArray(site.rules)).toBe(true);
      }
    });

    it("sanitizeFocusSites() applies normalizeSite()'s semantics: negative budget and non-positive cool-down fall back, rules keep only plain objects", async () => {
      const host = await import("../native-host/host.js");
      expect(host.sanitizeFocusSites([
        { domain: "a.com", budgetSeconds: -5, lockoutSeconds: 0, rules: [{ type: "block" }, "x", null, [1]] },
        { domain: "b.com", budgetSeconds: 0, lockoutSeconds: 900 },
        { domain: "" },
        [],
        42
      ])).toEqual([
        { domain: "a.com", budgetSeconds: 1800, lockoutSeconds: null, rules: [{ type: "block" }] },
        { domain: "b.com", budgetSeconds: 0, lockoutSeconds: 900, rules: [] }
      ]);
      expect(host.sanitizeStatePatch({ focusSites: [] })).toEqual({ focusSites: [] });
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

    it("passes through a per-site lock snapshot with only known, sane fields", async () => {
      const host = await import("../native-host/host.js");
      const patch = host.sanitizeStatePatch({
        locked: true,
        sites: {
          "youtube.com": { locked: true, reason: "lockout", until: 1_000, remainingMs: 0, extra: "dropped" },
          "reddit.com": { locked: false, reason: null, until: null, remainingMs: 5_000 },
          "bad.example": "not-an-object",
          "": { locked: true }
        }
      });
      expect(patch).toEqual({
        locked: true,
        sites: {
          "youtube.com": { locked: true, reason: "lockout", until: 1_000, remainingMs: 0 },
          "reddit.com": { locked: false, reason: null, until: null, remainingMs: 5_000 }
        }
      });
    });

    // Issue #18: the snapshot map is keyed by extension-supplied domains, so
    // a key named "__proto__" has to be an own entry, not a prototype swap.
    it("sanitizeSites() returns a null-prototype map, so a \"__proto__\" key is an own entry and Object.prototype is untouched", async () => {
      const host = await import("../native-host/host.js");
      const out = host.sanitizeSites(JSON.parse('{"__proto__":{"locked":true},"example.com":{"locked":false}}'));
      expect(Object.getPrototypeOf(out)).toBeNull();
      expect(Object.hasOwn(out, "__proto__")).toBe(true);
      expect(out["__proto__"]).toEqual({ locked: true, reason: null, until: null, remainingMs: 0 });
      expect(({}).locked).toBeUndefined();
      expect(Object.prototype.locked).toBeUndefined();
      // Still round-trips as plain JSON for the state file.
      expect(JSON.parse(JSON.stringify(out))["example.com"]).toEqual({ locked: false, reason: null, until: null, remainingMs: 0 });
    });

    it("ignores a `sites` value that isn't a plain object", async () => {
      const host = await import("../native-host/host.js");
      expect(host.sanitizeStatePatch({ sites: ["youtube.com"] })).toEqual({});
      expect(host.sanitizeStatePatch({ sites: "youtube.com" })).toEqual({});
      expect(host.sanitizeStatePatch({ sites: null })).toEqual({});
    });

    it("handles a completely empty/undefined message without throwing", async () => {
      const host = await import("../native-host/host.js");
      expect(host.sanitizeStatePatch(undefined)).toEqual({});
      expect(host.sanitizeStatePatch(null)).toEqual({});
      expect(host.sanitizeStatePatch("not an object")).toEqual({});
    });
  });
});
