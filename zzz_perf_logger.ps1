$ErrorActionPreference = "Stop"

$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$csvPath = Join-Path $logDir "zzz-perf-$timestamp.csv"
$metaPath = Join-Path $logDir "zzz-perf-$timestamp.meta.txt"
$errorPath = Join-Path $logDir "zzz-perf-$timestamp.error.txt"

$sampleIntervalMs = 1000
$counterPaths = @(
    '\Processor Information(_Total)\% Processor Utility',
    '\Memory\Available MBytes'
)
$gpuQuery = 'utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,power.limit,temperature.gpu,clocks.current.graphics,clocks.current.memory'

@(
    "Started: $(Get-Date -Format s)"
    "Host: $env:COMPUTERNAME"
    "User: $env:USERNAME"
    "GameProcess: ZenlessZoneZero"
    "SampleIntervalMs: $sampleIntervalMs"
    "CsvPath: $csvPath"
) | Set-Content -Path $metaPath -Encoding ascii

'"Timestamp","CPU_Total_Utility_Pct","Memory_Available_MB","ZZZ_CPU_Time_Sec","ZZZ_WorkingSet_MB","GPU_Util_Pct","GPU_MemCtrl_Pct","GPU_Memory_Total_MB","GPU_Memory_Used_MB","GPU_Power_W","GPU_Power_Limit_W","GPU_Temp_C","GPU_Graphics_Clock_MHz","GPU_Memory_Clock_MHz"' |
    Set-Content -Path $csvPath -Encoding ascii

$sampleCount = 0

try {
    while ($true) {
        $proc = Get-Process -Name ZenlessZoneZero -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $proc) {
            break
        }

        $gpuRaw = & nvidia-smi --query-gpu=$gpuQuery --format=csv,noheader,nounits 2>$null
        $gpuParts = $gpuRaw -split ',\s*'
        if ($gpuParts.Count -lt 9) {
            throw "Unexpected nvidia-smi output: $gpuRaw"
        }

        $counterData = Get-Counter -Counter $counterPaths
        $cpuTotal = $null
        $memAvailable = $null
        foreach ($sample in $counterData.CounterSamples) {
            if ($sample.Path -match 'processor information\(_total\)\\% processor utility$') {
                $cpuTotal = [math]::Round($sample.CookedValue, 2)
            }
            elseif ($sample.Path -match 'memory\\available mbytes$') {
                $memAvailable = [math]::Round($sample.CookedValue, 2)
            }
        }

        $line = '"{0}",{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13}' -f @(
            (Get-Date -Format "o"),
            $cpuTotal,
            $memAvailable,
            [math]::Round($proc.CPU, 2),
            [math]::Round($proc.WorkingSet64 / 1MB, 2),
            [int]$gpuParts[0],
            [int]$gpuParts[1],
            [int]$gpuParts[2],
            [int]$gpuParts[3],
            [double]$gpuParts[4],
            [double]$gpuParts[5],
            [int]$gpuParts[6],
            [int]$gpuParts[7],
            [int]$gpuParts[8]
        )

        Add-Content -Path $csvPath -Value $line -Encoding ascii
        $sampleCount++
        Start-Sleep -Milliseconds $sampleIntervalMs
    }
}
catch {
    $_ | Out-String | Set-Content -Path $errorPath -Encoding ascii
    throw
}
finally {
    @(
        ""
        "Stopped: $(Get-Date -Format s)"
        "Samples: $sampleCount"
        "ErrorLog: $errorPath"
    ) | Add-Content -Path $metaPath -Encoding ascii
}

Write-Output "Wrote $sampleCount samples to $csvPath"
