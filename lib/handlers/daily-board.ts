import { formatMorningStandings, formatPersonalBoard } from "@/lib/game/board";
import {
  assembleDestinationProfile,
  type DestinationProfile,
} from "@/lib/game/destination";
import {
  assignOwnedDayCodes,
  fillTemplatesDeterministically,
  generateTasksForAssignee,
  isCurveballBoard,
  pickBounty,
  type ExistingDayCode,
  type GenerationPlan,
} from "@/lib/game/generate";
import {
  candidatesToRequest,
  dayMinutes,
  maxTaskMinutes,
  paceFor,
  parseClockMinutes,
  planDay,
  selectForDay,
  targetMinutes,
  usableWindow,
  type DayWindow,
} from "@/lib/game/day-plan";
import {
  boardConflict,
  planAssigneeBoard,
  prepareCandidates,
  type Candidate,
  type PlannedTask,
  type PrepareContext,
} from "@/lib/game/plan-board";
import { boardTemplates } from "@/lib/game/templates";
import { peerLapsedLine } from "@/lib/game/copy";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import {
  pointsForBoard,
  tripLengthDays,
} from "@/lib/game/scoring";
import type { ProposedTask } from "@/lib/game/validate";
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
import { endOfLocalDay, localDateString, localHour, localTimeHHMM } from "@/lib/game/time";
import { buildStandingsRows } from "@/lib/game/standings";
import { teamsWithMembers } from "@/lib/handlers/teams";

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

export type Assignee = {
  kind: "person" | "team";
  id: string;
  participantId: string | null;
  teamId: string | null;
  people: ParticipantRow[];
  label: string;
};

export async function loadAssignees(tripId: string, people: ParticipantRow[]): Promise<Assignee[]> {
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
  const teamed = new Set<string>();
  for (const team of teams) {
    const { data: members, error: memErr } = await getServiceClient()
      .from("team_members")
      .select("participant_id")
      .eq("team_id", team.id);
    if (memErr) throw memErr;
    const ids = new Set(
      (members ?? []).map((m) => (m as { participant_id: string }).participant_id),
    );
    for (const id of ids) teamed.add(id);
    assignees.push({
      kind: "team",
      id: team.id,
      participantId: null,
      teamId: team.id,
      people: people.filter((p) => ids.has(p.id)),
      label: team.name,
    });
  }
  // Anyone not on a team (survey answer was "solo", or teams don't cover
  // everyone) still gets their own personal board.
  for (const person of people) {
    if (teamed.has(person.id)) continue;
    assignees.push({
      kind: "person",
      id: person.id,
      participantId: person.id,
      teamId: null,
      people: [person],
      label: person.display_name,
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

// Every title already on this trip's boards, oldest first, for the prompt.
async function tripBoardTitles(tripId: string): Promise<string[]> {
  const { data, error } = await getServiceClient()
    .from("tasks")
    .select("title, day")
    .eq("trip_id", tripId)
    .order("day");
  if (error) throw error;
  return [...new Set((data ?? []).map((t) => (t as { title: string }).title))];
}

function clockText(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// The usable part of the day for these people: board_time to a pace-based
// end of day, or now to then when the board is for today (see usableWindow).
export function dayWindowFor(
  trip: TripRow,
  people: ParticipantRow[],
  date: string,
  now: Date,
): DayWindow {
  const timezone = trip.timezone || "UTC";
  const pace = paceFor(
    people.map((p) => answerValue((p.survey_json ?? {}) as SurveyAnswers, "pace")),
  );
  const today = localDateString(now, timezone);
  const nowMinutes = date === today ? parseClockMinutes(localTimeHHMM(now, timezone)) : null;
  return usableWindow({ boardTime: trip.board_time, pace, nowMinutes });
}

// One assignee's day: ask the model for enough candidates to fill 60-70% of
// their usable hours, gate and time them in code, top up from templates if
// short, then order along a route with a time of day on each.
async function planForAssignee(opts: {
  trip: TripRow;
  assignee: Assignee;
  profile: DestinationProfile;
  weather: DayWeather;
  date: string;
  now: Date;
  day: number;
  ratings: string;
  gap: string;
  boardTitles: string[];
}): Promise<{ tasks: PlannedTask[]; usedFallback: boolean; window: DayWindow }> {
  const { trip, assignee } = opts;
  const window = dayWindowFor(trip, assignee.people, opts.date, opts.now);
  const completed = await completedTitles(trip.id, assignee.people.map((p) => p.id));
  const solo = Boolean(trip.is_solo);
  const templates = boardTemplates({ solo });
  const curveball = isCurveballBoard(`${trip.id}:${opts.day}:${assignee.id}`);
  const ctx: PrepareContext = {
    profile: opts.profile,
    solo,
    window,
    assignees: assignee.people.map((p) => ({ answers: (p.survey_json ?? {}) as SurveyAnswers })),
    completedTitles: completed,
    expiresAt: endOfLocalDay(opts.date, trip.timezone || "UTC"),
    now: opts.now,
    onReject: (reason, title) => logReject(reason, title, { assignee: assignee.label }),
  };
  const plan: GenerationPlan = {
    windowText: `${clockText(window.startMinutes)} to ${clockText(window.endMinutes)}`,
    usableMinutes: window.usableMinutes,
    targetMinutes: targetMinutes(window),
    maxTaskMinutes: maxTaskMinutes(window),
    lateStart: window.startMinutes >= 12 * 60,
  };
  const answers = (assignee.people[0]?.survey_json ?? {}) as SurveyAnswers;

  let pool: Candidate[] = [];
  let curveballProposed = false;
  for (let round = 1; round <= 2 && window.usableMinutes > 0; round++) {
    let proposals: ProposedTask[] = [];
    try {
      proposals = await generateTasksForAssignee({
        profile: opts.profile,
        weather: opts.weather,
        preferenceText: preferenceText(answers),
        completedTitles: completed,
        yesterdayRatings: opts.ratings,
        scoreGap: opts.gap,
        day: opts.day,
        difficulty: trip.difficulty,
        boardTitles: opts.boardTitles,
        templates,
        plan,
        curveball,
        count: candidatesToRequest(window),
      });
    } catch (err) {
      console.error("[japlan.generate] llm failed", { round, assignee: assignee.label, err });
    }
    curveballProposed ||= proposals.some((t) => t.template === "curveball");
    const fresh = prepareCandidates(proposals, {
      ...ctx,
      completedTitles: [...completed, ...pool.map((t) => t.title)],
    });
    pool = [...pool, ...fresh];
    if (dayMinutes(selectForDay(pool, window, { conflicts: boardConflict })) >= targetMinutes(window) * 0.5) break;
    console.info("[japlan.generate] regenerating; model fell short of half the day", {
      round,
      assignee: assignee.label,
      pool: pool.length,
    });
  }

  // Every board template, filled a few ways (different neighborhoods,
  // dishes, places), so a refill can reuse a template with new slots.
  const fills = [0, 1, 2, 3].flatMap((variant) =>
    fillTemplatesDeterministically({
      profile: opts.profile,
      weather: opts.weather,
      templates,
      count: templates.length,
      seed: opts.day * 7 + variant * 5,
    }),
  );
  const fallbackPool = prepareCandidates(
    fills,
    { ...ctx, onReject: (reason, title) => logReject(reason, title, { assignee: assignee.label, fallback: true }) },
  );
  const planned = planAssigneeBoard({ modelPool: pool, fallbackPool, window });
  console.info("[japlan.generate] day plan", {
    tripId: trip.id,
    assignee: assignee.label,
    pace: window.pace,
    window: plan.windowText,
    usableMinutes: window.usableMinutes,
    targetMinutes: plan.targetMinutes,
    plannedMinutes: dayMinutes(planned.tasks),
    tasks: planned.tasks.map((t) => ({ title: t.title, minutes: t.minutes, slot: t.slot, template: t.template })),
    usedFallback: planned.usedFallback,
    curveball: !curveball
      ? "none"
      : planned.tasks.some((t) => t.source === "curveball")
        ? "landed"
        : curveballProposed
          ? "rejected"
          : "not_proposed",
  });
  return { ...planned, window };
}

export function persistableTask(opts: {
  tripId: string;
  day: number;
  tripDays: number | null;
  task: ProposedTask & Partial<Pick<PlannedTask, "slot" | "minutes" | "resolvedNeighborhood">>;
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
      // A planned task stores only a neighborhood it actually resolved to (the
      // board header's route); "can be anywhere" is null, not the city name.
      neighborhood:
        opts.task.minutes !== undefined
          ? (opts.task.resolvedNeighborhood ?? null)
          : rowTask.neighborhood || null,
      source: rowTask.source ?? "generated",
      slot: opts.task.slot ?? null,
      duration_minutes: opts.task.minutes ?? null,
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
  const boardTitles = await tripBoardTitles(opts.trip.id);

  let kept: (PlannedTask & { participantId: string | null; teamId: string | null })[] = [];
  let usedFallback = false;
  for (const assignee of assignees) {
    const planned = await planForAssignee({
      trip: opts.trip,
      assignee,
      profile: opts.profile,
      weather: opts.weather,
      date,
      now,
      day,
      ratings,
      gap,
      boardTitles,
    });
    usedFallback ||= planned.usedFallback;
    kept.push(
      ...planned.tasks.map((task) => ({
        ...task,
        participantId: assignee.participantId,
        teamId: assignee.teamId,
      })),
    );
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
    const window = dayWindowFor(opts.trip, [trailer], date, now);
    const [timed] = bounty
      ? prepareCandidates([bounty], {
          profile: opts.profile,
          solo: Boolean(opts.trip.is_solo),
          window,
          assignees: [{ answers: (trailer.survey_json ?? {}) as SurveyAnswers }],
          completedTitles: trailerDone,
          expiresAt,
          now,
          onReject: (reason, title) => logReject(reason, title, { bounty: true }),
        })
      : [];
    if (timed) {
      // The bounty is extra to the day's fill: it joins the trailer's route.
      const theirs = kept.filter((t) => t.participantId === trailer.id);
      const replanned = planDay([...theirs, timed], window).map((task) => ({
        ...task,
        participantId: trailer.id,
        teamId: null,
      }));
      kept = [...kept.filter((t) => t.participantId !== trailer.id), ...replanned];
    } else {
      logReject("no_valid_bounty", "(none)", { bounty: true, trailer: trailer.id });
    }
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
      "id, trip_id, participant_id, team_id, code, title, tier, axes_json, base_points, photo_bonus_max, verification, day, expires_at, neighborhood, source, slot, duration_minutes",
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
            slot: row.slot ?? null,
            neighborhood: row.neighborhood,
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
  const teams = await teamsWithMembers(opts.trip.id);
  const standings = formatMorningStandings({
    day: opts.day,
    weatherLine: opts.weatherLine,
    standings: buildStandingsRows(opts.allPeople ?? opts.people, teams),
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

  const ratings = await yesterdayRatings(opts.trip.id);
  const gap = scoreGapText(people);
  const boardTitles = await tripBoardTitles(opts.trip.id);
  const assignee: Assignee = {
    kind: "person",
    id: opts.claimant.id,
    participantId: opts.claimant.id,
    teamId: null,
    people: [opts.claimant],
    label: opts.claimant.display_name,
  };
  // Same planner as the morning board, over whatever is left of that day.
  const planned = await planForAssignee({
    trip: opts.trip,
    assignee,
    profile,
    weather,
    date: today,
    now,
    day,
    ratings,
    gap,
    boardTitles,
  });
  const expiresAt = endOfLocalDay(today, timezone);
  const kept = planned.tasks.map((task) => ({
    ...task,
    participantId: opts.claimant.id,
    teamId: null,
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
      slot: row.slot ?? null,
      neighborhood: row.neighborhood,
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
