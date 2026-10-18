#!/usr/bin/env node
// Focus Cap — real-browser end-to-end harness.
//
// Launches the REAL Chrome binary given with --chrome (headless by default),
// loads the extension (unpacked through DevTools' Extensions.loadUnpacked, or
// a policy-installed packed build with --packed), serves a throwaway site on
// localhost, and walks the lock → native host → unlock chain, writing one
// machine-readable JSON report to --out. Every check keeps going after a
// failure; the exit code is 1 if any check fails. See README.md.
//
// Only puppeteer-core is used (no browser download): the browser under test
// is always the one you point --chrome at.

import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HOST_NAME = "com.focuscap.host";
const CONSOLE_CANARY = "focuscap-e2e console canary";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- CLI -------------------------------------------------------------------

const { values: argv } = parseArgs({
  options: {
    chrome: { type: "string" },
    repo: { type: "string", default: path.resolve(SCRIPT_DIR, "..") },
    home: { type: "string" },
    "user-data-dir": { type: "string" },
    out: { type: "string" },
    "budget-seconds": { type: "string", default: "5" },
    "lockout-seconds": { type: "string", default: "20" },
    port: { type: "string", default: "8765" },
    packed: { type: "boolean", default: false },
    "extension-id": { type: "string", default: "oladakapegoiphmpicedkgnieanibbbe" },
    "no-sandbox": { type: "boolean", default: false },
    headless: { type: "boolean", default: true },
    headed: { type: "boolean", default: false },
    skip: { type: "string", default: "" },
    "timeout-ms": { type: "string", default: "90000" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  },
  strict: true
});

function usage() {
  return [
    "Usage: node run.mjs --chrome <browser binary> --home <dir> --user-data-dir <dir> --out <report.json> [options]",
    "",
    "  --chrome <path>          the real browser binary to launch (required)",
    "  --repo <dir>             extension root (default: the parent of this script)",
    "  --home <dir>             HOME / USERPROFILE handed to Chrome, so the spawned native host",
    "                           writes <home>/.focuscap/state.json there (required)",
    "  --user-data-dir <dir>    Chrome profile directory; use a fresh one per run (required)",
    "  --out <file>             where to write the JSON report (required)",
    "  --budget-seconds <n>     per-site budget for the localhost fixture (default 5)",
    "  --lockout-seconds <n>    cool-down after the budget is spent (default 20)",
    "  --port <n>               local HTTP fixture port (default 8765)",
    "  --packed                 expect a policy-installed packed build instead of loading unpacked",
    "  --extension-id <id>      expected extension ID (default oladakapegoiphmpicedkgnieanibbbe)",
    "  --no-sandbox             add --no-sandbox (needed as root on Linux)",
    "  --headed                 show a window (default: headless)",
    "  --skip <ids>             comma-separated check ids to skip",
    "  --timeout-ms <n>         per-check cap and browser launch timeout (default 90000)",
    "  --verbose                echo Chrome's own stderr (native messaging errors show there)",
    ""
  ].join("\n");
}

if (argv.help) {
  process.stdout.write(usage());
  process.exit(0);
}
for (const required of ["chrome", "home", "user-data-dir", "out"]) {
  if (!argv[required]) {
    process.stderr.write(`Missing --${required}\n\n${usage()}`);
    process.exit(2);
  }
}

const cfg = {
  chrome: path.resolve(argv.chrome),
  repo: path.resolve(argv.repo),
  home: path.resolve(argv.home),
  userDataDir: path.resolve(argv["user-data-dir"]),
  out: path.resolve(argv.out),
  budgetSeconds: Number(argv["budget-seconds"]),
  lockoutSeconds: Number(argv["lockout-seconds"]),
  port: Number(argv.port),
  packed: argv.packed,
  extensionId: argv["extension-id"],
  noSandbox: argv["no-sandbox"],
  headless: argv.headed ? false : argv.headless,
  skip: new Set(argv.skip.split(",").map((s) => s.trim()).filter(Boolean)),
  timeoutMs: Number(argv["timeout-ms"]),
  verbose: argv.verbose
};
for (const [k, v] of Object.entries({ budgetSeconds: cfg.budgetSeconds, lockoutSeconds: cfg.lockoutSeconds, port: cfg.port, timeoutMs: cfg.timeoutMs })) {
  if (!Number.isFinite(v) || v <= 0) {
    process.stderr.write(`--${k} must be a positive number\n`);
    process.exit(2);
  }
}

const SITE_URL = `http://localhost:${cfg.port}/`;
const SITE_DOMAIN = "localhost";
const EXT_ORIGIN = `chrome-extension://${cfg.extensionId}/`;
const BLOCK_PAGE_URL = EXT_ORIGIN + "time-is-up.html";
const STATE_DIR = path.join(cfg.home, ".focuscap");
const STATE_FILE = path.join(STATE_DIR, "state.json");

// ---- small helpers ---------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function log(line) {
  process.stdout.write(`${line}\n`);
}

// Poll `fn` until it returns a truthy value or the deadline passes. Returns
// the value, or undefined on timeout. Errors in `fn` are swallowed so a page
// mid-navigation doesn't abort a wait.
async function pollUntil(fn, deadlineAt, intervalMs = 100) {
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch (_) {
      v = undefined;
    }
    if (v) return v;
    if (now() >= deadlineAt) return undefined;
    await sleep(intervalMs);
  }
}

function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

function modeBits(p) {
  try {
    return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, "0");
  } catch (_) {
    return null;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded --timeout-ms (${ms} ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- local fixture site ----------------------------------------------------

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Focus Cap e2e fixture</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1 id="fixture">Focus Cap e2e fixture</h1>
<p>This page is the tracked "distraction site" for the harness. Served at ${SITE_URL}.</p>
<p id="now"></p>
<script>setInterval(() => { document.getElementById("now").textContent = new Date().toISOString(); }, 500);</script>
</body></html>`;

function startFixtureServer() {
  const handler = (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(FIXTURE_HTML);
  };
  const servers = [];
  const listen = (host) =>
    new Promise((resolve) => {
      const s = http.createServer(handler);
      s.on("error", () => resolve(null));
      s.listen(cfg.port, host, () => resolve(s));
    });
  // Chrome resolves "localhost" to both loopback families; serve both so the
  // first one it tries answers. The IPv6 listener is best-effort.
  return Promise.all([listen("127.0.0.1"), listen("::1")]).then((list) => {
    for (const s of list) if (s) servers.push(s);
    if (!servers.length) throw new Error(`could not listen on port ${cfg.port}`);
    return {
      close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))))
    };
  });
}

// ---- browser + service worker access --------------------------------------

const ctx = {
  browser: null,
  server: null,
  consoleMessages: [], // { level, text, at, source }
  swTargetSeen: 0,
  handshakeError: null,
  runStartedAt: Date.now(),
  tOpen: null,
  tLock: null,
  lockedUntil: null,
  unlockDelayMs: null,
  sitePage: null
};

function isOurServiceWorker(target) {
  return target.type() === "service_worker" && target.url().startsWith(EXT_ORIGIN);
}

// Collect console output + uncaught exceptions from every service worker of
// the extension (including any restart) for the sw-console-clean check.
// A service worker target tolerates exactly one DevTools session, so this
// listens on the session puppeteer's worker() already holds instead of
// opening a second one (which closes the first).
async function attachConsole(target) {
  if (!isOurServiceWorker(target)) return;
  ctx.swTargetSeen += 1;
  let worker;
  try {
    worker = await target.worker();
  } catch (_) {
    return;
  }
  const push = (level, text, source) => {
    ctx.consoleMessages.push({ level, text, source, at: new Date().toISOString() });
  };
  worker.on("console", (msg) => {
    const type = msg.type();
    const level = type === "error" || type === "assert" ? "error" : type === "warning" || type === "warn" ? "warning" : type;
    push(level, msg.text(), "console");
  });
  const client = worker.client;
  client.on("Runtime.exceptionThrown", (ev) => {
    const d = ev.exceptionDetails || {};
    const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || "uncaught exception";
    push("error", String(text), "exception");
  });
  client.on("Log.entryAdded", (ev) => {
    const e = ev.entry || {};
    push(e.level === "error" ? "error" : e.level === "warning" ? "warning" : e.level || "info", String(e.text || ""), `log:${e.source || ""}`);
  });
  try {
    await client.send("Log.enable");
  } catch (_) {
    // the worker may already be gone
  }
}

async function findServiceWorker(timeoutMs) {
  const target = await ctx.browser.waitForTarget(isOurServiceWorker, { timeout: timeoutMs });
  return target;
}

// Evaluate in the extension's service worker. Re-resolves the target every
// time so a worker that Chrome stopped and restarted is picked up again.
async function sw(fn, ...args) {
  const target = await findServiceWorker(15000);
  const worker = await target.worker();
  return worker.evaluate(fn, ...args);
}

async function getStorage(keys) {
  return sw((k) => chrome.storage.local.get(k), keys);
}

// ---- the checks ------------------------------------------------------------
// Each check: { id, title, needs: [ids], run(): Promise<{ pass, detail, ...extra }> }

const checks = [
  {
    id: "extension-loaded",
    title: "The extension's service worker is running under the expected ID",
    needs: [],
    async run() {
      const wait = cfg.packed ? 60000 : 20000;
      const target = await findServiceWorker(wait).catch(() => null);
      if (!target) {
        const seen = ctx.browser.targets().map((t) => `${t.type()} ${t.url()}`);
        return { pass: false, detail: `no service worker for ${EXT_ORIGIN} within ${wait} ms (targets: ${seen.join("; ") || "none"})` };
      }
      const id = await sw(() => chrome.runtime.id);
      const manifest = await sw(() => chrome.runtime.getManifest());
      // Wait for onInstalled to have stamped the schema version before any
      // storage write of ours could race its defaults seeding.
      const stamped = await pollUntil(async () => (await getStorage("schemaVersion")).schemaVersion !== undefined, now() + 15000, 150);
      // Canary: proves the console capture used by sw-console-clean is wired.
      await sw((t) => console.info(t), CONSOLE_CANARY).catch(() => {});
      const pass = id === cfg.extensionId && !!stamped;
      return {
        pass,
        detail: `runtime.id=${id} (expected ${cfg.extensionId}); ${manifest.name} ${manifest.version}; schemaVersion stamped: ${!!stamped}`,
        runtimeId: id,
        version: manifest.version
      };
    }
  },
  {
    id: "protocol-handshake",
    title: "connectNative(\"com.focuscap.host\") answers {ok:true, protocolVersion:1}",
    needs: ["extension-loaded"],
    async run() {
      const r = await sw(
        (hostName) =>
          new Promise((resolve) => {
            const started = Date.now();
            let done = false;
            const finish = (v) => {
              if (!done) {
                done = true;
                resolve({ ...v, ms: Date.now() - started });
              }
            };
            let port;
            try {
              port = chrome.runtime.connectNative(hostName);
            } catch (e) {
              finish({ threw: String(e && e.message ? e.message : e) });
              return;
            }
            port.onMessage.addListener((reply) => finish({ reply }));
            port.onDisconnect.addListener(() => {
              const err = chrome.runtime.lastError;
              finish({ disconnected: true, lastError: err ? err.message : null });
            });
            try {
              port.postMessage({});
            } catch (e) {
              finish({ threw: String(e && e.message ? e.message : e) });
            }
            setTimeout(() => finish({ timeout: true }), 5000);
          }),
        HOST_NAME
      );
      if (r.reply) {
        const ok = r.reply.ok === true && r.reply.protocolVersion === 1;
        return {
          pass: ok,
          detail: `reply ${JSON.stringify(r.reply)} after ${r.ms} ms${ok ? "" : " (expected ok:true and protocolVersion:1)"}`,
          reply: r.reply
        };
      }
      const reason = r.threw ? `connectNative threw: ${r.threw}` : r.disconnected ? `port disconnected${r.lastError ? `: ${r.lastError}` : " (no lastError)"}` : "no reply within 5 s";
      ctx.handshakeError = reason;
      return { pass: false, detail: `${reason} — the native host is not registered for this browser/profile, or its command cannot start (see README prerequisites)` };
    }
  },
  {
    id: "lock",
    title: `A ${cfg.budgetSeconds} s budget on localhost redirects to time-is-up.html`,
    needs: ["extension-loaded"],
    async run() {
      await sw(
        (site) => chrome.storage.local.set({ focusSites: [site] }),
        { domain: SITE_DOMAIN, budgetSeconds: cfg.budgetSeconds, lockoutSeconds: cfg.lockoutSeconds, rules: [] }
      );
      const stored = await getStorage("focusSites");
      if (!Array.isArray(stored.focusSites) || !stored.focusSites.some((s) => s && s.domain === SITE_DOMAIN)) {
        return { pass: false, detail: `focusSites seed did not stick: ${JSON.stringify(stored.focusSites)}` };
      }
      const page = await ctx.browser.newPage();
      ctx.sitePage = page;
      const tOpen = now();
      ctx.tOpen = tOpen;
      await page.goto(SITE_URL, { waitUntil: "load", timeout: 15000 });
      await page.bringToFront().catch(() => {});
      const deadline = tOpen + (cfg.budgetSeconds + 5) * 1000;
      let wiggle = 0;
      const locked = await pollUntil(async () => {
        // Keep the content script's idle clock fresh the way a real user
        // would; harmless if the page is already mid-redirect.
        if (page.url().startsWith(SITE_URL)) {
          wiggle = (wiggle + 7) % 200;
          await page.mouse.move(100 + wiggle, 100 + wiggle).catch(() => {});
        }
        return page.url().startsWith(BLOCK_PAGE_URL) ? now() : null;
      }, deadline, 100);
      if (!locked) {
        const usage = await getStorage("usage").catch(() => ({}));
        return {
          pass: false,
          detail: `page still at ${page.url()} after ${cfg.budgetSeconds + 5} s; usage=${JSON.stringify(usage.usage)}`
        };
      }
      ctx.tLock = locked;
      const usage = await getStorage("usage");
      const rec = usage.usage && usage.usage.sites && usage.usage.sites[SITE_DOMAIN];
      ctx.lockedUntil = rec && typeof rec.lockedUntil === "number" ? rec.lockedUntil : null;
      // The block page fills its heading/countdown from storage a moment
      // after it loads; wait briefly so the detail shows the real text.
      const heading =
        (await pollUntil(async () => {
          const t = await page.evaluate(() => `${document.getElementById("headline").textContent} / ${document.getElementById("resetLine").textContent}`);
          return /\d/.test(t) ? t : null;
        }, now() + 2000, 100)) || "";
      return {
        pass: true,
        detail: `locked ${locked - tOpen} ms after opening the site; block page: "${heading.trim()}"; usage.sites.localhost=${JSON.stringify(rec)}`,
        tLock: new Date(locked).toISOString(),
        lockAfterMs: locked - tOpen,
        lockedUntil: ctx.lockedUntil
      };
    }
  },
  {
    id: "alarm-scheduled",
    title: "chrome.alarms has unlock:localhost armed for the cool-down end",
    needs: ["lock"],
    async run() {
      const alarms = await sw(() => chrome.alarms.getAll());
      const alarm = alarms.find((a) => a.name === `unlock:${SITE_DOMAIN}`);
      if (!alarm) return { pass: false, detail: `no unlock:${SITE_DOMAIN} alarm; alarms=${JSON.stringify(alarms.map((a) => a.name))}` };
      const floor = ctx.lockedUntil === null ? null : alarm.scheduledTime - ctx.lockedUntil;
      const note = floor === null ? "lockedUntil unknown" : floor <= 0 ? "no floor applied (unpacked behaviour)" : floor >= 25000 ? "floored — packed-build clamp (#17)" : "small positive offset";
      return {
        pass: true,
        detail: `scheduledTime − lockedUntil = ${floor} ms (${note}); scheduledTime − tLock = ${alarm.scheduledTime - ctx.tLock} ms`,
        scheduledTime: alarm.scheduledTime,
        lockedUntil: ctx.lockedUntil,
        floorMs: floor
      };
    }
  },
  {
    id: "host-wrote-state",
    title: "The native host wrote <home>/.focuscap/state.json with the lock",
    needs: ["lock"],
    async run() {
      const deadline = ctx.tLock + 5000;
      const expect = (s) =>
        s &&
        s.schemaVersion === 1 &&
        s.locked === true &&
        s.sites &&
        s.sites[SITE_DOMAIN] &&
        s.sites[SITE_DOMAIN].locked === true &&
        s.sites[SITE_DOMAIN].reason === "lockout" &&
        s.lastBlocked === SITE_DOMAIN &&
        // written by THIS run, not a stale file from an earlier one
        typeof s.updatedAt === "number" &&
        s.updatedAt >= ctx.tOpen;
      const state = await pollUntil(() => {
        const s = readStateFile();
        return expect(s) ? s : null;
      }, deadline, 100);
      const observedAt = now();
      const modes = process.platform === "win32" ? null : { dir: modeBits(STATE_DIR), file: modeBits(STATE_FILE) };
      if (!state) {
        const last = readStateFile();
        const why = last ? `state.json present but not as expected: ${JSON.stringify(last)}` : fs.existsSync(STATE_FILE) ? "state.json present but unparseable" : `${STATE_FILE} does not exist`;
        const hint = ctx.handshakeError ? ` (native host handshake failed earlier: ${ctx.handshakeError})` : "";
        return { pass: false, detail: `${why} within 5 s of the lock${hint}`, modes };
      }
      let pass = true;
      let modeNote = "mode bits not checked on Windows";
      if (modes) {
        pass = modes.dir === "700" && modes.file === "600";
        modeNote = `.focuscap=${modes.dir} state.json=${modes.file}${pass ? "" : " (expected 700/600, #10)"}`;
      }
      return {
        pass,
        detail: `locked=true sites.localhost={locked:true,reason:lockout} lastBlocked=localhost schemaVersion=1, ${observedAt - ctx.tLock} ms after the lock; updatedAt=${state.updatedAt}; ${modeNote}`,
        updatedAt: state.updatedAt,
        modes,
        observedAfterLockMs: observedAt - ctx.tLock
      };
    }
  },
  {
    id: "unlock-reported",
    title: `state.json flips to unlocked within lockout+45 s (unpacked ≈ ${cfg.lockoutSeconds} s, packed ≥ 30 s)`,
    needs: ["host-wrote-state"],
    async run() {
      const deadline = ctx.tLock + (cfg.lockoutSeconds + 45) * 1000;
      const state = await pollUntil(() => {
        const s = readStateFile();
        return s && s.locked === false && s.sites && s.sites[SITE_DOMAIN] && s.sites[SITE_DOMAIN].locked === false ? s : null;
      }, deadline, 100);
      if (!state) {
        return { pass: false, detail: `state.json still locked ${cfg.lockoutSeconds + 45} s after the lock: ${JSON.stringify(readStateFile())}` };
      }
      const delay = now() - ctx.tLock;
      ctx.unlockDelayMs = delay;
      const viaUpdatedAt = typeof state.updatedAt === "number" ? state.updatedAt - ctx.tLock : null;
      return {
        pass: true,
        detail: `UNLOCK DELAY ${delay} ms after the lock (lockout ${cfg.lockoutSeconds * 1000} ms; by updatedAt: ${viaUpdatedAt} ms); lastBlocked="${state.lastBlocked}" remainingMs=${state.sites[SITE_DOMAIN].remainingMs}`,
        unlockDelayMs: delay,
        unlockDelayByUpdatedAtMs: viaUpdatedAt,
        lockoutMs: cfg.lockoutSeconds * 1000
      };
    }
  },
  {
    id: "block-page-countdown",
    title: "The block page counts down to \"You can go back now.\"",
    needs: ["lock"],
    async run() {
      const page = ctx.sitePage;
      const deadline = ctx.tLock + (cfg.lockoutSeconds + 3) * 1000;
      const text = await pollUntil(async () => {
        if (!page.url().startsWith(BLOCK_PAGE_URL)) return null;
        const t = await page.evaluate(() => document.getElementById("resetLine").textContent.trim());
        return t === "You can go back now." ? t : null;
      }, deadline, 250);
      const at = now() - ctx.tLock;
      if (!text) {
        let current = "";
        try {
          current = await page.evaluate(() => document.getElementById("resetLine").textContent.trim());
        } catch (_) {
          current = `(page at ${page.url()})`;
        }
        return { pass: false, detail: `resetLine reads "${current}" ${at} ms after the lock (expected "You can go back now." by ${cfg.lockoutSeconds + 3} s)` };
      }
      return { pass: true, detail: `"${text}" observed ${at} ms after the lock`, observedAfterLockMs: at };
    }
  },
  {
    id: "renavigate",
    title: "After the unlock the real site loads again with a fresh allowance",
    needs: ["lock"],
    async run() {
      // Make sure the cool-down really is over even if unlock-reported was
      // skipped, so this check tests the lazy re-evaluation, not the clock.
      if (ctx.lockedUntil && now() < ctx.lockedUntil + 500) await sleep(ctx.lockedUntil + 500 - now());
      const page = ctx.sitePage;
      await page.goto(SITE_URL, { waitUntil: "load", timeout: 15000 });
      // Read usage immediately: the first heartbeat (1 s after the content
      // script's "entering") would start charging again.
      const usage = await getStorage("usage");
      const rec = usage.usage && usage.usage.sites && usage.usage.sites[SITE_DOMAIN];
      const totalMs = rec ? rec.totalMs : 0;
      await sleep(1500);
      const url = page.url();
      const stayed = url.startsWith(SITE_URL);
      // Park the fixture tab so its heartbeats don't spend the budget again
      // while the remaining checks run.
      await page.goto("about:blank").catch(() => {});
      const pass = stayed && totalMs === 0 && !(rec && typeof rec.lockedUntil === "number");
      return {
        pass,
        detail: `url after 1.5 s: ${url}; usage.sites.localhost right after load: ${JSON.stringify(rec)}${pass ? "" : " (expected to stay on localhost with totalMs 0 and no lockedUntil)"}`
      };
    }
  },
  {
    id: "options-reserved-names",
    title: "The Dashboard add-site form refuses __proto__/constructor/prototype (#18 TC1)",
    needs: ["extension-loaded"],
    async run() {
      const page = await ctx.browser.newPage();
      try {
        await page.goto(EXT_ORIGIN + "options.html", { waitUntil: "load", timeout: 15000 });
        await page.waitForSelector("#domainInput", { timeout: 10000 });
        const before = (await getStorage("focusSites")).focusSites || [];
        const submit = async (value) => {
          await page.click("#domainInput", { clickCount: 3 });
          await page.evaluate(() => {
            document.getElementById("domainInput").value = "";
          });
          await page.type("#domainInput", value);
          await page.keyboard.press("Enter");
          await sleep(150);
        };
        const reserved = ["__proto__", "constructor", "prototype", "https://__proto__/x"];
        for (const v of reserved) await submit(v);
        await submit("proto.example.com");
        // The real-domain add proves the form processed the queue in order.
        const accepted = await pollUntil(async () => {
          const s = (await getStorage("focusSites")).focusSites || [];
          return s.some((x) => x && x.domain === "proto.example.com") ? s : null;
        }, now() + 5000, 150);
        const after = accepted || (await getStorage("focusSites")).focusSites || [];
        const domains = after.map((s) => s && s.domain);
        const leaked = domains.filter((d) => ["__proto__", "constructor", "prototype"].includes(d));
        const rows = await page.$$eval("#siteList li", (els) => els.map((e) => e.textContent.trim().split("\n")[0]));
        const pass = !!accepted && leaked.length === 0 && domains.length === before.length + 1;
        return {
          pass,
          detail: `focusSites before: ${JSON.stringify(before.map((s) => s.domain))}; after submitting ${JSON.stringify([...reserved, "proto.example.com"])}: ${JSON.stringify(domains)}; leaked reserved: ${JSON.stringify(leaked)}; proto.example.com accepted: ${!!accepted}; rows: ${JSON.stringify(rows)}`
        };
      } finally {
        await page.close().catch(() => {});
      }
    }
  },
  {
    id: "proto-pollution",
    title: "normalizeUsage/siteUsage do not pollute Object.prototype (#18 TC2)",
    needs: ["extension-loaded"],
    async run() {
      const r = await sw(() => {
        const out = {};
        try {
          const crafted = { date: todayKey(), totalMs: 0, sites: JSON.parse('{"__proto__":{"totalMs":1,"lastTickAt":1}}') };
          const u = normalizeUsage(crafted, Date.now());
          out.nullProtoSites = Object.getPrototypeOf(u.sites) === null;
          out.hasOwnProto = Object.hasOwn(u.sites, "__proto__");
          let rec;
          try {
            rec = siteUsage(u, "__proto__");
            out.lookupThrew = null;
          } catch (e) {
            out.lookupThrew = String(e && e.message ? e.message : e);
          }
          out.recIsObjectPrototype = rec === Object.prototype;
          out.recTotalMs = rec ? rec.totalMs : null;
          // A normal site must be unaffected by the crafted entry.
          out.normalSiteTotalMs = siteUsage(u, "example.com").totalMs;
        } catch (e) {
          out.probeThrew = String(e && e.message ? e.message : e);
        }
        out.emptyObjectTotalMs = {}.totalMs;
        out.objectPrototypeLastTickAt = Object.prototype.lastTickAt;
        return out;
      });
      const pass = r.emptyObjectTotalMs === undefined && r.objectPrototypeLastTickAt === undefined && !r.lookupThrew && !r.probeThrew && r.recIsObjectPrototype === false;
      return { pass, detail: JSON.stringify(r) };
    }
  },
  {
    id: "schema-version",
    title: "chrome.storage.local.schemaVersion and state.json.schemaVersion are both 1 (#16)",
    needs: ["extension-loaded"],
    async run() {
      const stored = (await getStorage("schemaVersion")).schemaVersion;
      const state = readStateFile();
      const fileVersion = state ? state.schemaVersion : null;
      // Only a state.json written during this run counts — a file left by an
      // earlier run says nothing about this browser's host.
      const fresh = !!state && typeof state.updatedAt === "number" && state.updatedAt >= ctx.runStartedAt;
      const pass = stored === 1 && fileVersion === 1 && fresh;
      const fileNote = state ? `state.json.schemaVersion=${fileVersion}${fresh ? "" : " (file predates this run — not written by this browser's host)"}` : `${STATE_FILE} missing or unparseable`;
      return { pass, detail: `storage.schemaVersion=${stored}; ${fileNote}` };
    }
  },
  {
    id: "sw-console-clean",
    title: "No error-level messages in the service worker console during the run",
    needs: ["extension-loaded"],
    async run() {
      // Give late console output a moment to arrive.
      await sleep(300);
      const canarySeen = ctx.consoleMessages.some((m) => m.text.includes(CONSOLE_CANARY));
      const msgs = ctx.consoleMessages.filter((m) => !m.text.includes(CONSOLE_CANARY));
      const errors = msgs.filter((m) => m.level === "error");
      const warnings = msgs.filter((m) => m.level === "warning");
      const native = msgs.filter((m) => /native|protocol|Specified native/i.test(m.text));
      // Identical lines (Chrome repeats "Unchecked runtime.lastError" per
      // connectNative attempt) are collapsed with a count.
      const fmt = (list) => {
        const counts = new Map();
        for (const m of list) {
          const key = `[${m.level}/${m.source}] ${m.text}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts].map(([k, n]) => (n > 1 ? `${k} (x${n})` : k));
      };
      return {
        pass: errors.length === 0 && canarySeen,
        detail: `${msgs.length} message(s) from ${ctx.swTargetSeen} service-worker target(s): ${errors.length} error, ${warnings.length} warning; console capture verified by canary: ${canarySeen}; native/protocol mentions: ${native.length ? JSON.stringify(fmt(native)) : "none"}${errors.length ? `; errors: ${JSON.stringify(fmt(errors))}` : ""}`,
        captureVerified: canarySeen,
        errors: fmt(errors),
        warnings: fmt(warnings),
        nativeMentions: fmt(native)
      };
    }
  }
];

// ---- main ------------------------------------------------------------------

async function launchBrowser() {
  const args = ["--no-first-run", "--no-default-browser-check", "--disable-sync"];
  if (cfg.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
  if (!cfg.packed) args.push("--enable-unsafe-extension-debugging");
  const launch = {
    executablePath: cfg.chrome,
    headless: cfg.headless,
    userDataDir: cfg.userDataDir,
    pipe: true,
    args,
    // Chrome hands its environment to the native host it spawns; the host
    // (plain Node) resolves ~/.focuscap from HOME (POSIX) / USERPROFILE (Windows).
    env: { ...process.env, HOME: cfg.home, USERPROFILE: cfg.home },
    dumpio: cfg.verbose,
    timeout: cfg.timeoutMs,
    // Unpacked: DevTools' Extensions.loadUnpacked (works in branded Chrome,
    // where --load-extension is ignored since 137). Packed: just keep
    // extensions enabled and let the policy-installed build show up.
    enableExtensions: cfg.packed ? true : [cfg.repo]
  };
  if (cfg.packed) {
    // A policy force-install needs the extension updater's network access,
    // which two of puppeteer's default flags switch off.
    launch.ignoreDefaultArgs = ["--disable-background-networking", "--disable-component-update"];
  }
  return puppeteer.launch(launch);
}

async function main() {
  const startedAt = new Date();
  fs.mkdirSync(cfg.home, { recursive: true });
  fs.mkdirSync(cfg.userDataDir, { recursive: true });
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true });

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    pass: false,
    chromeVersion: null,
    chromePath: cfg.chrome,
    platform: `${process.platform} ${os.release()} ${os.arch()}`,
    node: process.version,
    extensionId: cfg.extensionId,
    mode: cfg.packed ? "packed" : "unpacked",
    headless: cfg.headless,
    repo: cfg.repo,
    home: cfg.home,
    stateFile: STATE_FILE,
    userDataDir: cfg.userDataDir,
    hostManifestLocation: hostManifestLocation(),
    fixture: { url: SITE_URL, budgetSeconds: cfg.budgetSeconds, lockoutSeconds: cfg.lockoutSeconds },
    timings: {},
    checks: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
    error: null
  };

  const results = new Map();
  try {
    ctx.server = await startFixtureServer();
    log(`fixture site on ${SITE_URL}`);
    ctx.browser = await launchBrowser();
    report.chromeVersion = await ctx.browser.version();
    log(`launched ${report.chromeVersion} (${report.mode}, ${cfg.headless ? "headless" : "headed"}) profile ${cfg.userDataDir}`);
    for (const t of ctx.browser.targets()) attachConsole(t);
    ctx.browser.on("targetcreated", (t) => attachConsole(t));

    for (const check of checks) {
      const t0 = now();
      let result;
      const skipped = cfg.skip.has(check.id);
      const unmet = check.needs.find((dep) => !(results.get(dep) && results.get(dep).pass === true));
      if (skipped) {
        result = { pass: null, skipped: true, detail: "skipped via --skip" };
      } else if (unmet) {
        const dep = results.get(unmet);
        result = dep && dep.skipped ? { pass: null, skipped: true, detail: `prerequisite ${unmet} was skipped` } : { pass: false, detail: `prerequisite ${unmet} did not pass` };
      } else {
        try {
          result = await withTimeout(check.run(), cfg.timeoutMs, check.id);
        } catch (e) {
          result = { pass: false, detail: `threw: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)}` };
        }
      }
      const entry = { id: check.id, title: check.title, ...result, pass: result.pass, detail: result.detail, ms: now() - t0 };
      results.set(check.id, entry);
      report.checks.push(entry);
      const tag = entry.skipped ? "SKIP" : entry.pass ? "PASS" : "FAIL";
      log(`[${tag}] ${check.id} (${entry.ms} ms) — ${entry.detail}`);
    }
  } catch (e) {
    report.error = e && e.stack ? e.stack : String(e);
    log(`harness error: ${report.error}`);
  } finally {
    if (ctx.browser) {
      try {
        await withTimeout(ctx.browser.close(), 15000, "browser.close");
      } catch (e) {
        try {
          ctx.browser.process()?.kill("SIGKILL");
        } catch (_) {
          // nothing else to do
        }
      }
    }
    if (ctx.server) await ctx.server.close().catch(() => {});
  }

  report.timings = {
    tLock: ctx.tLock ? new Date(ctx.tLock).toISOString() : null,
    lockedUntil: ctx.lockedUntil ? new Date(ctx.lockedUntil).toISOString() : null,
    unlockDelayMs: ctx.unlockDelayMs,
    lockoutMs: cfg.lockoutSeconds * 1000
  };
  for (const c of report.checks) {
    if (c.skipped) report.summary.skipped += 1;
    else if (c.pass) report.summary.passed += 1;
    else report.summary.failed += 1;
  }
  report.pass = !report.error && report.summary.failed === 0 && report.checks.length === checks.length;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(cfg.out, JSON.stringify(report, null, 2) + "\n");
  log(`${report.pass ? "PASS" : "FAIL"}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped` + (ctx.unlockDelayMs !== null ? `; unlock reported ${ctx.unlockDelayMs} ms after the lock (lockout ${cfg.lockoutSeconds * 1000} ms)` : "") + ` → ${cfg.out}`);
  process.exitCode = report.pass ? 0 : 1;
}

function hostManifestLocation() {
  const linux = path.join(cfg.userDataDir, "NativeMessagingHosts", `${HOST_NAME}.json`);
  switch (process.platform) {
    case "linux":
      return { expected: linux, present: fs.existsSync(linux), note: "Linux Chrome resolves user-level hosts relative to --user-data-dir" };
    case "darwin":
      return { expected: `~/Library/Application Support/<channel>/NativeMessagingHosts/${HOST_NAME}.json`, userDataDir: cfg.userDataDir, note: "run native-host/install-mac.sh as the user launching Chrome" };
    case "win32":
      return { expected: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, userDataDir: cfg.userDataDir, note: "run native-host/install-windows.ps1 as the user launching Chrome" };
    default:
      return { userDataDir: cfg.userDataDir };
  }
}

main().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 1;
});
