# Registers the Focus Cap native messaging host for Chrome on Windows.
# Usage: .\install-windows.ps1 -ExtensionId <EXTENSION_ID>
# Find <EXTENSION_ID> at chrome://extensions with Developer mode on, after
# loading the unpacked extension from the repo root.
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
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
