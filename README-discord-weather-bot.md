# Discord Weather Bot

This workspace contains a Discord weather bot for Nagoya.

It supports two execution modes:

- GitHub Actions
  - Recommended. Runs even when your PC is off.
- Windows Task Scheduler
  - Local fallback. Requires your PC to be on.

## Main files

- `send_nagoya_weather_to_discord.mjs`
  - Fetches the forecast from Open-Meteo and posts a Discord embed.
- `.github/workflows/nagoya-weather-discord.yml`
  - Runs the bot every day at 07:00 JST through GitHub Actions.
- `register_nagoya_weather_bot_task.ps1`
  - Registers the local Windows scheduled task.
- `.env.example`
  - Local configuration template.

## Discord setup

1. Create a Discord bot in the Discord Developer Portal.
2. Invite the bot to your server.
3. Give the bot `View Channel` and `Send Messages` permissions on the target channel.
4. Enable Discord developer mode and copy the target channel ID.

## GitHub Actions setup

1. Push this folder to a GitHub repository.
2. Open the repository on GitHub.
3. Go to `Settings` -> `Secrets and variables` -> `Actions`.
4. Add these repository secrets:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_CHANNEL_ID`
5. Go to the `Actions` tab.
6. Open `Nagoya Weather Discord Bot`.
7. Run `Run workflow` once for a manual test.

Notes:

- GitHub Actions `schedule` uses UTC, so the workflow is set to `0 22 * * *`, which corresponds to 07:00 JST.
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
