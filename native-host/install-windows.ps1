# Registers the Focus Cap native messaging host for Chrome, Chromium and Edge
# on Windows. Usage: .\install-windows.ps1 [-ExtensionId <EXTENSION_ID>]
# manifest.json pins a stable ID via its "key" field, so as long as you loaded
# the repo's own manifest.json unpacked, the default below is already correct
# and you don't need to pass anything. Only pass -ExtensionId if you
# regenerated your own "key" (and therefore a different ID).
#
# Runs on Windows PowerShell 5.1 and PowerShell 7+. No -UserDataDir option:
# on Windows the host is looked up in the registry (per user, per browser
# brand), not relative to the active --user-data-dir as on Linux.
#
# CI executes this script on windows-latest (.github/workflows/test.yml) and
# checks the manifest and every registry key below; see GitHub issue #14.
param(
  [string]$ExtensionId = "oladakapegoiphmpicedkgnieanibbbe"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $ScriptDir "com.focuscap.host.json"
$HostPath = Join-Path $ScriptDir "host.bat"
$TemplatePath = Join-Path $ScriptDir "com.focuscap.host.json.template"

# host.bat is just `node host.js`, and Chrome launches it with the plain
# user/system PATH (not your shell's), so fail here, with a clear message,
# rather than at the first connectNative() with "native host has exited".
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine("install-windows.ps1: 'node' was not found on PATH. host.bat runs 'node host.js', so install Node.js (https://nodejs.org) and make sure 'node' resolves from a plain cmd prompt, then re-run this script.")
  exit 1
}

# The manifest is built from the template OBJECT and serialized by
# ConvertTo-Json, not by string-replacing placeholders: a checkout path full
# of backslashes (every Windows path), or one containing a `"`, is escaped
# correctly whatever it holds (the Linux/mac scripts do the same with node;
# issue #18). Written as UTF-8 WITHOUT a BOM: Chrome rejects a BOM'd manifest,
# and Set-Content -Encoding UTF8 on Windows PowerShell 5.1 would add one.
$Manifest = Get-Content -LiteralPath $TemplatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Manifest.path = $HostPath
$Manifest.allowed_origins = [string[]]@("chrome-extension://$ExtensionId/")
$Json = $Manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ManifestPath, $Json + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Registered native messaging host manifest at: $ManifestPath"

# Each Chromium-based browser (and each Chrome/Edge channel) looks the host
# up under its OWN registry key - registering only under Google\Chrome
# silently misses Beta/Canary (SxS)/Chrome for Testing/Chromium/Edge, which
# then fail with "Specified native messaging host not found". Registering
# into all of them is harmless: a key for a browser that isn't installed is
# just never read.
$BrowserKeys = @(
  "HKCU:\Software\Google\Chrome",
  "HKCU:\Software\Google\Chrome Beta",
  "HKCU:\Software\Google\Chrome SxS",
  "HKCU:\Software\Google\Chrome for Testing",
  "HKCU:\Software\Chromium",
  "HKCU:\Software\Microsoft\Edge",
  "HKCU:\Software\Microsoft\Edge Beta",
  "HKCU:\Software\Microsoft\Edge Dev",
  "HKCU:\Software\Microsoft\Edge SxS"
)
foreach ($BrowserKey in $BrowserKeys) {
  $RegKey = "$BrowserKey\NativeMessagingHosts\com.focuscap.host"
  New-Item -Path $RegKey -Force | Out-Null
  Set-ItemProperty -Path $RegKey -Name "(default)" -Value $ManifestPath
  Write-Host "Registered: $RegKey"
}

Write-Host "Restart your browser for it to take effect."
