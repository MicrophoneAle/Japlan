import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import type { TripCommand } from "@/lib/game/commands";
import {
  END_TRIP_CONFIRM_LINE,
  NEW_TRIP_DM_LINE,
  NO_TRIP_RUNNING_LINE,
  SETUP_IN_DM_LINE,
  TRIP_ALREADY_RUNNING_LINE,
  TRIP_OVER_LINE,
  BOARD_TIME_UNREADABLE_LINE,
  boardTimeSetLine,
  finalStandingsLine,
  notOnTripLine,
  onlyOrganizerLine,
  PROFILE_IN_DM_LINE,
  profileLine,
  profileUnfinishedLine,
  resurveyStartLine,
  SETTINGS_IN_DM_LINE,
  settingsListLine,
  tripNotReadyLine,
} from "@/lib/game/copy";
import { settingsSummary } from "@/lib/game/settings";
import { lookupOwnProfile } from "./profiles";
import type { SurveyAnswers } from "@/lib/game/survey";
import { FIRST_QUESTION_ID, QUESTIONS } from "@/lib/game/survey-questions";
import { losersOf } from "@/lib/game/setup";
import { formatBoardTime } from "@/lib/game/board-schedule";
import { soloModeEnabled } from "@/lib/game/solo";
import { buildStandingsRows } from "@/lib/game/standings";
import { sendDM, sendText, type MessageEffect } from "@/lib/linq/send";
import {
  bootstrapGroupIfNeeded,
  findOpenSurveyByPhone,
  findParticipantOnTrip,
  getLatestTripByChatId,
  getTripByChatId,
  listParticipants,
  persistSurveyProgress,
} from "./bootstrap";
import { beginSetup } from "./setup";
import { bootstrapSoloIfNeeded } from "./solo";
import { teamsWithMembers } from "./teams";

type SendFn = (
  chatId: string,
  text: string,
  opts?: { effect?: MessageEffect },
) => Promise<{ messageId: string }>;

function lifecycleStep(step: string, fields: Record<string, unknown> = {}): void {
  console.log("[japlan.lifecycle] step", { step, ...fields });
}

// No per-trip Wrapped exists yet (app/wrapped is a fictional demo). When it
// does, return its URL here and the final standings will carry the link.
export function wrappedUrlFor(trip: TripRow): string | null {
  void trip;
  return null;
}

// Organizer-only actions. Trips from before the organizer column have no
// organizer; the first participant to run setup or end takes the role.
async function authorize(opts: {
  trip: TripRow;
  participant: ParticipantRow;
  people: ParticipantRow[];
  action: "change the setup" | "end the trip" | "change the board time";
}): Promise<string | null> {
  const organizerId = opts.trip.organizer_participant_id;
  if (!organizerId) {
    const { error } = await getServiceClient()
      .from("trips")
      .update({ organizer_participant_id: opts.participant.id })
      .eq("id", opts.trip.id)
      .is("organizer_participant_id", null);
    if (error) throw error;
    opts.trip.organizer_participant_id = opts.participant.id;
    lifecycleStep("organizer.claimed", { tripId: opts.trip.id });
    return null;
  }
  if (organizerId === opts.participant.id) return null;
  const organizer = opts.people.find((p) => p.id === organizerId);
  return onlyOrganizerLine(organizer?.display_name ?? "the organizer", opts.action);
}

// "japlan board time 7am": organizer-only. time is HH:MM, or null when the
// command was recognised but the time was not.
export async function handleBoardTimeCommand(opts: {
  chatId: string;
  isDm: boolean;
  phone: string | null;
  time: string | null;
  send?: SendFn;
}): Promise<void> {
  const send = opts.send ?? sendText;
  if (!opts.time) {
    await send(opts.chatId, BOARD_TIME_UNREADABLE_LINE);
    return;
  }
  const trip =
    (await getTripByChatId(opts.chatId)) ??
    (opts.isDm && opts.phone ? (await findOpenSurveyByPhone(opts.phone))?.trip ?? null : null);
  if (!trip) {
    await send(opts.chatId, NO_TRIP_RUNNING_LINE);
    return;
  }
  const participant = opts.phone ? await findParticipantOnTrip(trip.id, opts.phone) : null;
  if (!participant) {
    await send(opts.chatId, notOnTripLine());
    return;
  }
  const people = await listParticipants(trip.id);
  const refusal = await authorize({ trip, participant, people, action: "change the board time" });
  if (refusal) {
    await send(opts.chatId, refusal);
    return;
  }
  const { error } = await getServiceClient()
    .from("trips")
    .update({ board_time: opts.time })
    .eq("id", trip.id);
  if (error) throw error;
  lifecycleStep("board_time.set", { tripId: trip.id, boardTime: opts.time });
  await send(opts.chatId, boardTimeSetLine(formatBoardTime(opts.time)));
}

export async function handleTripCommand(opts: {
  command: TripCommand;
  chatId: string;
  isDm: boolean;
  phone: string | null;
  displayName?: string | null;
  send?: SendFn;
}): Promise<void> {
  const send = opts.send ?? sendText;
  lifecycleStep("command", { command: opts.command, chatId: opts.chatId, isDm: opts.isDm });

  if (opts.command === "new_trip") {
    await startNewTrip({ ...opts, send });
    return;
  }

  // In a DM about a group trip the DM chat has no trip of its own; use the
  // sender's open trip (the same one their DMs are routed to).
  const trip =
    (await getTripByChatId(opts.chatId)) ??
    (opts.isDm && opts.phone ? (await findOpenSurveyByPhone(opts.phone))?.trip ?? null : null);
  if (!trip) {
    const latest = await getLatestTripByChatId(opts.chatId);
    await send(
      opts.chatId,
      latest?.state === "complete" ? TRIP_OVER_LINE : NO_TRIP_RUNNING_LINE,
    );
    return;
  }
  const participant = opts.phone ? await findParticipantOnTrip(trip.id, opts.phone) : null;
  if (!participant) {
    await send(opts.chatId, notOnTripLine());
    return;
  }
  const people = await listParticipants(trip.id);

  // Everyone's own answers are theirs to see and change, any time. Private
  // ones, so the list goes to their DM.
  if (opts.command === "settings") {
    const text = settingsListLine(settingsSummary((participant.survey_json ?? {}) as SurveyAnswers));
    if (opts.isDm) {
      await send(opts.chatId, text);
    } else {
      await sendDM(participant.phone, text);
      await send(opts.chatId, SETTINGS_IN_DM_LINE);
    }
    return;
  }
  if (opts.command === "profile") {
    // participant came from (trip_id, phone): findParticipantOnTrip.
    const own = await lookupOwnProfile(trip, participant.id);
    const text = own && !own.finished && own.nextQuestion
      ? profileUnfinishedLine(own.nextQuestion)
      : profileLine(own?.text ?? null);
    if (opts.isDm) {
      await send(opts.chatId, text);
    } else {
      await sendDM(participant.phone, text);
      await send(opts.chatId, PROFILE_IN_DM_LINE);
    }
    return;
  }
  if (opts.command === "resurvey") {
    // Back to the first question, keeping every answer until it is replaced
    // (skip keeps the old one). Their boards keep working meanwhile.
    await persistSurveyProgress({
      participantId: participant.id,
      awaiting: FIRST_QUESTION_ID,
      answers: (participant.survey_json ?? {}) as SurveyAnswers,
    });
    const prompt = resurveyStartLine(QUESTIONS[FIRST_QUESTION_ID].prompt);
    if (opts.isDm) {
      await send(opts.chatId, prompt);
    } else {
      await sendDM(participant.phone, prompt);
      await send(opts.chatId, SETTINGS_IN_DM_LINE.replace("your settings are", "your questions are"));
    }
    return;
  }

  if (opts.command === "setup") {
    const refusal = await authorize({ trip, participant, people, action: "change the setup" });
    if (refusal) {
      await send(opts.chatId, refusal);
      return;
    }
    const prompt = await beginSetup(trip);
    if (opts.isDm) {
      await send(opts.chatId, prompt);
    } else {
      // The questions go to the organizer's DM; the group gets one line.
      await sendDM(participant.phone, prompt);
      await send(opts.chatId, SETUP_IN_DM_LINE);
    }
    return;
  }

  const refusal = await authorize({ trip, participant, people, action: "end the trip" });
  if (refusal) {
    await send(opts.chatId, refusal);
    return;
  }
  if (opts.command === "end_trip") {
    await send(opts.chatId, END_TRIP_CONFIRM_LINE);
    return;
  }

  // end_trip_confirm: only the call that flips the state posts the final line.
  const { data: ended, error } = await getServiceClient()
    .from("trips")
    .update({ state: "complete", completed_at: new Date().toISOString() })
    .eq("id", trip.id)
    .neq("state", "complete")
    .select("id");
  if (error) throw error;
  if (!ended || ended.length === 0) {
    await send(opts.chatId, TRIP_OVER_LINE);
    return;
  }
  lifecycleStep("trip.completed", { tripId: trip.id });
  const teams = await teamsWithMembers(trip.id);
  const standings = buildStandingsRows(people, teams)
    .map((row) => ({ name: row.display_name, score: row.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  // Final standings belong in the trip's own chat, even if confirmed by DM.
  // Confetti, once: this branch only runs the one time a trip actually flips
  // to complete (the update above is guarded by neq("state", "complete")).
  await send(
    trip.linq_chat_id,
    finalStandingsLine({
      standings,
      losers: losersOf(standings),
      stake: trip.stake_text,
      wrappedUrl: wrappedUrlFor(trip),
    }),
    { effect: { type: "screen", name: "confetti" } },
  );
}

async function startNewTrip(opts: {
  chatId: string;
  isDm: boolean;
  phone: string | null;
  displayName?: string | null;
  send: SendFn;
}): Promise<void> {
  const open = await getTripByChatId(opts.chatId);
  if (open) {
    await opts.send(opts.chatId, TRIP_ALREADY_RUNNING_LINE);
    return;
  }
  if (opts.isDm) {
    if (!soloModeEnabled() || !opts.phone) {
      await opts.send(opts.chatId, NEW_TRIP_DM_LINE);
      return;
    }
    // Solo testing: a fresh solo trip on the same DM.
    await bootstrapSoloIfNeeded({
      chatId: opts.chatId,
      phone: opts.phone,
      displayName: opts.displayName ?? null,
    });
    return;
  }
  // Same chat, a second trip: bootstrap runs again, posting the intro and
  // sending the setup and surveys. The sender becomes the organizer.
  const trip = await bootstrapGroupIfNeeded(opts.chatId, {
    isGroup: true,
    senderPhone: opts.phone,
    explicitNewTrip: true,
  });
  lifecycleStep("new_trip", { chatId: opts.chatId, tripId: trip?.id ?? null, state: trip?.state ?? null });
  if (!trip || trip.state === "bootstrapping") {
    // Bootstrap did not get as far as the intro; answer rather than go quiet.
    await opts.send(opts.chatId, tripNotReadyLine());
  }
}
