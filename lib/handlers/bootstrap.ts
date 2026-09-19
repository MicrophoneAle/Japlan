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
  handleFromUnknown,
  handlesFromUnknown,
  humansFromHandles,
  isBotHandle,
  sameHandle,
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

async function fetchChatHandles(chatId: string): Promise<{
  displayName: string | null;
  handles: HandleLike[];
}> {
  const chat = await getLinqClient().chats.retrieve(chatId);
  return {
    displayName: chat.display_name,
    handles: handlesFromUnknown(chat.handles),
  };
}

async function getTripByChatId(chatId: string): Promise<TripRow | null> {
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

async function createTrip(chatId: string, displayName: string | null): Promise<TripRow> {
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
      if (existing) return existing;
    }
    throw error;
  }
  return asTrip(data);
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

export async function bootstrapGroupChat(opts: {
  chatId: string;
  displayName?: string | null;
  handles?: HandleLike[];
}): Promise<TripRow> {
  let handles = opts.handles ?? [];
  let displayName = opts.displayName ?? null;
  if (handles.length === 0) {
    const fetched = await fetchChatHandles(opts.chatId);
    handles = fetched.handles;
    displayName = displayName ?? fetched.displayName;
  }

  let trip = await getTripByChatId(opts.chatId);
  if (!trip) {
    trip = await createTrip(opts.chatId, displayName);
  }

  const participants = await upsertHumans(trip.id, handles);

  if (trip.state === "bootstrapping") {
    const publicTrip = {
      id: trip.id,
      linq_chat_id: trip.linq_chat_id,
      name: trip.name,
      state: trip.state,
    };
    await sendText(trip.linq_chat_id, buildIntroGroupPost(publicTrip));
  }

  for (const person of participants) {
    await startSurveyDm(person);
  }

  if (trip.state === "bootstrapping") {
    const { error } = await getServiceClient()
      .from("trips")
      .update({ state: "surveying" })
      .eq("id", trip.id)
      .eq("state", "bootstrapping");
    if (error) throw error;
    trip = { ...trip, state: "surveying" };
  }

  return trip;
}

export async function onBotAddedToChat(chatId: string): Promise<void> {
  if (!chatId) return;
  await bootstrapGroupChat({ chatId });
}

export async function onChatCreated(data: unknown): Promise<void> {
  if (!data || typeof data !== "object") return;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== "string") return;
  if (row.is_group !== true) return;
  await bootstrapGroupChat({
    chatId: row.id,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    handles: handlesFromUnknown(row.handles),
  });
}

export async function onParticipantAdded(data: unknown): Promise<void> {
  if (!data || typeof data !== "object") return;
  const row = data as Record<string, unknown>;
  const chatId = typeof row.chat_id === "string" ? row.chat_id : "";
  if (!chatId) return;

  const added =
    handleFromUnknown(row.participant) ??
    (typeof row.handle === "string" ? { handle: row.handle, is_me: null } : null);
  if (!added) return;

  const addedIsBot = added.is_me === true || isBotHandle(added.handle);
  if (addedIsBot) {
    await onBotAddedToChat(chatId);
    return;
  }

  const trip = await getTripByChatId(chatId);
  if (!trip) return;

  const participants = await upsertHumans(trip.id, [added]);
  const person = participants.find((p) => sameHandle(p.phone, added.handle));
  if (person) await startSurveyDm(person);
}

export async function findOpenSurveyByPhone(
  phone: string,
): Promise<{ trip: TripRow; participant: ParticipantRow } | null> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(`${PARTICIPANT_COLS}, trips (${TRIP_COLS})`)
    .eq("phone", phone);
  if (error) throw error;
  const rows = (data ?? []) as Array<ParticipantRow & { trips: TripRow | TripRow[] | null }>;
  const mapped = rows.flatMap((row) => {
    const trip = Array.isArray(row.trips) ? row.trips[0] : row.trips;
    if (!trip) return [];
    return [{ trip, participant: row }];
  });
  const open = mapped.find(
    (row) => row.participant.survey_state && row.participant.survey_state !== "done",
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
