import { loadEnvConfig } from "@next/env";
import { getServiceClient } from "../lib/db/client";
import { TOKYO_HAND_PROFILE } from "../lib/game/tokyo-profile";

loadEnvConfig(process.cwd(), true);

function todayInTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function resolveTripId(): Promise<string> {
  const wanted = process.env.TRIP_ID?.trim();
  const supabase = getServiceClient();
  if (wanted) return wanted;

  const { data, error } = await supabase
    .from("trips")
    .select("id, name, is_solo")
    .eq("is_solo", true);
  if (error) throw error;
  const trips = data ?? [];
  if (trips.length === 0) {
    throw new Error("no solo trip found. run japlan solo first, or set TRIP_ID.");
  }
  if (trips.length > 1) {
    throw new Error(
      `multiple solo trips: ${trips.map((t) => t.id).join(", ")}. set TRIP_ID.`,
    );
  }
  return trips[0].id as string;
}

async function main(): Promise<void> {
  const tripId = await resolveTripId();
  const start = todayInTokyo();
  const { data, error } = await getServiceClient()
    .from("trips")
    .update({
      destination: "Tokyo",
      timezone: "Asia/Tokyo",
      start_date: start,
      destination_profile_json: TOKYO_HAND_PROFILE,
    })
    .eq("id", tripId)
    .select("id, destination, timezone, is_solo")
    .single();
  if (error) throw error;
  console.log("seeded destination profile", {
    tripId: data.id,
    destination: data.destination,
    timezone: data.timezone,
    is_solo: data.is_solo,
    neighborhoods: TOKYO_HAND_PROFILE.neighborhoods.length,
    landmarks: TOKYO_HAND_PROFILE.landmarks.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
