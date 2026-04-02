$ErrorActionPreference = "Stop"

param(
    [string]$BackupTarget = "D:",
    [string[]]$IncludeVolumes = @("C:"),
    [int]$IdleMinutesToStart = 20,
    [int]$ActiveGraceSeconds = 15,
    [int]$PollSeconds = 15,
    [switch]$AllCritical = $true
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class IdleTimer
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static uint GetIdleMilliseconds()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info))
        {
            throw new InvalidOperationException("GetLastInputInfo failed.");
        }

        return unchecked((uint)Environment.TickCount - info.dwTime);
    }
}
"@

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    Add-Content -Path $script:LogPath -Value $line -Encoding ascii
    Write-Output $line
}

function Get-IdleMilliseconds {
    return [IdleTimer]::GetIdleMilliseconds()
}

function Get-BackupEngineProcess {
    return Get-Process -Name wbengine -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Start-BackupJob {
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

    Write-Log "Starting backup: wbadmin $($arguments -join ' ')"
    Start-Process -FilePath "wbadmin.exe" -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

function Stop-BackupJob {
    Write-Log "Stopping backup because user activity resumed."
    & wbadmin.exe stop job -quiet | Out-Null
}

function Test-RecentBackupExists {
    $output = & wbadmin.exe get versions 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) {
        return $false
    }

    $today = (Get-Date).Date
    foreach ($line in $output) {
        if ($line -match '^Backup time:\s+(.+)$') {
            try {
                $backupTime = [datetime]::Parse($Matches[1], [Globalization.CultureInfo]::CurrentCulture)
                if ($backupTime.Date -eq $today) {
                    return $true
                }
            }
            catch {
            }
        }
    }

    return $false
}

if (-not (Test-IsAdministrator)) {
    throw "Run this script as Administrator."
}

$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$script:LogPath = Join-Path $logDir "smart-windows-backup.log"

$idleThresholdMs = $IdleMinutesToStart * 60 * 1000
$activeThresholdMs = $ActiveGraceSeconds * 1000

Write-Log "Monitor started. Target=$BackupTarget Include=$($IncludeVolumes -join ',') IdleMinutesToStart=$IdleMinutesToStart ActiveGraceSeconds=$ActiveGraceSeconds PollSeconds=$PollSeconds"

while ($true) {
    $idleMs = Get-IdleMilliseconds
    $backupEngine = Get-BackupEngineProcess

    if ($backupEngine) {
        if ($idleMs -lt $activeThresholdMs) {
            Stop-BackupJob
            Start-Sleep -Seconds 10
        }
    }
    else {
        if ($idleMs -ge $idleThresholdMs) {
            if (Test-RecentBackupExists) {
                Write-Log "A backup for today already exists. Waiting for the next day."
                Start-Sleep -Seconds ([Math]::Max($PollSeconds, 300))
                continue
            }

            Start-BackupJob
            Start-Sleep -Seconds 10
        }
    }

    Start-Sleep -Seconds $PollSeconds
}
