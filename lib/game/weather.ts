export type DayWeather = {
  temperatureC: number | null;
  precipitationChance: number | null;
  summary: string;
  indoorPreferred: boolean;
};

function weatherCodeSummary(code: number): { summary: string; wet: boolean } {
  if (code === 0) return { summary: "clear", wet: false };
  if (code <= 3) return { summary: "cloudy", wet: false };
  if (code <= 48) return { summary: "fog", wet: false };
  if (code <= 67) return { summary: "rain", wet: true };
  if (code <= 77) return { summary: "snow", wet: true };
  if (code <= 82) return { summary: "rain", wet: true };
  if (code <= 99) return { summary: "storms", wet: true };
  return { summary: "mixed", wet: false };
}

export function formatWeatherLine(weather: DayWeather): string {
  const bits: string[] = [];
  if (weather.temperatureC !== null) bits.push(`${Math.round(weather.temperatureC)}°C`);
  bits.push(weather.summary);
  return bits.join(", ");
}

export async function fetchDayWeather(opts: {
  lat: number;
  lng: number;
  date: string;
  timezone: string;
}): Promise<DayWeather> {
  // TODO: plan requires weather in the header and in generation but does not name a provider.
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(opts.lat));
  url.searchParams.set("longitude", String(opts.lng));
  url.searchParams.set("daily", "weather_code,temperature_2m_max,precipitation_probability_max");
  url.searchParams.set("timezone", opts.timezone);
  url.searchParams.set("start_date", opts.date);
  url.searchParams.set("end_date", opts.date);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`weather HTTP ${res.status}`);
  }
  const payload = (await res.json()) as {
    daily?: {
      weather_code?: number[];
      temperature_2m_max?: number[];
      precipitation_probability_max?: number[];
    };
  };
  const code = payload.daily?.weather_code?.[0] ?? 1;
  const { summary, wet } = weatherCodeSummary(code);
  const precip = payload.daily?.precipitation_probability_max?.[0] ?? null;
  const indoorPreferred = wet || (precip !== null && precip >= 50);
  return {
    temperatureC: payload.daily?.temperature_2m_max?.[0] ?? null,
    precipitationChance: precip,
    summary: indoorPreferred && precip !== null ? `${summary}, rain likely` : summary,
    indoorPreferred,
  };
}
