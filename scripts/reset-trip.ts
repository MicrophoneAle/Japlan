import { loadEnvConfig } from "@next/env";
import { getServiceClient } from "../lib/db/client";

loadEnvConfig(process.cwd(), true);

async function resolveTripId(): Promise<string> {
  const wanted = process.env.TRIP_ID?.trim();
  if (wanted) return wanted;
  throw new Error("set TRIP_ID to the trip to reset.");
}

async function main(): Promise<void> {
  const tripId = await resolveTripId();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
