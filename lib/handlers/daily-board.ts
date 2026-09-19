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
  // Codes already taken today by tasks that must survive (claimed ones).
  reservedCodes?: ExistingDayCode[];
}): Promise<{ tasks: ProposedTask[]; usedFallback: boolean; day: number }> {
  const now = opts.now ?? new Date();
  const day = currentTripDay(opts.trip, now);
  const today = localDateString(now, opts.trip.timezone || "UTC");
  const expiresAt = endOfLocalDay(today, opts.trip.timezone || "UTC");
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

export async function runDailyBoardForTrip(
  trip: TripRow,
  opts: { now?: Date } = {},
): Promise<{ posted: boolean; day: number; count: number; usedFallback: boolean }> {
  const supabase = getServiceClient();
  const peopleRes = await supabase
    .from("participants")
    .select(
      "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at",
    )
    .eq("trip_id", trip.id);
  if (peopleRes.error) throw peopleRes.error;
  const people = (peopleRes.data ?? []) as ParticipantRow[];

  let profile: DestinationProfile;
  try {
    profile = await assembleDestinationProfile({ trip, people });
  } catch (err) {
    console.error("[japlan.generate] destination profile failed", err);
    throw err;
  }

  const timezone = trip.timezone || "UTC";
  const now = opts.now ?? new Date();
  const today = localDateString(now, timezone);
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
      console.error("[japlan.generate] weather failed", err);
    }
  }

  const lapsed = await sweepLapsedPeerClaims(trip.id, now);
  const claimedToday = await claimedTasksOnDay(trip.id, currentTripDay(trip, now));

  const { tasks, usedFallback, day } = await generateValidatedBoard({
    trip,
    people,
    profile,
    weather,
    now,
    reservedCodes: claimedToday,
  });

  const tripDays = tripLengthDays(trip.start_date, trip.end_date);
  const expiresAt = endOfLocalDay(today, timezone);
  const generated = tasks.map((task) => {
    const persisted = persistableTask({
      tripId: trip.id,
      day,
      tripDays,
      task,
      participantId: task.participantId ?? null,
      teamId: task.teamId ?? null,
      expiresAt,
      isSolo: Boolean(trip.is_solo),
    });
    return persisted.row;
  });
  const rows = withoutClaimedCollisions(generated, claimedToday, trip.id);

  if (rows.length > 0) {
    const { error } = await supabase.from("tasks").upsert(rows, {
      onConflict: TASK_CODE_CONFLICT,
    });
    if (error) throw error;
  }

  const weatherLine = formatWeatherLine(weather);
  await deliverMorningBoards({
    trip,
    people,
    rows,
    day,
    weatherLine,
    lapsed,
  });
  console.info("[japlan.generate] board posted", {
    tripId: trip.id,
    day,
    count: rows.length,
    usedFallback,
  });
  return { posted: true, day, count: rows.length, usedFallback };
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
  people: ParticipantRow[];
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
    standings: opts.people.map((p) => ({
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
}): Promise<void> {
  if (opts.remainingOpenPersonal > 0) return;

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
    return;
  }

  const now = new Date();
  const timezone = opts.trip.timezone || "UTC";
  const today = localDateString(now, timezone);
  const day = currentTripDay(opts.trip, now);
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
  if (rows.length === 0) return;
  const { error } = await supabase.from("tasks").upsert(rows, {
    onConflict: TASK_CODE_CONFLICT,
  });
  if (error) throw error;
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
    const timezone = trip.timezone || "UTC";
    if (!opts.force && !isLocalMorning(now, timezone)) {
      skipped.push(trip.id);
      continue;
    }
    const day = currentTripDay(trip, now);
    const existing = await getServiceClient()
      .from("tasks")
      .select("id")
      .eq("trip_id", trip.id)
      .eq("day", day)
      .limit(1);
    if (!opts.force && existing.data && existing.data.length > 0) {
      skipped.push(trip.id);
      continue;
    }
    await runDailyBoardForTrip(trip, { now });
    ran.push(trip.id);
  }
  return { ran, skipped };
}
