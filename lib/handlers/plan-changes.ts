import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, PlaceRow, TripRow } from "@/lib/db/types";
import { parseBoardDay } from "@/lib/game/board-schedule";
import {
  avoidNotedLine,
  BOARD_MAKE_FAILED_LINE,
  boardRedoneLine,
  EVERYONE_REDONE_LINE,
  onlyOrganizerLine,
  regroupLine,
  SETTING_IN_DM_LINE,
  SETTING_UNKNOWN_LINE,
  settingChangedLine,
  settingUnclearLine,
  preferenceNotedLine,
  splitAskLine,
  splitNotedLine,
  suggestionLine,
  tasksRequestedLine,
} from "@/lib/game/copy";
import { formatPersonalBoard } from "@/lib/game/board";
import { PRIVATE_SURVEY_IDS } from "@/lib/game/conversation";
import {
  applySettingUpdate,
  DEFAULT_MORE_STEP,
  MAX_TASKS_PER_DAY,
  SETTING_LABELS,
  settingIdFor,
} from "@/lib/game/settings";
import { prefDimsFor } from "@/lib/game/prefs";
import { learnFrom, statePreference } from "./profiles";
import { applyTripSetting, tripSettingFor } from "./setup";
import { getTripById } from "./bootstrap";
import type { DestinationProfile } from "@/lib/game/destination";
import type { LatLng } from "@/lib/game/duration";
import { parseClockMinutes } from "@/lib/game/day-plan";
import { resolvePlace } from "@/lib/game/plan-board";
import { categoryKeyFor } from "@/lib/game/preferences";
import { fitSuggestion, splitPlaceList, type DayPoints } from "@/lib/game/suggestions";
import { hhmm, resolveSplit, type SplitInput } from "@/lib/game/split";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import { addDaysIso, localDateString, localTimeHHMM } from "@/lib/game/time";
import { tripDayForDate } from "@/lib/game/board-schedule";
import {
  buildBoardForDate,
  dayAnchorsForBoard,
  dayTeams,
  extendPersonalBoard,
  getBoard,
  lockNewBoard,
  redoMyDay,
  replanDay,
  tasksForDay,
  tripDayOn,
  updateBoard,
} from "./daily-board";

// What the group says about its own plan, turned into state: splits and
// regrouping (teams for a day), places they want (suggestions, anchored on a
// day that fits), and things they want less of. The model extracts; this
// decides. Each returns the one reply to send.

type Ctx = {
  trip: TripRow;
  people: ParticipantRow[];
  sender: ParticipantRow;
  now: Date;
  text: string;
};

const TEAM_COLORS = ["red", "blue", "green", "yellow", "purple", "orange"];

function norm(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function profileOf(trip: TripRow): DestinationProfile | null {
  return (trip.destination_profile_json ?? null) as DestinationProfile | null;
}

function today(ctx: Ctx): string {
  return localDateString(ctx.now, ctx.trip.timezone || "UTC");
}

// "tomorrow", "day 3", "friday", "oct 19"; nothing said is today.
function dateFor(ctx: Ctx, said: string | null | undefined): string {
  if (!said?.trim() || !ctx.trip.start_date) return today(ctx);
  // The model sometimes passes a bare number for "day 3".
  if (/^\d{1,2}$/.test(said.trim())) said = `day ${said.trim()}`;
  return parseBoardDay(said, {
    today: today(ctx),
    startDate: ctx.trip.start_date,
    endDate: ctx.trip.end_date,
  }).date;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export async function recordSplit(
  ctx: Ctx,
  input: SplitInput & { day?: string | null },
): Promise<string> {
  const date = dateFor(ctx, input.day);
  const day = tripDayOn(ctx.trip, date, ctx.now);
  const isToday = date === today(ctx);
  const nowMinutes = isToday
    ? parseClockMinutes(localTimeHHMM(ctx.now, ctx.trip.timezone))
    : parseClockMinutes(ctx.trip.board_time);
  const people = ctx.people.map((p) => ({
    id: p.id,
    display_name: p.display_name,
    answers: (p.survey_json ?? {}) as SurveyAnswers,
  }));
  const resolved = resolveSplit(input, people, ctx.sender.id, nowMinutes);
  const nameOf = (id: string) =>
    id === ctx.sender.id ? "you" : (ctx.people.find((p) => p.id === id)?.display_name ?? "someone");

  const db = getServiceClient();
  const existing = await dayTeams(ctx.trip.id, day);
  const teamIds: string[] = [];
  for (const [i, group] of resolved.groups.entries()) {
    if (group.memberIds.length === 0 && !group.area) continue;
    // Same area, or the same people: the same group, being filled in.
    const match =
      existing.find((t) => group.area && norm(t.area) === norm(group.area)) ??
      existing.find((t) => group.memberIds.some((id) => t.memberIds.includes(id)));
    const fields = {
      starts_at: group.startsAt !== null ? hhmm(group.startsAt) : null,
      rejoin_at: resolved.rejoinAt !== null ? hhmm(resolved.rejoinAt) : null,
      rejoin_place: resolved.rejoinPlace,
      area: group.area,
    };
    let teamId: string;
    if (match) {
      teamId = match.id;
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
      if (Object.keys(patch).length > 0) {
        const { error } = await db.from("teams").update(patch).eq("id", teamId);
        if (error) throw error;
      }
    } else {
      const { data, error } = await db
        .from("teams")
        .insert({
          trip_id: ctx.trip.id,
          name: group.area ?? `group ${i + 1}`,
          color: TEAM_COLORS[(existing.length + i) % TEAM_COLORS.length],
          formed_at: ctx.now.toISOString(),
          day,
          ...fields,
        })
        .select("id")
        .maybeSingle();
      if (error) throw error;
      teamId = (data as { id: string }).id;
    }
    teamIds.push(teamId);
    // One person, one group that day: move them out of any other.
    const others = existing.filter((t) => t.id !== teamId).map((t) => t.id);
    for (const id of group.memberIds) {
      if (others.length > 0) {
        const { error } = await db
          .from("team_members")
          .delete()
          .in("team_id", others)
          .eq("participant_id", id);
        if (error) throw error;
      }
      const already = existing.find((t) => t.id === teamId)?.memberIds.includes(id);
      if (!already) {
        const { error } = await db.from("team_members").insert({ team_id: teamId, participant_id: id });
        if (error) throw error;
      }
    }
  }

  const after = await dayTeams(ctx.trip.id, day);
  const placed = new Set(after.flatMap((t) => t.memberIds));
  const unplaced = ctx.people.filter((p) => !placed.has(p.id));
  const unresolved = resolved.groups.flatMap((g) => g.unresolved);
  const areas = after.map((t) => t.area).filter((a): a is string => Boolean(a));
  const ask =
    unplaced.length > 0 || unresolved.length > 0
      ? splitAskLine({
          unplaced: unplaced.map((p) => (p.id === ctx.sender.id ? "you" : p.display_name)),
          unresolved,
          areas,
        })
      : null;
  console.info("[japlan.split] recorded", {
    tripId: ctx.trip.id,
    day,
    teams: after.map((t) => ({ area: t.area, members: t.memberIds.length, startsAt: t.startsAt, rejoinAt: t.rejoinAt })),
    unplaced: unplaced.length,
    unresolved,
  });

  // The rest of that day, re-planned per group. Claimed tasks stand.
  const replanned = after.length > 0 ? await replanDay(ctx.trip, date, ctx.now) : false;
  return splitNotedLine({
    groups: after
      .filter((t) => t.memberIds.length > 0 || t.area)
      .map((t) => ({
        names: listNames(t.memberIds.map(nameOf)) || "nobody yet",
        area: t.area,
        from: t.startsAt !== null && t.startsAt > nowMinutes ? t.startsAt : null,
      })),
    rejoinAt: after.find((t) => t.rejoinAt !== null)?.rejoinAt ?? null,
    rejoinPlace: after.find((t) => t.rejoinPlace)?.rejoinPlace ?? null,
    dayLabel: isToday ? null : `day ${day}`,
    replanned,
    ask,
  });
}

export async function recordRegroup(ctx: Ctx): Promise<string> {
  const date = today(ctx);
  const day = tripDayOn(ctx.trip, date, ctx.now);
  const teams = await dayTeams(ctx.trip.id, day);
  if (teams.length === 0) return regroupLine(false);
  const { error } = await getServiceClient()
    .from("teams")
    .update({ dissolved_at: ctx.now.toISOString() })
    .in("id", teams.map((t) => t.id));
  if (error) throw error;
  const replanned = await replanDay(ctx.trip, date, ctx.now);
  return regroupLine(replanned);
}

async function tripPlaces(tripId: string): Promise<PlaceRow[]> {
  const { data, error } = await getServiceClient()
    .from("places")
    .select("id, trip_id, name, lat, lng, category, source, suggested_by")
    .eq("trip_id", tripId);
  if (error) throw error;
  return (data ?? []) as PlaceRow[];
}

// Resolve against the places layer we have: the trip's own places (cached
// Foursquare, chat mentions, earlier suggestions), then the destination
// profile, then the neighborhood they named. No live Foursquare call: this
// runs off a message, and the places layer is batch-only.
function locate(
  name: string,
  neighborhood: string | null,
  places: PlaceRow[],
  profile: DestinationProfile | null,
): { coords: LatLng | null; category: string | null; name: string } {
  const want = norm(name);
  const known = places.find((p) => norm(p.name) === want && p.lat !== null && p.lng !== null);
  if (known) return { coords: { lat: known.lat!, lng: known.lng! }, category: known.category, name: known.name };
  const onMap = profile ? resolvePlace(name, profile) : null;
  if (onMap?.coords) return { coords: onMap.coords, category: onMap.category, name: onMap.name };
  const area = profile && neighborhood ? resolvePlace(neighborhood, profile) : null;
  return { coords: area?.coords ?? null, category: null, name };
}

async function dayPoints(ctx: Ctx, profile: DestinationProfile | null): Promise<DayPoints[]> {
  if (!ctx.trip.start_date || !ctx.trip.end_date) return [];
  const from = today(ctx) > ctx.trip.start_date ? today(ctx) : ctx.trip.start_date;
  const out: DayPoints[] = [];
  const places = await tripPlaces(ctx.trip.id);
  for (let date = from; date <= ctx.trip.end_date; date = addDaysIso(date, 1)) {
    const day = tripDayForDate(ctx.trip.start_date, date);
    const tasks = await tasksForDay(ctx.trip.id, day);
    const hoods = tasks.map((t) => t.neighborhood).filter((n): n is string => Boolean(n));
    const points: LatLng[] = [];
    for (const hood of hoods) {
      const c = profile ? resolvePlace(hood, profile)?.coords : null;
      if (c) points.push(c);
    }
    const { data, error } = await getServiceClient()
      .from("itinerary")
      .select("place_id")
      .eq("trip_id", ctx.trip.id)
      .eq("day", day);
    if (error) throw error;
    for (const row of (data ?? []) as { place_id: string }[]) {
      const p = places.find((pl) => pl.id === row.place_id);
      if (p && p.lat !== null && p.lng !== null) points.push({ lat: p.lat, lng: p.lng });
    }
    const counts = new Map<string, number>();
    for (const h of hoods) counts.set(h, (counts.get(h) ?? 0) + 1);
    const area = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({ day, points, area });
  }
  return out;
}

async function anchorOnDay(tripId: string, day: number, placeId: string): Promise<void> {
  const { data, error } = await getServiceClient()
    .from("itinerary")
    .select("id, place_id")
    .eq("trip_id", tripId)
    .eq("day", day);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; place_id: string }[];
  if (rows.some((r) => r.place_id === placeId)) return;
  const insert = await getServiceClient()
    .from("itinerary")
    .insert({ trip_id: tripId, day, anchor_order: rows.length + 1, place_id: placeId });
  if (insert.error) throw insert.error;
}

async function saveSuggestion(opts: {
  tripId: string;
  by: string;
  name: string;
  note: string | null;
  located: { coords: LatLng | null; category: string | null; name: string };
}): Promise<{ id: string; duplicate: boolean }> {
  const places = await tripPlaces(opts.tripId);
  const same = places.find((p) => p.source === "suggestion" && norm(p.name) === norm(opts.located.name));
  if (same) return { id: same.id, duplicate: true };
  const { data, error } = await getServiceClient()
    .from("places")
    .insert({
      trip_id: opts.tripId,
      name: opts.located.name,
      lat: opts.located.coords?.lat ?? null,
      lng: opts.located.coords?.lng ?? null,
      category: opts.located.category,
      source: "suggestion",
      suggested_by: opts.by,
      note: opts.note,
    })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return { id: (data as { id: string }).id, duplicate: false };
}

// "we should go to teamLab", "there's a jazz bar in golden gai i want to hit".
export async function addSuggestion(
  ctx: Ctx,
  args: { place: string; neighborhood?: string | null; day?: string | null },
): Promise<string> {
  const profile = profileOf(ctx.trip);
  const located = locate(args.place, args.neighborhood ?? null, await tripPlaces(ctx.trip.id), profile);
  const saved = await saveSuggestion({
    tripId: ctx.trip.id,
    by: ctx.sender.id,
    name: args.place.trim(),
    note: ctx.text,
    located,
  });
  const days = await dayPoints(ctx, profile);
  const askedDay = args.day?.trim()
    ? tripDayOn(ctx.trip, dateFor(ctx, args.day), ctx.now)
    : null;
  const fit = fitSuggestion({ coords: located.coords, days, askedDay });
  // What someone asks for says what they are into.
  await learnFrom(ctx.trip, ctx.sender.id, {
    dims: prefDimsFor(`${located.name} ${located.category ?? ""} ${ctx.text}`),
    direction: 1,
    why: "suggested a place",
  }).catch((err) => console.error("[japlan.profile] learn failed", err));
  if (fit.kind === "near" || fit.kind === "open_day" || fit.kind === "asked_day") {
    await anchorOnDay(ctx.trip.id, fit.day, saved.id);
  }
  console.info("[japlan.suggest] added", {
    tripId: ctx.trip.id,
    place: located.name,
    located: Boolean(located.coords),
    fit: fit.kind,
    duplicate: saved.duplicate,
  });
  return suggestionLine({ name: located.name, fit, duplicate: saved.duplicate });
}

// "we don't want to do temples": that category's weight drops for the trip,
// the same factor a thumbs-down rating applies.
export const AVOID_WEIGHT = 0.3;

export async function avoidCategory(ctx: Ctx, phrase: string): Promise<string> {
  const key = categoryKeyFor(phrase);
  if (!key) return avoidNotedLine(phrase, false);
  const weights = { ...(ctx.trip.category_weights ?? {}), [key]: AVOID_WEIGHT };
  const { error } = await getServiceClient()
    .from("trips")
    .update({ category_weights: weights })
    .eq("id", ctx.trip.id);
  if (error) throw error;
  console.info("[japlan.suggest] avoid", { tripId: ctx.trip.id, category: key });
  await learnFrom(ctx.trip, ctx.sender.id, { dims: prefDimsFor(phrase), direction: -1, why: "asked to avoid" }).catch(
    (err) => console.error("[japlan.profile] learn failed", err),
  );
  return avoidNotedLine(key, true);
}

// Survey "attractions" and "paid attractions": the person's own list, into
// the same pool as conversational suggestions, credited to them. No reply,
// no day yet: boards prefer them and they anchor when someone places them.
export async function importSurveySuggestions(trip: TripRow, participant: ParticipantRow, answers: SurveyAnswers): Promise<number> {
  const names = [
    ...splitPlaceList(answerValue(answers, "attractions")),
    ...splitPlaceList(answerValue(answers, "paid_attractions")),
  ];
  const profile = profileOf(trip);
  const places = await tripPlaces(trip.id);
  let added = 0;
  for (const name of names.slice(0, 6)) {
    const saved = await saveSuggestion({
      tripId: trip.id,
      by: participant.id,
      name,
      note: "from the survey",
      located: locate(name, null, places, profile),
    });
    if (!saved.duplicate) added += 1;
  }
  if (added > 0) console.info("[japlan.suggest] from survey", { tripId: trip.id, added });
  return added;
}

export { listNames };

// ---- settings, task counts, redo ------------------------------------------

async function saveAnswers(participantId: string, answers: SurveyAnswers): Promise<void> {
  const { error } = await getServiceClient()
    .from("participants")
    .update({ survey_json: answers })
    .eq("id", participantId);
  if (error) throw error;
}

async function boardReadyToday(ctx: Ctx): Promise<boolean> {
  if (!ctx.trip.start_date) return false;
  const date = today(ctx);
  if (date < ctx.trip.start_date || (ctx.trip.end_date && date > ctx.trip.end_date)) return false;
  const board = await getBoard(ctx.trip.id, tripDayOn(ctx.trip, date, ctx.now));
  return board?.status === "ready";
}

function organizerOnly(ctx: Ctx): string | null {
  // REAL: one person owns the trip's shape.
  if (!ctx.trip.organizer_participant_id || ctx.trip.organizer_participant_id === ctx.sender.id) return null;
  const organizer = ctx.people.find((p) => p.id === ctx.trip.organizer_participant_id);
  return onlyOrganizerLine(organizer?.display_name ?? "the organizer", "change the setup");
}

// "japlan my pace is too slow", "change my budget to 150", "actually i do
// like museums", "i'm fine talking to strangers now", "i want more tasks".
// Private answers (budget, diet, sociability...) are confirmed in their DM.
export async function updateMySetting(
  ctx: Ctx & { isDm: boolean },
  args: { setting: string; value: string; mode?: "set" | "add" | "remove" },
): Promise<{ reply: string; dm: string | null }> {
  const answers = (ctx.sender.survey_json ?? {}) as SurveyAnswers;
  // "i'm not that into food", "more museums", "actually i do like museums":
  // a lean, stored as a weight (high confidence, stated outright). The
  // profile is rewritten from it.
  if (settingIdFor(args.setting) === "interest_picks" || settingIdFor(args.setting) === null) {
    const dims = prefDimsFor(`${args.value} ${settingIdFor(args.setting) === null ? args.setting : ""}`);
    if (dims.length > 0) {
      const less = args.mode === "remove" || /\b(not|less|no more|hate|over it|fewer|don'?t|stop)\b/i.test(args.value);
      await statePreference(ctx.trip, ctx.sender.id, dims, less ? 0.2 : 0.85);
      console.info("[japlan.settings] preference stated", { participantId: ctx.sender.id, dims, less });
      const line = preferenceNotedLine(args.value.replace(/^(more|less|not|no more)\s+/i, ""), !less, await boardReadyToday(ctx));
      return { reply: line, dm: null };
    }
  }
  const update = applySettingUpdate({ answers, setting: args.setting, value: args.value, mode: args.mode });
  if (!update.ok) {
    if (!update.id) return { reply: SETTING_UNKNOWN_LINE, dm: null };
    const label = SETTING_LABELS[update.id] ?? update.id.replace(/_/g, " ");
    return { reply: settingUnclearLine(label, update.options), dm: null };
  }
  await saveAnswers(ctx.sender.id, update.answers);
  console.info("[japlan.settings] changed", { participantId: ctx.sender.id, setting: update.id });
  const label = SETTING_LABELS[update.id] ?? update.id.replace(/_/g, " ");
  const line = settingChangedLine(label, update.shown, await boardReadyToday(ctx));
  if (!ctx.isDm && PRIVATE_SURVEY_IDS.includes(update.id)) {
    return { reply: SETTING_IN_DM_LINE, dm: line };
  }
  return { reply: line, dm: null };
}

// The organizer changing trip-level settings the same way.
export async function updateTripSetting(ctx: Ctx, args: { setting: string; value: string }): Promise<string> {
  const setting = tripSettingFor(args.setting);
  if (!setting) return SETTING_UNKNOWN_LINE;
  const refusal = organizerOnly(ctx);
  if (refusal) return refusal;
  const result = await applyTripSetting(ctx.trip, setting, args.value, { now: ctx.now });
  if (!result.ok) return result.line;
  const reshapes = setting !== "stake" && (await boardReadyToday(ctx));
  return reshapes ? `${result.line} want me to redo today's board for everyone?` : result.line;
}

// "I want 7 attractions": that many, or what genuinely fits, with the reason.
export async function requestTasks(
  ctx: Ctx,
  args: { count?: number | null; day?: string | null },
): Promise<string> {
  const date = dateFor(ctx, args.day);
  const day = tripDayOn(ctx.trip, date, ctx.now);
  // Make the day's board first if nobody has yet, the normal way.
  if ((await getBoard(ctx.trip.id, day))?.status !== "ready") {
    const lock = await lockNewBoard(ctx.trip.id, day, date, {
      provisional: date > today(ctx),
      requestedBy: ctx.sender.id,
    });
    if (lock) {
      await buildBoardForDate(ctx.trip, { date, now: ctx.now });
      await updateBoard(lock.id, { status: "ready", provisional: date > today(ctx) });
    }
  }
  const current = (await tasksForDay(ctx.trip.id, day)).filter((t) => t.participant_id === ctx.sender.id).length;
  const want = Math.max(1, Math.min(MAX_TASKS_PER_DAY, args.count ?? current + DEFAULT_MORE_STEP));
  const result = await extendPersonalBoard({ trip: ctx.trip, claimant: ctx.sender, want, date, now: ctx.now });
  console.info("[japlan.settings] tasks requested", {
    participantId: ctx.sender.id,
    day,
    want,
    got: result.board.length,
    added: result.added.length,
  });
  const board = formatPersonalBoard({
    day,
    tasks: result.board.map((t) => ({
      code: t.code,
      title: t.title,
      base_points: t.base_points,
      slot: t.slot ?? null,
      neighborhood: t.neighborhood,
    })),
    anchors: await dayAnchorsForBoard(ctx.trip, day),
  });
  return tasksRequestedLine({ want, got: result.board.length, minutesLeft: result.minutesLeft, board });
}

// "yes, redo it": their own board, from their answers as they are now. The
// organizer can redo everyone's after a trip-level change.
export async function redoToday(ctx: Ctx, args: { everyone?: boolean }): Promise<string> {
  if (args.everyone) {
    const refusal = organizerOnly(ctx);
    if (refusal) return refusal;
    const fresh = await getTripById(ctx.trip.id);
    const done = await replanDay(fresh ?? ctx.trip, today(ctx), ctx.now);
    return done ? EVERYONE_REDONE_LINE : BOARD_MAKE_FAILED_LINE;
  }
  const { data } = await getServiceClient().from("participants").select("*").eq("id", ctx.sender.id).maybeSingle();
  const me = (data as ParticipantRow | null) ?? ctx.sender;
  const { rows, day } = await redoMyDay({ trip: ctx.trip, claimant: me, now: ctx.now });
  if (rows.length === 0) return BOARD_MAKE_FAILED_LINE;
  const board = formatPersonalBoard({
    day,
    tasks: (await tasksForDay(ctx.trip.id, day))
      .filter((t) => t.participant_id === ctx.sender.id)
      .map((t) => ({ code: t.code, title: t.title, base_points: t.base_points, slot: t.slot ?? null, neighborhood: t.neighborhood })),
    anchors: await dayAnchorsForBoard(ctx.trip, day),
  });
  return boardRedoneLine(board);
}
