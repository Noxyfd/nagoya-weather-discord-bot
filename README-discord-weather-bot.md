# Discord Weather Bot

This workspace contains a Discord bot that posts Nagoya/Fukuoka weather and city earthquake alerts.

It supports two execution modes:

- Cloudflare Workers
  - Current production scheduler.
  - Runs weather every day at 06:00 JST and checks earthquakes every minute.
- GitHub Actions
  - Manual fallback only. Scheduled execution is disabled to avoid duplicate posts.
- Windows Task Scheduler
  - Local fallback. Requires your PC to be on.

## Main files

- `send_nagoya_weather_to_discord.mjs`
  - Fetches the forecast from Open-Meteo and posts a Discord embed.
- `send_city_earthquake_alerts.mjs`
  - Checks JMA earthquake intensity data for Nagoya/Fukuoka and posts alerts.
- `cloudflare-worker.mjs`
  - Cloudflare Workers implementation for weather and earthquake schedules.
- `wrangler.toml`
  - Cloudflare Worker configuration.
- `.github/workflows/nagoya-weather-discord.yml`
  - Manual weather fallback through GitHub Actions.
- `.github/workflows/city-earthquake-discord.yml`
  - Manual earthquake fallback through GitHub Actions.
- `register_nagoya_weather_bot_task.ps1`
  - Registers the local Windows scheduled task.
- `.env.example`
  - Local configuration template.

## Discord setup

1. Create a Discord bot in the Discord Developer Portal.
2. Invite the bot to your server.
3. Give the bot `View Channel` and `Send Messages` permissions on the target channel.
4. Enable Discord developer mode and copy the target channel ID.

## Cloudflare Workers setup

The production Worker is `nagoya-fukuoka-discord-bot`.

Cron triggers:

- `* * * * *`
  - Checks JMA earthquake information.
- `0 21 * * *`
  - Posts weather at 06:00 JST.

Bindings:

- `DISCORD_BOT_TOKEN`
  - Secret.
- `ADMIN_TOKEN`
  - Secret for manual test endpoints.
- `DISCORD_CHANNEL_ID`
  - Plain variable.
- `EARTHQUAKE_MAX_REPORT_AGE_MINUTES`
  - Plain variable. Default is `360`.
- `EARTHQUAKE_STATE`
  - KV namespace for deduplicating earthquake notifications.

Manual health check:

```powershell
Invoke-RestMethod https://nagoya-fukuoka-discord-bot.takuma1130h.workers.dev/health
```

Manual dry-run endpoints require the `x-admin-token` header:

```powershell
$headers = @{ "x-admin-token" = "your_admin_token_here" }
Invoke-RestMethod -Headers $headers "https://nagoya-fukuoka-discord-bot.takuma1130h.workers.dev/run/weather?dryRun=1"
Invoke-RestMethod -Headers $headers "https://nagoya-fukuoka-discord-bot.takuma1130h.workers.dev/run/earthquake?dryRun=1"
```

## GitHub Actions fallback setup

1. Push this folder to a GitHub repository.
2. Open the repository on GitHub.
3. Go to `Settings` -> `Secrets and variables` -> `Actions`.
4. Add these repository secrets:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_CHANNEL_ID`
5. Go to the `Actions` tab.
6. Open `Nagoya Weather Discord Bot`.
7. Run `Run workflow` once for a manual fallback test.

Notes:

- GitHub Actions schedules are intentionally disabled because Cloudflare Workers is the production scheduler.
- Scheduled workflows run on the repository's default branch.
- Scheduled workflows can be delayed during high GitHub Actions load.

## Local test

For local testing, copy `.env.example` to `.env` and fill in the values.

```powershell
Copy-Item .env.example .env
```

Preview the payload without sending:

```powershell
node .\send_nagoya_weather_to_discord.mjs --dry-run
```

Send a real local test:

```powershell
node .\send_nagoya_weather_to_discord.mjs
```

## Local Windows scheduler

If you still want the PC-based schedule:

```powershell
.\register_nagoya_weather_bot_task.ps1
```

## Notes

- Weather data comes from the Open-Meteo Forecast API.
- Discord posting uses the Discord REST API `POST /channels/{channel.id}/messages`.
- `.env` is excluded through `.gitignore` and should not be committed.
