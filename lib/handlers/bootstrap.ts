import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import {
  allParticipantsComplete,
  buildIntroGroupPost,
  buildSetupCompleteGroupPost,
  startSurvey,
  type SurveyAnswers,
  type SurveyAwaiting,
} from "@/lib/game/survey";
import { getLinqClient } from "@/lib/linq/client";
import {
  handlesFromUnknown,
  humansFromHandles,
  type HandleLike,
} from "@/lib/linq/payload";
import { sendDM, sendText } from "@/lib/linq/send";

const TRIP_COLS =
  "id, linq_chat_id, name, destination, start_date, end_date, state, difficulty, stake_text, timezone";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

function asTrip(row: unknown): TripRow {
  return row as TripRow;
}

function asParticipants(rows: unknown): ParticipantRow[] {
  return (rows ?? []) as ParticipantRow[];
}

async function fetchChat(chatId: string): Promise<{
  displayName: string | null;
  handles: HandleLike[];
}> {
  const chat = await getLinqClient().chats.retrieve(chatId);
  return {
    displayName: chat.display_name,
    handles: handlesFromUnknown(chat.handles),
  };
}

export async function getTripByChatId(chatId: string): Promise<TripRow | null> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("linq_chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  return data ? asTrip(data) : null;
}

async function listParticipants(tripId: string): Promise<ParticipantRow[]> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(PARTICIPANT_COLS)
    .eq("trip_id", tripId);
  if (error) throw error;
  return asParticipants(data);
}

async function insertTrip(
  chatId: string,
  displayName: string | null,
): Promise<{ trip: TripRow; created: boolean }> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .insert({
      linq_chat_id: chatId,
      name: displayName?.trim() || "PLACEHOLDER: unnamed trip",
      destination: null,
      start_date: null,
      end_date: null,
      state: "bootstrapping",
      difficulty: null,
      stake_text: null,
      timezone: null,
    })
    .select(TRIP_COLS)
    .single();

  if (error) {
    if (error.code === "23505") {
      const existing = await getTripByChatId(chatId);
      if (existing) return { trip: existing, created: false };
    }
    throw error;
  }
  return { trip: asTrip(data), created: true };
}

async function upsertHumans(
  tripId: string,
  handles: HandleLike[],
): Promise<ParticipantRow[]> {
  const humans = humansFromHandles(handles);
  if (humans.length === 0) return listParticipants(tripId);

  const { error } = await getServiceClient().from("participants").upsert(
    humans.map((handle) => ({
      trip_id: tripId,
      phone: handle.handle,
      display_name: handle.handle,
    })),
    { onConflict: "trip_id,phone", ignoreDuplicates: true },
  );
  if (error) throw error;
  return listParticipants(tripId);
}

async function startSurveyDm(participant: ParticipantRow): Promise<void> {
  if (participant.survey_state && participant.survey_state !== "not_started") {
    return;
  }
  const started = startSurvey();
  const { data, error } = await getServiceClient()
    .from("participants")
    .update({
      survey_state: started.state.awaiting,
      survey_json: started.state.answers,
    })
    .eq("id", participant.id)
    .is("survey_state", null)
    .select("id");
  if (error) throw error;
  if (!data?.length || !started.prompt) return;
  await sendDM(participant.phone, started.prompt);
}

export async function maybeActivateTrip(trip: TripRow): Promise<void> {
  const people = await listParticipants(trip.id);
  if (!allParticipantsComplete(people.map((p) => p.survey_state))) return;
  if (trip.state === "active") return;

  const publicTrip = {
    id: trip.id,
    linq_chat_id: trip.linq_chat_id,
    name: trip.name,
    state: trip.state,
  };
  await sendText(trip.linq_chat_id, buildSetupCompleteGroupPost(publicTrip));
  const { error } = await getServiceClient()
    .from("trips")
    .update({ state: "active" })
    .eq("id", trip.id)
    .neq("state", "active");
  if (error) throw error;
}

// First group message.received with no trip: fetch members from Linq, create
// the trip, post intro, DM the survey. The insert winner owns side effects so
// concurrent first messages do not double-intro.
export async function bootstrapGroupIfNeeded(chatId: string): Promise<TripRow> {
  const existing = await getTripByChatId(chatId);
  if (existing) return existing;

  const fetched = await fetchChat(chatId);
  const { trip, created } = await insertTrip(chatId, fetched.displayName);
  if (!created) return trip;

  const participants = await upsertHumans(trip.id, fetched.handles);

  const publicTrip = {
    id: trip.id,
    linq_chat_id: trip.linq_chat_id,
    name: trip.name,
    state: trip.state,
  };
  await sendText(trip.linq_chat_id, buildIntroGroupPost(publicTrip));

  for (const person of participants) {
    await startSurveyDm(person);
  }

  const { error } = await getServiceClient()
    .from("trips")
    .update({ state: "surveying" })
    .eq("id", trip.id)
    .eq("state", "bootstrapping");
  if (error) throw error;
  return { ...trip, state: "surveying" };
}

export async function findOpenSurveyByPhone(
  phone: string,
): Promise<{ trip: TripRow; participant: ParticipantRow } | null> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(`${PARTICIPANT_COLS}, trips (${TRIP_COLS})`)
    .eq("phone", phone);
  if (error) throw error;
  const rows = (data ?? []) as Array<
    ParticipantRow & { trips: TripRow | TripRow[] | null }
  >;
  const mapped = rows.flatMap((row) => {
    const trip = Array.isArray(row.trips) ? row.trips[0] : row.trips;
    if (!trip) return [];
    return [{ trip, participant: row }];
  });
  const open = mapped.find(
    (row) =>
      row.participant.survey_state && row.participant.survey_state !== "done",
  );
  return open ?? mapped[0] ?? null;
}

export async function persistSurveyProgress(opts: {
  participantId: string;
  awaiting: SurveyAwaiting;
  answers: SurveyAnswers;
}): Promise<void> {
  const { error } = await getServiceClient()
    .from("participants")
    .update({
      survey_state: opts.awaiting,
      survey_json: opts.answers,
    })
    .eq("id", opts.participantId);
  if (error) throw error;
}
