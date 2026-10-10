<#
.SYNOPSIS
  Host-side watch of the xDev Hive VM and hub, for administrators who live in Windows tools.

.DESCRIPTION
  Every run: the VM must be Running (started if it is Off), and the hub must answer /api/health. A change of state
  (healthy → not, and back) is written to the Application event log under the source "xDevHive" (IDs 1000 ok,
  1001 hub not healthy, 1002 VM started by the watch) and to C:\ProgramData\xdev-hive\watch.log.
  -Register installs it as a scheduled task running every five minutes as SYSTEM.

.EXAMPLE
  .\Watch-HiveHub.ps1 -Register
#>
param(
  [string] $VmName = "xdev-hive",
  [string] $HealthUrl = "http://192.168.250.10:7788/api/health",
  [switch] $Register
)
$ErrorActionPreference = "Stop"
$dir = "C:\ProgramData\xdev-hive"
$stateFile = Join-Path $dir "watch.state"
$logFile = Join-Path $dir "watch.log"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (-not [System.Diagnostics.EventLog]::SourceExists("xDevHive")) { New-EventLog -LogName Application -Source "xDevHive" }

if ($Register) {
  $script = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -VmName $VmName -HealthUrl $HealthUrl"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName "xDev Hive watch" -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest -Force | Out-Null
  Write-Host "Scheduled task 'xDev Hive watch' registered (every 5 minutes)."
  return
}

function Note([int] $id, [string] $type, [string] $text) {
  Write-EventLog -LogName Application -Source "xDevHive" -EventId $id -EntryType $type -Message $text
  Add-Content -Path $logFile -Value "$(Get-Date -Format s) $text"
}

$vm = Get-VM -Name $VmName
if ($vm.State -eq "Off") {
  Start-VM -Name $VmName
  Note 1002 Warning "VM $VmName was off; started it."
}

$ok = $false
try {
  $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 10
  $ok = $r.StatusCode -eq 200 -and $r.Content -match '"ok":true'
} catch { $ok = $false }

$was = if (Test-Path $stateFile) { Get-Content $stateFile } else { "unknown" }
$now = if ($ok) { "healthy" } else { "unhealthy" }
if ($now -ne $was) {
  if ($ok) { Note 1000 Information "xDev Hive hub healthy ($HealthUrl)." }
  else { Note 1001 Error "xDev Hive hub NOT healthy ($HealthUrl). On the VM: hive-status; journalctl -u hive-hub." }
  Set-Content -Path $stateFile -Value $now
}
