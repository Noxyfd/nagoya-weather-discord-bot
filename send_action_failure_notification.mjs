import process from "node:process";

const discordBotToken = requiredEnv("DISCORD_BOT_TOKEN");
const discordChannelId = requiredEnv("DISCORD_CHANNEL_ID");

const repository = process.env.GITHUB_REPOSITORY || "unknown/repository";
const workflow = process.env.GITHUB_WORKFLOW || "Unknown workflow";
const runId = process.env.GITHUB_RUN_ID || "";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const runUrl = runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : `${serverUrl}/${repository}/actions`;

const payload = {
  embeds: [
    {
      title: "GitHub Actions failed",
      description: `${workflow} failed.`,
      color: 0xc0392b,
      fields: [
        {
          name: "Repository",
          value: repository,
          inline: true,
        },
        {
          name: "Run",
          value: runUrl,
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
    },
  ],
  allowed_mentions: {
    parse: [],
  },
};

sendDiscordMessage(discordBotToken, discordChannelId, payload).catch((error) => {
  console.error("[failure-notifier] Failed:", error);
  process.exitCode = 1;
});

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function sendDiscordMessage(botToken, channelId, body) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "github-actions-failure-discord-bot/1.0",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Discord API request failed: ${response.status} ${response.statusText} ${responseBody}`);
  }
}
