<#
.SYNOPSIS
  Installs the BAMP device agent as an always-running Windows service-like scheduled task (no NSSM needed).

.DESCRIPTION
  Registers a scheduled task that runs service\run-forever.cmd, which restarts the agent whenever it exits
  (exit code 75 = restart requested by a remote command or a firmware update → immediate restart).

  -Mode Headless (default): runs at system start-up as SYSTEM, no console (terminal UI disabled; the real
                            fingerprint sensor scans continuously).
  -Mode Kiosk:              runs at logon of -KioskUser in a visible console window with the kiosk text UI
                            (required for the console bench sensor and for on-device enrolment).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File service\install-windows-service.ps1
  powershell -ExecutionPolicy Bypass -File service\install-windows-service.ps1 -Mode Kiosk -KioskUser "BRANCH\kiosk"
  powershell -ExecutionPolicy Bypass -File service\install-windows-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('Headless', 'Kiosk')]
  [string]$Mode = 'Headless',
  [string]$KioskUser = "$env:USERDOMAIN\$env:USERNAME",
  [string]$TaskName = 'BAMP Device Agent',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Uninstall) {
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -like '*dist\cli.js*run*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "Scheduled task '$TaskName' is not installed."
  }
  return
}

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $PSScriptRoot 'run-forever.cmd'
$entry = Join-Path $agentDir 'dist\cli.js'
if (-not (Test-Path $entry)) { throw "Build the agent first (npm ci; npm run build): $entry not found." }
if (-not (Test-Path (Join-Path $agentDir '.env'))) { Write-Warning "No .env in $agentDir - copy .env.example to .env and edit it before starting." }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")) { $node = "$env:ProgramFiles\nodejs\node.exe" }
if (-not $node) { throw 'Node.js 22 is not installed.' }

if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

if ($Mode -eq 'Headless') {
  # /always: also restart after a clean exit, there is no operator to press Q.
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$wrapper`" /always`"" -WorkingDirectory $agentDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
} else {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/k `"`"$wrapper`"`"" -WorkingDirectory $agentDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $KioskUser
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $KioskUser -LogonType Interactive -RunLevel Limited
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal `
  -Description 'BAMP biometric attendance terminal agent (restarts automatically; exit code 75 = restart requested)' | Out-Null

Write-Host "Installed scheduled task '$TaskName' ($Mode) running $wrapper"
Write-Host "Data directory comes from BAMP_DATA_DIR in $agentDir\.env (default %PROGRAMDATA%\bamp-device)."
if ($Mode -eq 'Headless') {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Started. Check status with:  node dist\cli.js status'
} else {
  Write-Host "The kiosk console starts at the next logon of $KioskUser (or run: Start-ScheduledTask -TaskName '$TaskName')."
}
