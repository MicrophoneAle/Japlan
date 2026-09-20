import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, SidequestOfferRow, SidequestRow, TaskRow, TripRow } from "@/lib/db/types";
import {
  busyNow,
  canReceiveSidequests,
  dueTrigger,
  fuseMinutes,
  hashSeed,
  personDay,
  pickSidequest,
  sidequestBonusMax,
  sidequestPoints,
  templateAllowedFor,
  SIDEQUEST_DONE_RE,
  SIDEQUEST_PASS_RE,
  SIDEQUESTS_PER_DAY,
  type SidequestTrigger,
} from "@/lib/game/sidequests";
import { paceFor, parseClockMinutes, usableWindow } from "@/lib/game/day-plan";
import { parseBlackouts } from "@/lib/game/preferences";
import { sidequestTemplates } from "@/lib/game/templates";
import {
  SIDEQUEST_BEATEN_LINE,
  SIDEQUEST_CAPPED_LINE,
  SIDEQUEST_EXPIRED_LINE,
  SIDEQUEST_PASSED_LINE,
  SIDEQUESTS_OFF_LINE,
  SIDEQUESTS_ON_CIVILIZED_LINE,
  SIDEQUESTS_ON_LINE,
  sidequestOfferLine,
  sidequestWinnerGroupLine,
  sidequestWonLine,
} from "@/lib/game/copy";
import { applyDailyPointsCap, DEFAULT_DAILY_POINTS_CAP } from "@/lib/game/scoring";
import { answerValue, isSidequestQuestion, type SurveyAnswers } from "@/lib/game/survey";
import { localDateString, localTimeHHMM } from "@/lib/game/time";
import { react, sendDM, sendText } from "@/lib/linq/send";
import { bumpStats } from "@/lib/handlers/stats";

type TeamMembership = { team_id: string; participant_id: string };
type SidequestTask = Pick<
  TaskRow,
  "id" | "participant_id" | "team_id" | "code" | "tier" | "day" | "duration_minutes"
>;
type SidequestClaim = { task_id: string; participant_id: string; status: string };

const PARTICIPANT_COLUMNS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

function answersOf(person: ParticipantRow): SurveyAnswers {
  return (person.survey_json ?? {}) as SurveyAnswers;
}

function surveyIsDone(person: ParticipantRow): boolean {
  return person.survey_state === "done" || isSidequestQuestion(person.survey_state);
}

function tripDayAt(trip: Pick<TripRow, "start_date" | "timezone">, now: Date): number {
  if (!trip.start_date) return 1;
  const today = localDateString(now, trip.timezone || "UTC");
  const start = Date.parse(`${trip.start_date}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return 1;
  return Math.max(1, Math.floor((current - start) / 86_400_000) + 1);
}

function fuseFor(sidequestId: string, participantId: string): number {
  const span = 60 - 30 + 1;
  return fuseMinutes(30 + (hashSeed(`${sidequestId}:${participantId}`) % span));
}

function isConflict(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}

async function tripById(tripId: string): Promise<TripRow | null> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select("id, linq_chat_id, name, destination, start_date, end_date, play_mode, state, timezone, daily_points_cap, board_time, is_solo")
    .eq("id", tripId)
    .maybeSingle();
  if (error) throw error;
  return (data as TripRow | null) ?? null;
}

async function listParticipants(tripId: string): Promise<ParticipantRow[]> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(PARTICIPANT_COLUMNS)
    .eq("trip_id", tripId);
  if (error) throw error;
  return (data ?? []) as ParticipantRow[];
}

async function currentlyOpenOffers(participantIds: string[]): Promise<Set<string>> {
  if (participantIds.length === 0) return new Set();
  const { data, error } = await getServiceClient()
    .from("sidequest_offers")
    .select("participant_id")
    .in("participant_id", participantIds)
    .in("status", ["live", "queued"]);
  if (error) throw error;
  return new Set(((data ?? []) as { participant_id: string }[]).map((row) => row.participant_id));
}

async function currentOpenSidequest(tripId: string): Promise<SidequestRow | null> {
  const { data, error } = await getServiceClient()
    .from("sidequests")
    .select("id, trip_id, day, local_date, template_id, title, points, photo_bonus_max, trigger, status, won_by, won_at, created_at")
    .eq("trip_id", tripId)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SidequestRow | null) ?? null;
}

function paceValue(answers: SurveyAnswers): string | null {
  const legacy = answerValue(answers, "pace");
  if (legacy) return legacy;
  const current = answerValue(answers, "ab_pace");
  return current === "a" ? "early_and_moving" : current === "b" ? "two_things_and_lunch" : null;
}

// Sidequests wait only while a main task is scheduled to be in progress. The
// stored task duration and survey pace make that window an estimate: Japlan
// has no signal that a person physically started walking or an activity.
async function busyParticipantIds(
  trip: TripRow,
  day: number,
  people: ParticipantRow[],
  now: Date,
): Promise<Set<string>> {
  const db = getServiceClient();
  const tasksResult = await db
    .from("tasks")
    .select("id, participant_id, team_id, code, tier, day, duration_minutes")
    .eq("trip_id", trip.id)
    .eq("day", day)
    .order("code");
  if (tasksResult.error) throw tasksResult.error;
  const tasks = (tasksResult.data ?? []) as SidequestTask[];
  if (tasks.length === 0) return new Set();

  const taskIds = tasks.map((task) => task.id);
  const [claimsResult, teamsResult] = await Promise.all([
    db.from("claims").select("task_id, participant_id, status").in("task_id", taskIds),
    db.from("teams").select("id").eq("trip_id", trip.id).is("dissolved_at", null).lte("formed_at", now.toISOString()),
  ]);
  if (claimsResult.error) throw claimsResult.error;
  if (teamsResult.error) throw teamsResult.error;
  const claims = (claimsResult.data ?? []) as SidequestClaim[];
  const teamIds = ((teamsResult.data ?? []) as { id: string }[]).map((team) => team.id);
  let memberships: TeamMembership[] = [];
  if (teamIds.length > 0) {
    const result = await db.from("team_members").select("team_id, participant_id").in("team_id", teamIds);
    if (result.error) throw result.error;
    memberships = (result.data ?? []) as TeamMembership[];
  }
  const teamsByPerson = new Map<string, Set<string>>();
  for (const row of memberships) {
    const set = teamsByPerson.get(row.participant_id) ?? new Set<string>();
    set.add(row.team_id);
    teamsByPerson.set(row.participant_id, set);
  }

  const localMinute = parseClockMinutes(localTimeHHMM(now, trip.timezone || "UTC"));
  const busy = new Set<string>();
  for (const person of people) {
    const personAnswers = answersOf(person);
    const ownTeams = teamsByPerson.get(person.id) ?? new Set<string>();
    const assigned = tasks.filter((task) => {
      if (task.participant_id === person.id) return true;
      if (task.team_id) return ownTeams.has(task.team_id);
      return trip.play_mode === "full_group" && task.participant_id === null;
    });
    if (assigned.length === 0) continue;
    const schedule = assigned.map((task) => {
      const sharedTeam = task.team_id !== null;
      const resolved = claims.some(
        (claim) =>
          claim.task_id === task.id &&
          claim.status === "awarded" &&
          (sharedTeam || task.participant_id === null || claim.participant_id === person.id),
      );
      const tier = task.tier.toLowerCase();
      const fallbackMinutes = tier === "challenging" ? 90 : tier === "medium" ? 60 : 30;
      return {
        id: task.id,
        minutes: task.duration_minutes && task.duration_minutes > 0 ? task.duration_minutes : fallbackMinutes,
        resolved,
      };
    });
    const window = usableWindow({
      boardTime: trip.board_time,
      pace: paceFor([paceValue(personAnswers)]),
      blackouts: parseBlackouts(answerValue(personAnswers, "blackout")),
    });
    if (busyNow(personDay(schedule, window), localMinute)) busy.add(person.id);
  }
  return busy;
}

function eligibleForRuntime(person: ParticipantRow): boolean {
  return canReceiveSidequests({
    id: person.id,
    answers: answersOf(person),
    muted: person.sidequests_muted,
    surveyDone: surveyIsDone(person),
  });
}

async function markOffer(
  offerId: string,
  from: "queued" | "live",
  to: SidequestOfferRow["status"],
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const { data, error } = await getServiceClient()
    .from("sidequest_offers")
    .update({ status: to, ...patch })
    .eq("id", offerId)
    .eq("status", from)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function closeIfNoOffers(sidequestId: string): Promise<void> {
  const { data, error } = await getServiceClient()
    .from("sidequest_offers")
    .select("id")
    .eq("sidequest_id", sidequestId)
    .in("status", ["live", "queued"])
    .limit(1);
  if (error) throw error;
  if ((data ?? []).length > 0) return;
  const { error: closeError } = await getServiceClient()
    .from("sidequests")
    .update({ status: "closed" })
    .eq("id", sidequestId)
    .eq("status", "open");
  if (closeError) throw closeError;
}

async function dropOffer(offer: SidequestOfferRow): Promise<boolean> {
  const from = offer.status === "live" ? "live" : "queued";
  return markOffer(offer.id, from, "dropped", { resolved_at: new Date().toISOString() });
}

async function fireOffer(
  trip: TripRow,
  offer: SidequestOfferRow,
  sidequest: SidequestRow,
  person: ParticipantRow,
  now: Date,
): Promise<boolean> {
  const minutes = fuseFor(sidequest.id, person.id);
  const firedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  try {
    const { data, error } = await getServiceClient()
      .from("sidequest_offers")
      .update({ status: "live", fired_at: firedAt, expires_at: expiresAt, queued_at: null })
      .eq("id", offer.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (isConflict(error)) return false;
    if (error) throw error;
    if (!data) return false;
  } catch (err) {
    if (isConflict(err as { code?: string })) return false;
    throw err;
  }

  try {
    await sendDM(person.phone, sidequestOfferLine(sidequest.title, sidequest.points, minutes));
    console.info("[japlan.sidequest] offer.fired", { tripId: trip.id, sidequestId: sidequest.id, participantId: person.id });
    return true;
  } catch (err) {
    console.error("[japlan.sidequest] offer.send_failed", {
      tripId: trip.id,
      sidequestId: sidequest.id,
      participantId: person.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await markOffer(offer.id, "live", "dropped", { resolved_at: new Date().toISOString() });
    return false;
  }
}

export type SidequestTickResult = {
  expired: number;
  dropped: number;
  fired: number;
  closed: number;
};

// Cron and successful main-task claims call this: expire old offers, quietly
// discard yesterday's queue, and fire queued DMs once a person is out of an
// estimated main-task window. Expiry and silence never send a follow-up.
export async function tickSidequests(tripId: string, now = new Date()): Promise<SidequestTickResult> {
  const result: SidequestTickResult = { expired: 0, dropped: 0, fired: 0, closed: 0 };
  const trip = await tripById(tripId);
  if (!trip || trip.state !== "active") return result;
  const date = localDateString(now, trip.timezone || "UTC");
  const day = tripDayAt(trip, now);
  const db = getServiceClient();
  const { data: openRows, error } = await db
    .from("sidequests")
    .select("id, trip_id, day, local_date, template_id, title, points, photo_bonus_max, trigger, status, won_by, won_at, created_at")
    .eq("trip_id", tripId)
    .eq("status", "open");
  if (error) throw error;
  const open = (openRows ?? []) as SidequestRow[];
  const people = await listParticipants(tripId);
  const personById = new Map(people.map((person) => [person.id, person]));
  const busy = await busyParticipantIds(trip, day, people, now);

  for (const sidequest of open) {
    const { data: offersData, error: offersError } = await db
      .from("sidequest_offers")
      .select("id, sidequest_id, trip_id, participant_id, status, queued_at, fired_at, expires_at, resolved_at, awarded_points, photo_bonus, created_at")
      .eq("sidequest_id", sidequest.id)
      .in("status", ["live", "queued"]);
    if (offersError) throw offersError;
    const offers = (offersData ?? []) as SidequestOfferRow[];

    if (sidequest.local_date !== date) {
      for (const offer of offers) {
        if (await dropOffer(offer)) result.dropped++;
      }
      await closeIfNoOffers(sidequest.id);
      result.closed++;
      continue;
    }

    for (const offer of offers) {
      const person = personById.get(offer.participant_id);
      if (!person || !eligibleForRuntime(person)) {
        if (await dropOffer(offer)) result.dropped++;
        continue;
      }
      if (offer.status === "live" && offer.expires_at && Date.parse(offer.expires_at) <= now.getTime()) {
        if (await markOffer(offer.id, "live", "expired", { resolved_at: now.toISOString() })) result.expired++;
      }
    }

    // Reload after expiry/drops so only current queued recipients can fire.
    const queuedResult = await db
      .from("sidequest_offers")
      .select("id, sidequest_id, trip_id, participant_id, status, queued_at, fired_at, expires_at, resolved_at, awarded_points, photo_bonus, created_at")
      .eq("sidequest_id", sidequest.id)
      .eq("status", "queued");
    if (queuedResult.error) throw queuedResult.error;
    for (const offer of (queuedResult.data ?? []) as SidequestOfferRow[]) {
      const person = personById.get(offer.participant_id);
      if (!person || !eligibleForRuntime(person)) {
        if (await dropOffer(offer)) result.dropped++;
        continue;
      }
      if (!busy.has(person.id) && (await fireOffer(trip, offer, sidequest, person, now))) result.fired++;
    }

    const priorStatus = sidequest.status;
    await closeIfNoOffers(sidequest.id);
    if (priorStatus === "open") {
      const { data: stillOpen, error: checkError } = await db
        .from("sidequests")
        .select("id")
        .eq("id", sidequest.id)
        .eq("status", "open")
        .maybeSingle();
      if (checkError) throw checkError;
      if (!stillOpen) result.closed++;
    }
  }
  return result;
}

export type OfferSidequestResult = {
  created: boolean;
  sidequestId?: string;
  reason?: "inactive_trip" | "already_open" | "daily_limit" | "no_eligible_people" | "no_safe_template";
  fired: number;
  queued: number;
};

async function trailingParticipantIds(tripId: string, people: ParticipantRow[]): Promise<string[]> {
  const { data: teamRows, error } = await getServiceClient()
    .from("teams")
    .select("id")
    .eq("trip_id", tripId)
    .is("dissolved_at", null);
  if (error) throw error;
  const teamIds = ((teamRows ?? []) as { id: string }[]).map((team) => team.id);
  if (teamIds.length > 0) {
    const { data, error: membersError } = await getServiceClient()
      .from("team_members")
      .select("team_id, participant_id")
      .in("team_id", teamIds);
    if (membersError) throw membersError;
    const membership = (data ?? []) as TeamMembership[];
    const byTeam = new Map<string, number[]>();
    for (const row of membership) {
      const person = people.find((candidate) => candidate.id === row.participant_id);
      if (!person) continue;
      const scores = byTeam.get(row.team_id) ?? [];
      scores.push(person.score);
      byTeam.set(row.team_id, scores);
    }
    const averages = [...byTeam.entries()].map(([teamId, scores]) => ({
      teamId,
      score: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    }));
    if (averages.length > 0) {
      const min = Math.min(...averages.map((row) => row.score));
      const trailingTeams = new Set(averages.filter((row) => row.score === min).map((row) => row.teamId));
      return membership.filter((row) => trailingTeams.has(row.team_id)).map((row) => row.participant_id);
    }
  }
  if (people.length === 0) return [];
  const min = Math.min(...people.map((person) => person.score));
  return people.filter((person) => person.score === min).map((person) => person.id);
}

// Call from an actual trigger source (cron, a completed challenging claim,
// etc.). Triggers with no recipient override offer the same race to every
// eligible person; the score-gap trigger is restricted to the trailing team.
export async function offerTriggeredSidequest(opts: {
  tripId: string;
  trigger: SidequestTrigger;
  recipientIds?: string[];
  now?: Date;
}): Promise<OfferSidequestResult> {
  const now = opts.now ?? new Date();
  const trip = await tripById(opts.tripId);
  if (!trip || trip.state !== "active") return { created: false, reason: "inactive_trip", fired: 0, queued: 0 };
  const today = localDateString(now, trip.timezone || "UTC");
  if (
    (trip.start_date && today < trip.start_date) ||
    (trip.end_date && today > trip.end_date)
  ) {
    return { created: false, reason: "inactive_trip", fired: 0, queued: 0 };
  }
  await tickSidequests(trip.id, now);
  if (await currentOpenSidequest(trip.id)) return { created: false, reason: "already_open", fired: 0, queued: 0 };

  const date = today;
  const day = tripDayAt(trip, now);
  const { data: todaysRows, error: dayError } = await getServiceClient()
    .from("sidequests")
    .select("template_id")
    .eq("trip_id", trip.id)
    .eq("local_date", date);
  if (dayError) throw dayError;
  const todays = (todaysRows ?? []) as { template_id: string }[];
  if (todays.length >= SIDEQUESTS_PER_DAY) return { created: false, reason: "daily_limit", fired: 0, queued: 0 };

  const everyone = await listParticipants(trip.id);
  const active = everyone.filter(eligibleForRuntime);
  const allowedIds = opts.recipientIds
    ? new Set(opts.recipientIds)
    : opts.trigger === "gap"
      ? new Set(await trailingParticipantIds(trip.id, active))
      : null;
  const candidates = active.filter((person) => !allowedIds || allowedIds.has(person.id));
  if (candidates.length === 0) {
    return { created: false, reason: "no_eligible_people", fired: 0, queued: 0 };
  }

  const hasOffer = await currentlyOpenOffers(candidates.map((person) => person.id));
  const recipients = candidates.filter((person) => !hasOffer.has(person.id));
  if (recipients.length === 0) {
    return { created: false, reason: "no_eligible_people", fired: 0, queued: 0 };
  }
  const seed = hashSeed(`${trip.id}:${date}:${opts.trigger}:${todays.length}`);
  const picked = pickSidequest({
    templates: sidequestTemplates(),
    recipients: recipients.map((person) => ({ id: person.id, answers: answersOf(person) })),
    usedToday: todays.map((row) => row.template_id),
    seed,
  });
  if (!picked || picked.eligible.length === 0) {
    return { created: false, reason: "no_safe_template", fired: 0, queued: 0 };
  }
  const template = picked.template;
  // A final code-side check before persistence; this guards future template
  // selection changes from bypassing red-line, age, or survey checks.
  const eligibleIds = new Set(
    recipients
      .filter((person) => picked.eligible.includes(person.id) && templateAllowedFor(template, answersOf(person)))
      .map((person) => person.id),
  );
  const finalRecipients = recipients.filter((person) => eligibleIds.has(person.id));
  if (finalRecipients.length === 0) {
    return { created: false, reason: "no_safe_template", fired: 0, queued: 0 };
  }

  const points = sidequestPoints(template);
  const { data: inserted, error: insertError } = await getServiceClient()
    .from("sidequests")
    .insert({
      trip_id: trip.id,
      day,
      local_date: date,
      template_id: template.id,
      title: template.archetype,
      points,
      photo_bonus_max: sidequestBonusMax(template, points),
      trigger: opts.trigger,
      status: "open",
    })
    .select("id, trip_id, day, local_date, template_id, title, points, photo_bonus_max, trigger, status, won_by, won_at, created_at")
    .single();
  if (isConflict(insertError)) {
    return { created: false, reason: "already_open", fired: 0, queued: 0 };
  }
  if (insertError) throw insertError;
  const sidequest = inserted as SidequestRow;
  const busy = await busyParticipantIds(trip, day, everyone, now);
  let fired = 0;
  let queued = 0;

  for (const person of finalRecipients) {
    const isBusy = busy.has(person.id);
    const { data, error } = await getServiceClient()
      .from("sidequest_offers")
      .insert({
        sidequest_id: sidequest.id,
        trip_id: trip.id,
        participant_id: person.id,
        status: "queued",
        queued_at: now.toISOString(),
        fired_at: null,
        expires_at: null,
      })
      .select("id, sidequest_id, trip_id, participant_id, status, queued_at, fired_at, expires_at, resolved_at, awarded_points, photo_bonus, created_at")
      .maybeSingle();
    if (isConflict(error)) continue;
    if (error) throw error;
    const offer = data as SidequestOfferRow | null;
    if (!offer) continue;
    if (isBusy) {
      queued++;
    } else if (await fireOffer(trip, offer, sidequest, person, now)) {
      fired++;
    }
  }
  // Re-read persisted states because another cron tick may have fired an
  // offer after the insert. This also avoids closing a sidequest while a
  // queued/live row survived a transient unique-index race.
  const activeOffers = await getServiceClient()
    .from("sidequest_offers")
    .select("status")
    .eq("sidequest_id", sidequest.id)
    .in("status", ["live", "queued"]);
  if (activeOffers.error) throw activeOffers.error;
  const states = (activeOffers.data ?? []) as { status: string }[];
  fired = states.filter((row) => row.status === "live").length;
  queued = states.filter((row) => row.status === "queued").length;
  if (fired + queued === 0) {
    await getServiceClient().from("sidequests").update({ status: "closed" }).eq("id", sidequest.id).eq("status", "open");
    return { created: false, reason: "no_eligible_people", fired: 0, queued: 0 };
  }
  console.info("[japlan.sidequest] created", {
    tripId: trip.id,
    sidequestId: sidequest.id,
    trigger: opts.trigger,
    templateId: template.id,
    fired,
    queued,
  });
  return { created: true, sidequestId: sidequest.id, fired, queued };
}

async function pointsAwardedToday(trip: TripRow, participantId: string, day: number, date: string): Promise<number> {
  const db = getServiceClient();
  const tasks = await db.from("tasks").select("id").eq("trip_id", trip.id).eq("day", day);
  if (tasks.error) throw tasks.error;
  const taskIds = ((tasks.data ?? []) as { id: string }[]).map((row) => row.id);
  let mainPoints = 0;
  if (taskIds.length > 0) {
    const claims = await db
      .from("claims")
      .select("awarded_points")
      .eq("participant_id", participantId)
      .eq("status", "awarded")
      .in("task_id", taskIds);
    if (claims.error) throw claims.error;
    mainPoints = ((claims.data ?? []) as { awarded_points: number | null }[])
      .reduce((sum, row) => sum + (row.awarded_points ?? 0), 0);
  }
  const sidequests = await db.from("sidequests").select("id").eq("trip_id", trip.id).eq("local_date", date);
  if (sidequests.error) throw sidequests.error;
  const sidequestIds = ((sidequests.data ?? []) as { id: string }[]).map((row) => row.id);
  let sidequestPointsToday = 0;
  if (sidequestIds.length > 0) {
    const offers = await db
      .from("sidequest_offers")
      .select("awarded_points")
      .eq("trip_id", trip.id)
      .eq("participant_id", participantId)
      .eq("status", "won")
      .in("sidequest_id", sidequestIds);
    if (offers.error) throw offers.error;
    sidequestPointsToday = ((offers.data ?? []) as { awarded_points: number | null }[])
      .reduce((sum, row) => sum + (row.awarded_points ?? 0), 0);
  }
  return mainPoints + sidequestPointsToday;
}

async function awardSidequest(opts: {
  trip: TripRow;
  offer: SidequestOfferRow;
  sidequest: SidequestRow;
  person: ParticipantRow;
  now: Date;
  replyChatId?: string;
}): Promise<"won" | "beaten" | "already_won"> {
  const db = getServiceClient();
  const pointsToday = await pointsAwardedToday(
    opts.trip,
    opts.person.id,
    opts.sidequest.day,
    opts.sidequest.local_date,
  );
  const capped = applyDailyPointsCap({
    pointsToday,
    incoming: opts.sidequest.points,
    cap: opts.trip.daily_points_cap ?? DEFAULT_DAILY_POINTS_CAP,
  });
  const { data: wonRow, error } = await db
    .from("sidequests")
    .update({ status: "won", won_by: opts.person.id, won_at: opts.now.toISOString() })
    .eq("id", opts.sidequest.id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!wonRow) {
    const current = await db
      .from("sidequests")
      .select("status, won_by")
      .eq("id", opts.sidequest.id)
      .maybeSingle();
    if (current.error) throw current.error;
    if (current.data?.status !== "won" || current.data?.won_by !== opts.person.id) return "beaten";
  }

  // The conditional open -> won update elects one winner. The offer row is the
  // idempotency marker before updating the score, so a webhook retry cannot
  // award the same sidequest twice.
  const { data: wonOffer, error: offerError } = await db
    .from("sidequest_offers")
    .update({
      status: "won",
      resolved_at: opts.now.toISOString(),
      awarded_points: capped.awarded_points,
      photo_bonus: 0,
    })
    .eq("id", opts.offer.id)
    .eq("status", "live")
    .select("id")
    .maybeSingle();
  if (offerError) throw offerError;
  if (!wonOffer) return "already_won";

  const { error: loseError } = await db
    .from("sidequest_offers")
    .update({ status: "lost", resolved_at: opts.now.toISOString() })
    .eq("sidequest_id", opts.sidequest.id)
    .neq("participant_id", opts.person.id)
    .in("status", ["live", "queued"]);
  if (loseError) throw loseError;

  let total = opts.person.score;
  if (capped.awarded_points > 0) {
    const score = await db.rpc("increment_participant_score", {
      p_participant_id: opts.person.id,
      p_delta: capped.awarded_points,
    });
    if (score.error) throw score.error;
    if (typeof score.data === "number") total = score.data;
  }
  await bumpStats(opts.trip.id, opts.person.id, { sidequests_claimed: 1 });

  const dmText = capped.capped
    ? SIDEQUEST_CAPPED_LINE
    : sidequestWonLine(capped.awarded_points, 0, total);
  let dmChatId = opts.replyChatId ?? null;
  let dmSent = false;
  try {
    const dm = opts.replyChatId
      ? await sendText(opts.replyChatId, dmText, { effect: { type: "screen", name: "fireworks" } })
      : await sendDM(opts.person.phone, dmText);
    dmChatId = dm.chatId;
    dmSent = true;
  } catch (sendError) {
    console.error("[japlan.sidequest] winner_dm_failed", {
      sidequestId: opts.sidequest.id,
      participantId: opts.person.id,
      error: sendError instanceof Error ? sendError.message : String(sendError),
    });
  }
  if (dmChatId !== opts.trip.linq_chat_id || !dmSent) {
    try {
      await sendText(
        opts.trip.linq_chat_id,
        sidequestWinnerGroupLine(opts.person.display_name, opts.sidequest.title, capped.awarded_points),
      );
    } catch (sendError) {
      console.error("[japlan.sidequest] winner_group_announcement_failed", {
        sidequestId: opts.sidequest.id,
        participantId: opts.person.id,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
  }
  return "won";
}

export type SidequestMessageResult = { handled: boolean; outcome?: "won" | "lost" | "passed" | "expired" | "already_won" };

// Called before normal DM conversation handling. Only the explicit completion
// and pass phrases are consumed; all other text falls through untouched.
export async function handleSidequestMessage(opts: {
  tripId: string;
  participantId: string;
  text: string;
  chatId?: string;
  messageId?: string | null;
  now?: Date;
}): Promise<SidequestMessageResult> {
  const text = opts.text.trim();
  const done = SIDEQUEST_DONE_RE.test(text);
  const pass = SIDEQUEST_PASS_RE.test(text);
  if (!done && !pass) return { handled: false };

  const db = getServiceClient();
  const { data, error } = await db
    .from("sidequest_offers")
    .select("id, sidequest_id, trip_id, participant_id, status, queued_at, fired_at, expires_at, resolved_at, awarded_points, photo_bonus, created_at")
    .eq("trip_id", opts.tripId)
    .eq("participant_id", opts.participantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const offer = data as SidequestOfferRow | null;
  if (!offer || !["live", "queued", "expired", "lost", "won"].includes(offer.status)) return { handled: false };
  const trip = await tripById(opts.tripId);
  if (!trip) return { handled: false };
  const reply = async (line: string) => {
    if (opts.chatId) return sendText(opts.chatId, line);
    return sendDM(await personPhone(opts.participantId), line);
  };
  const now = opts.now ?? new Date();

  if (offer.status === "queued") {
    if (pass) {
      await markOffer(offer.id, "queued", "declined", { resolved_at: now.toISOString() });
      await reply(SIDEQUEST_PASSED_LINE);
      await tickSidequests(opts.tripId, now);
      return { handled: true, outcome: "passed" };
    }
    return { handled: false };
  }
  if (pass) {
    if (offer.status === "live") {
      await markOffer(offer.id, "live", "declined", { resolved_at: now.toISOString() });
      await tickSidequests(opts.tripId, now);
    }
    await reply(SIDEQUEST_PASSED_LINE);
    return { handled: true, outcome: "passed" };
  }
  if (offer.status === "expired") {
    await reply(SIDEQUEST_EXPIRED_LINE);
    return { handled: true, outcome: "expired" };
  }
  if (offer.status === "lost") {
    await reply(SIDEQUEST_BEATEN_LINE);
    return { handled: true, outcome: "lost" };
  }
  if (offer.status === "won") return { handled: true, outcome: "already_won" };
  if (offer.expires_at && Date.parse(offer.expires_at) <= now.getTime()) {
    await markOffer(offer.id, "live", "expired", { resolved_at: now.toISOString() });
    await reply(SIDEQUEST_EXPIRED_LINE);
    await closeIfNoOffers(offer.sidequest_id);
    return { handled: true, outcome: "expired" };
  }

  const sidequestResult = await db
    .from("sidequests")
    .select("id, trip_id, day, local_date, template_id, title, points, photo_bonus_max, trigger, status, won_by, won_at, created_at")
    .eq("id", offer.sidequest_id)
    .maybeSingle();
  if (sidequestResult.error) throw sidequestResult.error;
  const sidequest = sidequestResult.data as SidequestRow | null;
  if (!sidequest) return { handled: false };
  const person = (await listParticipants(opts.tripId)).find((candidate) => candidate.id === opts.participantId);
  if (!person) return { handled: false };
  if (!eligibleForRuntime(person)) {
    await markOffer(offer.id, "live", "dropped", { resolved_at: now.toISOString() });
    await closeIfNoOffers(offer.sidequest_id);
    await reply(SIDEQUEST_PASSED_LINE);
    return { handled: true, outcome: "passed" };
  }

  const outcome = await awardSidequest({ trip, offer, sidequest, person, now, replyChatId: opts.chatId });
  if (outcome === "beaten") {
    await markOffer(offer.id, "live", "lost", { resolved_at: now.toISOString() });
    await reply(SIDEQUEST_BEATEN_LINE);
    return { handled: true, outcome: "lost" };
  }
  if (outcome === "already_won") return { handled: true, outcome };
  if (opts.messageId) {
    try {
      await react(opts.messageId, { emoji: "🏆" });
    } catch (err) {
      console.error("[japlan.sidequest] completion reaction failed", {
        messageId: opts.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { handled: true, outcome: "won" };
}

async function personPhone(participantId: string): Promise<string> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select("phone")
    .eq("id", participantId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.phone) throw new Error("sidequest participant has no phone");
  return data.phone as string;
}

// Mute is personal. Existing live or queued offers are quietly dropped, and
// unmuting only affects future triggers.
export async function setSidequestsMuted(opts: {
  participantId: string;
  muted: boolean;
}): Promise<string> {
  const db = getServiceClient();
  const { data: participant, error: participantError } = await db
    .from("participants")
    .select("id")
    .eq("id", opts.participantId)
    .maybeSingle();
  if (participantError) throw participantError;
  if (!participant) throw new Error("sidequest participant not found");
  const { error } = await db
    .from("participants")
    .update({ sidequests_muted: opts.muted })
    .eq("id", opts.participantId);
  if (error) throw error;
  if (opts.muted) {
    const { data: offers, error: offersError } = await db
      .from("sidequest_offers")
      .select("id, sidequest_id, trip_id, participant_id, status, queued_at, fired_at, expires_at, resolved_at, awarded_points, photo_bonus, created_at")
      .eq("participant_id", opts.participantId)
      .in("status", ["live", "queued"]);
    if (offersError) throw offersError;
    for (const offer of (offers ?? []) as SidequestOfferRow[]) {
      await dropOffer(offer);
      await closeIfNoOffers(offer.sidequest_id);
    }
  }
  return opts.muted ? SIDEQUESTS_OFF_LINE : SIDEQUESTS_ON_LINE;
}

export async function setSidequestsEnabled(opts: {
  participantId: string;
  enabled: boolean;
}): Promise<string> {
  if (opts.enabled) {
    const { data, error } = await getServiceClient()
      .from("participants")
      .select("survey_json")
      .eq("id", opts.participantId)
      .maybeSingle();
    if (error) throw error;
    const answers = ((data?.survey_json ?? {}) as SurveyAnswers);
    const level = answerValue(answers, "sidequest_level");
    const line = level === "1" ? SIDEQUESTS_ON_CIVILIZED_LINE : SIDEQUESTS_ON_LINE;
    await setSidequestsMuted({ participantId: opts.participantId, muted: false });
    return line;
  }
  return setSidequestsMuted({ participantId: opts.participantId, muted: true });
}

// Convenient event hook for the successful-claim path. Only call after a
// Challenging task was actually awarded; ordinary claims just release queues.
export async function onMainTaskResolved(opts: {
  tripId: string;
  participantId: string;
  challenging: boolean;
  now?: Date;
}): Promise<{ tick: SidequestTickResult; trigger?: OfferSidequestResult }> {
  const now = opts.now ?? new Date();
  const tick = await tickSidequests(opts.tripId, now);
  const trigger = opts.challenging
    ? await offerTriggeredSidequest({ tripId: opts.tripId, trigger: "challenging", now })
    : undefined;
  return { tick, trigger };
}

// Keeps the trigger selector close to the pure rules for callers that want to
// combine several cron signals before creating one offer.
export { dueTrigger };
