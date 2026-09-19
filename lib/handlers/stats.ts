import { getServiceClient } from "@/lib/db/client";
import {
  compareStats,
  countsAsItineraryItem,
  deriveStats,
  photoBonusOf,
  statPlaceKey,
  STAT_FIELDS,
  zeroStats,
  type Drift,
  type Stats,
  type StatClaim,
  type StatField,
  type StatTask,
} from "@/lib/game/stats";
import { FREEFORM_SOURCE } from "@/lib/game/freeform";

// Live per-person trip stats (participant_stats, migration 2026-09-29). Every
// write is one call to bump_participant_stats: atomic, so concurrent claims
// cannot lose an increment. A bump never throws: stats must never cost
// anyone a claim or a board. A failed bump is logged, and statsDrift finds it.

type Deltas = Partial<Record<Exclude<StatField, "days_with_activity" | "places_visited">, number>>;

export async function bumpStats(
  tripId: string,
  participantId: string,
  deltas: Deltas,
  opts: { day?: number | null; place?: string | null } = {},
): Promise<void> {
  try {
    const { error } = await getServiceClient().rpc("bump_participant_stats", {
      p_trip_id: tripId,
      p_participant_id: participantId,
      p_deltas: deltas,
      p_day: opts.day ?? null,
      p_place: opts.place ?? null,
    });
    if (error) console.error("[japlan.stats] bump failed", { tripId, participantId, deltas, code: error.code });
  } catch (err) {
    console.error("[japlan.stats] bump failed", { tripId, participantId, deltas, err });
  }
}

// A claim was just awarded: everything that follows from it, in one bump.
export async function recordClaimAwarded(opts: {
  tripId: string;
  participantId: string;
  task: Pick<StatTask, "day" | "neighborhood" | "source">;
  evidenceUrl: string | null;
  resolution: unknown;
}): Promise<void> {
  await bumpStats(
    opts.tripId,
    opts.participantId,
    {
      tasks_completed: 1,
      photos_submitted: opts.evidenceUrl ? 1 : 0,
      photo_bonuses_earned: photoBonusOf(opts.resolution) > 0 ? 1 : 0,
      freeform_claims: opts.task.source === FREEFORM_SOURCE ? 1 : 0,
    },
    { day: opts.task.day, place: statPlaceKey(opts.task.neighborhood) },
  );
}

// Tasks created (+1) or removed (-1) for people: their own, or their team's
// members at the time. Freeform tasks and the unowned shared board do not
// count toward anyone's itinerary.
export async function recordTasksChanged(
  tripId: string,
  rows: Pick<StatTask, "participant_id" | "team_id" | "source">[],
  sign: 1 | -1,
): Promise<void> {
  const perPerson = new Map<string, number>();
  const teamIds = [...new Set(rows.filter((r) => countsAsItineraryItem(r) && !r.participant_id && r.team_id).map((r) => r.team_id!))];
  const members: Record<string, string[]> = {};
  if (teamIds.length) {
    const { data, error } = await getServiceClient().from("team_members").select("team_id, participant_id").in("team_id", teamIds);
    if (error) console.error("[japlan.stats] team lookup failed", { tripId, code: error.code });
    for (const row of (data ?? []) as { team_id: string; participant_id: string }[]) {
      (members[row.team_id] ??= []).push(row.participant_id);
    }
  }
  for (const row of rows) {
    if (!countsAsItineraryItem(row)) continue;
    const owners = row.participant_id ? [row.participant_id] : row.team_id ? members[row.team_id] ?? [] : [];
    for (const pid of owners) perPerson.set(pid, (perPerson.get(pid) ?? 0) + sign);
  }
  for (const [pid, n] of perPerson) await bumpStats(tripId, pid, { itinerary_items_total: n });
}

export type StoredStats = Stats & { participant_id: string };

export async function readStats(tripId: string): Promise<StoredStats[]> {
  const { data, error } = await getServiceClient()
    .from("participant_stats")
    .select(["participant_id", ...STAT_FIELDS].join(", "))
    .eq("trip_id", tripId);
  if (error) throw error;
  return ((data ?? []) as unknown as StoredStats[]).map((row) => ({ ...zeroStats(), ...row }));
}

// Every stat rebuilt from claims, tasks and teams. What the counters must
// equal.
export async function recomputeStats(tripId: string): Promise<Record<string, Stats>> {
  const db = getServiceClient();
  const [people, tasks] = await Promise.all([
    db.from("participants").select("id").eq("trip_id", tripId),
    db.from("tasks").select("id, participant_id, team_id, day, neighborhood, source").eq("trip_id", tripId),
  ]);
  if (people.error) throw people.error;
  if (tasks.error) throw tasks.error;
  const taskRows = (tasks.data ?? []) as StatTask[];
  const claims = taskRows.length
    ? await db
        .from("claims")
        .select("task_id, participant_id, status, evidence_url, resolution_json")
        .in("task_id", taskRows.map((t) => t.id))
    : { data: [], error: null };
  if (claims.error) throw claims.error;
  const teamIds = [...new Set(taskRows.map((t) => t.team_id).filter((t): t is string => Boolean(t)))];
  const teamMembers: Record<string, string[]> = {};
  if (teamIds.length) {
    const tm = await db.from("team_members").select("team_id, participant_id").in("team_id", teamIds);
    if (tm.error) throw tm.error;
    for (const row of (tm.data ?? []) as { team_id: string; participant_id: string }[]) {
      (teamMembers[row.team_id] ??= []).push(row.participant_id);
    }
  }
  // Sidequest wins, once delivery exists (table from migration 2026-09-28).
  const wins: Record<string, number> = {};
  const offers = await db.from("sidequest_offers").select("participant_id, status").eq("trip_id", tripId).eq("status", "won");
  if (!offers.error) {
    for (const row of (offers.data ?? []) as { participant_id: string }[]) wins[row.participant_id] = (wins[row.participant_id] ?? 0) + 1;
  }
  return deriveStats({
    participantIds: ((people.data ?? []) as { id: string }[]).map((p) => p.id),
    tasks: taskRows,
    claims: (claims.data ?? []) as StatClaim[],
    teamMembers,
    sidequestWins: wins,
  });
}

// Stored counters against the recomputed truth. Empty means trustworthy.
export async function statsDrift(tripId: string): Promise<Drift[]> {
  const [stored, derived] = await Promise.all([readStats(tripId), recomputeStats(tripId)]);
  const drift = compareStats(Object.fromEntries(stored.map((s) => [s.participant_id, s])), derived);
  if (drift.length) console.warn("[japlan.stats] drift", { tripId, drift });
  return drift;
}
