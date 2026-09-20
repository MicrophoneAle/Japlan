// Loading and writing a trip's legs. The pure side (which leg a date falls in,
// which city, which timezone) is lib/game/legs.ts; this is the I/O.
//
// Legs are loaded once per trip load and hung on the trip as `trip.legs`, so
// the ~50 call sites that used to read trips.timezone / trips.destination stay
// synchronous and cost no query of their own. That matters on the claim path,
// where a second round trip is the known hang (see CLAUDE.md).
//
// Never fatal. A missing table (migration not run), an error, or a trip whose
// legs were never written all read as "no legs", and lib/game/legs.ts
// synthesises a single leg from trips.destination / timezone / dates. That is
// exactly what the old single-city code did, so nothing can break on a missed
// migration.

import { getServiceClient } from "@/lib/db/client";
import type { TripRow } from "@/lib/db/types";
import { legsOf, splitIntoLegs, type TripLeg } from "@/lib/game/legs";

export const LEG_COLS =
  "id, trip_id, leg_order, city, start_date, end_date, timezone, destination_profile_json, is_travel_day";

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.legs] step", { step, ...fields });
}

export async function loadTripLegs(tripId: string): Promise<TripLeg[]> {
  const { data, error } = await getServiceClient()
    .from("trip_legs")
    .select(LEG_COLS)
    .eq("trip_id", tripId)
    .order("leg_order");
  if (error) {
    step("load.skipped", { code: error.code, note: "migration 2026-10-03 applied?" });
    return [];
  }
  return (data ?? []) as TripLeg[];
}

// Attach legs to a freshly loaded trip. Safe to call on null.
export async function withLegs<T extends TripRow | null>(trip: T): Promise<T> {
  if (!trip) return trip;
  if (trip.legs && trip.legs.length > 0) return trip;
  trip.legs = await loadTripLegs(trip.id);
  return trip;
}

// Replace the trip's legs wholesale. Setup owns this: a destination or date
// change rewrites the whole list rather than patching one row, because legs
// have to keep partitioning the dates.
export async function writeTripLegs(
  tripId: string,
  legs: Omit<TripLeg, "id" | "trip_id">[],
): Promise<TripLeg[]> {
  const client = getServiceClient();
  const cleared = await client.from("trip_legs").delete().eq("trip_id", tripId);
  if (cleared.error) {
    step("write.clear_failed", { code: cleared.error.code, note: "migration 2026-10-03 applied?" });
    return [];
  }
  if (legs.length === 0) return [];
  const { data, error } = await client
    .from("trip_legs")
    .insert(legs.map((leg) => ({ ...leg, trip_id: tripId })))
    .select(LEG_COLS);
  if (error) {
    step("write.failed", { code: error.code, tripId });
    return [];
  }
  step("written", { tripId, legs: legs.length, cities: legs.map((l) => l.city).join(" > ") });
  return (data ?? []) as TripLeg[];
}

// Setup's entry point: the cities they named plus the trip's dates become a
// partition. One city is one leg, which is the single-city path and must stay
// indistinguishable from what trips.destination alone used to do.
export async function setTripLegsFromCities(opts: {
  trip: TripRow;
  cities: { city: string; timezone: string | null }[];
  startDate: string;
  endDate: string;
}): Promise<TripLeg[]> {
  const planned = splitIntoLegs({
    tripId: opts.trip.id,
    cities: opts.cities,
    startDate: opts.startDate,
    endDate: opts.endDate,
  });
  if (planned.length === 0) return [];
  const written = await writeTripLegs(
    opts.trip.id,
    planned.map(({ id: _id, trip_id: _tripId, ...leg }) => {
      void _id;
      void _tripId;
      return leg;
    }),
  );
  opts.trip.legs = written;
  return written;
}

// Which leg a place belongs to, for the places pool. Null when the trip has
// only a synthesised leg (nothing to point at yet).
export function legIdForWrite(trip: TripRow, date: string): string | null {
  const legs = legsOf(trip);
  const leg = legs.find((l) => date >= l.start_date && date <= l.end_date) ?? legs[0];
  return leg.id.startsWith("synthetic:") || leg.id.startsWith("pending:") ? null : leg.id;
}
