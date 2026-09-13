# Registers the Focus Cap native messaging host for Chrome on Windows.
# Usage: .\install-windows.ps1 [-ExtensionId <EXTENSION_ID>]
# manifest.json pins a stable ID via its "key" field, so as long as you loaded
# the repo's own manifest.json unpacked, the default below is already correct
# and you don't need to pass anything. Only pass -ExtensionId if you
# regenerated your own "key" (and therefore a different ID).
param(
  [string]$ExtensionId = "oladakapegoiphmpicedkgnieanibbbe"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $ScriptDir "com.focuscap.host.json"
$HostPath = Join-Path $ScriptDir "host.bat"

$Template = Get-Content (Join-Path $ScriptDir "com.focuscap.host.json.template") -Raw
$Template = $Template.Replace("__HOST_PATH__", $HostPath.Replace("\", "\\"))
$Template = $Template.Replace("__EXTENSION_ID__", $ExtensionId)
Set-Content -Path $ManifestPath -Value $Template -NoNewline

$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.focuscap.host"
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(default)" -Value $ManifestPath

Write-Host "Registered native messaging host manifest at: $ManifestPath"
Write-Host "Registry key set: $RegKey"
Write-Host "Restart Chrome for it to take effect."
