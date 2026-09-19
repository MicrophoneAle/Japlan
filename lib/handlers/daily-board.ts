import { formatMorningStandings, formatPersonalBoard } from "@/lib/game/board";
import {
  assembleDestinationProfile,
  type DestinationProfile,
} from "@/lib/game/destination";
import {
  assignOwnedDayCodes,
  fillTemplatesDeterministically,
  generateTasksForAssignee,
  pickBounty,
  TASKS_PER_CALL,
  type ExistingDayCode,
} from "@/lib/game/generate";
import { peerLapsedLine } from "@/lib/game/copy";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import {
  pointsForBoard,
  tripLengthDays,
} from "@/lib/game/scoring";
import {
  validateGeneratedTask,
  type AssigneeConstraints,
  type ProposedTask,
} from "@/lib/game/validate";
import {
  fetchDayWeather,
  formatWeatherLine,
  type DayWeather,
} from "@/lib/game/weather";
import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { sendDM, sendText } from "@/lib/linq/send";
import { applySoloVerification } from "@/lib/game/solo";
// Plan does not specify the exact expiry instant; tasks end with the trip's local day.
import { endOfLocalDay, localDateString, localHour } from "@/lib/game/time";

import { TRIP_COLS } from "@/lib/db/columns";
import { boardDueNow, tripDayForDate } from "@/lib/game/board-schedule";

// Matches tasks_owner_code_key: codes are unique per owner per day, not per trip.
const TASK_CODE_CONFLICT = "trip_id,day,participant_id,team_id,code";

export type PersistedGeneratedTask = {
  code: string;
  title: string;
  base_points: number;
  day: number;
};

function logReject(reason: string, title: string, extra: Record<string, unknown> = {}) {
  console.info("[japlan.generate] rejected", { reason, title, ...extra });
}

function preferenceText(answers: SurveyAnswers): string {
  const bits = [
    answerValue(answers, "interests"),
    answerValue(answers, "pace"),
    answerValue(answers, "chaos"),
    answerValue(answers, "food_adventure"),
    answerValue(answers, "nightlife"),
    answerValue(answers, "drinking"),
  ].filter(Boolean);
  return bits.join("; ") || "(no survey answers)";
}

export function isLocalMorning(now: Date, timezone: string): boolean {
  return localHour(now, timezone) === 8;
}

// The trip day a local date falls on; falls back to the current day when the
// trip has no start date (only in tests and legacy rows).
export function tripDayOn(trip: TripRow, date: string, now: Date): number {
  return trip.start_date ? tripDayForDate(trip.start_date, date) : currentTripDay(trip, now);
}

export function currentTripDay(trip: TripRow, now: Date): number {
  if (!trip.start_date) return 1;
  const today = localDateString(now, trip.timezone || "UTC");
  const start = Date.parse(trip.start_date);
  const current = Date.parse(today);
  if (Number.isNaN(start) || Number.isNaN(current)) return 1;
  const day = Math.floor((current - start) / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, day);
}

async function completedTitles(tripId: string, participantIds: string[]): Promise<string[]> {
  if (participantIds.length === 0) return [];
  const supabase = getServiceClient();
  const { data: claims, error } = await supabase
    .from("claims")
    .select("task_id, status, participant_id")
    .in("participant_id", participantIds)
    .eq("status", "awarded");
  if (error) throw error;
  const taskIds = [...new Set((claims ?? []).map((c) => (c as { task_id: string }).task_id))];
  if (taskIds.length === 0) return [];
  const { data: tasks, error: taskErr } = await supabase
    .from("tasks")
    .select("title")
    .eq("trip_id", tripId)
    .in("id", taskIds);
  if (taskErr) throw taskErr;
  return (tasks ?? []).map((t) => (t as { title: string }).title);
}

async function yesterdayRatings(tripId: string): Promise<string> {
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getServiceClient()
    .from("ratings")
    .select("score, place_id, created_at, participant_id")
    .gte("created_at", since);
  if (error) throw error;
  void tripId;
  if (!data || data.length === 0) return "";
  return (data as { score: number }[])
    .map((row) => `rating ${row.score}`)
    .join(", ");
}

type Assignee = {
  kind: "person" | "team";
  id: string;
  participantId: string | null;
  teamId: string | null;
  people: ParticipantRow[];
  label: string;
};

async function loadAssignees(tripId: string, people: ParticipantRow[]): Promise<Assignee[]> {
  const { data, error } = await getServiceClient()
    .from("teams")
    .select("id, name, dissolved_at")
    .eq("trip_id", tripId)
    .is("dissolved_at", null);
  if (error) throw error;
  const teams = (data ?? []) as { id: string; name: string }[];
  if (teams.length === 0) {
    return people.map((person) => ({
      kind: "person" as const,
      id: person.id,
      participantId: person.id,
      teamId: null,
      people: [person],
      label: person.display_name,
    }));
  }

  const assignees: Assignee[] = [];
  for (const team of teams) {
    const { data: members, error: memErr } = await getServiceClient()
      .from("team_members")
      .select("participant_id")
      .eq("team_id", team.id);
    if (memErr) throw memErr;
    const ids = new Set(
      (members ?? []).map((m) => (m as { participant_id: string }).participant_id),
    );
    assignees.push({
      kind: "team",
      id: team.id,
      participantId: null,
      teamId: team.id,
      people: people.filter((p) => ids.has(p.id)),
      label: team.name,
    });
  }
  return assignees;
}

export function scoreGapText(people: ParticipantRow[]): string {
  if (people.length === 0) return "no scores yet";
  if (people.length === 1) return `solo trip, ${people[0].score} points so far, no opponents`;
  const sorted = [...people].sort((a, b) => b.score - a.score);
  const lead = sorted[0];
  const trail = sorted[sorted.length - 1];
  return `${lead.display_name} ${lead.score} leads; ${trail.display_name} ${trail.score} trails; gap ${lead.score - trail.score}`;
}

function trailingPlayer(people: ParticipantRow[]): ParticipantRow | null {
  if (people.length < 2) return null;
  const sorted = [...people].sort((a, b) => a.score - b.score);
  if (sorted[0].score === sorted[1].score) return null;
  return sorted[0];
}

function filterValid(
  proposals: ProposedTask[],
  assignees: AssigneeConstraints[],
  completed: string[],
  expiresAt: Date,
): ProposedTask[] {
  const kept: ProposedTask[] = [];
  for (const task of proposals) {
    const reason = validateGeneratedTask(task, {
      assignees,
      completedTitles: completed,
      expiresAt,
    });
    if (reason) {
      logReject(reason, task.title);
      continue;
    }
    kept.push(task);
    completed.push(task.title);
  }
  return kept;
}

async function proposalsForAssignee(opts: {
  assignee: Assignee;
  profile: DestinationProfile;
  weather: DayWeather;
  completed: string[];
  ratings: string;
  gap: string;
  day: number;
  difficulty?: string | null;
}): Promise<ProposedTask[]> {
  const answers = (opts.assignee.people[0]?.survey_json ?? {}) as SurveyAnswers;
  return generateTasksForAssignee({
    profile: opts.profile,
    weather: opts.weather,
    preferenceText: preferenceText(answers),
    completedTitles: opts.completed,
    yesterdayRatings: opts.ratings,
    scoreGap: opts.gap,
    day: opts.day,
    difficulty: opts.difficulty,
  });
}

export function persistableTask(opts: {
  tripId: string;
  day: number;
  tripDays: number | null;
  task: ProposedTask;
  participantId: string | null;
  teamId: string | null;
  expiresAt: Date;
  isSolo?: boolean;
}): { row: Omit<TaskRow, "id"> } {
  const { points, tier } = pointsForBoard(opts.task.axes, {
    day: opts.day,
    tripDays: opts.tripDays,
  });
  const [task] = applySoloVerification([opts.task], Boolean(opts.isSolo));
  const rowTask = task ?? opts.task;
  return {
    row: {
      trip_id: opts.tripId,
      participant_id: opts.participantId,
      team_id: opts.teamId,
      code: rowTask.code,
      title: rowTask.title,
      tier,
      axes_json: rowTask.axes,
      base_points: points,
      photo_bonus_max: rowTask.photo_bonus_max,
      verification: rowTask.verification,
      day: opts.day,
      expires_at: opts.expiresAt.toISOString(),
      neighborhood: rowTask.neighborhood || null,
      source: rowTask.source ?? "generated",
    },
  };
}

export async function generateValidatedBoard(opts: {
  trip: TripRow;
  people: ParticipantRow[];
  profile: DestinationProfile;
  weather: DayWeather;
  now?: Date;
  // The trip-local date the board is for. Default: today. A future date is an
  // on-demand provisional board; everything else in the pipeline is the same.
  date?: string;
  // Codes already taken today by tasks that must survive (claimed ones).
  reservedCodes?: ExistingDayCode[];
}): Promise<{ tasks: ProposedTask[]; usedFallback: boolean; day: number }> {
  const now = opts.now ?? new Date();
  const date = opts.date ?? localDateString(now, opts.trip.timezone || "UTC");
  const day = tripDayOn(opts.trip, date, now);
  const expiresAt = endOfLocalDay(date, opts.trip.timezone || "UTC");
  const assignees = await loadAssignees(opts.trip.id, opts.people);
  const ratings = await yesterdayRatings(opts.trip.id);
  const gap = scoreGapText(opts.people);
  const wanted = Math.max(TASKS_PER_CALL, assignees.length * TASKS_PER_CALL);

  async function run(round: number): Promise<ProposedTask[]> {
    const collected: ProposedTask[] = [];
    for (const assignee of assignees) {
      const completed = await completedTitles(
        opts.trip.id,
        assignee.people.map((p) => p.id),
      );
      const constraints: AssigneeConstraints[] = assignee.people.map((p) => ({
        answers: (p.survey_json ?? {}) as SurveyAnswers,
      }));
      let proposals: ProposedTask[] = [];
      try {
        proposals = await proposalsForAssignee({
          assignee,
          profile: opts.profile,
          weather: opts.weather,
          completed,
          ratings,
          gap,
          day,
          difficulty: opts.trip.difficulty,
        });
      } catch (err) {
        console.error("[japlan.generate] llm failed", {
          round,
          assignee: assignee.label,
          err,
        });
      }
      const valid = filterValid(proposals, constraints, completed, expiresAt);
      collected.push(
        ...valid.map((task) => ({
          ...task,
          neighborhood: task.neighborhood || opts.profile.destination,
          participantId: assignee.participantId,
          teamId: assignee.teamId,
        })),
      );
    }
    return collected;
  }

  let kept = await run(1);
  let usedFallback = false;
  if (kept.length < wanted / 2) {
    console.info("[japlan.generate] regenerating; more than half rejected", {
      kept: kept.length,
      wanted,
    });
    kept = await run(2);
  }
  if (kept.length < wanted / 2) {
    usedFallback = true;
    const completed = await completedTitles(
      opts.trip.id,
      opts.people.map((p) => p.id),
    );
    const constraints: AssigneeConstraints[] = opts.people.map((p) => ({
      answers: (p.survey_json ?? {}) as SurveyAnswers,
    }));
    const fallback = fillTemplatesDeterministically({
      profile: opts.profile,
      weather: opts.weather,
      count: wanted,
    });
    kept = filterValid(fallback, constraints, completed, expiresAt);
    console.info("[japlan.generate] fallback templates", { kept: kept.length });
  }

  const trailer = trailingPlayer(opts.people);
  if (trailer) {
    const trailerDone = await completedTitles(opts.trip.id, [trailer.id]);
    const bounty = pickBounty({
      profile: opts.profile,
      day,
      trailer: {
        id: trailer.id,
        answers: (trailer.survey_json ?? {}) as SurveyAnswers,
      },
      avoidTitles: [...trailerDone, ...kept.map((t) => t.title)],
      expiresAt,
      now,
      onReject: (reason, title, attempt) =>
        logReject(reason, title, { bounty: true, attempt }),
    });
    if (bounty) kept.push(bounty);
    else logReject("no_valid_bounty", "(none)", { bounty: true, trailer: trailer.id });
  }

  const soloAdjusted = applySoloVerification(
    kept,
    Boolean(opts.trip.is_solo),
  );
  const teamMembers: Record<string, string[]> = {};
  for (const assignee of assignees) {
    if (assignee.teamId) {
      teamMembers[assignee.teamId] = assignee.people.map((p) => p.id);
    }
  }
  const coded = assignOwnedDayCodes(soloAdjusted, day, {
    participantIds: opts.people.map((p) => p.id),
    teamMembers,
    existing: opts.reservedCodes,
  });
  return { tasks: coded, usedFallback, day };
}

const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

// Whose tasks can be generated: anyone whose allergies and limits we know.
// Someone mid-survey (a late joiner, say) is left off rather than given tasks
// that might clash with answers they have not given yet. Null survey_state is
// a participant from before surveys existed, treated as known.
export function constraintsKnown(person: Pick<ParticipantRow, "survey_state">): boolean {
  const state = person.survey_state;
  return !state || state === "done";
}

async function tripPeople(tripId: string): Promise<ParticipantRow[]> {
  const res = await getServiceClient()
    .from("participants")
    .select(PARTICIPANT_COLS)
    .eq("trip_id", tripId);
  if (res.error) throw res.error;
  return (res.data ?? []) as ParticipantRow[];
}

async function weatherFor(
  profile: DestinationProfile | null,
  date: string,
  timezone: string,
): Promise<DayWeather> {
  const unknown: DayWeather = {
    temperatureC: null,
    precipitationChance: null,
    summary: "unknown",
    indoorPreferred: false,
  };
  if (!profile?.center) return unknown;
  try {
    return await fetchDayWeather({
      lat: profile.center.lat,
      lng: profile.center.lng,
      date,
      timezone,
    });
  } catch (err) {
    console.error("[japlan.generate] weather failed", err);
    return unknown;
  }
}

export type BuiltBoard = {
  day: number;
  date: string;
  rows: Omit<TaskRow, "id">[];
  weatherLine: string | null;
  usedFallback: boolean;
  people: ParticipantRow[];
};

// THE board pipeline: profile, weather for that date, generation, the
// validation rejects, scoring, per-owner codes, and the write. The cron and
// on-demand requests both come through here, so a board is the same however
// it was asked for. Claimed tasks on the day are never overwritten.
export async function buildBoardForDate(
  trip: TripRow,
  opts: { date: string; now?: Date },
): Promise<BuiltBoard> {
  const now = opts.now ?? new Date();
  const timezone = trip.timezone || "UTC";
  const people = await tripPeople(trip.id);
  let profile: DestinationProfile;
  try {
    profile = await assembleDestinationProfile({ trip, people });
  } catch (err) {
    console.error("[japlan.generate] destination profile failed", err);
    throw err;
  }
  const weather = await weatherFor(profile, opts.date, timezone);
  const day = tripDayOn(trip, opts.date, now);
  const claimedOnDay = await claimedTasksOnDay(trip.id, day);
  const eligible = people.filter(constraintsKnown);
  if (eligible.length < people.length) {
    console.info("[japlan.generate] skipped people with unknown constraints", {
      tripId: trip.id,
      day,
      skipped: people.length - eligible.length,
    });
  }

  const { tasks, usedFallback } = await generateValidatedBoard({
    trip,
    people: eligible,
    profile,
    weather,
    now,
    date: opts.date,
    reservedCodes: claimedOnDay,
  });

  const tripDays = tripLengthDays(trip.start_date, trip.end_date);
  const expiresAt = endOfLocalDay(opts.date, timezone);
  const generated = tasks.map(
    (task) =>
      persistableTask({
        tripId: trip.id,
        day,
        tripDays,
        task,
        participantId: task.participantId ?? null,
        teamId: task.teamId ?? null,
        expiresAt,
        isSolo: Boolean(trip.is_solo),
      }).row,
  );
  const rows = withoutClaimedCollisions(generated, claimedOnDay, trip.id);
  if (rows.length > 0) {
    const { error } = await getServiceClient().from("tasks").upsert(rows, {
      onConflict: TASK_CODE_CONFLICT,
    });
    if (error) throw error;
  }
  console.info("[japlan.generate] board built", {
    tripId: trip.id,
    day,
    date: opts.date,
    count: rows.length,
    usedFallback,
  });
  return { day, date: opts.date, rows, weatherLine: formatWeatherLine(weather), usedFallback, people };
}

// Build today's board and deliver it to everyone. The force=1 path.
export async function runDailyBoardForTrip(
  trip: TripRow,
  opts: { now?: Date } = {},
): Promise<{ posted: boolean; day: number; count: number; usedFallback: boolean }> {
  const now = opts.now ?? new Date();
  // A manual run for a trip outside its dates builds the nearest real day
  // (day 1 before the trip, the last day after it) rather than day 0 or -3.
  const today = localDateString(now, trip.timezone || "UTC");
  const date =
    trip.start_date && today < trip.start_date
      ? trip.start_date
      : trip.end_date && today > trip.end_date
        ? trip.end_date
        : today;
  const lapsed = await sweepLapsedPeerClaims(trip.id, now);
  const built = await buildBoardForDate(trip, { date, now });
  await deliverMorningBoards({
    trip,
    people: built.people,
    rows: built.rows,
    day: built.day,
    weatherLine: built.weatherLine,
    lapsed,
  });
  await upsertBoardRow(trip.id, built.day, date, {
    status: "ready",
    provisional: false,
    delivered_at: new Date().toISOString(),
  });
  console.info("[japlan.generate] board posted", {
    tripId: trip.id,
    day: built.day,
    count: built.rows.length,
    usedFallback: built.usedFallback,
  });
  return { posted: true, day: built.day, count: built.rows.length, usedFallback: built.usedFallback };
}

// ---- boards rows: existence, provisional, delivery, and the generation lock.

export type BoardRow = {
  id: string;
  trip_id: string;
  day: number;
  local_date: string;
  status: string;
  provisional: boolean;
  requested_by: string | null;
  delivered_at: string | null;
  updated_at: string | null;
};

// A generating row older than this is from a crashed run and may be retaken.
const STALE_GENERATING_MS = 10 * 60 * 1000;

export async function getBoard(tripId: string, day: number): Promise<BoardRow | null> {
  const { data, error } = await getServiceClient()
    .from("boards")
    .select("id, trip_id, day, local_date, status, provisional, requested_by, delivered_at, updated_at")
    .eq("trip_id", tripId)
    .eq("day", day)
    .maybeSingle();
  if (error) throw error;
  return (data as BoardRow | null) ?? null;
}

// Insert-first lock: only the caller whose insert succeeds generates the day.
export async function lockNewBoard(
  tripId: string,
  day: number,
  date: string,
  opts: { provisional: boolean; requestedBy?: string | null },
): Promise<BoardRow | null> {
  const { data, error } = await getServiceClient()
    .from("boards")
    .insert({
      trip_id: tripId,
      day,
      local_date: date,
      status: "generating",
      provisional: opts.provisional,
      requested_by: opts.requestedBy ?? null,
    })
    .select("id, trip_id, day, local_date, status, provisional, requested_by, delivered_at, updated_at")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data as BoardRow;
}

// Retake a board for regeneration: ready+provisional, or a stale generating
// row. Conditional update, so two ticks cannot both retake it.
async function relockBoard(board: BoardRow, now: Date): Promise<boolean> {
  let query = getServiceClient()
    .from("boards")
    .update({ status: "generating", updated_at: now.toISOString() })
    .eq("id", board.id);
  if (board.status === "generating") {
    query = query
      .eq("status", "generating")
      .lte("updated_at", new Date(now.getTime() - STALE_GENERATING_MS).toISOString());
  } else {
    query = query.eq("status", "ready").eq("provisional", true);
  }
  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function updateBoard(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await getServiceClient()
    .from("boards")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

async function upsertBoardRow(
  tripId: string,
  day: number,
  date: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const existing = await getBoard(tripId, day);
  if (existing) {
    await updateBoard(existing.id, patch);
    return;
  }
  const { error } = await getServiceClient()
    .from("boards")
    .insert({ trip_id: tripId, day, local_date: date, ...patch });
  if (error && error.code !== "23505") throw error;
}

export async function tasksForDay(tripId: string, day: number): Promise<TaskRow[]> {
  const { data, error } = await getServiceClient()
    .from("tasks")
    .select(
      "id, trip_id, participant_id, team_id, code, title, tier, axes_json, base_points, photo_bonus_max, verification, day, expires_at, neighborhood, source",
    )
    .eq("trip_id", tripId)
    .eq("day", day);
  if (error) throw error;
  return (data ?? []) as TaskRow[];
}

// Deliver a board that already exists (made on demand earlier) to everyone
// who has not seen it. People who asked for it already got it in their reply.
export async function deliverExistingBoard(trip: TripRow, day: number, date: string, now: Date) {
  const people = await tripPeople(trip.id);
  const asked = await getServiceClient()
    .from("board_requests")
    .select("participant_id")
    .eq("trip_id", trip.id)
    .eq("day", day);
  if (asked.error) throw asked.error;
  const seen = new Set(
    (asked.data ?? []).map((row) => (row as { participant_id: string }).participant_id),
  );
  const lapsed = await sweepLapsedPeerClaims(trip.id, now);
  const profile = await cachedProfileOf(trip);
  const weather = await weatherFor(profile, date, trip.timezone || "UTC");
  // Anyone who finished their survey after this board was made has no tasks
  // on it yet: add theirs now, so they are not skipped for the day.
  const dayTasks = await tasksForDay(trip.id, day);
  const owners = new Set(dayTasks.map((t) => t.participant_id).filter(Boolean));
  // Team or shared tasks already reach everyone; top-ups are for personal boards.
  const personalOnly = dayTasks.every((t) => t.participant_id);
  for (const person of personalOnly ? people : []) {
    if (seen.has(person.id) || owners.has(person.id) || !constraintsKnown(person)) continue;
    const topUp = await refillPersonalTasksIfNeeded({
      trip,
      claimant: person,
      people,
      remainingOpenPersonal: 0,
      deliver: false,
      date,
    });
    console.info("[japlan.board] step", {
      step: "delivery.top_up",
      tripId: trip.id,
      day,
      participantId: person.id,
      count: topUp.length,
    });
  }
  const rows = (await tasksForDay(trip.id, day)).map(({ id: _id, ...row }) => {
    void _id;
    return row;
  });
  await deliverMorningBoards({
    trip,
    people: people.filter((p) => !seen.has(p.id)),
    allPeople: people,
    rows,
    day,
    weatherLine: formatWeatherLine(weather),
    lapsed,
  });
}

async function cachedProfileOf(trip: TripRow): Promise<DestinationProfile | null> {
  const raw = trip.destination_profile_json;
  return raw && typeof raw === "object" ? (raw as DestinationProfile) : null;
}

async function dayHasClaims(tripId: string, day: number): Promise<boolean> {
  return (await claimedTasksOnDay(tripId, day)).length > 0;
}

export async function deleteUnclaimedTasksForDay(tripId: string, day: number): Promise<void> {
  const claimed = new Set((await claimedTasksOnDay(tripId, day)).map((c) => c.code));
  const tasks = await tasksForDay(tripId, day);
  const drop = tasks.filter((t) => !claimed.has(t.code)).map((t) => t.id);
  if (drop.length === 0) return;
  const { error } = await getServiceClient().from("tasks").delete().in("id", drop);
  if (error) throw error;
}

function boardLog(step: string, fields: Record<string, unknown>) {
  console.info("[japlan.board] step", { step, ...fields });
}

// One cron tick for one trip whose board is due today:
//  - no board: generate and deliver to everyone
//  - provisional (made ahead on request): regenerate with today's weather and
//    ratings unless something on it was claimed, then deliver
//  - made on demand earlier today, not yet delivered: deliver it
//  - delivered: nothing
export async function tickBoard(trip: TripRow, date: string, day: number, now: Date) {
  let board = await getBoard(trip.id, day);

  if (!board) {
    if ((await tasksForDay(trip.id, day)).length > 0) {
      // Tasks from before boards rows existed: treat as delivered.
      await upsertBoardRow(trip.id, day, date, {
        status: "ready",
        delivered_at: now.toISOString(),
      });
      boardLog("tick.legacy_tasks", { tripId: trip.id, day });
      return "skipped";
    }
    const locked = await lockNewBoard(trip.id, day, date, { provisional: false });
    if (!locked) {
      boardLog("tick.lock_lost", { tripId: trip.id, day });
      return "skipped";
    }
    await generateAndDeliver(trip, locked, date, now);
    return "generated";
  }

  if (board.status === "generating") {
    if (!(await relockBoard(board, now))) {
      boardLog("tick.in_progress", { tripId: trip.id, day });
      return "skipped";
    }
    await deleteUnclaimedTasksForDay(trip.id, day);
    await generateAndDeliver(trip, board, date, now);
    return "generated";
  }

  if (board.provisional) {
    if (await dayHasClaims(trip.id, day)) {
      // Someone already claimed from the provisional board: it stands.
      await updateBoard(board.id, { provisional: false });
      board = { ...board, provisional: false };
      boardLog("tick.provisional_kept", { tripId: trip.id, day, reason: "claimed" });
    } else if (await relockBoard(board, now)) {
      await deleteUnclaimedTasksForDay(trip.id, day);
      boardLog("tick.provisional_regenerate", { tripId: trip.id, day });
      await generateAndDeliver(trip, board, date, now);
      return "regenerated";
    } else {
      return "skipped";
    }
  }

  if (!board.delivered_at) {
    await deliverExistingBoard(trip, day, date, now);
    await updateBoard(board.id, { delivered_at: now.toISOString() });
    boardLog("tick.delivered_existing", { tripId: trip.id, day });
    return "delivered";
  }
  return "skipped";
}

async function generateAndDeliver(trip: TripRow, board: BoardRow, date: string, now: Date) {
  try {
    const lapsed = await sweepLapsedPeerClaims(trip.id, now);
    const built = await buildBoardForDate(trip, { date, now });
    await deliverMorningBoards({
      trip,
      people: built.people,
      rows: [...(await tasksForDay(trip.id, built.day))].map(({ id: _id, ...row }) => {
        void _id;
        return row;
      }),
      day: built.day,
      weatherLine: built.weatherLine,
      lapsed,
    });
    await updateBoard(board.id, {
      status: "ready",
      provisional: false,
      delivered_at: new Date().toISOString(),
    });
    boardLog("tick.generated", { tripId: trip.id, day: built.day, count: built.rows.length });
  } catch (err) {
    // Leave the row generating; it goes stale and the next tick retakes it.
    boardLog("tick.generate_failed", {
      tripId: trip.id,
      day: board.day,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// Tasks on this day that already have any claim row. A forced re-run must
// never upsert over them: their codes are reserved and collisions are skipped.
async function claimedTasksOnDay(tripId: string, day: number): Promise<ExistingDayCode[]> {
  const supabase = getServiceClient();
  const tasksRes = await supabase
    .from("tasks")
    .select("id, code, participant_id, team_id")
    .eq("trip_id", tripId)
    .eq("day", day);
  if (tasksRes.error) throw tasksRes.error;
  const dayTasks = (tasksRes.data ?? []) as {
    id: string;
    code: string;
    participant_id: string | null;
    team_id: string | null;
  }[];
  if (dayTasks.length === 0) return [];
  const claimsRes = await supabase
    .from("claims")
    .select("task_id")
    .in("task_id", dayTasks.map((t) => t.id));
  if (claimsRes.error) throw claimsRes.error;
  const claimedIds = new Set(
    (claimsRes.data ?? []).map((row) => (row as { task_id: string }).task_id),
  );
  return dayTasks
    .filter((t) => claimedIds.has(t.id))
    .map((t) => ({ code: t.code, participantId: t.participant_id, teamId: t.team_id }));
}

function ownerCodeKey(code: string, participantId: string | null, teamId: string | null) {
  return `${participantId ?? ""}|${teamId ?? ""}|${code.toUpperCase()}`;
}

export function withoutClaimedCollisions<
  T extends { code: string; participant_id: string | null; team_id: string | null },
>(rows: T[], claimed: ExistingDayCode[], tripId: string): T[] {
  const taken = new Set(claimed.map((c) => ownerCodeKey(c.code, c.participantId, c.teamId)));
  return rows.filter((row) => {
    const hit = taken.has(ownerCodeKey(row.code, row.participant_id, row.team_id));
    if (hit) {
      console.warn("[japlan.generate] skipped overwrite of claimed task", {
        tripId,
        code: row.code,
        participantId: row.participant_id,
        teamId: row.team_id,
      });
    }
    return !hit;
  });
}

// Lapse pending_peer claims past their expiry, then report every claim that
// lapsed in the last day so the morning DM can say the code is open again.
async function sweepLapsedPeerClaims(
  tripId: string,
  now: Date,
): Promise<Map<string, string[]>> {
  const supabase = getServiceClient();
  const tasksRes = await supabase.from("tasks").select("id, code").eq("trip_id", tripId);
  if (tasksRes.error) throw tasksRes.error;
  const tripTasks = (tasksRes.data ?? []) as { id: string; code: string }[];
  const byParticipant = new Map<string, string[]>();
  if (tripTasks.length === 0) return byParticipant;
  const taskIds = tripTasks.map((t) => t.id);

  const sweep = await supabase
    .from("claims")
    .update({ status: "expired" })
    .eq("status", "pending_peer")
    .lte("expires_at", now.toISOString())
    .in("task_id", taskIds);
  if (sweep.error) throw sweep.error;

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const lapsedRes = await supabase
    .from("claims")
    .select("task_id, participant_id")
    .eq("status", "expired")
    .gt("expires_at", since)
    .lte("expires_at", now.toISOString())
    .in("task_id", taskIds);
  if (lapsedRes.error) throw lapsedRes.error;
  const codeById = new Map(tripTasks.map((t) => [t.id, t.code]));
  for (const row of (lapsedRes.data ?? []) as { task_id: string; participant_id: string }[]) {
    const code = codeById.get(row.task_id);
    if (!code) continue;
    byParticipant.set(row.participant_id, [
      ...(byParticipant.get(row.participant_id) ?? []),
      code,
    ]);
  }
  return byParticipant;
}

async function deliverMorningBoards(opts: {
  trip: TripRow;
  // Who gets their board by DM now.
  people: ParticipantRow[];
  // Everyone on the trip, for the group standings. Default: people.
  allPeople?: ParticipantRow[];
  rows: Omit<TaskRow, "id">[];
  day: number;
  weatherLine: string | null;
  // participant id -> codes whose pending peer claim lapsed overnight
  lapsed?: Map<string, string[]>;
}): Promise<void> {
  const byPerson = new Map<string, Omit<TaskRow, "id">[]>();
  for (const person of opts.people) {
    byPerson.set(person.id, []);
  }
  for (const row of opts.rows) {
    if (row.participant_id && byPerson.has(row.participant_id)) {
      byPerson.get(row.participant_id)!.push(row);
    }
  }

  const teamRows = opts.rows.filter((row) => row.team_id);
  if (teamRows.length > 0) {
    const supabase = getServiceClient();
    for (const teamId of [...new Set(teamRows.map((row) => row.team_id!))]) {
      const { data, error } = await supabase
        .from("team_members")
        .select("participant_id")
        .eq("team_id", teamId);
      if (error) throw error;
      const memberIds = (data ?? []).map(
        (row) => (row as { participant_id: string }).participant_id,
      );
      const tasks = teamRows.filter((row) => row.team_id === teamId);
      for (const memberId of memberIds) {
        const list = byPerson.get(memberId);
        if (list) list.push(...tasks);
      }
    }
  }

  const shared = opts.rows.filter((row) => !row.participant_id && !row.team_id);
  if (shared.length > 0) {
    for (const list of byPerson.values()) list.push(...shared);
  }

  for (const person of opts.people) {
    const tasks = byPerson.get(person.id) ?? [];
    const lapsedCodes = opts.lapsed?.get(person.id) ?? [];
    if (tasks.length === 0 && lapsedCodes.length === 0) continue;
    const parts: string[] = [];
    // One DM: the lapsed-claim line (which names the reopened code) rides on
    // top of the board instead of arriving as a second message.
    if (lapsedCodes.length > 0) parts.push(peerLapsedLine(lapsedCodes));
    if (tasks.length > 0) {
      parts.push(
        formatPersonalBoard({
          day: opts.day,
          weatherLine: opts.weatherLine,
          tasks: tasks.map((row) => ({
            code: row.code,
            title: row.title,
            base_points: row.base_points,
          })),
        }),
      );
    }
    const text = parts.join("\n\n");
    try {
      await sendDM(person.phone, text);
    } catch (err) {
      console.error("[japlan.generate] personal board DM failed", {
        participantId: person.id,
        err,
      });
    }
  }

  // A solo trip's chat IS the player's DM, which just got their board: a
  // one-person standings post would be a second message saying nothing.
  if (opts.trip.is_solo) return;
  const standings = formatMorningStandings({
    day: opts.day,
    weatherLine: opts.weatherLine,
    standings: (opts.allPeople ?? opts.people).map((p) => ({
      display_name: p.display_name,
      score: p.score,
    })),
  });
  await sendText(opts.trip.linq_chat_id, standings);
}

export async function refillPersonalTasksIfNeeded(opts: {
  trip: TripRow;
  claimant: ParticipantRow;
  people: ParticipantRow[];
  remainingOpenPersonal: number;
  // false: return the rows instead of DMing them, so an on-demand reply can
  // carry the refill in its one message.
  deliver?: boolean;
  // Which trip-local date to add tasks to. Default today. Used for someone
  // who joined after that day's board was made.
  date?: string;
}): Promise<Omit<TaskRow, "id">[]> {
  if (opts.remainingOpenPersonal > 0) return [];

  const supabase = getServiceClient();
  const peopleRes = await supabase
    .from("participants")
    .select(
      "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at",
    )
    .eq("trip_id", opts.trip.id);
  if (peopleRes.error) throw peopleRes.error;
  const people = (peopleRes.data ?? []) as ParticipantRow[];

  let profile: DestinationProfile;
  try {
    profile = await assembleDestinationProfile({ trip: opts.trip, people });
  } catch (err) {
    console.error("[japlan.generate] refill profile failed", err);
    return [];
  }

  const now = new Date();
  const timezone = opts.trip.timezone || "UTC";
  const today = opts.date ?? localDateString(now, timezone);
  const day = opts.date ? tripDayOn(opts.trip, opts.date, now) : currentTripDay(opts.trip, now);
  let weather: DayWeather = {
    temperatureC: null,
    precipitationChance: null,
    summary: "unknown",
    indoorPreferred: false,
  };
  if (profile.center) {
    try {
      weather = await fetchDayWeather({
        lat: profile.center.lat,
        lng: profile.center.lng,
        date: today,
        timezone,
      });
    } catch (err) {
      console.error("[japlan.generate] refill weather failed", err);
    }
  }

  const completed = await completedTitles(opts.trip.id, [opts.claimant.id]);
  const ratings = await yesterdayRatings(opts.trip.id);
  const gap = scoreGapText(people);
  const assignee: Assignee = {
    kind: "person",
    id: opts.claimant.id,
    participantId: opts.claimant.id,
    teamId: null,
    people: [opts.claimant],
    label: opts.claimant.display_name,
  };
  let proposals: ProposedTask[] = [];
  try {
    proposals = await proposalsForAssignee({
      assignee,
      profile,
      weather,
      completed,
      ratings,
      gap,
      day,
      difficulty: opts.trip.difficulty,
    });
  } catch (err) {
    console.error("[japlan.generate] refill llm failed", err);
  }
  const expiresAt = endOfLocalDay(today, timezone);
  const constraints: AssigneeConstraints[] = [
    { answers: (opts.claimant.survey_json ?? {}) as SurveyAnswers },
  ];
  let kept = filterValid(proposals, constraints, completed, expiresAt);
  if (kept.length < TASKS_PER_CALL / 2) {
    kept = filterValid(
      fillTemplatesDeterministically({
        profile,
        weather,
        count: TASKS_PER_CALL,
        seed: Date.now() % 1000,
      }),
      constraints,
      completed,
      expiresAt,
    );
  }
  kept = kept.slice(0, TASKS_PER_CALL).map((task) => ({
    ...task,
    participantId: opts.claimant.id,
    teamId: null,
    source: "generated" as const,
  }));
  const existing = await supabase
    .from("tasks")
    .select("code, participant_id, team_id")
    .eq("trip_id", opts.trip.id)
    .eq("day", day);
  if (existing.error) throw existing.error;
  const membership = await supabase
    .from("team_members")
    .select("team_id")
    .eq("participant_id", opts.claimant.id);
  if (membership.error) throw membership.error;
  // Only the claimant's view matters: their personal, team, and shared codes.
  const teamMembers: Record<string, string[]> = {};
  for (const row of membership.data ?? []) {
    teamMembers[(row as { team_id: string }).team_id] = [opts.claimant.id];
  }
  const coded = applySoloVerification(
    assignOwnedDayCodes(kept, day, {
      participantIds: [opts.claimant.id],
      teamMembers,
      existing: (existing.data ?? []).map((row) => {
        const r = row as {
          code: string;
          participant_id: string | null;
          team_id: string | null;
        };
        return { code: r.code, participantId: r.participant_id, teamId: r.team_id };
      }),
    }),
    Boolean(opts.trip.is_solo),
  );
  const tripDays = tripLengthDays(opts.trip.start_date, opts.trip.end_date);
  const rows = coded.map((task) =>
    persistableTask({
      tripId: opts.trip.id,
      day,
      tripDays,
      task,
      participantId: opts.claimant.id,
      teamId: null,
      expiresAt,
      isSolo: Boolean(opts.trip.is_solo),
    }).row,
  );
  if (rows.length === 0) return [];
  const { error } = await supabase.from("tasks").upsert(rows, {
    onConflict: TASK_CODE_CONFLICT,
  });
  if (error) throw error;
  if (opts.deliver === false) return rows;
  const text = formatPersonalBoard({
    day,
    tasks: rows.map((row) => ({
      code: row.code,
      title: row.title,
      base_points: row.base_points,
    })),
  });
  try {
    await sendDM(opts.claimant.phone, text);
  } catch (err) {
    console.error("[japlan.generate] refill DM failed", err);
  }
  console.info("[japlan.generate] personal refill", {
    tripId: opts.trip.id,
    participantId: opts.claimant.id,
    count: rows.length,
  });
  return rows;
}

export async function runDailyBoards(opts: {
  now?: Date;
  tripId?: string;
  force?: boolean;
}): Promise<{ ran: string[]; skipped: string[] }> {
  const now = opts.now ?? new Date();
  let query = getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("state", "active");
  if (opts.tripId) query = query.eq("id", opts.tripId);
  const { data, error } = await query;
  if (error) throw error;
  const trips = (data ?? []) as TripRow[];
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const trip of trips) {
    if (!trip.destination) {
      console.error("[japlan.generate] skip; trip.destination is empty", {
        tripId: trip.id,
      });
      skipped.push(trip.id);
      continue;
    }
    if (opts.force) {
      // Manual run (testing): today's board now, whatever the time or dates.
      await runDailyBoardForTrip(trip, { now });
      ran.push(trip.id);
      continue;
    }
    // Due when local time is at or after board_time, inside the trip's dates.
    // Any tick after board_time posts a missing board, so a late or missed
    // tick recovers instead of skipping the day.
    const due = boardDueNow(trip, now);
    if (!due.due) {
      boardLog("tick.not_due", { tripId: trip.id, reason: due.reason });
      skipped.push(trip.id);
      continue;
    }
    try {
      const outcome = await tickBoard(trip, due.date, due.day, now);
      (outcome === "skipped" ? skipped : ran).push(trip.id);
    } catch (err) {
      // One trip failing must not stop the rest of the tick.
      console.error("[japlan.board] tick failed", {
        tripId: trip.id,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped.push(trip.id);
    }
  }
  return { ran, skipped };
}
