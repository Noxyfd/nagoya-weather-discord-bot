[CmdletBinding()]
param(
    [string]$TaskName = "NagoyaDiscordWeatherBot",
    [string]$Time = "07:00"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSCommandPath
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = $nodeCommand.Source
$scriptPath = Join-Path $root "send_nagoya_weather_to_discord.mjs"
$envPath = Join-Path $root ".env"

if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Script not found: $scriptPath"
}

if (-not (Test-Path -LiteralPath $envPath)) {
    throw ".env was not found. Copy .env.example to .env and fill in your values first."
}

$startTime = [DateTime]::ParseExact($Time, "HH:mm", $null)
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$scriptPath`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $startTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Post the Nagoya weather forecast to Discord every day at $Time." `
    -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered for $Time every day."
