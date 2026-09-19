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

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const tripId = await resolveTripId();
  const start = todayInTokyo();
  const supabase = getServiceClient();
  // Stands in for the organizer setup: a trip only goes active once it has
  // a destination and both dates.
  const { data, error } = await supabase
    .from("trips")
    .update({
      destination: "Tokyo",
      timezone: "Asia/Tokyo",
      start_date: start,
      end_date: addDays(start, 4),
      setup_state: "done",
      destination_profile_json: TOKYO_HAND_PROFILE,
    })
    .eq("id", tripId)
    .select("id, destination, timezone, is_solo, state")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`trip not found: ${tripId}`);

  // Activate if every survey is done (the step setup completion would take).
  const people = await supabase.from("participants").select("survey_state").eq("trip_id", tripId);
  if (people.error) throw people.error;
  const allDone =
    (people.data ?? []).length > 0 &&
    (people.data ?? []).every((p) => (p as { survey_state: string | null }).survey_state === "done");
  if (allDone && data.state !== "active") {
    const activate = await supabase.from("trips").update({ state: "active" }).eq("id", tripId);
    if (activate.error) throw activate.error;
    data.state = "active";
  }
  console.log("seeded destination profile", {
    tripId: data.id,
    destination: data.destination,
    timezone: data.timezone,
    is_solo: data.is_solo,
    state: data.state,
    neighborhoods: TOKYO_HAND_PROFILE.neighborhoods.length,
    landmarks: TOKYO_HAND_PROFILE.landmarks.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
