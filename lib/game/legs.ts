// A trip is a list of legs: a city and the dates you are in it. Day five in
// Osaka has to generate Osaka tasks, and board_time has to fire on Osaka's
// clock, so nothing reads trips.destination or trips.timezone directly any
// more. It resolves the leg for the date in question and reads that.
//
// Legs PARTITION the trip's dates: no gaps, no overlaps, every date in exactly
// one leg. A date outside the trip clamps to the nearest end, because plenty
// of callers ask about "today" before the trip starts or after it ends and the
// old code simply used trips.timezone for those.
//
// Single-city trips are one leg and behave identically, by construction: when
// a trip has no legs loaded (or the migration has not run) legsOf synthesises
// one from trips.destination / timezone / dates / destination_profile_json,
// which is exactly what the old code read. That fallback is the reason no call
// site can break on a missed migration.
//
// Pure: no network, no database. Handlers load legs and hang them on the trip.

import { localDateString } from "./time";
import { isCountryWord } from "./countries";

export type TripLeg = {
  id: string;
  trip_id: string;
  leg_order: number;
  city: string;
  start_date: string;
  end_date: string;
  timezone: string | null;
  destination_profile_json?: unknown | null;
  // The first date of a leg that follows another one. Leg 1 is never one.
  is_travel_day: boolean;
};

// What legsOf needs off a trip. Deliberately structural, so TripRow and a test
// fixture both satisfy it.
export type LeggedTrip = {
  id: string;
  destination?: string | null;
  timezone?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  destination_profile_json?: unknown | null;
  legs?: TripLeg[] | null;
};

// The single leg a one-city trip has always implicitly been. Used when nothing
// loaded legs, and when the migration has not run.
export function syntheticLeg(trip: LeggedTrip): TripLeg {
  return {
    id: `synthetic:${trip.id}`,
    trip_id: trip.id,
    leg_order: 1,
    city: trip.destination?.trim() || "the trip",
    start_date: trip.start_date ?? "",
    end_date: trip.end_date ?? "",
    timezone: trip.timezone ?? null,
    destination_profile_json: trip.destination_profile_json ?? null,
    is_travel_day: false,
  };
}

export function isSyntheticLeg(leg: TripLeg): boolean {
  return leg.id.startsWith("synthetic:");
}

// Always at least one leg, always in order.
export function legsOf(trip: LeggedTrip): TripLeg[] {
  const loaded = trip.legs;
  if (!loaded || loaded.length === 0) return [syntheticLeg(trip)];
  return [...loaded].sort((a, b) => a.leg_order - b.leg_order);
}

export function isMultiCity(trip: LeggedTrip): boolean {
  return legsOf(trip).length > 1;
}

// The leg a trip-local date falls in. Never null: a date before the trip takes
// the first leg, a date after it takes the last, which is what the old
// single-timezone code did for the same dates.
export function legForDate(trip: LeggedTrip, date: string): TripLeg {
  const legs = legsOf(trip);
  for (const leg of legs) {
    if (leg.start_date && date < leg.start_date) continue;
    if (leg.end_date && date > leg.end_date) continue;
    return leg;
  }
  const first = legs[0];
  if (first.start_date && date < first.start_date) return first;
  return legs[legs.length - 1];
}

// The leg happening right now. Circular by nature: you need a timezone to know
// what "today" is, and the date to know the timezone.
//
// Resolving it by re-reading the date in the guessed leg's zone does NOT
// converge. When the next city is BEHIND the current one, there is a window
// (Tokyo is already the 5th, Bangkok is still the 4th) where each leg's zone
// points at the other, and the answer oscillates.
//
// So this does not iterate. The current leg is the LAST leg that has started
// in its own timezone, which is a monotonic property of time: it can only ever
// move forward, so it is stable at every instant and never flips back. In that
// straddling window it keeps them in the city they have not left yet, which is
// also where they physically are.
export function legForNow(trip: LeggedTrip, now: Date): TripLeg {
  const legs = legsOf(trip);
  if (legs.length === 1) return legs[0];
  let current = legs[0];
  for (const leg of legs) {
    if (!leg.start_date) continue;
    if (localDateString(now, leg.timezone) >= leg.start_date) current = leg;
  }
  return current;
}

// The two reads that replace trips.timezone everywhere.
export function zoneFor(trip: LeggedTrip, date: string): string {
  return legForDate(trip, date).timezone || trip.timezone || "UTC";
}

export function zoneNow(trip: LeggedTrip, now: Date): string {
  return legForNow(trip, now).timezone || trip.timezone || "UTC";
}

// The trip-local date it is right now, in the zone of wherever they are.
export function todayFor(trip: LeggedTrip, now: Date): string {
  return localDateString(now, zoneNow(trip, now));
}

// The read that replaces trips.destination everywhere.
export function cityFor(trip: LeggedTrip, date: string): string {
  return legForDate(trip, date).city || trip.destination?.trim() || "";
}

export function cityNow(trip: LeggedTrip, now: Date): string {
  return legForNow(trip, now).city || trip.destination?.trim() || "";
}

// A travel day is the first date of a leg that follows another one: you arrive
// that day, so the board is light and transit-shaped rather than a normal day
// that assumes you are already somewhere.
export function isTravelDate(trip: LeggedTrip, date: string): boolean {
  const leg = legForDate(trip, date);
  return leg.is_travel_day && leg.start_date === date;
}

// "Tokyo", "Tokyo → Osaka", "Tokyo → Osaka → Kyoto". The display string for
// settings, Wrapped and anywhere that used to print trips.destination whole.
export function legsLabel(trip: LeggedTrip): string {
  const cities = legsOf(trip)
    .map((leg) => leg.city.trim())
    .filter(Boolean)
    .filter((city, i, all) => all.indexOf(city) === i);
  return cities.join(" → ");
}

// Every city on the trip, in order, no repeats. Wrapped's "cities visited".
export function legCities(trip: LeggedTrip): string[] {
  return legsOf(trip)
    .map((leg) => leg.city.trim())
    .filter(Boolean)
    .filter((city, i, all) => all.indexOf(city) === i);
}

// Legs are only usable if they actually partition the trip. Returns the
// problems rather than throwing: setup uses it to re-ask, and a stored trip
// with a gap should degrade, not crash.
export function legProblems(legs: TripLeg[]): string[] {
  const problems: string[] = [];
  const ordered = [...legs].sort((a, b) => a.leg_order - b.leg_order);
  for (const [i, leg] of ordered.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(leg.end_date)) {
      problems.push(`leg ${i + 1} has unusable dates`);
      continue;
    }
    if (leg.end_date < leg.start_date) problems.push(`leg ${i + 1} ends before it starts`);
    const prev = ordered[i - 1];
    if (!prev) continue;
    if (leg.start_date <= prev.end_date) problems.push(`leg ${i + 1} overlaps the one before it`);
  }
  return problems;
}

// Turn a list of cities and the trip's dates into legs that partition those
// dates. Used by setup when someone answers with more than one place and by
// the migration path for a single city. Splits as evenly as possible, longer
// legs first, because the leftover days are better spent at the start.
export function splitIntoLegs(opts: {
  tripId: string;
  cities: { city: string; timezone: string | null }[];
  startDate: string;
  endDate: string;
}): TripLeg[] {
  const cities = opts.cities.filter((c) => c.city.trim());
  if (cities.length === 0) return [];
  const days = daysInclusive(opts.startDate, opts.endDate);
  if (days < 1) return [];
  const per = Math.floor(days / cities.length);
  const extra = days % cities.length;
  const legs: TripLeg[] = [];
  let cursor = opts.startDate;
  for (const [i, entry] of cities.entries()) {
    // Every leg gets at least a day even when there are more cities than days;
    // splitIntoLegs never returns a leg that ends before it starts.
    const length = Math.max(1, per + (i < extra ? 1 : 0));
    const end = addDays(cursor, length - 1);
    legs.push({
      id: `pending:${i + 1}`,
      trip_id: opts.tripId,
      leg_order: i + 1,
      city: entry.city.trim(),
      start_date: cursor,
      end_date: end > opts.endDate ? opts.endDate : end,
      timezone: entry.timezone,
      destination_profile_json: null,
      is_travel_day: i > 0,
    });
    cursor = addDays(end, 1);
    if (cursor > opts.endDate && i < cities.length - 1) break;
  }
  return legs;
}

function addDays(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function daysInclusive(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}

// "where are you going?" answers. One place is one leg and costs no extra
// questions, which is the whole point: multi-city only asks more when someone
// actually names more than one place.
//
// A comma is ambiguous ("tokyo, japan" is one place, "tokyo, osaka" is two),
// so a trailing country word is folded back into the part before it. Explicit
// separators (and / then / -> / via) are never ambiguous.
const LEG_SEPARATORS = /\s*(?:->|→|=>|\band then\b|\bthen\b|\band\b|\bvia\b|\+|&|\/|,|;)\s*/i;

export function splitDestinationAnswer(text: string): string[] {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return [];
  const raw = cleaned
    .split(LEG_SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean);
  if (raw.length <= 1) return raw;
  // Fold a country or region back onto the city it qualifies: "tokyo, japan"
  // is one leg, and so is "kyoto and osaka, japan" for its last leg.
  const merged: string[] = [];
  for (const part of raw) {
    if (merged.length > 0 && isCountryWord(part)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}, ${part}`;
      continue;
    }
    merged.push(part);
  }
  // Same place twice in a row ("tokyo then tokyo") is one leg.
  return merged.filter((part, i) => i === 0 || part.toLowerCase() !== merged[i - 1].toLowerCase());
}
