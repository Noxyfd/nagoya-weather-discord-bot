$ErrorActionPreference = "Stop"

param(
    [string]$BackupTarget = "D:",
    [string[]]$IncludeVolumes = @("C:"),
    [switch]$AllCritical = $true
)

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-ElevatedSelf {
    $scriptPath = $MyInvocation.MyCommand.Path
    $argumentList = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$scriptPath`"",
        "-BackupTarget", $BackupTarget
    )

    foreach ($volume in $IncludeVolumes) {
        $argumentList += @("-IncludeVolumes", $volume)
    }

    if ($AllCritical) {
        $argumentList += "-AllCritical"
    }

    Start-Process -FilePath "powershell.exe" -ArgumentList $argumentList -Verb RunAs | Out-Null
}

if (-not (Test-IsAdministrator)) {
    Start-ElevatedSelf
    exit 0
}

$arguments = @(
    "start",
    "backup",
    "-backupTarget:$BackupTarget",
    "-include:$($IncludeVolumes -join ',')",
    "-quiet"
)

if ($AllCritical) {
    $arguments += "-allCritical"
}

Start-Process -FilePath "wbadmin.exe" -ArgumentList $arguments -Verb RunAs
