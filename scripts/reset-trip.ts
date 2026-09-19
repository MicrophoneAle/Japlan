import { loadEnvConfig } from "@next/env";
import { getServiceClient } from "../lib/db/client";

loadEnvConfig(process.cwd(), true);

// Default: wipe the trip's board (tasks and claims), keep the trip, its
// people, and its destination profile.
//   TRIP_ID=<uuid> npx tsx scripts/reset-trip.ts
// --hard: delete the trip and everything under it, for testing. Relies on the
// ON DELETE CASCADE foreign keys from the 2026-09-21 migration.
//   TRIP_ID=<uuid> npx tsx scripts/reset-trip.ts --hard

async function resolveTripId(): Promise<string> {
  const wanted = process.env.TRIP_ID?.trim();
  if (wanted) return wanted;
  throw new Error("set TRIP_ID to the trip to reset.");
}

async function count(table: string, column: string, value: string): Promise<number> {
  const { count: n, error } = await getServiceClient()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value);
  if (error) throw error;
  return n ?? 0;
}

async function hardReset(tripId: string): Promise<void> {
  const supabase = getServiceClient();
  const before = {
    participants: await count("participants", "trip_id", tripId),
    tasks: await count("tasks", "trip_id", tripId),
    teams: await count("teams", "trip_id", tripId),
    places: await count("places", "trip_id", tripId),
  };
  const { data, error } = await supabase
    .from("trips")
    .delete()
    .eq("id", tripId)
    .select("id, linq_chat_id");
  if (error) {
    if (error.code === "23503") {
      throw new Error(
        "a foreign key blocked the delete: run lib/db/migrations/2026-09-21-trip-lifecycle-and-setup.sql first (it adds ON DELETE CASCADE).",
      );
    }
    throw error;
  }
  if (!data || data.length === 0) throw new Error(`trip not found: ${tripId}`);
  console.log("hard reset: trip deleted with everything under it", {
    tripId,
    chatId: (data[0] as { linq_chat_id: string }).linq_chat_id,
    removed: before,
    note: "events rows are kept (trip_id set null) so old Linq retries stay deduplicated",
  });
}

async function softReset(tripId: string): Promise<void> {
  const supabase = getServiceClient();

  const tripRes = await supabase
    .from("trips")
    .select("id, destination_profile_json, is_solo")
    .eq("id", tripId)
    .maybeSingle();
  if (tripRes.error) throw tripRes.error;
  if (!tripRes.data) throw new Error(`trip not found: ${tripId}`);

  const tasksRes = await supabase
    .from("tasks")
    .select("id")
    .eq("trip_id", tripId);
  if (tasksRes.error) throw tasksRes.error;
  const taskIds = (tasksRes.data ?? []).map((row) => row.id as string);

  if (taskIds.length > 0) {
    const claimsRes = await supabase
      .from("claims")
      .delete()
      .in("task_id", taskIds);
    if (claimsRes.error) throw claimsRes.error;
  }

  const deleteTasks = await supabase.from("tasks").delete().eq("trip_id", tripId);
  if (deleteTasks.error) throw deleteTasks.error;

  console.log("reset trip board", {
    tripId,
    tasksCleared: taskIds.length,
    profileIntact: Boolean(tripRes.data.destination_profile_json),
    is_solo: tripRes.data.is_solo,
  });
}

async function main(): Promise<void> {
  const tripId = await resolveTripId();
  if (process.argv.includes("--hard")) {
    await hardReset(tripId);
  } else {
    await softReset(tripId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
