import { formatDailyBoard, formatMorningStandings, formatPersonalBoard } from "@/lib/game/board";
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
  slotForMinute,
  targetMinutes,
  usableWindow,
  type DaySlot,
  type DayWindow,
} from "@/lib/game/day-plan";
import {
  anchorCandidate,
  boardConflict,
  boardPreferencesFor,
  personalizationFor,
  planFromProposals,
  prepareCandidates,
  resolvePlace,
  templatesAllowedFor,
  type Candidate,
  type PlannedTask,
  type PrepareContext,
  type Suggestion,
} from "@/lib/game/plan-board";
import {
  categoriesOf,
  groupBlackouts,
  INTEREST_KEYS,
  interestPicksFor,
  isUnderAge,
  promptPreferences,
} from "@/lib/game/preferences";
import { type DayTeam } from "@/lib/game/split";
import { groupProfile, personProfile } from "@/lib/game/profile";
import { prefsOf } from "@/lib/game/prefs";
import { isSidequestQuestion } from "@/lib/game/survey";
import { boardTemplates } from "@/lib/game/templates";
import { peerLapsedLine } from "@/lib/game/copy";
import { answerValue, interestPicksOf, type SurveyAnswers } from "@/lib/game/survey";
import {
  clampPhotoBonusMax,
  pointsForBoard,
  tripLengthDays,
} from "@/lib/game/scoring";
import { normalizeTitle, type ProposedTask } from "@/lib/game/validate";
import {
  fetchDayWeather,
  formatWeatherLine,
  type DayWeather,
} from "@/lib/game/weather";
import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, PlaceRow, TaskRow, TeamRow, TripRow } from "@/lib/db/types";
import { sendDM, sendText } from "@/lib/linq/send";
import { applySoloVerification } from "@/lib/game/solo";
// Plan does not specify the exact expiry instant; tasks end with the trip's local day.
import {
  endOfLocalDay,
  localDateString,
  localHour,
  localTimeHHMM,
  zonedTimeToUtc,
} from "@/lib/game/time";
import { buildStandingsRows } from "@/lib/game/standings";
import { teamsWithMembers } from "@/lib/handlers/teams";
import { pairBySharedInterests } from "@/lib/game/teams";

import { TRIP_COLS } from "@/lib/db/columns";
import { missingRequiredSetup, type SetupFields } from "@/lib/game/setup";
import { recordTasksChanged } from "./stats";
import { boardDueNow, dateForTripDay, tripDayForDate } from "@/lib/game/board-schedule";
import { cityFor, isMultiCity, isTravelDate, legForDate, todayFor, zoneFor, zoneNow } from "@/lib/game/legs";
import { dayMultiplierFor, loadMultiplierDays, refreshTripMultipliers } from "@/lib/handlers/holidays";
import { resolveQueuedLinks } from "@/lib/handlers/social-links";
import { multiplierHeaderPart, multiplierDayAnnouncement } from "@/lib/game/copy";
import { multiplierLabel, taskMultiplierFor, type TaskMultiplier } from "@/lib/game/multipliers";
import { remindOpenGroupDecisions } from "@/lib/handlers/group-decisions";

// When a travel day's board starts: late afternoon, once they have arrived and
// dropped bags. Deliberately a constant rather than a per-leg arrival time,
// which PLAN asks for but setup does not collect yet.
export const TRAVEL_DAY_START_MINUTE = 16 * 60;
// A travel day gets a short board on purpose: two or three things near where
// they are staying, not a normal day that assumes they are already out.
export const TRAVEL_DAY_MAX_TASKS = 3;

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

// What the model reads about the people on a board: a written profile, not
// a field dump. One person: their own profile (their board, their DM). More
// than one: the group profile only, an aggregate that never names who has
// which constraint, so nobody's private answers reach anyone else's prompt.
function groupPreferenceText(people: ParticipantRow[]): string {
  if (people.length === 0) return "(no survey answers)";
  if (people.length === 1) {
    const person = people[0];
    const answers = (person.survey_json ?? {}) as SurveyAnswers;
    // Written fresh from their answers (either survey), not the stored
    // paragraph: a row written before the first survey was readable kept a
    // "no lean yet" profile_md that every board then generated from.
    const fresh = personProfile({ name: "They", answers, prefs: prefsOf(person.prefs_json, answers) });
    return fresh || person.profile_md || preferenceText(answers);
  }
  return groupProfile(
    people.map((p) => {
      const answers = (p.survey_json ?? {}) as SurveyAnswers;
      return { answers, prefs: prefsOf(p.prefs_json, answers) };
    }),
  );
}

// "this trip is a waste if we don't ___", verbatim, deduplicated. Free text,
// so it goes to the model rather than through a keyword bucket: the four
// regexes in interestsFor only catch food, nightlife, culture and outdoors,
// and "we should see a show" matches none of them.
function mustHavesOf(answers: SurveyAnswers[]): string[] {
  const seen = new Set<string>();
  for (const a of answers) {
    const value = answerValue(a, "must_have")?.trim().replace(/[.!]+$/, "");
    if (value) seen.add(value);
  }
  return [...seen];
}

function preferenceText(answers: SurveyAnswers): string {
  // Free text the code cannot act on goes to the model, labelled.
  const bits = Object.entries(promptPreferences(answers)).map(([k, v]) => `${k}: ${v}`);
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
  const today = todayFor(trip, now);
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

// Ratings by this trip's people in the last 36 hours. Used to read every
// trip's ratings (no trip filter); nothing writes ratings yet (PLAN's rating
// prompt after an anchor is not built), so this is empty in practice.
async function yesterdayRatings(people: ParticipantRow[]): Promise<string> {
  if (people.length === 0) return "";
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getServiceClient()
    .from("ratings")
    .select("score, place_id, created_at, participant_id")
    .in("participant_id", people.map((p) => p.id))
    .gte("created_at", since);
  if (error) throw error;
  if (!data || data.length === 0) return "";
  return (data as { score: number }[])
    .map((row) => `rating ${row.score}`)
    .join(", ");
}

// What the group asked to avoid ("we don't want to do temples"), plus any
// thumbs-down (score 1-2) on a place, which lowers its category the same way.
async function tripAvoidWeights(trip: TripRow, people: ParticipantRow[]): Promise<Record<string, number>> {
  const weights: Record<string, number> = { ...(trip.category_weights ?? {}) };
  if (people.length === 0) return weights;
  const { data, error } = await getServiceClient()
    .from("ratings")
    .select("score, place_id")
    .in("participant_id", people.map((p) => p.id))
    .lte("score", 2);
  if (error) throw error;
  const placeIds = [...new Set((data ?? []).map((r) => (r as { place_id: string }).place_id))];
  if (placeIds.length === 0) return weights;
  const places = await getServiceClient().from("places").select("id, name, category").in("id", placeIds);
  if (places.error) throw places.error;
  for (const place of (places.data ?? []) as Pick<PlaceRow, "id" | "name" | "category">[]) {
    for (const key of categoriesOf(place.name, place.category)) {
      weights[key] = Math.min(weights[key] ?? 1, 0.6);
    }
  }
  return weights;
}

function coordsOfPlace(row: Pick<PlaceRow, "lat" | "lng">): { lat: number; lng: number } | null {
  return row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null;
}

// Places people asked for (conversation, and their survey's attractions).
export async function tripSuggestions(
  tripId: string,
  people: ParticipantRow[],
): Promise<(Suggestion & { placeId: string; category: string | null })[]> {
  const { data, error } = await getServiceClient()
    .from("places")
    .select("id, name, lat, lng, category, suggested_by, source")
    .eq("trip_id", tripId)
    .eq("source", "suggestion");
  if (error) throw error;
  return ((data ?? []) as PlaceRow[]).map((row) => ({
    placeId: row.id,
    name: row.name,
    coords: coordsOfPlace(row),
    category: row.category,
    by: people.find((p) => p.id === row.suggested_by)?.display_name ?? null,
  }));
}

export type BoardAnchor = { name: string; by: string | null; slot: DaySlot | null };

type AnchorRow = { id: string; place_id: string; planned_time: string | null; anchor_order: number };

async function dayAnchorRows(tripId: string, day: number): Promise<AnchorRow[]> {
  const { data, error } = await getServiceClient()
    .from("itinerary")
    .select("id, place_id, planned_time, anchor_order")
    .eq("trip_id", tripId)
    .eq("day", day)
    .order("anchor_order");
  if (error) throw error;
  return (data ?? []) as AnchorRow[];
}

// The day's anchors as the board shows them: "+ teamLab (Dev's pick)".
export async function dayAnchorsForBoard(trip: TripRow, day: number): Promise<BoardAnchor[]> {
  const rows = await dayAnchorRows(trip.id, day);
  if (rows.length === 0) return [];
  const [places, people] = await Promise.all([
    getServiceClient().from("places").select("id, name, suggested_by").in("id", rows.map((r) => r.place_id)),
    getServiceClient().from("participants").select("id, display_name").eq("trip_id", trip.id),
  ]);
  if (places.error) throw places.error;
  if (people.error) throw people.error;
  return rows.map((row) => {
    const place = ((places.data ?? []) as Pick<PlaceRow, "id" | "name" | "suggested_by">[]).find((p) => p.id === row.place_id);
    const by = ((people.data ?? []) as Pick<ParticipantRow, "id" | "display_name">[]).find((p) => p.id === place?.suggested_by);
    const slot = row.planned_time
      ? slotForMinute(parseClockMinutes(localTimeHHMM(new Date(row.planned_time), zoneNow(trip, new Date(row.planned_time)))))
      : null;
    return { name: place?.name ?? "a stop", by: by?.display_name ?? null, slot };
  });
}

// Who a board is planned for. No split: everyone together, one plan, cloned
// to each person (one shared schedule, individual claims). A split: each
// group a time-bounded team with its own window (lib/game/split.ts).
export type Assignee = {
  kind: "group" | "team";
  id: string;
  teamId: string | null;
  shared?: boolean;
  people: ParticipantRow[];
  label: string;
  startAt: number | null;
  endAt: number | null;
  startNear: string | null;
  endNear: string | null;
};

// A day's teams: the groups of a conversational split for that trip day.
export async function dayTeams(tripId: string, day: number): Promise<DayTeam[]> {
  const { data, error } = await getServiceClient()
    .from("teams")
    .select("id, name, day, starts_at, rejoin_at, rejoin_place, area, dissolved_at")
    .eq("trip_id", tripId)
    .eq("day", day)
    .is("dissolved_at", null);
  if (error) throw error;
  const teams = (data ?? []) as TeamRow[];
  const out: DayTeam[] = [];
  for (const team of teams) {
    const { data: members, error: memErr } = await getServiceClient()
      .from("team_members")
      .select("participant_id")
      .eq("team_id", team.id);
    if (memErr) throw memErr;
    out.push({
      id: team.id,
      name: team.name,
      memberIds: (members ?? []).map((m) => (m as { participant_id: string }).participant_id),
      startsAt: team.starts_at ? parseClockMinutes(team.starts_at) : null,
      rejoinAt: team.rejoin_at ? parseClockMinutes(team.rejoin_at) : null,
      rejoinPlace: team.rejoin_place ?? null,
      area: team.area ?? null,
    });
  }
  return out;
}

function sharedInterests(person: ParticipantRow): string[] {
  const answers = (person.survey_json ?? {}) as SurveyAnswers;
  const interests = new Set<string>();
  for (const pick of interestPicksOf(answers)) interests.add(pick);
  const add = (question: "ab_food_outdoors" | "ab_discover_iconic" | "ab_culture_nightlife", a: string, b: string) => {
    const value = answerValue(answers, question);
    if (value === "a" || value === "both") interests.add(a);
    if (value === "b" || value === "both") interests.add(b);
  };
  add("ab_food_outdoors", "food", "outdoors");
  add("ab_discover_iconic", "neighbourhoods", "landmarks");
  add("ab_culture_nightlife", "culture", "nightlife");
  const mustHave = answerValue(answers, "must_have")?.toLowerCase() ?? "";
  if (/food|restaurant|eat|ramen|snack/.test(mustHave)) interests.add("food");
  if (/party|bar|club|nightlife|dance/.test(mustHave)) interests.add("nightlife");
  if (/museum|art|history|temple|architecture/.test(mustHave)) interests.add("culture");
  if (/hike|kayak|nature|outdoor|beach|mountain/.test(mustHave)) interests.add("outdoors");
  return [...interests];
}

async function createPreferenceTeamsForDay(
  tripId: string,
  day: number,
  people: ParticipantRow[],
): Promise<DayTeam[]> {
  const existing = await dayTeams(tripId, day);
  if (existing.length > 0) return existing;
  const pairs = pairBySharedInterests(people.map((person) => ({
    id: person.id,
    interests: sharedInterests(person),
  })));
  const byId = new Map(people.map((person) => [person.id, person]));
  for (let index = 0; index < pairs.length; index++) {
    const name = `day ${day} pair ${index + 1}`;
    const { data, error } = await getServiceClient()
      .from("teams")
      .insert({
        trip_id: tripId,
        name,
        color: ["blue", "green", "purple", "orange", "teal"][index % 5],
        formed_at: new Date().toISOString(),
        day,
      })
      .select("id, name")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("daily preference team insert returned no row");
    const members = pairs[index].filter((id) => byId.has(id));
    const { error: memberError } = await getServiceClient()
      .from("team_members")
      .insert(members.map((participant_id) => ({ team_id: data.id, participant_id })));
    if (memberError) throw memberError;
  }
  return dayTeams(tripId, day);
}

async function createFullGroupTeamForDay(
  tripId: string,
  day: number,
  people: ParticipantRow[],
): Promise<DayTeam> {
  const name = `everyone · day ${day}`;
  const { data: existing, error: lookupError } = await getServiceClient()
    .from("teams")
    .select("id")
    .eq("trip_id", tripId)
    .eq("day", day)
    .eq("name", name)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    const team = (await dayTeams(tripId, day)).find((row) => row.id === (existing as { id: string }).id);
    if (team) return team;
  }
  const { data, error } = await getServiceClient()
    .from("teams")
    .insert({
      trip_id: tripId,
      name,
      color: "teal",
      formed_at: new Date().toISOString(),
      day,
    })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("full group team insert returned no row");
  const { error: memberError } = await getServiceClient()
    .from("team_members")
    .insert(people.map((person) => ({ team_id: data.id, participant_id: person.id })));
  if (memberError) throw memberError;
  const team = (await dayTeams(tripId, day)).find((row) => row.id === (data as { id: string }).id);
  if (!team) throw new Error("full group team could not be reloaded");
  return team;
}

function personAssignee(person: ParticipantRow): Assignee {
  return {
    kind: "group",
    id: `person:${person.id}`,
    teamId: null,
    people: [person],
    label: person.display_name,
    startAt: null,
    endAt: null,
    startNear: null,
    endNear: null,
  };
}

export async function loadAssignees(trip: TripRow, people: ParticipantRow[], day: number): Promise<Assignee[]> {
  if (people.length === 0) return [];
  if (trip.play_mode === "full_group") {
    const team = await createFullGroupTeamForDay(trip.id, day, people);
    return [{
      kind: "team",
      id: "full-group",
      teamId: team.id,
      people,
      label: team.name,
      startAt: null,
      endAt: null,
      startNear: null,
      endNear: null,
    }];
  }

  if (trip.play_mode === "individual") return people.map(personAssignee);

  if (trip.play_mode === "teams") {
    const teams = await createPreferenceTeamsForDay(trip.id, day, people);
    const assigned = new Set<string>();
    const assignees: Assignee[] = teams.map((team) => {
      const members = people.filter((person) => team.memberIds.includes(person.id));
      members.forEach((person) => assigned.add(person.id));
      return {
        kind: "team",
        id: `team:${team.id}`,
        teamId: team.id,
        people: members,
        label: team.name,
        startAt: team.startsAt,
        endAt: team.rejoinAt,
        startNear: team.area,
        endNear: team.rejoinPlace,
      };
    });
    assignees.push(...people.filter((person) => !assigned.has(person.id)).map(personAssignee));
    return assignees;
  }

  // Legacy trips retain the former shared-plan behavior.
  return [{
    kind: "group",
    id: "together",
    teamId: null,
    people,
    label: "everyone",
    startAt: null,
    endAt: null,
    startNear: null,
    endNear: null,
  }];
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
  group: { startAt?: number | null; endAt?: number | null } = {},
): DayWindow {
  const timezone = zoneFor(trip, date);
  const answers = people.map((p) => (p.survey_json ?? {}) as SurveyAnswers);
  const pace = paceFor(answers.map((a) => answerValue(a, "pace")));
  const today = localDateString(now, timezone);
  const nowMinutes = date === today ? parseClockMinutes(localTimeHHMM(now, timezone)) : null;
  // A travel day starts when they land, not at board_time: the morning is a
  // train or an airport, so the usable day is the evening in the new city.
  // Everything downstream (60-70% fill, max task count, the route) then falls
  // out of the shorter window on its own.
  const travel = isTravelDate(trip, date);
  return usableWindow({
    boardTime: trip.board_time,
    pace,
    nowMinutes,
    blackouts: groupBlackouts(answers),
    startAt: travel ? Math.max(TRAVEL_DAY_START_MINUTE, group.startAt ?? 0) : group.startAt,
    endAt: group.endAt,
  });
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
  avoid: Record<string, number>;
  suggestions: Suggestion[];
  anchors?: Candidate[];
  // A holiday or festival changes what is worth doing, not only what it
  // scores: generation leans into it and is warned about what will be shut.
  specialDay?: TaskMultiplier | null;
  // "7 attractions": this many tasks, whatever the pace default.
  targetCount?: number | null;
  // Titles already on their board today, so an extension adds new ones.
  avoidTitles?: string[];
  // A redo: the board being replaced (never repeated) and which attempt this
  // is, so the deterministic fallback does not refill the same tasks.
  rejectedTitles?: string[];
  variant?: number;
}): Promise<{ tasks: PlannedTask[]; anchors: PlannedTask[]; usedFallback: boolean; window: DayWindow }> {
  const { trip, assignee } = opts;
  const answers = assignee.people.map((p) => (p.survey_json ?? {}) as SurveyAnswers);
  const window = dayWindowFor(trip, assignee.people, opts.date, opts.now, assignee);
  const completed = [
    ...(await completedTitles(trip.id, assignee.people.map((p) => p.id))),
    ...(opts.avoidTitles ?? []),
    ...(opts.rejectedTitles ?? []),
  ];
  const solo = Boolean(trip.is_solo);
  const bank = boardTemplates({ solo });
  const templates = templatesAllowedFor(bank, answers);
  const curveball = isCurveballBoard(`${trip.id}:${opts.day}:${assignee.id}`);
  const travelDay = isTravelDate(trip, opts.date);
  const prefs = boardPreferencesFor({
    answers,
    difficulty: trip.difficulty,
    avoid: opts.avoid,
    suggestions: opts.suggestions,
    // An explicit "7 attractions" still wins; the cap is only the default.
    targetCount:
      travelDay && !opts.targetCount ? TRAVEL_DAY_MAX_TASKS : opts.targetCount,
  });
  const ctx: PrepareContext = {
    profile: opts.profile,
    solo,
    window,
    assignees: answers.map((a) => ({ answers: a })),
    completedTitles: completed,
    expiresAt: endOfLocalDay(opts.date, zoneFor(trip, opts.date)),
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
  const interests = INTEREST_KEYS.map((key) => ({
    key,
    share: answers.filter((a) => interestPicksFor(a).includes(key)).length / Math.max(1, answers.length),
  })).filter((i) => i.share > 0);
  const avoidList = Object.entries(opts.avoid).filter(([, w]) => w < 1).map(([k]) => k);
  const promptFields = [
    ...new Set([
      ...answers.flatMap((a) => Object.keys(promptPreferences(a))),
      "sociability",
      ...(opts.suggestions.length ? ["suggestions"] : []),
      ...(avoidList.length ? ["avoid"] : []),
    ]),
  ];
  console.info(
    "[japlan.generate] personalization",
    JSON.stringify({
      tripId: trip.id,
      assignee: assignee.label,
      ...personalizationFor({ answers, prefs, window, offered: templates.length, total: bank.length, promptFields }),
    }),
  );

  const proposals: ProposedTask[] = [];
  let curveballProposed = false;
  for (let round = 1; round <= 2 && window.usableMinutes > 0; round++) {
    let fresh: ProposedTask[] = [];
    try {
      fresh = await generateTasksForAssignee({
        profile: opts.profile,
        weather: opts.weather,
        preferenceText: groupPreferenceText(assignee.people),
        completedTitles: completed,
        yesterdayRatings: opts.ratings,
        scoreGap: opts.gap,
        day: opts.day,
        difficulty: trip.difficulty,
        boardTitles: opts.boardTitles,
        rejectedTitles: opts.rejectedTitles,
        templates,
        plan,
        curveball,
        count: candidatesToRequest(window, prefs.targetCount),
        sociability: prefs.sociability,
        interests,
        suggestions: opts.suggestions.map((sg) => ({ name: sg.name, by: sg.by })),
        avoid: avoidList,
        specialDay: opts.specialDay
          ? { label: opts.specialDay.label, source: opts.specialDay.source }
          : null,
        mustHaves: mustHavesOf(answers),
        travelDay: travelDay ? { city: legForDate(trip, opts.date).city } : null,
      });
    } catch (err) {
      console.error("[japlan.generate] llm failed", { round, assignee: assignee.label, err });
    }
    curveballProposed ||= fresh.some((t) => t.template === "curveball");
    proposals.push(...fresh);
    const pool = prepareCandidates(proposals, { ...ctx, onReject: undefined });
    if (dayMinutes(selectForDay(pool, window, { conflicts: boardConflict })) >= targetMinutes(window) * 0.5) break;
    console.info("[japlan.generate] regenerating; model fell short of half the day", {
      round,
      assignee: assignee.label,
      pool: pool.length,
    });
  }

  // Every allowed template, filled a few ways (different neighborhoods,
  // dishes, places), so a refill can reuse a template with new slots.
  const fills = [0, 1, 2, 3].flatMap((variant) =>
    fillTemplatesDeterministically({
      profile: opts.profile,
      weather: opts.weather,
      templates,
      count: templates.length,
      seed: opts.day * 7 + variant * 5 + (opts.variant ?? 0) * 13,
    }),
  );
  const near = (name: string | null) => (name ? resolvePlace(name, opts.profile)?.coords ?? null : null);
  const planned = planFromProposals({
    proposals,
    fallback: fills,
    ctx,
    prefs,
    anchors: opts.anchors,
    ends: { start: near(assignee.startNear), end: near(assignee.endNear) },
  });
  console.info("[japlan.generate] day plan", {
    tripId: trip.id,
    assignee: assignee.label,
    pace: window.pace,
    window: plan.windowText,
    usableMinutes: window.usableMinutes,
    targetMinutes: plan.targetMinutes,
    plannedMinutes: dayMinutes([...planned.tasks, ...planned.anchors]),
    tasks: planned.tasks.map((t) => ({ title: t.title, minutes: t.minutes, slot: t.slot, template: t.template })),
    anchors: planned.anchors.map((a) => a.title),
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
  // What the board promises on a special day. Stored on the row, never folded
  // into base_points: base_points is the number the board prints and the
  // number tierForPoints reads, so doubling it would make a medium task read
  // as challenging. On the row, a claim awards what people were shown even if
  // the local day rolls over between the board landing and the claim.
  multiplier?: TaskMultiplier | null;
}): { row: Omit<TaskRow, "id"> } {
  // A special day REPLACES the day-of-trip scaling rather than compounding
  // with it (lib/game/multipliers.ts takes the higher of the two, never the
  // product). So on a multiplier day the printed points are the task's own
  // unscaled worth and the multiplier applies to them, which is what makes
  // "everything's 2x" true of the number people can actually see.
  const { points, tier } = pointsForBoard(
    opts.task.axes,
    opts.multiplier ? { day: 1, tripDays: null } : { day: opts.day, tripDays: opts.tripDays },
  );
  const [task] = applySoloVerification([opts.task], Boolean(opts.isSolo));
  const rowTask = task ?? opts.task;
  // Code, not the prompt, bounds the photo bonus. Every clamp is logged with
  // the model's original so the gap is visible.
  const bonus = clampPhotoBonusMax(rowTask.photo_bonus_max, points);
  if (bonus.clamped) {
    console.info("[japlan.generate] photo_bonus_max clamped", {
      title: rowTask.title,
      original: rowTask.photo_bonus_max,
      clamped: bonus.value,
      basePoints: points,
    });
  }
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
      photo_bonus_max: bonus.value,
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
      day_multiplier: opts.multiplier?.value ?? null,
      multiplier_reason: opts.multiplier?.label ?? null,
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
  // What this trip-day is worth, if it is a special one.
  specialDay?: TaskMultiplier | null;
}): Promise<{
  tasks: ProposedTask[];
  usedFallback: boolean;
  day: number;
  anchors: { itineraryId: string; slot: DaySlot }[];
}> {
  const now = opts.now ?? new Date();
  const date = opts.date ?? todayFor(opts.trip, now);
  const day = tripDayOn(opts.trip, date, now);
  const expiresAt = endOfLocalDay(date, zoneFor(opts.trip, date));
  const assignees = await loadAssignees(opts.trip, opts.people, day);
  const ratings = await yesterdayRatings(opts.people);
  const gap = scoreGapText(opts.people);
  const boardTitles = await tripBoardTitles(opts.trip.id);
  const avoid = await tripAvoidWeights(opts.trip, opts.people);
  const suggestions = await tripSuggestions(opts.trip.id, opts.people);
  // The day's anchors (places people asked for, put on this day) ride on
  // the together plan, else the first group's.
  const anchorRows = await dayAnchorRows(opts.trip.id, day);
  const anchorOwner =
    assignees.find((a) => a.id === "together:after") ??
    assignees.find((a) => a.kind === "group") ??
    assignees[0];
  const anchorFor = new Map<Candidate, string>();
  const anchorCandidates: Candidate[] = [];
  for (const row of anchorRows) {
    const s = suggestions.find((sg) => sg.placeId === row.place_id);
    if (!s) continue;
    const c = anchorCandidate({
      name: s.name,
      coords: s.coords,
      category: s.category,
      by: s.by,
      neighborhood: s.coords ? resolvePlace(s.name, opts.profile)?.neighborhood ?? null : null,
    });
    anchorFor.set(c, row.id);
    anchorCandidates.push(c);
  }

  let kept: (PlannedTask & { participantId: string | null; teamId: string | null })[] = [];
  const anchors: { itineraryId: string; slot: DaySlot }[] = [];
  let usedFallback = false;
  for (const assignee of assignees) {
    if (assignee.people.length === 0) continue;
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
      avoid,
      suggestions,
      specialDay: opts.specialDay,
      anchors: assignee === anchorOwner ? anchorCandidates : [],
    });
    usedFallback ||= planned.usedFallback;
    for (const a of planned.anchors) {
      const source = anchorCandidates.find((c) => c.title === a.title);
      const id = source ? anchorFor.get(source) : undefined;
      if (id) anchors.push({ itineraryId: id, slot: a.slot });
    }
    if (assignee.teamId) {
      kept.push(...planned.tasks.map((task) => ({ ...task, participantId: null, teamId: assignee.teamId })));
    } else if (assignee.shared) {
      kept.push(...planned.tasks.map((task) => ({ ...task, participantId: null, teamId: null })));
    } else {
      // Together: one plan, a copy per person. Same schedule, same codes,
      // each claimed and scored individually.
      for (const person of assignee.people) {
        kept.push(...planned.tasks.map((task) => ({ ...task, participantId: person.id, teamId: null })));
      }
    }
  }

  const trailer = trailingPlayer(opts.people);
  if (trailer && opts.trip.play_mode !== "full_group") {
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
  return { tasks: coded, usedFallback, day, anchors };
}

const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

// Whose tasks can be generated: anyone whose allergies and limits we know.
// Someone mid-survey (a late joiner, say) is left off rather than given tasks
// that might clash with answers they have not given yet. Null survey_state is
// a participant from before surveys existed, treated as known.
export function constraintsKnown(
  person: Pick<ParticipantRow, "survey_state"> & { survey_json?: SurveyAnswers | null },
): boolean {
  const state = person.survey_state;
  if (!state || state === "done") return true;
  // Answering the sidequest question, after the survey: constraints known.
  if (isSidequestQuestion(state)) return true;
  // Mid-resurvey: the hard constraints were answered the first time and are
  // kept until replaced, so their boards keep coming.
  const answers = person.survey_json ?? {};
  return ["dietary", "mobility", "budget"].every((id) => answers[id as keyof SurveyAnswers] !== undefined);
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
  // What the day is worth, already worked out: callers render the header from
  // this rather than reading the special days back.
  specialDay: TaskMultiplier | null;
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
  const timezone = zoneFor(trip, opts.date);
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
  // Under 18 is out for v1 (PLAN's 18+ gate); unknown constraints wait.
  const eligible = people.filter(
    (p) => constraintsKnown(p) && !isUnderAge((p.survey_json ?? {}) as SurveyAnswers),
  );
  if (eligible.length < people.length) {
    console.info("[japlan.generate] skipped people with unknown constraints", {
      tripId: trip.id,
      day,
      skipped: people.length - eligible.length,
    });
  }

  const tripDays = tripLengthDays(trip.start_date, trip.end_date);
  // One lookup for the whole board: what this day is worth, as a factor on the
  // points each line prints. Weekends need nothing stored, so this answers
  // even on a trip whose holidays were never looked up.
  const specialDay = taskMultiplierFor({
    localDate: opts.date,
    day,
    tripDays,
    days: await loadMultiplierDays(trip.id),
  });
  if (specialDay) {
    console.info("[japlan.generate] special day", {
      tripId: trip.id,
      day,
      date: opts.date,
      label: specialDay.label,
      source: specialDay.source,
      multiplier: specialDay.value,
    });
  }

  const { tasks, usedFallback, anchors } = await generateValidatedBoard({
    trip,
    people: eligible,
    profile,
    weather,
    now,
    date: opts.date,
    reservedCodes: claimedOnDay,
    specialDay,
  });

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
        multiplier: specialDay,
      }).row,
  );
  const rows = withoutClaimedCollisions(generated, claimedOnDay, trip.id);
  if (rows.length > 0) {
    const { error } = await getServiceClient().from("tasks").upsert(rows, {
      onConflict: TASK_CODE_CONFLICT,
    });
    if (error) throw error;
    // Unclaimed tasks were removed first and claimed collisions filtered out,
    // so every row here is new: each one is an itinerary item.
    await recordTasksChanged(trip.id, rows, 1);
  }
  // Anchors keep the time of day they were planned into.
  const SLOT_TIME: Record<DaySlot, string> = { morning: "10:00", afternoon: "14:30", evening: "19:00" };
  for (const a of anchors) {
    const { error } = await getServiceClient()
      .from("itinerary")
      .update({ planned_time: zonedTimeToUtc(opts.date, SLOT_TIME[a.slot], timezone).toISOString() })
      .eq("id", a.itineraryId);
    if (error) throw error;
  }
  console.info("[japlan.generate] board built", {
    tripId: trip.id,
    day,
    date: opts.date,
    count: rows.length,
    usedFallback,
  });
  return {
    day,
    date: opts.date,
    rows,
    weatherLine: formatWeatherLine(weather),
    usedFallback,
    people,
    specialDay,
  };
}

// Build today's board and deliver it to everyone. The force=1 path.
export async function runDailyBoardForTrip(
  trip: TripRow,
  opts: { now?: Date } = {},
): Promise<{ posted: boolean; day: number; count: number; usedFallback: boolean }> {
  const now = opts.now ?? new Date();
  // A manual run for a trip outside its dates builds the nearest real day
  // (day 1 before the trip, the last day after it) rather than day 0 or -3.
  const today = todayFor(trip, now);
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
    specialDay: built.specialDay,
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
  const weather = await weatherFor(profile, date, zoneFor(trip, date));
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
  // By owner and code: codes repeat per owner, so one person's claimed A1
  // must not keep everyone else's unclaimed A1.
  const claimed = new Set(
    (await claimedTasksOnDay(tripId, day)).map((c) => ownerCodeKey(c.code, c.participantId, c.teamId)),
  );
  const tasks = await tasksForDay(tripId, day);
  const drop = tasks
    .filter((t) => !claimed.has(ownerCodeKey(t.code, t.participant_id, t.team_id)))
    .map((t) => t.id);
  if (drop.length === 0) return;
  const { error } = await getServiceClient().from("tasks").delete().in("id", drop);
  if (error) throw error;
  // A regenerated day replaces these: they come off the count, the new ones
  // go on, so regeneration never inflates it.
  await recordTasksChanged(tripId, tasks.filter((t) => drop.includes(t.id)), -1);
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
      specialDay: built.specialDay,
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
  // false: a re-plan mid-day (a split), not a morning: no standings post.
  standings?: boolean;
  // What the day is worth. Omitted (not null) means look it up.
  specialDay?: TaskMultiplier | null;
}): Promise<void> {
  const anchors = await dayAnchorsForBoard(opts.trip, opts.day);
  // A holiday, a festival, a weekend: it rides in the board
  // header so it changes the plan and not only the score.
  const specialDay =
    opts.specialDay !== undefined
      ? opts.specialDay
      : opts.trip.start_date
        ? await dayMultiplierFor(opts.trip, opts.day, dateForTripDay(opts.trip.start_date, opts.day))
        : null;
  // Multi-city only: the city goes in the header so day five reads as Osaka.
  // A single-leg trip passes null and its header is byte-identical to before.
  const boardDate = opts.trip.start_date ? dateForTripDay(opts.trip.start_date, opts.day) : null;
  const place =
    boardDate && isMultiCity(opts.trip)
      ? { city: cityFor(opts.trip, boardDate), travelDay: isTravelDate(opts.trip, boardDate) }
      : null;
  const multiplierPart = specialDay
    ? multiplierHeaderPart({
        label: specialDay.label,
        multiplier: multiplierLabel(specialDay.value),
      })
    : null;
  if (opts.trip.play_mode === "full_group" && !opts.trip.is_solo) {
    const people = opts.allPeople ?? opts.people;
    const sharedTasks = opts.rows.filter((row) => !row.participant_id);
    const board = formatDailyBoard({
      day: opts.day,
      weatherLine: opts.weatherLine,
      multiplierPart,
      place,
      tasks: sharedTasks.map((row) => ({
        code: row.code,
        title: row.title,
        base_points: row.base_points,
        slot: row.slot ?? null,
        neighborhood: row.neighborhood,
      })),
      standings: people.map((person) => ({
        display_name: person.display_name,
        score: person.score,
      })),
    });
    const reopened = [...new Set([...(opts.lapsed?.values() ?? [])].flat())];
    await sendText(
      opts.trip.linq_chat_id,
      `${board}${reopened.length > 0 ? `\n\n♻️ reopened: ${reopened.join(", ")}` : ""}`,
    );
    return;
  }

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

  const teamLabelByParticipant = new Map<string, string>();
  const tripPeople = opts.allPeople ?? opts.people;
  for (const teamId of [...new Set(teamRows.map((row) => row.team_id!))]) {
    const { data, error } = await getServiceClient()
      .from("team_members")
      .select("participant_id")
      .eq("team_id", teamId);
    if (error) throw error;
    const memberIds = (data ?? []).map((row) => (row as { participant_id: string }).participant_id);
    const label = memberIds
      .map((id) => tripPeople.find((person) => person.id === id)?.display_name)
      .filter((name): name is string => Boolean(name))
      .join(" + ");
    for (const id of memberIds) teamLabelByParticipant.set(id, label);
  }

  for (const person of opts.people) {
    const tasks = byPerson.get(person.id) ?? [];
    const lapsedCodes = opts.lapsed?.get(person.id) ?? [];
    if (tasks.length === 0 && lapsedCodes.length === 0) continue;
    const parts: string[] = [];
    const teamLabel = teamLabelByParticipant.get(person.id);
    if (teamLabel) parts.push(`🤝 today's shared tasks: ${teamLabel}.`);
    // One DM: the lapsed-claim line (which names the reopened code) rides on
    // top of the board instead of arriving as a second message.
    if (lapsedCodes.length > 0) parts.push(peerLapsedLine(lapsedCodes));
    if (tasks.length > 0) {
      parts.push(
        formatPersonalBoard({
          day: opts.day,
          weatherLine: opts.weatherLine,
          multiplierPart,
          place,
          anchors,
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
  if (opts.trip.is_solo || opts.standings === false) return;
  const teams = await teamsWithMembers(opts.trip.id);
  // One group message on a multiplier day, in the morning, never one per
  // claim: the multiplier is collective, so it is news rather than a receipt.
  // Solo trips skip it, the same way they skip the standings post: their
  // board header already said it in the DM they just got.
  if (specialDay && !opts.trip.is_solo) {
    await sendText(
      opts.trip.linq_chat_id,
      multiplierDayAnnouncement({
        label: specialDay.label,
        multiplier: multiplierLabel(specialDay.value),
        source: specialDay.source,
      }),
    );
  }
  const standings = formatMorningStandings({
    day: opts.day,
    weatherLine: opts.weatherLine,
    multiplierPart,
    place,
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
  // Asked for a number of tasks: plan exactly that many new ones (or what
  // fits), around the tasks they still have open.
  targetCount?: number | null;
  keep?: TaskRow[];
  // A redo: titles of the board being replaced, and the attempt number.
  rejectTitles?: string[];
  variant?: number;
  now?: Date;
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

  const now = opts.now ?? new Date();
  const today = opts.date ?? todayFor(opts.trip, now);
  const timezone = zoneFor(opts.trip, today);
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

  const ratings = await yesterdayRatings(people);
  const gap = scoreGapText(people);
  const boardTitles = await tripBoardTitles(opts.trip.id);
  const avoid = await tripAvoidWeights(opts.trip, people);
  const suggestions = await tripSuggestions(opts.trip.id, people);
  // A redo lands on the same day, so it is worth the same: the replacement
  // tasks carry the multiplier the morning board already promised.
  const specialDay = taskMultiplierFor({
    localDate: today,
    day,
    tripDays: tripLengthDays(opts.trip.start_date, opts.trip.end_date),
    days: await loadMultiplierDays(opts.trip.id),
  });
  const assignee: Assignee = {
    kind: "group",
    id: opts.claimant.id,
    teamId: null,
    people: [opts.claimant],
    label: opts.claimant.display_name,
    startAt: null,
    endAt: null,
    startNear: null,
    endNear: null,
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
    avoid,
    suggestions,
    specialDay,
    targetCount: opts.targetCount,
    avoidTitles: (opts.keep ?? []).map((t) => t.title),
    rejectedTitles: opts.rejectTitles,
    variant: opts.variant,
    // Open tasks they keep take their time in the day, as fixed stops.
    anchors: (opts.keep ?? []).map((t) => ({
      ...anchorCandidate({
        name: t.title,
        coords: t.neighborhood ? resolvePlace(t.neighborhood, profile)?.coords ?? null : null,
        category: null,
        by: null,
        neighborhood: t.neighborhood,
      }),
      minutes: t.duration_minutes ?? 60,
    })),
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
      multiplier: specialDay,
    }).row,
  );
  if (rows.length === 0) return [];
  const { error } = await supabase.from("tasks").upsert(rows, {
    onConflict: TASK_CODE_CONFLICT,
  });
  if (error) throw error;
  await recordTasksChanged(opts.trip.id, rows, 1);
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
  // Surveying trips too: at board time one that has a finished survey goes
  // live (a person gets a board once THEY are ready, whoever else is still
  // answering); one where nobody has finished tells the group once, and
  // nudges the people answering. Before, the cron skipped them silently.
  let query = getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .in("state", ["active", "surveying"]);
  if (opts.tripId) query = query.eq("id", opts.tripId);
  const { data, error } = await query;
  if (error) throw error;
  const listed = (data ?? []) as TripRow[];
  const ran: string[] = [];
  const skipped: string[] = [];
  const { maybeActivateTrip, getTripById } = await import("./bootstrap");
  const { announceWaitingOnce, nudgeUnfinished } = await import("./survey-nudges");
  const trips: TripRow[] = [];
  for (const trip of listed) {
    if (trip.state !== "surveying") {
      trips.push(trip);
      continue;
    }
    const due = boardDueNow(trip, now);
    if (!opts.force && !due.due) {
      skipped.push(trip.id);
      continue;
    }
    try {
      if (await maybeActivateTrip(trip)) {
        boardLog("tick.activated", { tripId: trip.id });
        trips.push((await getTripById(trip.id)) ?? { ...trip, state: "active" });
        continue;
      }
      // Nobody has finished (or setup is incomplete, which maybeActivateTrip
      // logs): no board to make yet.
      if (missingRequiredSetup(trip as SetupFields).length === 0) {
        await announceWaitingOnce(trip);
        if (due.due) await nudgeUnfinished(trip, due.date);
      }
    } catch (err) {
      console.error("[japlan.board] surveying tick failed", { tripId: trip.id, error: err instanceof Error ? err.message : String(err) });
    }
    skipped.push(trip.id);
  }
  for (const trip of trips) {
    try {
      await remindOpenGroupDecisions(trip, now);
    } catch (err) {
      console.error("[japlan.group_decision] reminder failed", {
        tripId: trip.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!trip.destination) {
      console.error("[japlan.generate] skip; trip.destination is empty", {
        tripId: trip.id,
      });
      skipped.push(trip.id);
      continue;
    }
    // Which days this trip's destination treats as special. Rate limited to
    // once a week inside, and never fatal: a trip with no holiday data still
    // gets its weekend multipliers.
    try {
      await refreshTripMultipliers(trip, { now });
    } catch (err) {
      console.error("[japlan.multipliers] refresh failed", {
        tripId: trip.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Links people dropped in the chat, resolved into places. Off the webhook
    // path entirely, rate limited per trip, one attempt each. Only a real
    // resolution says anything; a miss is silent by design.
    try {
      await resolveQueuedLinks(trip, {
        now,
        send: (text) => sendText(trip.linq_chat_id, text),
      });
    } catch (err) {
      console.error("[japlan.social] resolve failed", {
        tripId: trip.id,
        error: err instanceof Error ? err.message : String(err),
      });
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
      // Board time for people still answering: their next question instead
      // of a board, once a day.
      await nudgeUnfinished(trip, due.date);
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

// A split or a regroup re-plans the rest of that day: unclaimed tasks go,
// claimed ones stand, and each person gets their new board by DM (their
// group's, plus the together part after everyone rejoins). Only when that
// day's board exists already; otherwise the split shapes it when it is made.
export async function replanDay(trip: TripRow, date: string, now: Date): Promise<boolean> {
  const day = tripDayOn(trip, date, now);
  const board = await getBoard(trip.id, day);
  if (!board || board.status !== "ready") return false;
  await deleteUnclaimedTasksForDay(trip.id, day);
  const built = await buildBoardForDate(trip, { date, now });
  await deliverMorningBoards({
    trip,
    people: built.people,
    rows: built.rows,
    day,
    weatherLine: built.weatherLine,
    specialDay: built.specialDay,
    standings: false,
  });
  console.info("[japlan.split] replanned", { tripId: trip.id, day, rows: built.rows.length });
  return true;
}

// "I want 7 attractions": that many tasks on their board for the day, or as
// many as fit in what is left of it. Pace only sets the default; asking for
// more is a request, not something to refuse. Returns what they have now and
// the day's usable time left, so the reply can say the real tradeoff.
export async function extendPersonalBoard(opts: {
  trip: TripRow;
  claimant: ParticipantRow;
  want: number;
  date: string;
  now: Date;
}): Promise<{ added: Omit<TaskRow, "id">[]; board: TaskRow[]; minutesLeft: number; day: number }> {
  const day = tripDayOn(opts.trip, opts.date, opts.now);
  const mine = async () => {
    const [tasks, membership] = await Promise.all([
      tasksForDay(opts.trip.id, day),
      getServiceClient().from("team_members").select("team_id").eq("participant_id", opts.claimant.id),
    ]);
    if (membership.error) throw membership.error;
    const teams = (membership.data ?? []).map((m) => (m as { team_id: string }).team_id);
    return tasks.filter(
      (t) => t.participant_id === opts.claimant.id || (t.team_id && teams.includes(t.team_id)) || (!t.participant_id && !t.team_id),
    );
  };
  const before = await mine();
  const claimedIds = new Set(
    ((await getServiceClient().from("claims").select("task_id").in("task_id", before.length ? before.map((t) => t.id) : ["-"])).data ?? []).map(
      (c) => (c as { task_id: string }).task_id,
    ),
  );
  const open = before.filter((t) => !claimedIds.has(t.id));
  const window = dayWindowFor(opts.trip, [opts.claimant], opts.date, opts.now);
  const busy = open.reduce((sum, t) => sum + (t.duration_minutes ?? 60), 0);
  const need = opts.want - before.length;
  const added =
    need > 0
      ? await refillPersonalTasksIfNeeded({
          trip: opts.trip,
          claimant: opts.claimant,
          people: [],
          remainingOpenPersonal: 0,
          deliver: false,
          date: opts.date,
          targetCount: need,
          keep: open,
          now: opts.now,
        })
      : [];
  const board = await mine();
  const addedMinutes = added.reduce((sum, t) => sum + (t.duration_minutes ?? 60), 0);
  return { added, board, minutesLeft: Math.max(0, window.usableMinutes - busy - addedMinutes), day };
}

// After someone changes their settings and says yes to a new board: their
// unclaimed personal tasks for today go, and a new set is planned from their
// answers as they are now. Claimed tasks stand; nobody else's board changes.
// "Give me a different board": the unclaimed part of their board for that
// day is replaced; claimed tasks stay. The old titles go to the generator as
// a retry that must not repeat them, and the fallback is re-seeded per
// attempt. Generation fails: the old board is put back, never left empty.
export type RedoOutcome =
  | { kind: "redone"; day: number; rows: Omit<TaskRow, "id">[]; kept: TaskRow[]; replaced: string[]; repeated: number }
  | { kind: "all_claimed"; day: number; kept: TaskRow[] }
  | { kind: "no_board"; day: number }
  | { kind: "failed"; day: number };

export async function redoMyDay(opts: {
  trip: TripRow;
  claimant: ParticipantRow;
  now: Date;
  date?: string;
  // How many redos of this day came before: varies the fallback.
  variant?: number;
}): Promise<RedoOutcome> {
  const date = opts.date ?? todayFor(opts.trip, opts.now);
  const day = tripDayOn(opts.trip, date, opts.now);
  const tasks = (await tasksForDay(opts.trip.id, day)).filter((t) => t.participant_id === opts.claimant.id);
  if (tasks.length === 0) {
    boardLog("redo.no_board", { tripId: opts.trip.id, day, participantId: opts.claimant.id });
    return { kind: "no_board", day };
  }
  const claims = await getServiceClient()
    .from("claims")
    .select("task_id, status")
    .in("task_id", tasks.map((t) => t.id));
  if (claims.error) throw claims.error;
  const claimed = new Set(
    ((claims.data ?? []) as { task_id: string; status: string }[])
      .filter((c) => c.status === "awarded" || c.status === "pending_peer")
      .map((c) => c.task_id),
  );
  const kept = tasks.filter((t) => claimed.has(t.id));
  const replace = tasks.filter((t) => !claimed.has(t.id));
  if (replace.length === 0) {
    boardLog("redo.refused", { tripId: opts.trip.id, day, participantId: opts.claimant.id, reason: "all_claimed" });
    return { kind: "all_claimed", day, kept };
  }
  const { error } = await getServiceClient().from("tasks").delete().in("id", replace.map((t) => t.id));
  if (error) throw error;
  // A reroll replaces, it does not add: the replaced tasks come off the count.
  await recordTasksChanged(opts.trip.id, replace, -1);
  let rows: Omit<TaskRow, "id">[] = [];
  try {
    rows = await refillPersonalTasksIfNeeded({
      trip: opts.trip,
      claimant: opts.claimant,
      people: [],
      remainingOpenPersonal: 0,
      deliver: false,
      date,
      now: opts.now,
      keep: kept,
      rejectTitles: replace.map((t) => t.title),
      variant: (opts.variant ?? 0) + 1,
    });
  } catch (err) {
    console.error("[japlan.board] redo generation threw", err);
  }
  if (rows.length === 0) {
    // Put the old board back rather than leave them with nothing.
    const restore = await getServiceClient().from("tasks").insert(replace);
    if (restore.error) console.error("[japlan.board] redo restore failed", restore.error);
    else await recordTasksChanged(opts.trip.id, replace, 1);
    boardLog("redo.failed", { tripId: opts.trip.id, day, participantId: opts.claimant.id, restored: replace.length });
    return { kind: "failed", day };
  }
  const old = new Set(replace.map((t) => normalizeTitle(t.title)));
  const repeated = rows.filter((r) => old.has(normalizeTitle(r.title))).length;
  boardLog("redo.regenerated", {
    tripId: opts.trip.id,
    day,
    participantId: opts.claimant.id,
    replaced: replace.length,
    kept: kept.length,
    added: rows.length,
    repeated,
    variant: (opts.variant ?? 0) + 1,
  });
  return { kind: "redone", day, rows, kept, replaced: replace.map((t) => t.title), repeated };
}
