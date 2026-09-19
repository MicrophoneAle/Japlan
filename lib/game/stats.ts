import { FREEFORM_SOURCE } from "./freeform";
import { placeKey } from "./validate";

// Per-person trip stats for Wrapped. The live counters (participant_stats,
// bumped by lib/handlers/stats.ts as things happen) and deriveStats below
// must agree: this file is the definition of each stat, and statsDrift
// compares the two. Change a definition here and in the bump together.

export const STAT_FIELDS = [
  "itinerary_items_total",
  "tasks_completed",
  "photos_submitted",
  "photo_bonuses_earned",
  "sidequests_claimed",
  "freeform_claims",
  "days_with_activity",
  "distance_km",
  "places_visited",
] as const;

export type StatField = (typeof STAT_FIELDS)[number];
export type Stats = Record<StatField, number>;

export function zeroStats(): Stats {
  return Object.fromEntries(STAT_FIELDS.map((f) => [f, 0])) as Stats;
}

export type StatTask = {
  id: string;
  participant_id: string | null;
  team_id: string | null;
  day: number;
  neighborhood: string | null;
  source?: string | null;
};

export type StatClaim = {
  task_id: string;
  participant_id: string;
  status: string;
  evidence_url: string | null;
  resolution_json: unknown;
};

// Tasks that count toward someone's itinerary: generated for them (their
// own, or their team's), not ones they made up by claiming (freeform), and
// not the unowned shared board.
export function countsAsItineraryItem(task: Pick<StatTask, "source">): boolean {
  return task.source !== FREEFORM_SOURCE;
}

export function statPlaceKey(neighborhood: string | null | undefined): string | null {
  return placeKey(neighborhood ?? undefined);
}

export function photoBonusOf(resolution: unknown): number {
  const r = (resolution ?? {}) as { photo_bonus?: unknown };
  const n = Number(r.photo_bonus);
  return Number.isFinite(n) ? n : 0;
}

// Every stat, recomputed from rows.
export function deriveStats(input: {
  participantIds: string[];
  tasks: StatTask[];
  claims: StatClaim[];
  // team id -> member participant ids
  teamMembers: Record<string, string[]>;
  // participant id -> sidequests won
  sidequestWins?: Record<string, number>;
}): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  const byTask = new Map(input.tasks.map((t) => [t.id, t]));
  for (const pid of input.participantIds) {
    const s = zeroStats();
    s.itinerary_items_total = input.tasks.filter(
      (t) =>
        countsAsItineraryItem(t) &&
        (t.participant_id === pid || (t.team_id !== null && (input.teamMembers[t.team_id] ?? []).includes(pid))),
    ).length;
    const done = input.claims.filter((c) => c.participant_id === pid && c.status === "awarded");
    s.tasks_completed = done.length;
    s.photos_submitted = done.filter((c) => c.evidence_url).length;
    s.photo_bonuses_earned = done.filter((c) => photoBonusOf(c.resolution_json) > 0).length;
    s.freeform_claims = done.filter((c) => byTask.get(c.task_id)?.source === FREEFORM_SOURCE).length;
    const days = new Set<number>();
    const places = new Set<string>();
    for (const c of done) {
      const task = byTask.get(c.task_id);
      if (!task) continue;
      days.add(task.day);
      const key = statPlaceKey(task.neighborhood);
      if (key) places.add(key);
    }
    s.days_with_activity = days.size;
    s.places_visited = places.size;
    s.sidequests_claimed = input.sidequestWins?.[pid] ?? 0;
    // Claims carry no location yet: nothing to sum.
    s.distance_km = 0;
    out[pid] = s;
  }
  return out;
}

// The shared Wrapped cards: summed across people, on read. Never stored.
export function groupTotals(rows: Stats[]): Stats {
  const total = zeroStats();
  for (const row of rows) for (const f of STAT_FIELDS) total[f] += Number(row[f] ?? 0);
  return total;
}

export type Drift = { participantId: string; field: StatField; stored: number; derived: number };

export function compareStats(stored: Record<string, Partial<Stats>>, derived: Record<string, Stats>): Drift[] {
  const drift: Drift[] = [];
  for (const [pid, want] of Object.entries(derived)) {
    for (const f of STAT_FIELDS) {
      const have = Number(stored[pid]?.[f] ?? 0);
      if (have !== want[f]) drift.push({ participantId: pid, field: f, stored: have, derived: want[f] });
    }
  }
  return drift;
}
