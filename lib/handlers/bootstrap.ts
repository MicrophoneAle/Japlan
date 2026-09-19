import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { QUESTIONS } from "@/lib/game/survey-questions";
import {
  allParticipantsComplete,
  answerValue,
  buildIntroGroupPost,
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
import {
  isSetupQuestion,
  missingRequiredSetup,
  setupReadyToActivate,
  type SetupFields,
} from "@/lib/game/setup";
import { setupCompleteLine, setupPrompt } from "@/lib/game/copy";
import { describeBoardTime, nextBoardAt } from "@/lib/game/board-schedule";

import { TRIP_COLS } from "@/lib/db/columns";

// Until the group chat's own name is known.
const UNNAMED_TRIP = "unnamed trip";

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

// The chat's current trip: the newest one that is not complete. A chat can
// hold many trips over time; trips_one_open_trip_per_chat allows only one open.
export async function getTripByChatId(chatId: string): Promise<TripRow | null> {
  console.log("[japlan.dispatch] step", { step: "getTripByChatId.before", chatId });
  const { data, error } = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("linq_chat_id", chatId)
    .neq("state", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
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

// The most recent trip for a chat in any state, for "this trip is over".
export async function getLatestTripByChatId(chatId: string): Promise<TripRow | null> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("linq_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? asTrip(data) : null;
}

export async function getTripById(tripId: string): Promise<TripRow | null> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("id", tripId)
    .maybeSingle();
  if (error) throw error;
  return data ? asTrip(data) : null;
}

export async function listParticipants(tripId: string): Promise<ParticipantRow[]> {
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
      name: displayName?.trim() || UNNAMED_TRIP,
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

async function startSetupDm(
  organizer: ParticipantRow,
  trip: TripRow,
): Promise<boolean> {
  if (!isSetupQuestion(trip.setup_state)) return false;
  const first = trip.setup_state === "destination" && !trip.destination;
  const prompt = setupPrompt(trip.setup_state, null, { first });
  try {
    await sendDM(organizer.phone, prompt);
    logStep("sendDM.setup", { phone: organizer.phone, ok: true, question: trip.setup_state });
    return true;
  } catch (err) {
    logError("sendDM.setup", err, { phone: organizer.phone, ok: false });
    return false;
  }
}

export async function countSurveysPending(tripId: string): Promise<number> {
  const people = await listParticipants(tripId);
  return people.filter((p) => p.survey_state !== "done").length;
}

// Active needs every personal survey done AND the organizer setup's required
// answers (destination, dates). Re-reads the trip: callers often hold a copy
// from before the setup answer that just landed.
// Returns the "we're live" line when the trip activated. announce (default)
// posts it to the trip chat. A solo trip's chat is the player's DM, where the
// caller is already replying: pass announce:false and fold the line into that
// one reply rather than sending two messages.
export async function maybeActivateTrip(
  stale: TripRow,
  opts: { announce?: boolean } = {},
): Promise<string | null> {
  const trip = (await getTripById(stale.id)) ?? stale;
  if (trip.state === "active" || trip.state === "complete") return null;
  const people = await listParticipants(trip.id);
  if (!allParticipantsComplete(people.map((p) => p.survey_state))) return null;
  if (!setupReadyToActivate(trip as SetupFields)) {
    logStep("activate.blocked", {
      tripId: trip.id,
      missing: missingRequiredSetup(trip as SetupFields),
    });
    return null;
  }

  // Group-safe fields only (DM stays in DM); the line names when the first
  // board really lands, from the same schedule the cron follows.
  const now = new Date();
  const next = nextBoardAt(trip, now, { todayBoardExists: false });
  const line = setupCompleteLine(next ? describeBoardTime(next.at, now, trip.timezone) : null);
  if (opts.announce !== false) await sendText(trip.linq_chat_id, line);
  const { error } = await getServiceClient()
    .from("trips")
    .update({ state: "active" })
    .eq("id", trip.id)
    .neq("state", "active");
  if (error) throw error;
  return line;
}

export async function bootstrapGroupIfNeeded(
  chatId: string,
  opts: {
    isGroup: boolean;
    // Sender of the triggering message. Linq never reports who added the bot,
    // so the first person to message the group becomes the organizer.
    senderPhone?: string | null;
    // "japlan new trip": allowed to start a trip in a chat whose last trip ended.
    explicitNewTrip?: boolean;
  } = { isGroup: true },
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

    if (!existing && !opts.explicitNewTrip) {
      // After "japlan end trip" the chat stays quiet until someone asks for a
      // new one; ordinary messages must not silently start trip two.
      const latest = await getLatestTripByChatId(chatId);
      if (latest?.state === "complete") {
        logStep("skip.completed_trip_needs_new_trip_command", { chatId, tripId: latest.id });
        return null;
      }
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
    // Legacy rows were named "PLACEHOLDER: unnamed trip".
    if (displayName && (trip.name === UNNAMED_TRIP || trip.name.startsWith("PLACEHOLDER:"))) {
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
    // At most once per chat, whatever state the trip is stuck in: claim the
    // intro atomically, and release the claim only if the send itself failed.
    const introClaim = await getServiceClient()
      .from("trips")
      .update({ intro_sent_at: new Date().toISOString() })
      .eq("id", trip.id)
      .is("intro_sent_at", null)
      .select("id");
    if (introClaim.error) throw introClaim.error;
    if (!introClaim.data || introClaim.data.length === 0) {
      logStep("intro.skip", { chatId, reason: "already_sent" });
    } else {
      try {
        await sendText(trip.linq_chat_id, buildIntroGroupPost(publicTrip));
        logStep("intro.send", { chatId, ok: true });
      } catch (err) {
        logError("intro.send", err, { chatId, ok: false });
        const { error: releaseErr } = await getServiceClient()
          .from("trips")
          .update({ intro_sent_at: null })
          .eq("id", trip.id);
        if (releaseErr) logError("intro.release", releaseErr, { chatId });
        return trip;
      }
    }

    step = "organizer.assign";
    let organizerId = trip.organizer_participant_id ?? null;
    let setupState = trip.setup_state ?? null;
    if (!organizerId) {
      const organizer =
        participants.find((p) => opts.senderPhone && p.phone === opts.senderPhone) ??
        participants[0];
      organizerId = organizer.id;
      setupState = setupState ?? "destination";
      const { error: orgErr } = await getServiceClient()
        .from("trips")
        .update({ organizer_participant_id: organizerId, setup_state: setupState })
        .eq("id", trip.id)
        .is("organizer_participant_id", null);
      if (orgErr) throw orgErr;
      logStep("organizer.assign", {
        chatId,
        tripId: trip.id,
        fromSender: organizer.phone === opts.senderPhone,
      });
    }

    step = "sendDM";
    let dmOk = 0;
    let dmFail = 0;
    for (const person of participants) {
      // The organizer answers the trip setup first; their own survey follows.
      const ok =
        person.id === organizerId && isSetupQuestion(setupState)
          ? await startSetupDm(person, { ...trip, setup_state: setupState })
          : await startSurveyDm(person);
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

  // Two flat queries rather than a participants->trips embed: nested embeds
  // are a suspect in the isolate hang, and completed trips must be skipped.
  const { data, error } = await getServiceClient()
    .from("participants")
    .select(PARTICIPANT_COLS)
    .eq("phone", phone);
  if (error) throw error;
  const rows = asParticipants(data);
  if (rows.length === 0) return null;
  const tripsRes = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .in("id", [...new Set(rows.map((row) => row.trip_id))])
    .neq("state", "complete");
  if (tripsRes.error) throw tripsRes.error;
  const trips = new Map(
    ((tripsRes.data ?? []) as TripRow[]).map((trip) => [trip.id, trip]),
  );
  const candidates = rows.flatMap((participant) => {
    const trip = trips.get(participant.trip_id);
    return trip ? [{ trip, participant }] : [];
  });
  return pickDmTrip(candidates);
}

// Which open trip a DM is about, for someone on more than one: an organizer
// mid-setup first, then an in-progress survey, then an organizer who still
// owes setup answers, then the newest trip.
export function pickDmTrip<
  T extends {
    trip: Pick<TripRow, "organizer_participant_id" | "setup_state" | "destination" | "start_date" | "end_date"> & { created_at?: string };
    participant: Pick<ParticipantRow, "id" | "survey_state">;
  },
>(candidates: T[]): T | null {
  const rank = (c: T): number => {
    const organizer = c.trip.organizer_participant_id === c.participant.id;
    if (organizer && isSetupQuestion(c.trip.setup_state)) return 0;
    const state = c.participant.survey_state;
    if (state && state !== "done" && state !== "not_started") return 1;
    if (organizer && missingRequiredSetup(c.trip as SetupFields).length > 0) return 2;
    return 3;
  };
  return (
    [...candidates].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        String(b.trip.created_at ?? "").localeCompare(String(a.trip.created_at ?? "")),
    )[0] ?? null
  );
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
