[CmdletBinding()]
param(
    [string]$Owner = "",
    [string]$RepoName = "nagoya-weather-discord-bot",
    [switch]$Private,
    [switch]$DispatchWorkflow
)

$ErrorActionPreference = "Stop"

function Get-GitHubCredential {
    $raw = @"
protocol=https
host=github.com

"@ | git credential-manager get

    $map = @{}
    foreach ($line in $raw -split "`r?`n") {
        if ($line -match "^(?<key>[^=]+)=(?<value>.*)$") {
            $map[$matches.key] = $matches.value
        }
    }

    if (-not $map.username -or -not $map.password) {
        throw "GitHub credential was not found. Run 'git credential-manager github login --device --force' first."
    }

    return $map
}

function Invoke-GitHubApi {
    param(
        [string]$Method,
        [string]$Uri,
        [object]$Body = $null,
        [hashtable]$Headers
    )

    $params = @{
        Method      = $Method
        Uri         = $Uri
        Headers     = $Headers
        ContentType = "application/json"
    }

    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }

    return Invoke-RestMethod @params
}

function Get-EnvFileValue {
    param(
        [string]$Name,
        [string]$DefaultValue = ""
    )

    $envPath = Join-Path $PSScriptRoot ".env"
    if (-not (Test-Path -LiteralPath $envPath)) {
        return $DefaultValue
    }

    foreach ($line in Get-Content -LiteralPath $envPath) {
        if ($line -match "^\s*$Name=(.*)$") {
            return $matches[1].Trim()
        }
    }

    return $DefaultValue
}

function Set-GitHubSecret {
    param(
        [string]$Owner,
        [string]$RepoName,
        [string]$SecretName,
        [string]$SecretValue,
        [hashtable]$Headers
    )

    $publicKey = Invoke-GitHubApi -Method Get -Uri "https://api.github.com/repos/$Owner/$RepoName/actions/secrets/public-key" -Headers $Headers
    $tempScript = Join-Path $env:TEMP "encrypt_github_secret.py"

    $pythonScript = @'
import base64
import sys
from nacl import public, encoding

key = public.PublicKey(sys.argv[1], encoding.Base64Encoder())
sealed_box = public.SealedBox(key)
encrypted = sealed_box.encrypt(sys.argv[2].encode("utf-8"))
print(base64.b64encode(encrypted).decode("utf-8"))
'@

    Set-Content -LiteralPath $tempScript -Value $pythonScript -Encoding UTF8
    try {
        $encryptedValue = py -3 $tempScript $publicKey.key $SecretValue
    } finally {
        Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
    }

    $body = @{
        encrypted_value = $encryptedValue.Trim()
        key_id          = $publicKey.key_id
    }

    Invoke-GitHubApi -Method Put -Uri "https://api.github.com/repos/$Owner/$RepoName/actions/secrets/$SecretName" -Body $body -Headers $Headers | Out-Null
}

$credential = Get-GitHubCredential
$token = $credential.password
$headers = @{
    Authorization        = "Bearer $token"
    Accept               = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"         = "codex-github-publisher"
}

$viewer = Invoke-GitHubApi -Method Get -Uri "https://api.github.com/user" -Headers $headers
if (-not $Owner) {
    $Owner = $viewer.login
}

$repo = $null
try {
    $repo = Invoke-GitHubApi -Method Get -Uri "https://api.github.com/repos/$Owner/$RepoName" -Headers $headers
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) {
        throw
    }
}

if (-not $repo) {
    $body = @{
        name        = $RepoName
        private     = [bool]$Private
        description = "Discord bot that posts Nagoya weather every morning."
    }
    $repo = Invoke-GitHubApi -Method Post -Uri "https://api.github.com/user/repos" -Body $body -Headers $headers
    Write-Host "Created repository: $($repo.html_url)"
} else {
    Write-Host "Using existing repository: $($repo.html_url)"
}

$remoteUrl = $repo.clone_url
$currentRemote = ""
try {
    $currentRemote = git remote get-url origin
} catch {
}

if (-not $currentRemote) {
    git remote add origin $remoteUrl
} elseif ($currentRemote -ne $remoteUrl) {
    git remote set-url origin $remoteUrl
}

git push -u origin main

$discordBotToken = Get-EnvFileValue -Name "DISCORD_BOT_TOKEN"
$discordChannelId = Get-EnvFileValue -Name "DISCORD_CHANNEL_ID"

if (-not $discordBotToken -or -not $discordChannelId) {
    throw ".env must contain DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID."
}

Set-GitHubSecret -Owner $Owner -RepoName $RepoName -SecretName "DISCORD_BOT_TOKEN" -SecretValue $discordBotToken -Headers $headers
Set-GitHubSecret -Owner $Owner -RepoName $RepoName -SecretName "DISCORD_CHANNEL_ID" -SecretValue $discordChannelId -Headers $headers

if ($DispatchWorkflow) {
    $body = @{ ref = "main" }
    Invoke-GitHubApi -Method Post -Uri "https://api.github.com/repos/$Owner/$RepoName/actions/workflows/nagoya-weather-discord.yml/dispatches" -Body $body -Headers $headers | Out-Null
    Write-Host "Workflow dispatch requested."
}

Write-Host "Repository URL: $($repo.html_url)"
