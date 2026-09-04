import type { WeatherSummary } from "@shared/schema";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: WeatherSummary | null }>();

const WEATHER_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Cloudy",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Heavy freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Heavy showers",
  82: "Violent showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Severe thunderstorm",
};

function riskFromWeather(code: number, windKmh: number | null, precipitationMm: number | null): WeatherSummary["risk"] {
  if ([82, 95, 96, 99].includes(code) || (windKmh ?? 0) >= 55 || (precipitationMm ?? 0) >= 8) return "high";
  if ([45, 48, 65, 67, 73, 75, 80, 81, 85, 86].includes(code) || (windKmh ?? 0) >= 35 || (precipitationMm ?? 0) >= 2) return "moderate";
  return "low";
}

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

export async function getWeatherSummary(lat: number | null | undefined, lng: number | null | undefined): Promise<WeatherSummary | null> {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);

    const payload = await response.json() as any;
    const current = payload?.current;
    const units = payload?.current_units || {};
    if (!current || typeof current.weather_code !== "number") throw new Error("Missing current weather");

    const windKmh = typeof current.wind_speed_10m === "number" ? current.wind_speed_10m : null;
    const precipitationMm = typeof current.precipitation === "number" ? current.precipitation : null;
    const weather: WeatherSummary = {
      summary: WEATHER_LABELS[current.weather_code] || "Weather unavailable",
      temperatureC: typeof current.temperature_2m === "number" ? Math.round(current.temperature_2m) : null,
      feelsLikeC: typeof current.apparent_temperature === "number" ? Math.round(current.apparent_temperature) : null,
      humidityPercent: typeof current.relative_humidity_2m === "number" ? Math.round(current.relative_humidity_2m) : null,
      windKmh: windKmh == null ? null : Math.round(windKmh),
      precipitationMm,
      weatherCode: current.weather_code,
      risk: riskFromWeather(current.weather_code, windKmh, precipitationMm),
      observedAt: current.time ? new Date(current.time).toISOString() : new Date().toISOString(),
      source: "Open-Meteo",
      units: {
        temperature: units.temperature_2m || "°C",
        wind: units.wind_speed_10m || "km/h",
        precipitation: units.precipitation || "mm",
      },
    };
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: weather });
    return weather;
  } catch (error: any) {
    console.warn("[WEATHER] lookup failed:", error?.message || error);
    cache.set(key, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  }
}
