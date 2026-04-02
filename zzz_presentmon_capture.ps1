$ErrorActionPreference = "Stop"

$presentMon = "C:\Program Files\NVIDIA Corporation\FrameViewSDK\bin\PresentMon_x64.exe"
if (-not (Test-Path $presentMon)) {
    throw "PresentMon not found: $presentMon"
}

$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$csvPath = Join-Path $logDir "zzz-presentmon-$timestamp.csv"
$metaPath = Join-Path $logDir "zzz-presentmon-$timestamp.meta.txt"

@(
    "Started: $(Get-Date -Format s)"
    "CsvPath: $csvPath"
    "TargetProcess: ZenlessZoneZero.exe"
) | Set-Content -Path $metaPath -Encoding ascii

& $presentMon `
    --process_name ZenlessZoneZero.exe `
    --output_file $csvPath `
    --stop_existing_session `
    --terminate_on_proc_exit

@(
    ""
    "Stopped: $(Get-Date -Format s)"
) | Add-Content -Path $metaPath -Encoding ascii

Write-Output "Wrote PresentMon capture to $csvPath"
