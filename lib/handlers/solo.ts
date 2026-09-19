import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import {
  defaultSoloSurveyAnswers,
  soloParticipantCount,
} from "@/lib/game/solo";
import { startSurvey } from "@/lib/game/survey";
import { sendText } from "@/lib/linq/send";
import {
  findParticipantOnTrip,
  getTripByChatId,
  maybeActivateTrip,
  persistSurveyProgress,
} from "./bootstrap";
import { looksLikePhone } from "@/lib/linq/payload";
import { isSetupQuestion } from "@/lib/game/setup";
import { needsSetupResume, resumeSetup, setupPromptFor } from "./setup";

import { TRIP_COLS } from "@/lib/db/columns";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

function asTrip(row: unknown): TripRow {
  return row as TripRow;
}

async function listParticipants(tripId: string): Promise<ParticipantRow[]> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(PARTICIPANT_COLS)
    .eq("trip_id", tripId);
  if (error) throw error;
  return (data ?? []) as ParticipantRow[];
}

export function buildSoloTripInsert(chatId: string): {
  linq_chat_id: string;
  name: string;
  state: string;
  is_solo: boolean;
} {
  return {
    linq_chat_id: chatId,
    name: "solo test",
    state: "bootstrapping",
    is_solo: true,
  };
}

export function buildSoloParticipantInsert(
  tripId: string,
  phone: string,
  displayName?: string | null,
): {
  trip_id: string;
  phone: string;
  display_name: string;
} {
  return {
    trip_id: tripId,
    phone,
    display_name: displayName?.trim() || phone,
  };
}

async function ensureSoloTrip(chatId: string): Promise<TripRow> {
  const existing = await getTripByChatId(chatId);
  if (existing) return existing;

  const { data, error } = await getServiceClient()
    .from("trips")
    .insert(buildSoloTripInsert(chatId))
    .select(TRIP_COLS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const raced = await getTripByChatId(chatId);
      if (raced) return raced;
    }
    throw error;
  }
  if (!data) throw new Error("solo trip insert returned no row");
  return asTrip(data);
}

async function ensureSoloParticipant(
  tripId: string,
  phone: string,
  displayName?: string | null,
): Promise<ParticipantRow> {
  const already = await findParticipantOnTrip(tripId, phone);
  const name = displayName?.trim() || null;
  if (already) {
    if (
      name &&
      !looksLikePhone(name) &&
      (looksLikePhone(already.display_name) || already.display_name === phone)
    ) {
      const { error } = await getServiceClient()
        .from("participants")
        .update({ display_name: name })
        .eq("id", already.id);
      if (error) throw error;
      return { ...already, display_name: name };
    }
    return already;
  }

  const { error } = await getServiceClient()
    .from("participants")
    .upsert([buildSoloParticipantInsert(tripId, phone, displayName)], {
      onConflict: "trip_id,phone",
      ignoreDuplicates: true,
    });
  if (error) throw error;
  const created = await findParticipantOnTrip(tripId, phone);
  if (!created) throw new Error("solo participant insert failed");
  return created;
}

export async function ensureSoloTripAndParticipant(opts: {
  chatId: string;
  phone: string;
  displayName?: string | null;
}): Promise<{ trip: TripRow; participant: ParticipantRow }> {
  const trip = await ensureSoloTrip(opts.chatId);
  const participant = await ensureSoloParticipant(
    trip.id,
    opts.phone,
    opts.displayName,
  );
  return { trip, participant };
}

async function startSoloSurvey(
  chatId: string,
  participant: ParticipantRow,
): Promise<void> {
  if (participant.survey_state && participant.survey_state !== "not_started") {
    return;
  }
  const started = startSurvey();
  if (!started.prompt) return;
  await sendText(chatId, started.prompt);
  await persistSurveyProgress({
    participantId: participant.id,
    awaiting: started.state.awaiting,
    answers: started.state.answers,
  });
}

export async function bootstrapSoloIfNeeded(opts: {
  chatId: string;
  phone: string;
  displayName?: string | null;
}): Promise<TripRow> {
  const { trip, participant } = await ensureSoloTripAndParticipant(opts);
  const people = await listParticipants(trip.id);
  console.info("[japlan.solo] bootstrap", {
    tripId: trip.id,
    chatId: opts.chatId,
    participants: soloParticipantCount(people.map((p) => p.phone)),
  });

  if (trip.state === "active") return trip;

  // The solo participant is the organizer: trip setup first, survey after.
  const organized = await ensureSoloOrganizer(trip, participant);
  if (isSetupQuestion(organized.setup_state)) {
    await sendText(
      opts.chatId,
      setupPromptFor(organized, organized.setup_state, !organized.destination),
    );
    await markSurveying(trip);
    return { ...organized, state: "surveying" };
  }

  if (participant.survey_state === "done") {
    await maybeActivateTrip(organized);
    return (await getTripByChatId(opts.chatId)) ?? organized;
  }

  await startSoloSurvey(opts.chatId, participant);
  if (trip.state === "bootstrapping") {
    await getServiceClient()
      .from("trips")
      .update({ state: "surveying" })
      .eq("id", trip.id)
      .eq("state", "bootstrapping");
  }
  return { ...trip, is_solo: true, state: "surveying" };
}

export async function skipSoloSurvey(opts: {
  chatId: string;
  phone: string;
  displayName?: string | null;
}): Promise<TripRow> {
  const { trip, participant } = await ensureSoloTripAndParticipant(opts);
  const answers = defaultSoloSurveyAnswers();
  if (opts.displayName?.trim()) {
    answers.first_name = { value: opts.displayName.trim() };
  }
  await persistSurveyProgress({
    participantId: participant.id,
    awaiting: "done",
    answers,
  });

  const organized = await ensureSoloOrganizer(
    (await getTripByChatId(opts.chatId)) ?? trip,
    participant,
  );
  await maybeActivateTrip(organized);
  const activated = (await getTripByChatId(opts.chatId)) ?? organized;
  console.info("[japlan.solo] skipsurvey", {
    tripId: activated.id,
    state: activated.state,
    setupState: activated.setup_state ?? null,
  });
  // skipsurvey skips the personal survey only. A trip still missing where or
  // when cannot go active, so ask for it here (one message).
  if (activated.state !== "active") {
    const prompt = isSetupQuestion(activated.setup_state)
      ? setupPromptFor(activated, activated.setup_state)
      : needsSetupResume(activated)
        ? await resumeSetup(activated)
        : null;
    if (prompt) await sendText(opts.chatId, prompt);
  }
  return activated;
}

async function ensureSoloOrganizer(
  trip: TripRow,
  participant: ParticipantRow,
): Promise<TripRow> {
  if (trip.organizer_participant_id) return trip;
  const setupState = trip.setup_state ?? "destination";
  const { error } = await getServiceClient()
    .from("trips")
    .update({ organizer_participant_id: participant.id, setup_state: setupState })
    .eq("id", trip.id)
    .is("organizer_participant_id", null);
  if (error) throw error;
  return { ...trip, organizer_participant_id: participant.id, setup_state: setupState };
}

async function markSurveying(trip: TripRow): Promise<void> {
  if (trip.state !== "bootstrapping") return;
  const { error } = await getServiceClient()
    .from("trips")
    .update({ state: "surveying" })
    .eq("id", trip.id)
    .eq("state", "bootstrapping");
  if (error) throw error;
}

export async function soloTripForChat(chatId: string): Promise<TripRow | null> {
  console.log("[japlan.solo] step", { step: "soloTripForChat.before", chatId });
  const trip = await getTripByChatId(chatId);
  console.log("[japlan.solo] step", {
    step: "soloTripForChat.after",
    chatId,
    found: Boolean(trip),
    isSolo: trip?.is_solo ?? null,
    state: trip?.state ?? null,
    tripId: trip?.id ?? null,
  });
  if (!trip) {
    console.log("[japlan.dispatch] idle", {
      reason: "solo_trip_lookup_miss",
      chatId,
    });
    return null;
  }
  if (!trip.is_solo) {
    console.log("[japlan.dispatch] idle", {
      reason: "trip_for_chat_is_not_solo",
      chatId,
      tripId: trip.id,
      state: trip.state,
    });
    return null;
  }
  return trip;
}
