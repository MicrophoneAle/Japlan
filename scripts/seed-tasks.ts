import { loadEnvConfig } from "@next/env";
import { formatDailyBoard } from "../lib/game/board";
import { HAND_WRITTEN_DAY1_TASKS } from "../lib/game/hand-written-tasks";
import { computePoints, tierForPoints } from "../lib/game/scoring";
import { getServiceClient } from "../lib/db/client";
import { sendText } from "../lib/linq/send";

loadEnvConfig(process.cwd(), true);

async function main(): Promise<void> {
  const supabase = getServiceClient();
  const wantedId = process.env.TRIP_ID;
  let query = supabase
    .from("trips")
    .select("id, linq_chat_id, name, state")
    .eq("state", "active");
  if (wantedId) query = query.eq("id", wantedId);
  const { data, error } = await query;
  if (error) throw error;
  const trips = data ?? [];
  if (trips.length === 0) {
    throw new Error("no active trip. finish the survey, or set TRIP_ID.");
  }
  if (trips.length > 1 && !wantedId) {
    throw new Error(
      `multiple active trips: ${trips.map((t) => t.id).join(", ")}. set TRIP_ID.`,
    );
  }
  const trip = trips[0] as {
    id: string;
    linq_chat_id: string;
    name: string;
  };

  const rows = HAND_WRITTEN_DAY1_TASKS.map((task) => {
    const base_points = computePoints(task.axes);
    const tier = tierForPoints(base_points);
    if (!tier) {
      throw new Error(`${task.code} scored ${base_points}, outside the three bands`);
    }
    console.log(
      `${task.code} ${tier} ${task.verification} ${base_points}pts bonus<=${task.photo_bonus_max} ${task.title}`,
    );
    return {
      trip_id: trip.id,
      participant_id: null,
      team_id: null,
      code: task.code,
      title: task.title,
      tier,
      axes_json: task.axes,
      base_points,
      photo_bonus_max: task.photo_bonus_max,
      verification: task.verification,
      day: 1,
      neighborhood: task.neighborhood,
    };
  });

  const { error: upsertError } = await supabase.from("tasks").upsert(rows, {
    onConflict: "trip_id,code",
  });
  if (upsertError) throw upsertError;

  const { data: people, error: peopleError } = await supabase
    .from("participants")
    .select("display_name, score")
    .eq("trip_id", trip.id);
  if (peopleError) throw peopleError;

  const board = formatDailyBoard({
    day: 1,
    tasks: rows,
    standings: (people ?? []) as { display_name: string; score: number }[],
  });
  const sent = await sendText(trip.linq_chat_id, board);
  console.log("board posted", sent);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
