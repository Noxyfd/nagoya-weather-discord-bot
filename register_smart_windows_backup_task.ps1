$ErrorActionPreference = "Stop"

param(
    [string]$TaskName = "Smart Windows Backup",
    [string]$ScriptPath = (Join-Path $PSScriptRoot "smart_windows_backup.ps1"),
    [int]$IdleMinutesToStart = 20,
    [int]$ActiveGraceSeconds = 15,
    [int]$PollSeconds = 15,
    [string]$BackupTarget = "D:"
)

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    throw "Run this script as Administrator."
}

if (-not (Test-Path $ScriptPath)) {
    throw "Script not found: $ScriptPath"
}

$escapedScriptPath = $ScriptPath.Replace('"', '""')
$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", "`"$escapedScriptPath`"",
    "-BackupTarget", $BackupTarget,
    "-IdleMinutesToStart", $IdleMinutesToStart,
    "-ActiveGraceSeconds", $ActiveGraceSeconds,
    "-PollSeconds", $PollSeconds
)

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($arguments -join " ")
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts Windows backup when the PC is idle and stops it when activity resumes." `
    -Force | Out-Null

Write-Output "Registered scheduled task: $TaskName"
