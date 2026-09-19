import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { QUESTIONS } from "@/lib/game/survey-questions";
import {
  allParticipantsComplete,
  answerValue,
  buildIntroGroupPost,
  buildSetupCompleteGroupPost,
  displayNameFromFirstName,
  startSurvey,
  type SurveyAnswers,
  type SurveyAwaiting,
} from "@/lib/game/survey";
import { getLinqClient } from "@/lib/linq/client";
import {
  displayNameFromChatJson,
  humansFromHandles,
  looksLikePhone,
  membersFromChatJson,
  type HandleLike,
} from "@/lib/linq/payload";
import { sendDM, sendText } from "@/lib/linq/send";

const TRIP_COLS =
  "id, linq_chat_id, name, destination, start_date, end_date, state, difficulty, stake_text, timezone, destination_profile_json, is_solo, daily_points_cap";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

function asTrip(row: unknown): TripRow {
  return row as TripRow;
}

function asParticipants(rows: unknown): ParticipantRow[] {
  return (rows ?? []) as ParticipantRow[];
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra = err as Error & { status?: unknown };
    return {
      name: err.name,
      error: err.message,
      stack: err.stack ?? null,
      status: extra.status ?? null,
    };
  }
  return { error: String(err), stack: null };
}

function logStep(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.bootstrap]", { step, ...fields });
}

function logError(
  step: string,
  err: unknown,
  fields: Record<string, unknown> = {},
): void {
  console.error("[japlan.bootstrap]", {
    step,
    ...fields,
    ...serializeError(err),
  });
}

export async function getTripByChatId(chatId: string): Promise<TripRow | null> {
  console.log("[japlan.dispatch] step", { step: "getTripByChatId.before", chatId });
  const { data, error } = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("linq_chat_id", chatId)
    .maybeSingle();
  if (error) {
    console.error("[japlan.dispatch] step", {
      step: "getTripByChatId.throw",
      chatId,
      message: error.message,
      code: error.code ?? null,
    });
    throw error;
  }
  console.log("[japlan.dispatch] step", {
    step: "getTripByChatId.after",
    chatId,
    found: Boolean(data),
    tripId: data ? (data as { id: string }).id : null,
    isSolo: data ? Boolean((data as { is_solo?: boolean }).is_solo) : null,
    state: data ? (data as { state?: string }).state ?? null : null,
  });
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
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const existing = await getTripByChatId(chatId);
      if (existing) return { trip: existing, created: false };
    }
    throw error;
  }
  if (!data) throw new Error("trip insert returned no row");
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
      display_name: handle.display_name?.trim() || handle.handle,
    })),
    { onConflict: "trip_id,phone", ignoreDuplicates: true },
  );
  if (error) throw error;

  const people = await listParticipants(tripId);
  for (const handle of humans) {
    const name = handle.display_name?.trim();
    if (!name || looksLikePhone(name)) continue;
    const person = people.find((row) => row.phone === handle.handle);
    if (!person) continue;
    if (!looksLikePhone(person.display_name) && person.display_name !== handle.handle) {
      continue;
    }
    const { error: nameErr } = await getServiceClient()
      .from("participants")
      .update({ display_name: name })
      .eq("id", person.id);
    if (nameErr) throw nameErr;
  }
  return listParticipants(tripId);
}

async function fetchChatRaw(chatId: string): Promise<unknown> {
  const response = await getLinqClient().chats.retrieve(chatId).asResponse();
  const rawText = await response.text();
  logStep("chat.fetch.raw", {
    chatId,
    httpStatus: response.status,
    raw: rawText,
  });
  if (!response.ok) {
    throw new Error(
      `GET /v3/chats/${chatId} failed: HTTP ${response.status} ${rawText}`,
    );
  }
  try {
    return JSON.parse(rawText) as unknown;
  } catch (err) {
    throw new Error(
      `GET /v3/chats/${chatId} returned non-JSON: ${String(err)} body=${rawText}`,
    );
  }
}

async function startSurveyDm(participant: ParticipantRow): Promise<boolean> {
  const inProgress =
    participant.survey_state &&
    participant.survey_state !== "not_started" &&
    participant.survey_state !== "done"
      ? participant.survey_state
      : null;

  const started = startSurvey();
  const awaiting: SurveyAwaiting = inProgress
    ? (inProgress as SurveyAwaiting)
    : started.state.awaiting;
  const answers: SurveyAnswers = inProgress
    ? ((participant.survey_json ?? {}) as SurveyAnswers)
    : started.state.answers;
  const prompt = inProgress
    ? (QUESTIONS[inProgress as keyof typeof QUESTIONS]?.prompt ?? null)
    : started.prompt;

  if (!prompt) {
    logStep("sendDM.skip", {
      phone: participant.phone,
      reason: "no prompt",
      survey_state: participant.survey_state,
    });
    return false;
  }

  try {
    await sendDM(participant.phone, prompt);
    logStep("sendDM", { phone: participant.phone, ok: true });
  } catch (err) {
    logError("sendDM", err, { phone: participant.phone, ok: false });
    return false;
  }

  if (!inProgress) {
    const { error } = await getServiceClient()
      .from("participants")
      .update({
        survey_state: awaiting,
        survey_json: answers,
      })
      .eq("id", participant.id);
    if (error) throw error;
  }
  return true;
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

export async function bootstrapGroupIfNeeded(
  chatId: string,
  opts: { isGroup: boolean } = { isGroup: true },
): Promise<TripRow | null> {
  let step = "triggered";
  try {
    const existing = await getTripByChatId(chatId);
    logStep("triggered", {
      chatId,
      is_group: opts.isGroup,
      tripExisted: Boolean(existing),
      existingState: existing?.state ?? null,
      existingTripId: existing?.id ?? null,
    });

    if (existing && existing.state !== "bootstrapping") {
      logStep("skip.already_past_bootstrap", {
        chatId,
        state: existing.state,
      });
      return existing;
    }

    step = "trip.ensure";
    const { trip } = existing
      ? { trip: existing }
      : await insertTrip(chatId, null);
    logStep("trip.ensure", {
      chatId,
      tripId: trip.id,
      state: trip.state,
      created: !existing,
    });

    step = "chat.fetch";
    let raw: unknown;
    try {
      raw = await fetchChatRaw(chatId);
    } catch (err) {
      logError("chat.fetch", err, { chatId, tripId: trip.id });
      return trip;
    }

    step = "chat.parse";
    const parsed = membersFromChatJson(raw);
    const humans = humansFromHandles(parsed.parsed);
    const filteredAsMe = parsed.parsed.length - humans.length;
    logStep("chat.parse", {
      chatId,
      sourcePath: parsed.sourcePath,
      candidatePaths: parsed.candidatePaths,
      parsedCount: parsed.parsed.length,
      filteredAsMe,
      humanCount: humans.length,
    });

    if (parsed.parsed.length === 0) {
      logError(
        "chat.parse.unexpected_shape",
        new Error("no members found on GET /v3/chats/{id} response"),
        {
          chatId,
          tripId: trip.id,
          candidatePaths: parsed.candidatePaths,
        },
      );
      return trip;
    }

    const displayName = displayNameFromChatJson(raw);
    if (displayName && trip.name.startsWith("PLACEHOLDER:")) {
      await getServiceClient()
        .from("trips")
        .update({ name: displayName })
        .eq("id", trip.id);
    }

    step = "participants.write";
    const participants = await upsertHumans(trip.id, parsed.parsed);
    logStep("participants.write", {
      chatId,
      tripId: trip.id,
      parsedCount: parsed.parsed.length,
      filteredAsMe,
      written: participants.length,
    });

    if (humans.length === 0 || participants.length === 0) {
      logError(
        "participants.none",
        new Error("no human participant rows after parse/filter"),
        { chatId, tripId: trip.id, parsedCount: parsed.parsed.length, filteredAsMe },
      );
      return trip;
    }

    step = "intro.send";
    const publicTrip = {
      id: trip.id,
      linq_chat_id: trip.linq_chat_id,
      name: displayName || trip.name,
      state: trip.state,
    };
    try {
      await sendText(trip.linq_chat_id, buildIntroGroupPost(publicTrip));
      logStep("intro.send", { chatId, ok: true });
    } catch (err) {
      logError("intro.send", err, { chatId, ok: false });
      return trip;
    }

    step = "sendDM";
    let dmOk = 0;
    let dmFail = 0;
    for (const person of participants) {
      const ok = await startSurveyDm(person);
      if (ok) dmOk += 1;
      else dmFail += 1;
    }
    logStep("sendDM.summary", { chatId, ok: dmOk, failed: dmFail });
    if (dmOk === 0) {
      logError(
        "sendDM.none_succeeded",
        new Error("every survey DM failed or was skipped"),
        { chatId, tripId: trip.id, attempted: participants.length },
      );
      return trip;
    }

    step = "state.surveying";
    const { error } = await getServiceClient()
      .from("trips")
      .update({ state: "surveying" })
      .eq("id", trip.id)
      .eq("state", "bootstrapping");
    if (error) throw error;
    logStep("state.surveying", { chatId, tripId: trip.id });
    return { ...trip, state: "surveying" };
  } catch (err) {
    logError(step, err, { chatId });
    return (await getTripByChatId(chatId)) ?? null;
  }
}

export async function findParticipantOnTrip(
  tripId: string,
  phone: string,
): Promise<ParticipantRow | null> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(PARTICIPANT_COLS)
    .eq("trip_id", tripId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as ParticipantRow) : null;
}

export function pickOpenSurveyMatch<T extends { survey_state: string | null }>(
  rows: T[],
): T | null {
  const open = rows.find(
    (row) => row.survey_state && row.survey_state !== "done",
  );
  return open ?? rows[0] ?? null;
}

export async function findOpenSurveyByPhone(
  phone: string,
  chatId?: string,
): Promise<{ trip: TripRow; participant: ParticipantRow } | null> {
  if (chatId) {
    const trip = await getTripByChatId(chatId);
    if (trip) {
      const participant = await findParticipantOnTrip(trip.id, phone);
      return participant ? { trip, participant } : null;
    }
  }

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
    return [{ trip, participant: row, survey_state: row.survey_state }];
  });
  const picked = pickOpenSurveyMatch(mapped);
  return picked ? { trip: picked.trip, participant: picked.participant } : null;
}

export async function persistSurveyProgress(opts: {
  participantId: string;
  awaiting: SurveyAwaiting;
  answers: SurveyAnswers;
}): Promise<void> {
  const first = answerValue(opts.answers, "first_name");
  const patch: {
    survey_state: SurveyAwaiting;
    survey_json: SurveyAnswers;
    display_name?: string;
  } = {
    survey_state: opts.awaiting,
    survey_json: opts.answers,
  };
  if (first && !looksLikePhone(first)) {
    patch.display_name = displayNameFromFirstName(first, first);
  }
  const { error } = await getServiceClient()
    .from("participants")
    .update(patch)
    .eq("id", opts.participantId);
  if (error) throw error;
}
