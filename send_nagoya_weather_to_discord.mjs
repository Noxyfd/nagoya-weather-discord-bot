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
  locationName: normalizeLocationName(process.env.WEATHER_LOCATION_NAME?.trim() || "名古屋"),
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

function normalizeLocationName(locationName) {
  const names = {
    Nagoya: "名古屋",
    Fukuoka: "福岡",
  };

  return names[locationName] || locationName;
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
  url.searchParams.set(
    "hourly",
    ["temperature_2m", "weather_code", "precipitation_probability"].join(",")
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
  const hourly = payload.hourly;

  if (
    !daily ||
    !Array.isArray(daily.time) ||
    daily.time.length === 0 ||
    !Array.isArray(daily.weather_code) ||
    !Array.isArray(daily.temperature_2m_max) ||
    !Array.isArray(daily.temperature_2m_min) ||
    !hourly ||
    !Array.isArray(hourly.time)
  ) {
    throw new Error("Unexpected Open-Meteo response shape.");
  }

  const date = daily.time[0];
  const hourlyEntries = hourly.time
    .map((time, index) => ({
      time,
      temperature: hourly.temperature_2m?.[index] ?? null,
      weatherCode: hourly.weather_code?.[index] ?? null,
      precipitationProbability: hourly.precipitation_probability?.[index] ?? null,
    }))
    .filter((entry) => entry.time.startsWith(`${date}T`));

  return {
    date,
    weatherCode: daily.weather_code[0],
    maxTemp: daily.temperature_2m_max[0],
    minTemp: daily.temperature_2m_min[0],
    precipitationProbabilityMax: daily.precipitation_probability_max?.[0] ?? null,
    precipitationSum: daily.precipitation_sum?.[0] ?? null,
    sunrise: daily.sunrise?.[0] ?? null,
    sunset: daily.sunset?.[0] ?? null,
    uvIndexMax: daily.uv_index_max?.[0] ?? null,
    windSpeedMax: daily.wind_speed_10m_max?.[0] ?? null,
    hourlySegments: [
      pickHourlySlot(date, "07:00", "🌅 朝 07:00", hourlyEntries),
      pickHourlySlot(date, "12:00", "☀️ 昼 12:00", hourlyEntries),
      pickHourlySlot(date, "18:00", "🌙 夜 18:00", hourlyEntries),
    ],
    rainPeak: findRainPeak(hourlyEntries),
  };
}

function pickHourlySlot(date, clock, label, hourlyEntries) {
  const target = `${date}T${clock}`;
  const entry = hourlyEntries.find((item) => item.time === target);

  return {
    label,
    time: clock,
    temperature: entry?.temperature ?? null,
    weatherCode: entry?.weatherCode ?? null,
    precipitationProbability: entry?.precipitationProbability ?? null,
  };
}

function findRainPeak(hourlyEntries) {
  let peak = null;

  for (const entry of hourlyEntries) {
    const hour = Number(entryClock(entry.time).slice(0, 2));
    if (!Number.isFinite(hour) || hour < 6 || hour > 22) {
      continue;
    }

    if (entry.precipitationProbability === null) {
      continue;
    }

    if (!peak || entry.precipitationProbability > peak.precipitationProbability) {
      peak = entry;
    }
  }

  return peak
    ? {
        time: entryClock(peak.time),
        precipitationProbability: peak.precipitationProbability,
      }
    : null;
}

function buildDiscordPayload(forecast, locationName) {
  const weather = getWeatherPresentation(forecast.weatherCode);
  const location = getLocationPresentation(locationName);
  const color = location.color ?? weather.color;
  const fortune = getDailyFortune(forecast.date);
  const weekday = formatJapaneseWeekday(forecast.date);
  const umbrella = getUmbrellaAdvice(forecast);
  const clothing = getClothingAdvice(forecast);
  const uv = getUvAdvice(forecast);
  const outdoor = getOutdoorAdvice(forecast);

  return {
    embeds: [
      {
        author: {
          name: `${location.emoji} ${locationName}エリア`,
        },
        title: `${location.emoji} ${weather.emoji} ${locationName}の今日の天気`,
        description: [
          `${forecast.date} (${weekday})`,
          `**${locationName}の結論:** ${buildDecisionLine(forecast, umbrella, clothing, uv)}`,
          buildHeadlineSummary(forecast),
        ].join("\n"),
        color,
        fields: [
          createField("☂️ 傘レベル", umbrella.short, true),
          createField("🧥 服装", clothing.short, true),
          createField("🧴 UV対策", uv.short, true),
          createField("🚶 外出", outdoor.short, true),
          createField("⏱️ 雨ピーク", formatRainPeak(forecast.rainPeak), true),
          createField("🌡️ 気温", `${formatNumber(forecast.minTemp)}℃ / ${formatNumber(forecast.maxTemp)}℃`, true),
          createField("🍃 風", `${formatNumberOrDash(forecast.windSpeedMax)} km/h`, true),
          createField("🌅 日の出", extractClockOrDash(forecast.sunrise), true),
          createField("🌇 日の入", extractClockOrDash(forecast.sunset), true),
          createField(
            "💡 ひとこと",
            [umbrella.long, clothing.long, uv.long, outdoor.long].filter(Boolean).join(" "),
            false
          ),
        ],
        footer: {
          text: `${fortune.emoji} 今日の運勢: ${fortune.label} | ${fortune.comment}`,
        },
        timestamp: new Date().toISOString(),
      },
      {
        author: {
          name: `${location.emoji} ${locationName}エリア`,
        },
        title: `🕒 ${locationName}の時間帯の目安`,
        description: "朝の動き方が決めやすいように、07時 / 12時 / 18時の予報をまとめとるよ。",
        color,
        fields: forecast.hourlySegments.map((segment) =>
          createField(segment.label, buildHourlySummary(segment), false)
        ),
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

function buildDecisionLine(forecast, umbrella, clothing, uv) {
  const parts = [umbrella.short, clothing.short];

  if ((forecast.uvIndexMax ?? 0) >= 5) {
    parts.push(uv.short);
  }

  if (forecast.rainPeak && forecast.rainPeak.precipitationProbability >= 50) {
    parts.push(`${forecast.rainPeak.time}に雨注意`);
  }

  return parts.join(" / ");
}

function buildHeadlineSummary(forecast) {
  const weather = getWeatherPresentation(forecast.weatherCode);
  const morningMood = forecast.minTemp <= 10 ? "朝は冷えるけん" : "朝はちょいひんやりで";
  const dayMood =
    forecast.maxTemp >= 25
      ? "昼はちょい暑め"
      : forecast.maxTemp >= 20
        ? "昼は過ごしやすかよ"
        : "昼もひんやりしとるよ";

  return `今日は${weather.label}やけん、${morningMood}、${dayMood}。`;
}

function buildHourlySummary(segment) {
  if (segment.temperature === null || segment.weatherCode === null) {
    return "データが取れんやったばい。";
  }

  const weather = getWeatherPresentation(segment.weatherCode);
  const rainNote =
    segment.precipitationProbability === null
      ? ""
      : segment.precipitationProbability >= 60
        ? " / 雨の可能性が高かよ"
        : segment.precipitationProbability >= 30
          ? " / にわか雨に気をつけんね"
          : " / 雨の心配は少なめ";

  return `${formatRounded(segment.temperature)}℃前後 / ${weather.label}${rainNote}`;
}

function formatRainPeak(rainPeak) {
  if (!rainPeak || rainPeak.precipitationProbability < 20) {
    return "大きな山はなさそう";
  }

  return `${rainPeak.time}ごろ (${Math.round(rainPeak.precipitationProbability)}%)`;
}

function getLocationPresentation(locationName) {
  const table = {
    名古屋: { emoji: "🏯", color: 0xd35400 },
    福岡: { emoji: "🍜", color: 0x16a085 },
  };

  return table[locationName] || { emoji: "📍", color: null };
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

function getUmbrellaAdvice(forecast) {
  const rainChance = forecast.precipitationProbabilityMax ?? 0;
  const rainAmount = forecast.precipitationSum ?? 0;

  if (rainChance >= 70 || rainAmount >= 5) {
    return {
      short: "傘忘れんで",
      long: "傘は持って出た方が安心やね。",
    };
  }

  if (rainChance >= 30 || rainAmount > 0) {
    return {
      short: "折りたたみ傘あると安心",
      long: "折りたたみ傘があると安心やけん、入れとくとよかよ。",
    };
  }

  return {
    short: "傘なしでもよさそう",
    long: "雨の心配はそこまで大きくなさそうよ。",
  };
}

function getClothingAdvice(forecast) {
  if (forecast.maxTemp >= 28) {
    return {
      short: "半袖メインでよか",
      long: "昼は暑くなりそうやけん、軽めの服装がちょうどよかよ。",
    };
  }

  if (forecast.maxTemp >= 22) {
    return {
      short: "薄手+羽織りがよか",
      long: "昼は動きやすか気温やけど、朝晩に備えて羽織りがあると助かるよ。",
    };
  }

  if (forecast.maxTemp >= 15) {
    return {
      short: "長袖+上着が無難",
      long: "朝晩との寒暖差があるけん、軽い上着まであると安心やね。",
    };
  }

  return {
    short: "しっかり防寒",
    long: "冷えやすか日やけん、防寒寄りの服装がよかよ。",
  };
}

function getUvAdvice(forecast) {
  const uv = forecast.uvIndexMax ?? 0;

  if (uv >= 8) {
    return {
      short: "しっかり対策",
      long: "日差しが強かけん、日焼け止めや帽子まであると安心やね。",
    };
  }

  if (uv >= 5) {
    return {
      short: "軽めでよか",
      long: "軽めの日焼け対策ばしとくと、だいぶ楽よ。",
    };
  }

  return {
    short: "最低限でよか",
    long: "UVは強すぎんけん、最低限の対策で十分よ。",
  };
}

function getOutdoorAdvice(forecast) {
  const rainChance = forecast.precipitationProbabilityMax ?? 0;
  const wind = forecast.windSpeedMax ?? 0;

  if (rainChance >= 70 || wind >= 30) {
    return {
      short: "計画は慎重に",
      long: "長時間の外出は、空ば見ながら動いた方がよかよ。",
    };
  }

  if (rainChance >= 30) {
    return {
      short: "傘があれば大丈夫",
      long: "外出はしやすかけど、傘があるとさらに安心やね。",
    };
  }

  return {
    short: "動きやすか日",
    long: "外にも出やすいコンディションよ。",
  };
}

function getDailyFortune(seedText) {
  const fortunes = [
    { label: "大吉", emoji: "🏆", comment: "攻め時ばい。迷ったら前に出てよか。" },
    { label: "中吉", emoji: "✨", comment: "丁寧に積んでいけば、うまくいくよ。" },
    { label: "小吉", emoji: "🌱", comment: "焦らんで進めたら安定するよ。" },
    { label: "吉", emoji: "🍀", comment: "普段通りがいちばん強かよ。" },
    { label: "末吉", emoji: "📘", comment: "欲張らんで、堅実にいくとよか。" },
    { label: "凶", emoji: "🛡️", comment: "無理せんで、慎重にいくばい。" },
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

  return entryClock(isoText);
}

function entryClock(isoText) {
  return isoText.split("T")[1]?.slice(0, 5) || isoText;
}

function formatNumber(value) {
  return Number(value).toFixed(1);
}

function formatRounded(value) {
  return String(Math.round(Number(value)));
}

function formatNumberOrDash(value) {
  return value === null ? "-" : formatNumber(value);
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
