import { getServiceClient } from "@/lib/db/client";
import { prefsOf } from "@/lib/game/prefs";
import { topInterestWords } from "@/lib/game/profile";
import type { SurveyAnswers } from "@/lib/game/survey";
import { buildWrappedData, type WrappedPhoto, type WrappedStory } from "@/lib/game/wrapped";
import { readStats } from "./stats";

// A real trip's Wrapped, in the contract the page renders (lib/game/wrapped).
// Numbers come from participant_stats, kept live as the trip happens.
export async function wrappedDataFor(tripId: string, placeholder: WrappedPhoto): Promise<WrappedStory | null> {
  const db = getServiceClient();
  const trip = await db.from("trips").select("name, destination, start_date, end_date").eq("id", tripId).maybeSingle();
  if (trip.error) throw trip.error;
  if (!trip.data) return null;
  const people = await db.from("participants").select("id, display_name, score, survey_json, prefs_json").eq("trip_id", tripId);
  if (people.error) throw people.error;
  const tasks = await db.from("tasks").select("id, title, neighborhood").eq("trip_id", tripId);
  if (tasks.error) throw tasks.error;
  const taskRows = (tasks.data ?? []) as { id: string; title: string; neighborhood: string | null }[];
  const claims = taskRows.length
    ? await db.from("claims").select("task_id, participant_id, awarded_points").eq("status", "awarded").in("task_id", taskRows.map((t) => t.id))
    : { data: [], error: null };
  if (claims.error) throw claims.error;
  const byTask = new Map(taskRows.map((t) => [t.id, t]));
  const stored = await readStats(tripId);
  type P = { id: string; display_name: string; score: number; survey_json: unknown; prefs_json: unknown };
  return buildWrappedData({
    trip: trip.data as { name: string; destination: string | null; start_date: string | null; end_date: string | null },
    people: ((people.data ?? []) as P[]).map((p) => {
      const answers = (p.survey_json ?? {}) as SurveyAnswers;
      return { id: p.id, name: p.display_name, score: p.score, favorite: topInterestWords(prefsOf(p.prefs_json, answers)) };
    }),
    stats: Object.fromEntries(stored.map((s) => [s.participant_id, s])),
    awarded: ((claims.data ?? []) as { task_id: string; participant_id: string; awarded_points: number | null }[]).map((c) => ({
      participantId: c.participant_id,
      title: byTask.get(c.task_id)?.title ?? "",
      points: c.awarded_points ?? 0,
      neighborhood: byTask.get(c.task_id)?.neighborhood ?? null,
    })),
    placeholder,
  });
}
