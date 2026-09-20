// What days are worth more on this trip. Two tiers, two different tools.
//
// Tier 1, national holidays: Nager.Date (lib/holidays/nager.ts). Public
// holidays are a solved dataset, published by country and year, and they do
// not change. No key, one JSON GET, derived from the country the destination
// already resolves to (lib/game/countries.ts). Never a browser session: a
// session per lookup would be slower and less accurate than the answer.
//
// Tier 2, local festivals: Browserbase, stateless only. A neighbourhood
// matsuri, a city festival, a parade is exactly what no holiday API carries,
// so this is where a search earns its place. search() then fetch() as markdown,
// never launch()/Stagehand, which spins up a real session for seconds to
// minutes. Runs from the daily cron, which is off the webhook path entirely.
//
// Nothing here throws, and a miss is normal rather than an error. A missing
// key, a dead host, a country Nager does not carry, a model that returns
// nonsense: the trip keeps its weekend multipliers and the board is posted
// regardless. A special day is a bonus, never a gate.

import { browserbase } from "@browserbasehq/stagehand";
import { getServiceClient } from "@/lib/db/client";
import type { TripRow } from "@/lib/db/types";
import { extractLocalFestivals } from "@/lib/llm/gemini";
import { countryForTrip } from "@/lib/game/countries";
import { isSyntheticLeg, legForDate, legsOf } from "@/lib/game/legs";
import { fetchPublicHolidays } from "@/lib/holidays/nager";
import {
  taskMultiplierFor,
  validSpecialDays,
  type MultiplierDay,
  type TaskMultiplier,
} from "@/lib/game/multipliers";
import { tripLengthDays } from "@/lib/game/scoring";

const SEARCH_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 10_000;
// Holidays for a year do not move, and a city's festival calendar moves
// slowly. One lookup a week per trip is plenty, and a failed lookup backs off
// the same way rather than retrying every tick.
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGE_CHARS = 20_000;
const MAX_PAGES_TRIED = 2;

export type RefreshOutcome = {
  holidays: number;
  festivals: number;
  reason:
    | "stored"
    | "incomplete_trip"
    | "checked_recently"
    | "no_country"
    | "none_found"
    | "migration_missing"
    | "failed";
};

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.multipliers] step", { step, ...fields });
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The trip's stored special days. A missing table (migration not run) reads as
// no special days, so weekends still work.
export async function loadMultiplierDays(tripId: string): Promise<MultiplierDay[]> {
  const { data, error } = await getServiceClient()
    .from("multiplier_days")
    .select("local_date, multiplier, label, source")
    .eq("trip_id", tripId);
  if (error) {
    step("load.skipped", { code: error.code, note: "migration 2026-10-02 applied?" });
    return [];
  }
  return (data ?? []) as MultiplierDay[];
}

// What this trip-day is worth, as a factor on the points the board prints.
// Weekends need nothing fetched, so this answers before any lookup has run.
export async function dayMultiplierFor(
  trip: Pick<TripRow, "id" | "start_date" | "end_date">,
  day: number,
  localDate: string,
): Promise<TaskMultiplier | null> {
  return taskMultiplierFor({
    localDate,
    day,
    tripDays: tripLengthDays(trip.start_date, trip.end_date),
    days: await loadMultiplierDays(trip.id),
  });
}

async function checkedAt(tripId: string): Promise<{ ok: boolean; at: string | null }> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select("multipliers_checked_at")
    .eq("id", tripId)
    .maybeSingle();
  if (error) {
    step("checked_at.skipped", { code: error.code, note: "migration 2026-10-02 applied?" });
    return { ok: false, at: null };
  }
  const row = data as { multipliers_checked_at: string | null } | null;
  return { ok: true, at: row?.multipliers_checked_at ?? null };
}

async function markChecked(tripId: string, now: Date): Promise<void> {
  const { error } = await getServiceClient()
    .from("trips")
    .update({ multipliers_checked_at: now.toISOString() })
    .eq("id", tripId);
  if (error) step("mark_checked.failed", { code: error.code });
}

// Replace one tier's rows without touching the other's: a failed festival
// scrape must never delete the holidays we did find.
async function storeSource(
  tripId: string,
  source: "holiday" | "festival",
  days: (MultiplierDay & { leg_id?: string | null })[],
): Promise<boolean> {
  const client = getServiceClient();
  const cleared = await client
    .from("multiplier_days")
    .delete()
    .eq("trip_id", tripId)
    .eq("source", source);
  if (cleared.error) {
    step("store.clear_failed", { code: cleared.error.code, note: "migration 2026-10-02 applied?" });
    return false;
  }
  if (days.length === 0) return true;
  const { error } = await client
    .from("multiplier_days")
    .upsert(days.map((day) => ({ ...day, trip_id: tripId })), { onConflict: "trip_id,local_date" });
  if (error) {
    step("store.failed", { code: error.code, source });
    return false;
  }
  return true;
}

// Tier 1, per leg. A Tokyo to Seoul trip has two countries and two holiday
// sets, and each leg's holidays only count on that leg's own dates. Legs
// partition the trip, so the results can never collide on a date.
async function nationalHolidays(trip: TripRow): Promise<(MultiplierDay & { leg_id: string | null })[] | null> {
  const legs = legsOf(trip);
  const out: (MultiplierDay & { leg_id: string | null })[] = [];
  let anyAnswered = false;
  for (const leg of legs) {
    const country = countryForTrip({ destination: leg.city, timezone: leg.timezone });
    if (!country) {
      step("holidays.no_country", { tripId: trip.id, leg: leg.leg_order, city: leg.city });
      continue;
    }
    const years = [Number(leg.start_date.slice(0, 4)), Number(leg.end_date.slice(0, 4))];
    const found = await fetchPublicHolidays({ countryCode: country, years });
    if (found === null) continue;
    anyAnswered = true;
    // Clipped to THIS leg's dates: a Japanese holiday must not pay out on the
    // Seoul half of the trip.
    const days = validSpecialDays(
      found.map((holiday) => ({ date: holiday.date, name: holiday.name, kind: "holiday" })),
      { start: leg.start_date, end: leg.end_date },
    );
    step("holidays.kept", {
      tripId: trip.id,
      leg: leg.leg_order,
      country,
      fetched: found.length,
      kept: days.length,
    });
    out.push(...days.map((day) => ({ ...day, leg_id: isSyntheticLeg(leg) ? null : leg.id })));
  }
  return anyAnswered ? out : null;
}

// Tier 2. Search, then read the first page that gives us anything. Two pages
// at most: this is a nice-to-have behind a cron, not a research task.
async function festivalPageText(opts: {
  apiKey: string;
  destination: string;
  start: string;
  end: string;
}): Promise<string | null> {
  const year = opts.start.slice(0, 4);
  const endYear = opts.end.slice(0, 4);
  const years = year === endYear ? year : `${year} ${endYear}`;
  const query = `${opts.destination} local festivals matsuri street events calendar ${years}`;
  const found = await withTimeout(
    browserbase.search({ apiKey: opts.apiKey, query, numResults: 5 }),
    SEARCH_TIMEOUT_MS,
    "browserbase.search",
  );
  const urls = found.results
    .map((result) => result.url)
    .filter((url) => url.startsWith("https://"))
    .slice(0, MAX_PAGES_TRIED);
  step("festivals.search", { query, count: urls.length });
  for (const url of urls) {
    try {
      const page = await withTimeout(
        browserbase.fetch({ apiKey: opts.apiKey, url, format: "markdown" }),
        FETCH_TIMEOUT_MS,
        "browserbase.fetch",
      );
      const content = typeof page.content === "string" ? page.content : "";
      if (content.trim().length > 0) {
        step("festivals.fetch.ok", { url, chars: content.length });
        return content.slice(0, MAX_PAGE_CHARS);
      }
      step("festivals.fetch.empty", { url });
    } catch (err) {
      step("festivals.fetch.failed", { url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return null;
}

async function localFestivals(trip: TripRow): Promise<(MultiplierDay & { leg_id: string | null })[] | null> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    step("festivals.skip", { reason: "no_api_key", tripId: trip.id });
    return null;
  }
  const pageText = await festivalPageText({
    apiKey,
    destination: trip.destination!,
    start: trip.start_date!,
    end: trip.end_date!,
  });
  if (!pageText) return null;
  const proposed = await extractLocalFestivals({
    pageText,
    destination: trip.destination!,
    start: trip.start_date!,
    end: trip.end_date!,
  });
  // Whatever the page called it, this tier is a festival: only Nager decides
  // what counts as a national holiday.
  const days = validSpecialDays(
    proposed.map((row) => ({ date: row.date, name: row.name, kind: "festival" })),
    { start: trip.start_date!, end: trip.end_date! },
  ).map((day) => {
    // Tag with whichever leg owns that date, so a festival found for one city
    // is recorded against it.
    const leg = legForDate(trip, day.local_date);
    return { ...day, leg_id: isSyntheticLeg(leg) ? null : leg.id };
  });
  step("festivals.kept", { tripId: trip.id, proposed: proposed.length, kept: days.length });
  return days;
}

// Look up this trip's special days, once a week at most. Safe to call on every
// cron tick, and safe to call at setup with `festivals: false`, which leaves
// out the only part that touches Browserbase.
export async function refreshTripMultipliers(
  trip: TripRow,
  opts: { now?: Date; force?: boolean; festivals?: boolean } = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  const empty = { holidays: 0, festivals: 0 };
  if (!trip.destination || !trip.start_date || !trip.end_date) {
    return { ...empty, reason: "incomplete_trip" };
  }
  const checked = await checkedAt(trip.id);
  if (!checked.ok) return { ...empty, reason: "migration_missing" };
  if (!opts.force && checked.at) {
    const age = now.getTime() - Date.parse(checked.at);
    if (Number.isFinite(age) && age < REFRESH_AFTER_MS) {
      return { ...empty, reason: "checked_recently" };
    }
  }

  let outcome: RefreshOutcome = { ...empty, reason: "failed" };
  try {
    // Independent on purpose: a country Nager does not carry still gets its
    // festivals, and a dead scrape still gets its holidays.
    const holidays = await nationalHolidays(trip).catch((err) => {
      step("holidays.failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    const festivals =
      opts.festivals === false
        ? null
        : await localFestivals(trip).catch((err) => {
            step("festivals.failed", { error: err instanceof Error ? err.message : String(err) });
            return null;
          });

    let stored = true;
    if (holidays) stored = (await storeSource(trip.id, "holiday", holidays)) && stored;
    if (festivals) stored = (await storeSource(trip.id, "festival", festivals)) && stored;

    const counts = { holidays: holidays?.length ?? 0, festivals: festivals?.length ?? 0 };
    outcome = !stored
      ? { ...counts, reason: "migration_missing" }
      : holidays === null && festivals === null
        ? { ...counts, reason: countryForTrip(trip) ? "failed" : "no_country" }
        : counts.holidays + counts.festivals === 0
          ? { ...counts, reason: "none_found" }
          : { ...counts, reason: "stored" };
    step("refreshed", { tripId: trip.id, ...outcome });
  } catch (err) {
    step("failed", { tripId: trip.id, error: err instanceof Error ? err.message : String(err) });
    outcome = { ...empty, reason: "failed" };
  }
  // Marked on success and on failure alike: a destination with nothing to find
  // must not be looked up again every tick.
  await markChecked(trip.id, now);
  return outcome;
}
