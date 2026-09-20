// Public holidays, per country per year, from Nager.Date (date.nager.at).
//
// Why an API and not a scrape: public holidays are a solved, closed dataset.
// They are published years ahead, they do not change, and every country's list
// is a few dozen rows. A browser session per lookup would be slower, flakier
// and less accurate than one JSON GET.
//
// Why this one: no API key and no account, so there is no secret to leak, no
// env var to forget, and nothing to break when a free tier lapses. It is open
// source (MIT), covers ~110 countries including every destination the alias
// table in lib/game/city-timezones.ts names, and answers in a single
// unauthenticated GET per country-year.
//
// Nothing here throws. A dead host, a country Nager does not carry, a shape we
// do not recognise: all of it comes back as null and the trip keeps its
// weekend multipliers. A holiday is a bonus, never a gate.

const BASE = "https://date.nager.at/api/v3";
const TIMEOUT_MS = 6_000;

export type PublicHoliday = { date: string; name: string };

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.multipliers] step", { step, ...fields });
}

// Nager returns regional days too (a German Land, a US state). A day only half
// the country has off does not empty the streets, so only nationwide public
// holidays count.
type NagerRow = {
  date?: unknown;
  name?: unknown;
  localName?: unknown;
  global?: unknown;
  counties?: unknown;
  types?: unknown;
};

function nationwidePublic(row: NagerRow): PublicHoliday | null {
  const date = typeof row.date === "string" ? row.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // `global: false` with a county list is the regional case.
  if (row.global === false) return null;
  if (Array.isArray(row.counties) && row.counties.length > 0) return null;
  // Observances and bank-only days are not a day off.
  const types = Array.isArray(row.types) ? row.types.map(String) : [];
  if (types.length > 0 && !types.includes("Public")) return null;
  const name = typeof row.name === "string" && row.name.trim()
    ? row.name.trim()
    : typeof row.localName === "string"
      ? row.localName.trim()
      : "";
  return name ? { date, name } : null;
}

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    // 404 is Nager's answer for a country it does not carry: a miss, not a bug.
    if (!response.ok) {
      step("nager.not_ok", { url, status: response.status });
      return null;
    }
    return await response.json();
  } catch (err) {
    step("nager.failed", { url, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Every nationwide public holiday for a country across the years a trip spans
// (two, for a trip over new year). Null means we learned nothing; an empty
// array means we asked and the country has none in those years.
export async function fetchPublicHolidays(opts: {
  countryCode: string;
  years: number[];
}): Promise<PublicHoliday[] | null> {
  const country = opts.countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const years = [...new Set(opts.years)].filter((y) => Number.isInteger(y) && y > 1900 && y < 2200);
  if (years.length === 0) return null;

  const pages = await Promise.all(
    years.map((year) => getJson(`${BASE}/PublicHolidays/${year}/${country}`)),
  );
  // Every year failing means we know nothing. One year answering is enough to
  // be useful, so a partial result is still a result.
  if (pages.every((page) => page === null)) return null;

  const found: PublicHoliday[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const row of page) {
      const holiday = nationwidePublic((row ?? {}) as NagerRow);
      if (holiday) found.push(holiday);
    }
  }
  step("nager.ok", { country, years: years.join(","), count: found.length });
  return found;
}
