import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import {
  defaultSoloSurveyAnswers,
  soloParticipantCount,
} from "@/lib/game/solo";
import { startSurvey } from "@/lib/game/survey";
import { sendText } from "@/lib/linq/send";
import {
  getTripByChatId,
  maybeActivateTrip,
  persistSurveyProgress,
} from "./bootstrap";

const TRIP_COLS =
  "id, linq_chat_id, name, destination, start_date, end_date, state, difficulty, stake_text, timezone, destination_profile_json, is_solo";
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
): {
  trip_id: string;
  phone: string;
  display_name: string;
} {
  return {
    trip_id: tripId,
    phone,
    display_name: phone,
  };
}

async function ensureSoloTrip(chatId: string): Promise<TripRow> {
  const existing = await getTripByChatId(chatId);
  if (existing) return existing;

  const { data, error } = await getServiceClient()
    .from("trips")
    .insert(buildSoloTripInsert(chatId))
    .select(TRIP_COLS)
    .single();
  if (error) {
    if (error.code === "23505") {
      const raced = await getTripByChatId(chatId);
      if (raced) return raced;
    }
    throw error;
  }
  return asTrip(data);
}

async function ensureSoloParticipant(
  tripId: string,
  phone: string,
): Promise<ParticipantRow> {
  const people = await listParticipants(tripId);
  const already = people.find((p) => p.phone === phone);
  if (already) return already;

  const { error } = await getServiceClient()
    .from("participants")
    .upsert([buildSoloParticipantInsert(tripId, phone)], {
      onConflict: "trip_id,phone",
      ignoreDuplicates: true,
    });
  if (error) throw error;
  const next = await listParticipants(tripId);
  const created = next.find((p) => p.phone === phone);
  if (!created) throw new Error("solo participant insert failed");
  return created;
}

export async function ensureSoloTripAndParticipant(opts: {
  chatId: string;
  phone: string;
}): Promise<{ trip: TripRow; participant: ParticipantRow }> {
  const trip = await ensureSoloTrip(opts.chatId);
  const participant = await ensureSoloParticipant(trip.id, opts.phone);
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
}): Promise<TripRow> {
  const { trip, participant } = await ensureSoloTripAndParticipant(opts);
  const people = await listParticipants(trip.id);
  console.info("[japlan.solo] bootstrap", {
    tripId: trip.id,
    chatId: opts.chatId,
    participants: soloParticipantCount(people.map((p) => p.phone)),
  });

  if (trip.state === "active") return trip;
  if (participant.survey_state === "done") {
    await maybeActivateTrip(trip);
    return { ...trip, state: "active" };
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
}): Promise<TripRow> {
  const { trip, participant } = await ensureSoloTripAndParticipant(opts);
  await persistSurveyProgress({
    participantId: participant.id,
    awaiting: "done",
    answers: defaultSoloSurveyAnswers(),
  });

  const latest = (await getTripByChatId(opts.chatId)) ?? trip;
  await maybeActivateTrip(latest);
  const activated = (await getTripByChatId(opts.chatId)) ?? latest;
  console.info("[japlan.solo] skipsurvey", {
    tripId: activated.id,
    state: activated.state,
  });
  return activated;
}

export async function soloTripForChat(chatId: string): Promise<TripRow | null> {
  const trip = await getTripByChatId(chatId);
  if (!trip?.is_solo) return null;
  return trip;
}
