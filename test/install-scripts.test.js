import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The install scripts had zero coverage: QA of the #18 hardening could revert
// the manifest generation to the old `sed s#…#…#` block without a single test
// noticing. These run the real scripts against a throwaway HOME with a
// checkout path and extension ID full of sed/shell metacharacters.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32";

function runInScratch(script, extraEnv = {}, args = []) {
  const scratch = mkdtempSync(join(tmpdir(), "fc-install-"));
  // A path with a space, `#`, `&`, `\` and a single quote — every character
  // that broke sed or would break a naively quoted shell/node string.
  const weird = join(scratch, "fc #weird&amp\\q'x");
  mkdirSync(weird, { recursive: true });
  cpSync(join(root, "native-host"), join(weird, "native-host"), { recursive: true });
  const home = join(scratch, "home");
  mkdirSync(home);
  execFileSync("bash", [join(weird, "native-host", script), ...args], {
    env: { ...process.env, HOME: home, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { scratch, weird, home };
}

function* manifestsUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* manifestsUnder(p);
    else if (entry.name === "com.focuscap.host.json") yield p;
  }
}

describe.skipIf(skip)("native-host install scripts", () => {
  const ID = "abc#def&x'y";

  it("install-linux.sh writes a parseable manifest with the path and ID taken literally, into every channel dir and the user-data-dir", () => {
    const udd = mkdtempSync(join(tmpdir(), "fc-udd-"));
    const { scratch, weird, home } = runInScratch("install-linux.sh", { CHROME_USER_DATA_DIR: udd }, [ID]);
    try {
      const files = [...manifestsUnder(home), ...manifestsUnder(udd)];
      // 5 Chrome/Chromium channel dirs under ~/.config + the custom user-data-dir.
      expect(files).toHaveLength(6);
      for (const f of files) {
        const m = JSON.parse(readFileSync(f, "utf8"));
        expect(m.name).toBe("com.focuscap.host");
        expect(m.type).toBe("stdio");
        expect(m.path).toBe(join(weird, "native-host", "host.js"));
        expect(m.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
      }
      expect(files.some((f) => f.startsWith(udd))).toBe(true);
      // host.js is made executable (Chrome runs it directly on Linux/macOS).
      expect(statSync(join(weird, "native-host", "host.js")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(udd, { recursive: true, force: true });
    }
  });

  it("install-mac.sh writes the same manifest into every macOS channel dir", () => {
    const { scratch, weird, home } = runInScratch("install-mac.sh", {}, [ID]);
    try {
      const files = [...manifestsUnder(join(home, "Library"))];
      expect(files).toHaveLength(5);
      for (const f of files) {
        const m = JSON.parse(readFileSync(f, "utf8"));
        expect(m.path).toBe(join(weird, "native-host", "host.js"));
        expect(m.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("defaults to the pinned extension ID when none is given", () => {
    const { scratch, home } = runInScratch("install-linux.sh");
    try {
      const [first] = manifestsUnder(home);
      const m = JSON.parse(readFileSync(first, "utf8"));
      expect(m.allowed_origins).toEqual(["chrome-extension://oladakapegoiphmpicedkgnieanibbbe/"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// install-windows.ps1 can't be executed here (no PowerShell on Linux/macOS;
// the windows-latest CI job runs it for real), so this is a static check of
// the source only: it catches a dropped browser key or a regression from
// ConvertTo-Json back to string-replacing the template (issue #14), nothing
// about runtime behaviour. Runs on every OS, win32 included.
describe("install-windows.ps1 (static check of the source, not executed)", () => {
  const ps1 = readFileSync(join(root, "native-host", "install-windows.ps1"), "utf8");

  it("registers the host under every Chrome/Chromium/Edge channel key", () => {
    const keys = [
      "HKCU:\\Software\\Google\\Chrome",
      "HKCU:\\Software\\Google\\Chrome Beta",
      "HKCU:\\Software\\Google\\Chrome SxS",
      "HKCU:\\Software\\Google\\Chrome for Testing",
      "HKCU:\\Software\\Chromium",
      "HKCU:\\Software\\Microsoft\\Edge",
      "HKCU:\\Software\\Microsoft\\Edge Beta",
      "HKCU:\\Software\\Microsoft\\Edge Dev",
      "HKCU:\\Software\\Microsoft\\Edge SxS"
    ];
    for (const key of keys) expect(ps1, `missing registry key ${key}`).toContain(`"${key}"`);
    expect(ps1).toContain("\\NativeMessagingHosts\\com.focuscap.host");
    expect(ps1).toContain('"(default)"');
  });

  it("builds the manifest with ConvertFrom-Json/ConvertTo-Json (no placeholder string replacement) and writes it without a BOM", () => {
    expect(ps1).toMatch(/ConvertFrom-Json/);
    expect(ps1).toMatch(/ConvertTo-Json/);
    expect(ps1).not.toMatch(/__HOST_PATH__|__EXTENSION_ID__/);
    expect(ps1).toContain("[System.Text.UTF8Encoding]::new($false)");
    // Code lines only: a comment is allowed to explain why Set-Content (BOM
    // on 5.1) is avoided.
    const code = ps1.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/Set-Content/);
  });

  it("defaults to the pinned extension ID, stops on errors and refuses to run without node", () => {
    expect(ps1).toContain('[string]$ExtensionId = "oladakapegoiphmpicedkgnieanibbbe"');
    expect(ps1).toContain('$ErrorActionPreference = "Stop"');
    expect(ps1).toMatch(/Get-Command node/);
  });
});
