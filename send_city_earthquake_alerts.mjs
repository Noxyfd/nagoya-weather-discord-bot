import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dryRun = process.argv.includes("--dry-run");
const statePath = path.join(__dirname, "earthquake_state.json");

loadDotEnv(path.join(__dirname, ".env"));

const config = {
  discordBotToken: dryRun ? optionalEnv("DISCORD_BOT_TOKEN") : requiredEnv("DISCORD_BOT_TOKEN"),
  discordChannelId: dryRun ? optionalEnv("DISCORD_CHANNEL_ID") : requiredEnv("DISCORD_CHANNEL_ID"),
};

const targetCities = [
  {
    cityCode: "2310000",
    name: "名古屋",
    emoji: "🏯",
    color: 0xd35400,
  },
  {
    cityCode: "4013000",
    name: "福岡",
    emoji: "🍜",
    color: 0x16a085,
  },
];

main().catch((error) => {
  console.error("[earthquake-bot] Failed:", error);
  process.exitCode = 1;
});

async function main() {
  const state = readState();
  const reports = await fetchEarthquakeReports();
  const alerts = findTargetCityAlerts(reports, state.notifiedKeys ?? []);

  if (dryRun) {
    console.log(JSON.stringify({ alerts, state }, null, 2));
    return;
  }

  if (!state.initialized) {
    const currentKeys = findTargetCityAlerts(reports, []).map((alert) => alert.key);
    writeState({
      initialized: true,
      notifiedKeys: unique([...(state.notifiedKeys ?? []), ...currentKeys]).slice(-100),
      updatedAt: new Date().toISOString(),
    });
    console.log("[earthquake-bot] Initialized state without posting old reports.");
    return;
  }

  if (alerts.length === 0) {
    console.log("[earthquake-bot] No new target city earthquake alerts.");
    return;
  }

  for (const alert of alerts) {
    await sendDiscordMessage(
      config.discordBotToken,
      config.discordChannelId,
      buildDiscordPayload(alert)
    );
    console.log(`[earthquake-bot] Posted alert: ${alert.city.name} ${alert.eventId}`);
  }

  writeState({
    initialized: true,
    notifiedKeys: unique([...(state.notifiedKeys ?? []), ...alerts.map((alert) => alert.key)]).slice(-100),
    updatedAt: new Date().toISOString(),
  });
}

function loadDotEnv(dotEnvPath) {
  if (!fs.existsSync(dotEnvPath)) {
    return;
  }

  const content = fs.readFileSync(dotEnvPath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function optionalEnv(name) {
  return process.env[name]?.trim() || "";
}

function requiredEnv(name) {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readState() {
  if (!fs.existsSync(statePath)) {
    return {
      initialized: false,
      notifiedKeys: [],
    };
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function writeState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function fetchEarthquakeReports() {
  const response = await fetch("https://www.jma.go.jp/bosai/quake/data/list.json", {
    headers: {
      Accept: "application/json",
      "User-Agent": "city-earthquake-discord-bot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`JMA earthquake request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected JMA earthquake response shape.");
  }

  return payload;
}

function findTargetCityAlerts(reports, notifiedKeys) {
  const notified = new Set(notifiedKeys);
  const latestReportByEvent = new Map();

  for (const report of reports) {
    if (!report.eid || report.ttl !== "震源・震度情報") {
      continue;
    }

    const existing = latestReportByEvent.get(report.eid);
    if (!existing || String(report.ctt) > String(existing.ctt)) {
      latestReportByEvent.set(report.eid, report);
    }
  }

  const alerts = [];
  for (const report of latestReportByEvent.values()) {
    for (const city of targetCities) {
      const intensity = findCityIntensity(report, city.cityCode);
      if (!intensity) {
        continue;
      }

      const key = `${report.eid}:${city.cityCode}`;
      if (notified.has(key)) {
        continue;
      }

      alerts.push({
        key,
        city,
        eventId: report.eid,
        reportTime: report.rdt,
        occurredAt: report.at,
        epicenter: report.anm || "不明",
        magnitude: report.mag || "不明",
        maxIntensity: report.maxi || "不明",
        cityIntensity: intensity,
        title: report.ttl,
      });
    }
  }

  return alerts.sort((a, b) => String(a.reportTime).localeCompare(String(b.reportTime)));
}

function findCityIntensity(report, cityCode) {
  if (!Array.isArray(report.int)) {
    return null;
  }

  for (const prefecture of report.int) {
    if (!Array.isArray(prefecture.city)) {
      continue;
    }

    for (const city of prefecture.city) {
      if (String(city.code) === cityCode) {
        return city.maxi || prefecture.maxi || report.maxi || "不明";
      }
    }
  }

  return null;
}

function buildDiscordPayload(alert) {
  return {
    embeds: [
      {
        author: {
          name: `${alert.city.emoji} ${alert.city.name}エリア`,
        },
        title: `⚠️ ${alert.city.name}で地震を観測`,
        description: [
          `**${alert.city.name}: 震度${formatIntensity(alert.cityIntensity)}**`,
          `震源: ${alert.epicenter}`,
        ].join("\n"),
        color: alert.city.color,
        fields: [
          createField("🕒 発生時刻", formatDateTime(alert.occurredAt), true),
          createField("📣 発表時刻", formatDateTime(alert.reportTime), true),
          createField("📍 震源地", alert.epicenter, true),
          createField("📏 マグニチュード", String(alert.magnitude), true),
          createField("🌐 全国最大震度", `震度${formatIntensity(alert.maxIntensity)}`, true),
          createField(`${alert.city.emoji} ${alert.city.name}`, `震度${formatIntensity(alert.cityIntensity)}`, true),
          createField("💡 ひとこと", buildSafetyMessage(alert.cityIntensity), false),
        ],
        footer: {
          text: "気象庁 地震情報をもとに通知しています",
        },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: {
      parse: [],
    },
  };
}

function createField(name, value, inline) {
  return { name, value, inline };
}

function buildSafetyMessage(intensity) {
  const numeric = Number(intensity);
  if (Number.isFinite(numeric) && numeric >= 4) {
    return "身の回りを確認して、落下物や火の元に注意してください。";
  }

  if (Number.isFinite(numeric) && numeric >= 3) {
    return "念のため周囲を確認して、続報がないか見とくと安心です。";
  }

  return "小さめの揺れでも、念のため周囲を確認しとくとよかよ。";
}

function formatIntensity(intensity) {
  const labels = {
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5-": "5弱",
    "5+": "5強",
    "6-": "6弱",
    "6+": "6強",
    "7": "7",
  };

  return labels[String(intensity)] || String(intensity);
}

function formatDateTime(value) {
  if (!value) {
    return "不明";
  }

  return String(value).replace("T", " ").replace("+09:00", "");
}

async function sendDiscordMessage(botToken, channelId, payload) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "city-earthquake-discord-bot/1.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await safeResponseText(response);
    throw new Error(`Discord API request failed: ${response.status} ${response.statusText} ${body}`);
  }
}

async function safeResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values)];
}
