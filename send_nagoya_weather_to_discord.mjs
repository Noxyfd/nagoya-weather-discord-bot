import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dryRun = process.argv.includes("--dry-run");

loadDotEnv(path.join(__dirname, ".env"));

const config = {
  discordBotToken: dryRun ? optionalEnv("DISCORD_BOT_TOKEN") : requiredEnv("DISCORD_BOT_TOKEN"),
  discordChannelId: dryRun ? optionalEnv("DISCORD_CHANNEL_ID") : requiredEnv("DISCORD_CHANNEL_ID"),
  latitude: numberEnv("WEATHER_LATITUDE", 35.1815),
  longitude: numberEnv("WEATHER_LONGITUDE", 136.9066),
  locationName: process.env.WEATHER_LOCATION_NAME?.trim() || "名古屋",
  timezone: process.env.WEATHER_TIMEZONE?.trim() || "Asia/Tokyo",
};

main().catch((error) => {
  console.error("[weather-bot] Failed:", error);
  process.exitCode = 1;
});

async function main() {
  const forecast = await fetchForecast(config);
  const payload = buildDiscordPayload(forecast, config.locationName);

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  await sendDiscordMessage(config.discordBotToken, config.discordChannelId, payload);
  console.log("[weather-bot] Posted forecast successfully.");
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

function numberEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
}

async function fetchForecast({ latitude, longitude, timezone }) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
      "precipitation_sum",
      "sunrise",
      "sunset",
      "uv_index_max",
      "wind_speed_10m_max",
    ].join(",")
  );
  url.searchParams.set("timezone", timezone);
  url.searchParams.set("forecast_days", "1");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "nagoya-weather-discord-bot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const daily = payload.daily;

  if (
    !daily ||
    !Array.isArray(daily.time) ||
    daily.time.length === 0 ||
    !Array.isArray(daily.weather_code) ||
    !Array.isArray(daily.temperature_2m_max) ||
    !Array.isArray(daily.temperature_2m_min)
  ) {
    throw new Error("Unexpected Open-Meteo response shape.");
  }

  return {
    date: daily.time[0],
    weatherCode: daily.weather_code[0],
    maxTemp: daily.temperature_2m_max[0],
    minTemp: daily.temperature_2m_min[0],
    precipitationProbabilityMax: daily.precipitation_probability_max?.[0] ?? null,
    precipitationSum: daily.precipitation_sum?.[0] ?? null,
    sunrise: daily.sunrise?.[0] ?? null,
    sunset: daily.sunset?.[0] ?? null,
    uvIndexMax: daily.uv_index_max?.[0] ?? null,
    windSpeedMax: daily.wind_speed_10m_max?.[0] ?? null,
  };
}

function buildDiscordPayload(forecast, locationName) {
  const weather = getWeatherPresentation(forecast.weatherCode);
  const fortune = getDailyFortune(forecast.date);
  const weekday = formatJapaneseWeekday(forecast.date);

  return {
    content: "valoから逃げるな",
    embeds: [
      {
        title: `${weather.emoji} ${locationName}の天気予報`,
        description: `${forecast.date} (${weekday})\n${weather.label}`,
        color: weather.color,
        fields: [
          createField("気温", `${formatNumber(forecast.minTemp)}℃ / ${formatNumber(forecast.maxTemp)}℃`, true),
          createField(
            "降水",
            `${formatIntegerOrDash(forecast.precipitationProbabilityMax)}% / ${formatNumberOrDash(forecast.precipitationSum)} mm`,
            true
          ),
          createField("風", `${formatNumberOrDash(forecast.windSpeedMax)} km/h`, true),
          createField("UV指数", formatNumberOrDash(forecast.uvIndexMax), true),
          createField("日の出", extractClockOrDash(forecast.sunrise), true),
          createField("日の入", extractClockOrDash(forecast.sunset), true),
          createField("ひとこと", buildDailyAdvice(forecast), false),
        ],
        footer: {
          text: `今日の運勢: ${fortune.label} | ${fortune.comment}`,
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
  return {
    name,
    value,
    inline,
  };
}

function getWeatherPresentation(code) {
  const table = {
    0: { label: "快晴", emoji: "☀️", color: 0xf6c343 },
    1: { label: "晴れ", emoji: "🌤️", color: 0xf6c343 },
    2: { label: "晴れ時々くもり", emoji: "⛅", color: 0xe0b84f },
    3: { label: "くもり", emoji: "☁️", color: 0x95a5a6 },
    45: { label: "霧", emoji: "🌫️", color: 0x7f8c8d },
    48: { label: "着氷性の霧", emoji: "🌫️", color: 0x7f8c8d },
    51: { label: "弱い霧雨", emoji: "🌦️", color: 0x5dade2 },
    53: { label: "霧雨", emoji: "🌦️", color: 0x5dade2 },
    55: { label: "強い霧雨", emoji: "🌧️", color: 0x3498db },
    56: { label: "弱い着氷性の霧雨", emoji: "🌧️", color: 0x3498db },
    57: { label: "強い着氷性の霧雨", emoji: "🌧️", color: 0x3498db },
    61: { label: "弱い雨", emoji: "🌧️", color: 0x3498db },
    63: { label: "雨", emoji: "🌧️", color: 0x2e86c1 },
    65: { label: "強い雨", emoji: "⛈️", color: 0x1f618d },
    66: { label: "弱い着氷性の雨", emoji: "🌧️", color: 0x2e86c1 },
    67: { label: "強い着氷性の雨", emoji: "🌧️", color: 0x1f618d },
    71: { label: "弱い雪", emoji: "🌨️", color: 0x85c1e9 },
    73: { label: "雪", emoji: "🌨️", color: 0x85c1e9 },
    75: { label: "大雪", emoji: "❄️", color: 0x5dade2 },
    77: { label: "雪粒", emoji: "❄️", color: 0x85c1e9 },
    80: { label: "弱いにわか雨", emoji: "🌦️", color: 0x5dade2 },
    81: { label: "にわか雨", emoji: "🌦️", color: 0x3498db },
    82: { label: "激しいにわか雨", emoji: "⛈️", color: 0x1f618d },
    85: { label: "弱いにわか雪", emoji: "🌨️", color: 0x85c1e9 },
    86: { label: "激しいにわか雪", emoji: "❄️", color: 0x5dade2 },
    95: { label: "雷雨", emoji: "⛈️", color: 0x6c3483 },
    96: { label: "弱いひょうを伴う雷雨", emoji: "⛈️", color: 0x6c3483 },
    99: { label: "強いひょうを伴う雷雨", emoji: "⛈️", color: 0x512e5f },
  };

  return table[code] || { label: `不明 (${code})`, emoji: "🌍", color: 0x566573 };
}

function buildDailyAdvice(forecast) {
  const advice = [];

  if ((forecast.precipitationProbabilityMax ?? 0) >= 70 || (forecast.precipitationSum ?? 0) >= 3) {
    advice.push("傘を持って出た方が安全");
  } else if ((forecast.precipitationProbabilityMax ?? 0) >= 30) {
    advice.push("折りたたみ傘があると安心");
  } else {
    advice.push("雨の心配は小さめ");
  }

  if (forecast.maxTemp >= 28) {
    advice.push("かなり暑いので水分補給を優先");
  } else if (forecast.maxTemp >= 22) {
    advice.push("日中は過ごしやすい");
  } else if (forecast.maxTemp >= 15) {
    advice.push("朝晩との寒暖差に注意");
  } else {
    advice.push("しっかり防寒した方がいい");
  }

  if ((forecast.windSpeedMax ?? 0) >= 30) {
    advice.push("風が強め");
  }

  if ((forecast.uvIndexMax ?? 0) >= 6) {
    advice.push("日焼け対策あり");
  }

  return advice.join(" / ");
}

function getDailyFortune(seedText) {
  const fortunes = [
    { label: "大吉", comment: "攻める日。迷ったら前へ。" },
    { label: "中吉", comment: "丁寧に積むと勝てる日。" },
    { label: "小吉", comment: "焦らずやれば安定。" },
    { label: "吉", comment: "普段通りが一番強い。" },
    { label: "末吉", comment: "欲張らず堅実に。" },
    { label: "凶", comment: "無理せず慎重にいこう。" },
  ];

  let hash = 0;
  for (const char of seedText) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return fortunes[hash % fortunes.length];
}

function formatJapaneseWeekday(dateText) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const date = new Date(`${dateText}T12:00:00+09:00`);
  return weekdays[date.getDay()];
}

function extractClockOrDash(isoText) {
  if (!isoText) {
    return "-";
  }

  return isoText.split("T")[1]?.slice(0, 5) || isoText;
}

function formatNumber(value) {
  return Number(value).toFixed(1);
}

function formatNumberOrDash(value) {
  return value === null ? "-" : formatNumber(value);
}

function formatIntegerOrDash(value) {
  return value === null ? "-" : String(Math.round(Number(value)));
}

async function sendDiscordMessage(botToken, channelId, payload) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "nagoya-weather-discord-bot/1.0",
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
