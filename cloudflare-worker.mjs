const WEATHER_CITIES = [
  { name: "名古屋", emoji: "🏯", color: 0xd35400, latitude: 35.1815, longitude: 136.9066 },
  { name: "福岡", emoji: "🍜", color: 0x16a085, latitude: 33.5902, longitude: 130.4017 },
];

const EARTHQUAKE_TARGETS = [
  { cityCodePrefixes: ["231"], name: "名古屋", emoji: "🏯", color: 0xd35400 },
  { cityCodePrefixes: ["4013"], name: "福岡", emoji: "🍜", color: 0x16a085 },
];

const EARTHQUAKE_STATE_KEY = "earthquake_state";

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event.cron, env));
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      service: "nagoya-fukuoka-discord-bot",
      schedules: {
        earthquake: "* * * * *",
        weather: "0 21 * * * (JST 06:00)",
      },
    });
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  if (url.pathname === "/run/weather") {
    const dryRun = url.searchParams.get("dryRun") === "1";
    const result = await postWeatherForAllCities(env, { dryRun });
    return jsonResponse({ ok: true, result });
  }

  if (url.pathname === "/run/earthquake") {
    const dryRun = url.searchParams.get("dryRun") === "1";
    const result = await postEarthquakeAlerts(env, { dryRun });
    return jsonResponse({ ok: true, result });
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

async function handleScheduled(cron, env) {
  if (cron === "0 21 * * *") {
    await postWeatherForAllCities(env);
    return;
  }

  await postEarthquakeAlerts(env);
}

function isAuthorized(request, env) {
  const adminToken = env.ADMIN_TOKEN || "";
  if (!adminToken) {
    return false;
  }

  return request.headers.get("x-admin-token") === adminToken;
}

async function postWeatherForAllCities(env, options = {}) {
  const results = [];
  for (const city of WEATHER_CITIES) {
    const forecast = await fetchForecast(city);
    const payload = buildWeatherDiscordPayload(forecast, city.name);
    if (!options.dryRun) {
      await sendDiscordMessage(env, payload, "cloudflare-weather-discord-bot/1.0");
    }
    results.push({ city: city.name, posted: !options.dryRun, payload });
  }

  return results;
}

async function fetchForecast({ latitude, longitude }) {
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
  url.searchParams.set("hourly", ["temperature_2m", "weather_code", "precipitation_probability"].join(","));
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("forecast_days", "1");

  const payload = await fetchJsonWithRetry(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "cloudflare-weather-discord-bot/1.0",
    },
  });
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
    rainBands: [
      evaluateRainBand("通勤", "通勤 07-09", 7, 9, hourlyEntries),
      evaluateRainBand("昼", "昼 11-14", 11, 14, hourlyEntries),
      evaluateRainBand("帰宅", "帰宅 17-20", 17, 20, hourlyEntries),
    ],
  };
}

async function fetchJsonWithRetry(url, options, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(750 * attempt);
      }
    }
  }

  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateRainBand(shortName, label, startHour, endHour, hourlyEntries) {
  const entries = hourlyEntries.filter((entry) => {
    const hour = Number(entryClock(entry.time).slice(0, 2));
    return Number.isFinite(hour) && hour >= startHour && hour <= endHour;
  });

  if (entries.length === 0) {
    return { shortName, label, maxProbability: null, averageTemperature: null, weatherCode: null };
  }

  const peak = entries.reduce((best, entry) => {
    if (entry.precipitationProbability === null) {
      return best;
    }

    if (!best || entry.precipitationProbability > best.precipitationProbability) {
      return entry;
    }

    return best;
  }, null);

  const temperatures = entries
    .map((entry) => entry.temperature)
    .filter((temperature) => temperature !== null);

  return {
    shortName,
    label,
    maxProbability: peak?.precipitationProbability ?? null,
    averageTemperature:
      temperatures.length > 0
        ? temperatures.reduce((sum, temperature) => sum + temperature, 0) / temperatures.length
        : null,
    weatherCode: peak?.weatherCode ?? entries.find((entry) => entry.weatherCode !== null)?.weatherCode ?? null,
  };
}

function buildWeatherDiscordPayload(forecast, locationName) {
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
        author: { name: `${location.emoji} ${locationName}エリア` },
        title: `${locationName} 今日の行動メモ`,
        description: [
          `**${forecast.date} (${weekday})** | ${formatNumber(forecast.minTemp)}℃ → ${formatNumber(forecast.maxTemp)}℃`,
          `**今日の判断:** ${buildPrimaryDecision(forecast)}`,
          buildHeadlineSummary(forecast),
        ].join("\n"),
        color,
        fields: [
          createSpacedField("🎒 持ち物・服装", buildMorningDecision(forecast), false),
          createSpacedField("🕒 時間帯", buildCompactTimeBands(forecast.rainBands), false),
          createSpacedField("📊 リスク", buildConditionDashboard(forecast), false),
          createSpacedField("💬 ひとこと", buildDailyNote(umbrella, clothing, uv, outdoor), false),
        ],
        footer: { text: `${fortune.emoji} 今日の運勢: ${fortune.label} | ${fortune.comment}` },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function createSpacedField(name, value, inline) {
  return { name: `\u200B\n${name}`, value, inline };
}

function createField(name, value, inline) {
  return { name, value, inline };
}

function buildPrimaryDecision(forecast) {
  return [
    summarizeUmbrellaDecision(forecast),
    summarizeClothingDecision(forecast),
    summarizeUvDecision(forecast),
  ].join(" / ");
}

function buildMorningDecision(forecast) {
  return [
    `傘: ${getUmbrellaAction(forecast)}`,
    `服装: ${getClothingAction(forecast)}`,
    `UV: ${getUvAction(forecast)}`,
  ].join("\n");
}

function buildConditionDashboard(forecast) {
  const rain = classifyRainRisk(forecast.precipitationProbabilityMax);
  const uvRisk = classifyUvRisk(forecast.uvIndexMax);
  const wind = classifyWindRisk(forecast.windSpeedMax);

  return [
    `雨: ${rain.label} ${formatPercent(forecast.precipitationProbabilityMax)} | ${rain.action}`,
    `UV: ${uvRisk.label} ${formatNumberOrDash(forecast.uvIndexMax)} | ${uvRisk.action}`,
    `風: ${wind.label} ${formatNumberOrDash(forecast.windSpeedMax)} km/h | ${wind.action}`,
  ].join("\n");
}

function buildDailyNote(umbrella, clothing, uv, outdoor) {
  return [umbrella.long, clothing.long, uv.long, outdoor.long].filter(Boolean).slice(0, 2).join("\n");
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

function buildCompactTimeBands(rainBands) {
  return rainBands.map((band) => buildCompactTimeBandLine(band)).join("\n");
}

function buildCompactTimeBandLine(band) {
  if (band.maxProbability === null || band.weatherCode === null) {
    return `${band.label}: データなし`;
  }

  const temperature = band.averageTemperature === null ? "-" : `${formatRounded(band.averageTemperature)}℃`;
  return `${band.label}｜${temperature}｜雨${Math.round(band.maxProbability)}%｜${getTimeBandAction(band)}`;
}

function summarizeUmbrellaDecision(forecast) {
  const probability = forecast.precipitationProbabilityMax ?? 0;
  const amount = forecast.precipitationSum ?? 0;
  if (probability >= 70 || amount >= 5) return "傘必須";
  if (probability >= 30 || amount > 0) return "折りたたみ傘";
  return "傘なし";
}

function summarizeClothingDecision(forecast) {
  if (forecast.maxTemp >= 28) return "半袖";
  if (forecast.maxTemp >= 22) return "薄手+羽織り";
  if (forecast.maxTemp >= 15) return "上着あり";
  return "防寒";
}

function summarizeUvDecision(forecast) {
  const uv = forecast.uvIndexMax ?? 0;
  if (uv >= 8) return "UV強め";
  if (uv >= 5) return "UV軽め";
  return "UV最低限";
}

function getUmbrellaAction(forecast) {
  const decision = summarizeUmbrellaDecision(forecast);
  if (decision === "傘必須") return "傘は持って出る";
  if (decision === "折りたたみ傘") return "折りたたみ傘が無難";
  return "傘なしでOK";
}

function getClothingAction(forecast) {
  const decision = summarizeClothingDecision(forecast);
  if (decision === "半袖") return "半袖メインでOK";
  if (decision === "薄手+羽織り") return "薄手+羽織りが無難";
  if (decision === "上着あり") return "長袖+上着が無難";
  return "しっかり防寒";
}

function getUvAction(forecast) {
  const decision = summarizeUvDecision(forecast);
  if (decision === "UV強め") return "しっかり対策";
  if (decision === "UV軽め") return "軽め対策";
  return "最低限でOK";
}

function getTimeBandAction(band) {
  if (band.maxProbability >= 70) return "傘必須";
  if (band.maxProbability >= 50) return "傘推奨";
  if (band.maxProbability >= 30) return "折りたたみ傘";
  if (band.shortName === "帰宅") return "傘なし寄り";
  if (band.averageTemperature === null) return "大きな注意なし";
  if (band.averageTemperature <= 10) return "冷える";
  if (band.averageTemperature <= 16) return "少しひんやり";
  if (band.averageTemperature >= 28) return "暑さ注意";
  if (band.averageTemperature >= 24) return "やや暑い";
  return "動きやすい";
}

function classifyRainRisk(probability) {
  if (probability === null) return { label: "不明", action: "確認できず" };
  if (probability >= 70) return { label: "高い", action: "傘必須" };
  if (probability >= 50) return { label: "やや高い", action: "傘推奨" };
  if (probability >= 30) return { label: "注意", action: "折りたたみ傘" };
  if (probability >= 10) return { label: "低め", action: "傘なし寄り" };
  return { label: "かなり低め", action: "傘なし寄り" };
}

function classifyUvRisk(uvIndex) {
  if (uvIndex === null) return { label: "不明", action: "確認できず" };
  if (uvIndex >= 8) return { label: "強い", action: "しっかり対策" };
  if (uvIndex >= 5) return { label: "普通", action: "軽め対策" };
  return { label: "弱め", action: "最低限でOK" };
}

function classifyWindRisk(speed) {
  if (speed === null) return { label: "不明", action: "確認できず" };
  if (speed >= 30) return { label: "強め", action: "外出注意" };
  if (speed >= 20) return { label: "やや強め", action: "髪型注意" };
  return { label: "穏やか", action: "問題なし" };
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
    80: { label: "弱いにわか雨", emoji: "🌦️", color: 0x5dade2 },
    81: { label: "にわか雨", emoji: "🌦️", color: 0x3498db },
    82: { label: "激しいにわか雨", emoji: "⛈️", color: 0x1f618d },
    95: { label: "雷雨", emoji: "⛈️", color: 0x6c3483 },
  };
  return table[code] || { label: `不明 (${code})`, emoji: "🌍", color: 0x566573 };
}

function getUmbrellaAdvice(forecast) {
  const rainChance = forecast.precipitationProbabilityMax ?? 0;
  const rainAmount = forecast.precipitationSum ?? 0;
  if (rainChance >= 70 || rainAmount >= 5) {
    return { short: "傘忘れんで", long: "傘は持って出た方が安心やね。" };
  }
  if (rainChance >= 30 || rainAmount > 0) {
    return { short: "折りたたみ傘あると安心", long: "折りたたみ傘があると安心やけん、入れとくとよかよ。" };
  }
  return { short: "傘なしでもよさそう", long: "雨の心配はそこまで大きくなさそうよ。" };
}

function getClothingAdvice(forecast) {
  if (forecast.maxTemp >= 28) {
    return { short: "半袖メインでよか", long: "昼は暑くなりそうやけん、軽めの服装がちょうどよかよ。" };
  }
  if (forecast.maxTemp >= 22) {
    return { short: "薄手+羽織りがよか", long: "昼は動きやすか気温やけど、朝晩に備えて羽織りがあると助かるよ。" };
  }
  if (forecast.maxTemp >= 15) {
    return { short: "長袖+上着が無難", long: "朝晩との寒暖差があるけん、軽い上着まであると安心やね。" };
  }
  return { short: "しっかり防寒", long: "冷えやすか日やけん、防寒寄りの服装がよかよ。" };
}

function getUvAdvice(forecast) {
  const uv = forecast.uvIndexMax ?? 0;
  if (uv >= 8) {
    return { short: "しっかり対策", long: "日差しが強かけん、日焼け止めや帽子まであると安心やね。" };
  }
  if (uv >= 5) {
    return { short: "軽めでよか", long: "軽めの日焼け対策ばしとくと、だいぶ楽よ。" };
  }
  return { short: "最低限でよか", long: "UVは強すぎんけん、最低限の対策で十分よ。" };
}

function getOutdoorAdvice(forecast) {
  const rainChance = forecast.precipitationProbabilityMax ?? 0;
  const wind = forecast.windSpeedMax ?? 0;
  if (rainChance >= 70 || wind >= 30) {
    return { short: "計画は慎重に", long: "長時間の外出は、空ば見ながら動いた方がよかよ。" };
  }
  if (rainChance >= 30) {
    return { short: "傘があれば大丈夫", long: "外出はしやすかけど、傘があるとさらに安心やね。" };
  }
  return { short: "動きやすか日", long: "外にも出やすいコンディションよ。" };
}

async function postEarthquakeAlerts(env, options = {}) {
  const state = await readEarthquakeState(env);
  const reports = await fetchEarthquakeReports();
  const alerts = findTargetCityAlerts(
    reports,
    state.notifiedKeys ?? [],
    numberEnv(env.EARTHQUAKE_MAX_REPORT_AGE_MINUTES, 360)
  );

  if (!state.initialized) {
    await writeEarthquakeState(env, {
      initialized: true,
      notifiedKeys: unique([...alerts.map((alert) => alert.key), ...(state.notifiedKeys ?? [])]).slice(-100),
      updatedAt: new Date().toISOString(),
    });
    return { initialized: true, posted: 0, alerts };
  }

  if (options.dryRun || alerts.length === 0) {
    return { initialized: true, posted: 0, alerts };
  }

  for (const alert of alerts) {
    await sendDiscordMessage(env, buildEarthquakeDiscordPayload(alert), "cloudflare-earthquake-discord-bot/1.0");
  }

  await writeEarthquakeState(env, {
    initialized: true,
    notifiedKeys: unique([...(state.notifiedKeys ?? []), ...alerts.map((alert) => alert.key)]).slice(-100),
    updatedAt: new Date().toISOString(),
  });

  return { initialized: true, posted: alerts.length, alerts };
}

async function readEarthquakeState(env) {
  const raw = await env.EARTHQUAKE_STATE.get(EARTHQUAKE_STATE_KEY);
  if (!raw) {
    return { initialized: false, notifiedKeys: [] };
  }

  return JSON.parse(raw);
}

async function writeEarthquakeState(env, state) {
  await env.EARTHQUAKE_STATE.put(EARTHQUAKE_STATE_KEY, JSON.stringify(state, null, 2));
}

async function fetchEarthquakeReports() {
  const response = await fetch("https://www.jma.go.jp/bosai/quake/data/list.json", {
    headers: {
      Accept: "application/json",
      "User-Agent": "cloudflare-earthquake-discord-bot/1.0",
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

function findTargetCityAlerts(reports, notifiedKeys, maxReportAgeMinutes) {
  const notified = new Set(notifiedKeys);
  const latestReportByEvent = new Map();
  const now = new Date();

  for (const report of reports) {
    if (!report.eid || !isIntensityReport(report) || !isRecentReport(report, now, maxReportAgeMinutes)) {
      continue;
    }

    const existing = latestReportByEvent.get(report.eid);
    if (!existing || String(report.ctt) > String(existing.ctt)) {
      latestReportByEvent.set(report.eid, report);
    }
  }

  const alerts = [];
  for (const report of latestReportByEvent.values()) {
    for (const city of EARTHQUAKE_TARGETS) {
      const intensity = findCityIntensity(report, city);
      if (!intensity) {
        continue;
      }

      const key = `${report.eid}:${city.name}`;
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
      });
    }
  }

  return alerts.sort((a, b) => String(a.reportTime).localeCompare(String(b.reportTime)));
}

function findCityIntensity(report, targetCity) {
  if (!Array.isArray(report.int)) {
    return null;
  }

  let maxIntensity = null;
  for (const prefecture of report.int) {
    if (!Array.isArray(prefecture.city)) {
      continue;
    }

    for (const city of prefecture.city) {
      const code = String(city.code);
      if (!targetCity.cityCodePrefixes.some((prefix) => code.startsWith(prefix))) {
        continue;
      }

      const intensity = city.maxi || prefecture.maxi || report.maxi || "不明";
      if (maxIntensity === null || compareIntensity(intensity, maxIntensity) > 0) {
        maxIntensity = intensity;
      }
    }
  }

  return maxIntensity;
}

function buildEarthquakeDiscordPayload(alert) {
  return {
    embeds: [
      {
        author: { name: `${alert.city.emoji} ${alert.city.name}エリア` },
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
        footer: { text: "気象庁 地震情報をもとに通知しています" },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function isIntensityReport(report) {
  return report.en_ttl === "Earthquake and Seismic Intensity Information" || report.ttl === "震源・震度情報";
}

function isRecentReport(report, now, maxReportAgeMinutes) {
  const timestamp = Date.parse(report.rdt || report.at || "");
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const ageMs = now.getTime() - timestamp;
  return ageMs >= 0 && ageMs <= maxReportAgeMinutes * 60 * 1000;
}

function compareIntensity(left, right) {
  return intensityRank(left) - intensityRank(right);
}

function intensityRank(intensity) {
  const ranks = { "1": 1, "2": 2, "3": 3, "4": 4, "5-": 5, "5+": 6, "6-": 7, "6+": 8, "7": 9 };
  return ranks[String(intensity)] ?? 0;
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
  const labels = { "1": "1", "2": "2", "3": "3", "4": "4", "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強", "7": "7" };
  return labels[String(intensity)] || String(intensity);
}

async function sendDiscordMessage(env, payload, userAgent) {
  const response = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": userAgent,
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

function entryClock(isoText) {
  return isoText.split("T")[1]?.slice(0, 5) || isoText;
}

function formatDateTime(value) {
  if (!value) return "不明";
  return String(value).replace("T", " ").replace("+09:00", "");
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

function formatPercent(value) {
  return value === null ? "-" : `${Math.round(value)}%`;
}

function numberEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected number, got: ${value}`);
  }

  return parsed;
}

function unique(values) {
  return [...new Set(values)];
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
