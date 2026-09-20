import { getServiceClient } from "@/lib/db/client";
import type { TripRow } from "@/lib/db/types";
import { localDateString } from "@/lib/game/time";
import { completeTripAndAnnounce } from "./trip-lifecycle";

export function tripHasExpired(trip: Pick<TripRow, "end_date" | "timezone">, now: Date): boolean {
  return Boolean(trip.end_date && trip.end_date < localDateString(now, trip.timezone));
}

// Run after the final local calendar day. A guarded completion means a cron
// retry or a concurrent organizer command cannot announce twice.
export async function completeExpiredTrips(opts: {
  now?: Date;
  tripId?: string;
} = {}): Promise<{ completed: string[]; skipped: string[] }> {
  const now = opts.now ?? new Date();
  let query = getServiceClient()
    .from("trips")
    .select("*")
    .neq("state", "complete")
    .not("end_date", "is", null);
  if (opts.tripId) query = query.eq("id", opts.tripId);
  const { data, error } = await query;
  if (error) throw error;

  const completed: string[] = [];
  const skipped: string[] = [];
  for (const trip of (data ?? []) as TripRow[]) {
    if (!tripHasExpired(trip, now)) {
      skipped.push(trip.id);
      continue;
    }
    try {
      if (await completeTripAndAnnounce({ trip })) completed.push(trip.id);
      else skipped.push(trip.id);
    } catch (error) {
      console.error("[japlan.lifecycle] expiry completion failed", {
        tripId: trip.id,
        error: error instanceof Error ? error.message : String(error),
      });
      skipped.push(trip.id);
    }
  }
  return { completed, skipped };
}
