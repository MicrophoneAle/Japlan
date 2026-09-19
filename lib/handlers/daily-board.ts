import { formatDailyBoard } from "@/lib/game/board";
import {
  assembleDestinationProfile,
  type DestinationProfile,
} from "@/lib/game/destination";
import {
  assignDayCodes,
  fillTemplatesDeterministically,
  generateTasksForAssignee,
  slotValuesFor,
  TASKS_PER_CALL,
} from "@/lib/game/generate";
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
import { sendText } from "@/lib/linq/send";
import { fillArchetype, midpointAxes, TEMPLATES } from "@/lib/game/templates";

const TRIP_COLS =
  "id, linq_chat_id, name, destination, start_date, end_date, state, difficulty, stake_text, timezone, destination_profile_json";

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

function localDateString(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function localHour(now: Date, timezone: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        hourCycle: "h23",
      }).format(now),
    );
  } catch {
    return now.getUTCHours();
  }
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

function endOfLocalDay(date: string, timezone: string): Date {
  // TODO: plan does not specify the exact expiry instant; using end of the local calendar day.
  const asUtc = new Date(`${date}T23:59:59`);
  void timezone;
  return asUtc;
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

function scoreGapText(people: ParticipantRow[]): string {
  if (people.length === 0) return "no scores yet";
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
}): { row: Omit<TaskRow, "id"> } {
  const { points, tier } = pointsForBoard(opts.task.axes, {
    day: opts.day,
    tripDays: opts.tripDays,
  });
  return {
    row: {
      trip_id: opts.tripId,
      participant_id: opts.participantId,
      team_id: opts.teamId,
      code: opts.task.code,
      title: opts.task.title,
      tier,
      axes_json: opts.task.axes,
      base_points: points,
      photo_bonus_max: opts.task.photo_bonus_max,
      verification: opts.task.verification,
      day: opts.day,
      expires_at: opts.expiresAt.toISOString(),
      neighborhood: opts.task.neighborhood || null,
    },
  };
}

export async function generateValidatedBoard(opts: {
  trip: TripRow;
  people: ParticipantRow[];
  profile: DestinationProfile;
  weather: DayWeather;
  now?: Date;
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
    const bountyTemplate =
      TEMPLATES.find((t) => t.verification === "peer") ?? TEMPLATES[0];
    const values = slotValuesFor(bountyTemplate, opts.profile, 99);
    const bounty: ProposedTask = {
      code: "",
      title: fillArchetype(bountyTemplate.archetype, values),
      axes: {
        ...midpointAxes(bountyTemplate),
        boldness: 5,
        scarcity: 4,
      },
      verification: bountyTemplate.verification,
      photo_bonus_max: bountyTemplate.photo_bonus_max,
      neighborhood: values.neighborhood ?? opts.profile.destination,
      participantId: trailer.id,
      teamId: null,
    };
    const reason = validateGeneratedTask(bounty, {
      assignees: [{ answers: (trailer.survey_json ?? {}) as SurveyAnswers }],
      completedTitles: kept.map((t) => t.title),
      expiresAt,
    });
    if (reason) {
      logReject(reason, bounty.title, { bounty: true });
    } else {
      kept.push(bounty);
    }
  }

  return { tasks: assignDayCodes(kept, day), usedFallback, day };
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

  const { tasks, usedFallback, day } = await generateValidatedBoard({
    trip,
    people,
    profile,
    weather,
    now,
  });

  const tripDays = tripLengthDays(trip.start_date, trip.end_date);
  const expiresAt = endOfLocalDay(today, timezone);
  const rows = tasks.map((task) => {
    const persisted = persistableTask({
      tripId: trip.id,
      day,
      tripDays,
      task,
      participantId: task.participantId ?? null,
      teamId: task.teamId ?? null,
      expiresAt,
    });
    return persisted.row;
  });

  if (rows.length > 0) {
    const { error } = await supabase.from("tasks").upsert(rows, {
      onConflict: "trip_id,code",
    });
    if (error) throw error;
  }

  const weatherLine = formatWeatherLine(weather);
  const board = formatDailyBoard({
    day,
    weatherLine,
    tasks: rows.map((row) => ({
      code: row.code,
      title: row.title,
      base_points: row.base_points,
    })),
    standings: people.map((p) => ({
      display_name: p.display_name,
      score: p.score,
    })),
  });
  await sendText(trip.linq_chat_id, board);
  console.info("[japlan.generate] board posted", {
    tripId: trip.id,
    day,
    count: rows.length,
    usedFallback,
  });
  return { posted: true, day, count: rows.length, usedFallback };
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
