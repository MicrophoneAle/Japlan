import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { FIRST_QUESTION_ID, QUESTIONS, SURVEY_V2_ORDER, type QuestionId } from "@/lib/game/survey-questions";
import {
  answerValue,
  buildIntroGroupMessages,
  displayNameFromFirstName,
  isSidequestQuestion,
  startSidequestOnboarding,
  startSurvey,
  type SurveyAnswers,
  type SurveyAwaiting,
} from "@/lib/game/survey";
import { getLinqClient } from "@/lib/linq/client";
import {
  displayNameFromChatJson,
  humansFromHandles,
  isBotHandle,
  looksLikeRawHandle,
  membersFromChatJson,
  type HandleLike,
} from "@/lib/linq/payload";
import { sendDM, sendText, shareContactCardSafely } from "@/lib/linq/send";
import {
  isSetupQuestion,
  missingRequiredSetup,
  setupReadyToActivate,
  type SetupFields,
} from "@/lib/game/setup";
import { setupCompleteLine, setupPrompt, surveyLaunchGroupLine, liveDashboardLine } from "@/lib/game/copy";
import { formTeamsForTrip, teamsAnnouncement } from "@/lib/handlers/teams";
import { liveUrlFor } from "@/lib/urls";

import { TRIP_COLS } from "@/lib/db/columns";
import { LEG_COLS } from "./legs";
import type { TripLeg } from "@/lib/game/legs";
import { personLabel } from "@/lib/handle";

// Until the group chat's own name is known.
const UNNAMED_TRIP = "unnamed trip";

const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";

function asTrip(row: unknown): TripRow {
  return row as TripRow;
}

// Every trip that comes out of here carries its legs, so the call sites that
// used to read trips.timezone / trips.destination can resolve a leg without a
// query of their own. A trip with no legs (migration not run, setup not
// finished) resolves to a synthesised single leg in lib/game/legs.ts, which is
// exactly the old single-city behaviour.
// Legs come back embedded in the trip query itself, so the claim path makes
// ONE Supabase call and never exposes itself to the second-call hang. The
// embed is a PostgREST join on the trip_legs foreign key.
//
// Falls back to a plain trip on any embed error: if 2026-10-03 has not run,
// trip_legs does not exist and the embed 42P01s, which would otherwise break
// every trip lookup. That is precisely the outage shape CLAUDE.md warns about,
// so the embed is never allowed to be load-bearing.
export const TRIP_COLS_WITH_LEGS = `${TRIP_COLS}, trip_legs (${LEG_COLS})`;

type TripRowWithEmbed = Record<string, unknown> & { trip_legs?: TripLeg[] | null };

// Run a trip query with legs embedded, and fall back to plain columns if the
// embed itself is what failed (migration not run, relation missing). Anything
// else is a real error and is rethrown.
export async function tripQuery(
  build: (cols: string) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
  // Overridable so scripts/verify-embed.ts can point it at a deliberately bad
  // relation and prove the fallback fires against the real database.
  embedCols: string = TRIP_COLS_WITH_LEGS,
): Promise<unknown> {
  const withLegs = await build(embedCols);
  if (!withLegs.error) return withLegs.data;
  const code = withLegs.error.code ?? "";
  const missing = code === "42P01" || code === "PGRST200" || /trip_legs/i.test(withLegs.error.message ?? "");
  if (!missing) throw withLegs.error;
  console.warn("[japlan.dispatch] step", {
    step: "trip_legs.embed_unavailable",
    code,
    note: "migration 2026-10-03 applied? falling back to a trip with no legs",
  });
  const plain = await build(TRIP_COLS);
  if (plain.error) throw plain.error;
  return plain.data;
}

export function asTripWithEmbeddedLegs(row: unknown): TripRow {
  const raw = row as TripRowWithEmbed;
  const { trip_legs: embedded, ...rest } = raw;
  const trip = asTrip(rest);
  trip.legs = Array.isArray(embedded) ? [...embedded].sort((a, b) => a.leg_order - b.leg_order) : [];
  return trip;
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
  let data: unknown;
  try {
    // ONE call, legs embedded: the claim path never makes a second Supabase
    // query, which is the call that hangs.
    data = await tripQuery((cols) =>
      getServiceClient()
        .from("trips")
        .select(cols)
        .eq("linq_chat_id", chatId)
        .neq("state", "complete")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
  } catch (err) {
    const error = err as { message?: string; code?: string };
    console.error("[japlan.dispatch] step", {
      step: "getTripByChatId.throw",
      chatId,
      message: error.message,
      code: error.code ?? null,
    });
    throw err;
  }
  console.log("[japlan.dispatch] step", {
    step: "getTripByChatId.after",
    chatId,
    found: Boolean(data),
    tripId: data ? (data as { id: string }).id : null,
    isSolo: data ? Boolean((data as { is_solo?: boolean }).is_solo) : null,
    state: data ? (data as { state?: string }).state ?? null : null,
  });
  return data ? asTripWithEmbeddedLegs(data) : null;
}

// The most recent trip for a chat in any state, for "this trip is over".
export async function getLatestTripByChatId(chatId: string): Promise<TripRow | null> {
  const data = await tripQuery((cols) =>
    getServiceClient()
      .from("trips")
      .select(cols)
      .eq("linq_chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return data ? asTripWithEmbeddedLegs(data) : null;
}

export async function getTripById(tripId: string): Promise<TripRow | null> {
  const data = await tripQuery((cols) =>
    getServiceClient().from("trips").select(cols).eq("id", tripId).maybeSingle(),
  );
  return data ? asTripWithEmbeddedLegs(data) : null;
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
      play_mode: null,
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
  return { trip: asTripWithEmbeddedLegs(data), created: true };
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
    if (!name || looksLikeRawHandle(name)) continue;
    const person = people.find((row) => row.phone === handle.handle);
    if (!person) continue;
    if (!looksLikeRawHandle(person.display_name) && person.display_name !== handle.handle) {
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
    const dm = await sendDM(participant.phone, prompt);
    logStep("sendDM", { phone: participant.phone, ok: true });
    await shareContactCardSafely(dm.chatId);
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

export async function startTripSurveys(stale: TripRow): Promise<void> {
  const trip = (await getTripById(stale.id)) ?? stale;
  if (trip.state === "active" || trip.state === "complete") return;
  const people = await listParticipants(trip.id);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const person of people) {
    if (person.survey_state === "done") continue;
    const ok = await startSurveyDm(person);
    (ok ? sent : failed).push(person.display_name);
  }
  const { error } = await getServiceClient()
    .from("trips")
    .update({ state: "surveying" })
    .eq("id", trip.id)
    .in("state", ["setup", "bootstrapping"]);
  if (error) throw error;
  await sendText(trip.linq_chat_id, surveyLaunchGroupLine(sent, failed));
}

// A group member who was not in the chat at bootstrap (or was added later):
// add them and start their survey by DM. No-op if they are already on the trip.
async function joinLateParticipant(
  trip: TripRow,
  phone: string,
  displayName: string | null,
): Promise<void> {
  if (isBotHandle(phone)) return;
  if (await findParticipantOnTrip(trip.id, phone)) return;
  const name = displayName?.trim() && !looksLikeRawHandle(displayName) ? displayName.trim() : phone;
  const { error } = await getServiceClient()
    .from("participants")
    .upsert([{ trip_id: trip.id, phone, display_name: name }], {
      onConflict: "trip_id,phone",
      ignoreDuplicates: true,
    });
  if (error) throw error;
  const joined = await findParticipantOnTrip(trip.id, phone);
  if (!joined) return;
  logStep("participant.late_join", { tripId: trip.id, participantId: joined.id });
  if (trip.state !== "setup" && trip.state !== "bootstrapping") {
    await startSurveyDm(joined);
  }
}

export async function countSurveysPending(tripId: string): Promise<number> {
  const people = await listParticipants(tripId);
  return people.filter((p) => p.survey_state !== "done" && !isSidequestQuestion(p.survey_state)).length;
}

// Active needs every personal survey done AND the organizer setup's required
// answers (destination, dates). Re-reads the trip: callers often hold a copy
// from before the setup answer that just landed.
// Returns the "we're live" line when the trip activated. announce (default)
// posts it to the trip chat. A solo trip's chat is the player's DM, where the
// caller is already replying: pass announce:false and fold the line into that
// one reply rather than sending two messages.
// Sidequests' own mini-onboarding, at trip start: the next thing this
// person's DM asks. Returns the question, for a reply that is already going.
// Finished the survey (either version), or answering the sidequest questions
// that follow it: ready for boards.
export function surveyFinished(state: string | null | undefined): boolean {
  return state === "done" || isSidequestQuestion(state);
}

// The sidequest question, unless they answered it before (a resurvey).
export async function sidequestPromptIfNew(participantId: string, answers: SurveyAnswers): Promise<string | null> {
  if (answerValue(answers, "sidequest_level")) return null;
  return beginSidequestOnboarding(participantId, answers);
}

// The question someone still answering is on. Never started, or partway
// through the first survey (whose questions are gone): moved to the first
// question of the current one, so their next reply answers it.
export async function nextUnansweredQuestion(person: Pick<ParticipantRow, "id" | "survey_state">): Promise<string> {
  const state = person.survey_state;
  if (state && SURVEY_V2_ORDER.includes(state as QuestionId)) return QUESTIONS[state as QuestionId].prompt;
  const { error } = await getServiceClient()
    .from("participants")
    .update({ survey_state: FIRST_QUESTION_ID })
    .eq("id", person.id);
  if (error) throw error;
  return QUESTIONS[FIRST_QUESTION_ID].prompt;
}

export async function beginSidequestOnboarding(participantId: string, answers: SurveyAnswers): Promise<string> {
  const step = startSidequestOnboarding(answers);
  await persistSurveyProgress({ participantId, awaiting: step.state.awaiting, answers: step.state.answers });
  return step.prompt ?? "";
}

export async function maybeActivateTrip(
  stale: TripRow,
  // quietFor: the person whose reply triggered this. They get the sidequest
  // question in that reply instead of a second DM.
  opts: { announce?: boolean; quietFor?: string } = {},
): Promise<string | null> {
  const trip = (await getTripById(stale.id)) ?? stale;
  if (trip.state === "active" || trip.state === "complete") return null;
  const people = await listParticipants(trip.id);
  // Live on the first finished survey: one slow person does not hold the
  // group hostage. Everyone else gets their board when they finish.
  const ready = people.filter((p) => surveyFinished(p.survey_state));
  if (ready.length === 0) return null;
  if (!setupReadyToActivate(trip as SetupFields)) {
    logStep("activate.blocked", {
      tripId: trip.id,
      missing: missingRequiredSetup(trip as SetupFields),
    });
    return null;
  }

  // Group-safe fields only (private preferences and board details stay in DMs).
  let line = setupCompleteLine(trip.play_mode);

  // Teams are decided once, here, from the survey (team_preference,
  // social_with): a no-op for a solo trip or a group where nobody opted in.
  if (!trip.is_solo && !trip.play_mode) {
    const teams = await formTeamsForTrip(trip, people);
    const announcement = teamsAnnouncement(teams);
    if (announcement) line = `${line}\n\n${announcement}`;
  }

  const liveUrl = liveUrlFor(trip.id);
  if (liveUrl) line = `${line}\n\n${liveDashboardLine(liveUrl)}`;

  // Claim the transition before sending anything. Concurrent final survey
  // replies can both reach this function; only one may announce activation
  // or fan out the ready DMs.
  const { data: activated, error } = await getServiceClient()
    .from("trips")
    .update({ state: "active" })
    .eq("id", trip.id)
    .in("state", ["bootstrapping", "setup", "surveying"])
    .select("id");
  if (error) throw error;
  if (!activated || activated.length === 0) {
    logStep("activate.skip", { tripId: trip.id, reason: "another request activated first" });
    return null;
  }
  if (opts.announce !== false) await sendText(trip.linq_chat_id, line);
  // Trip start: ready people get a short board-request instruction and the
  // sidequest question, in one DM. Nobody receives a board until they ask.
  const { boardForNewlyReady } = await import("./board-request");
  const live = (await getTripById(trip.id)) ?? { ...trip, state: "active" };
  for (const person of ready) {
    if (person.id === opts.quietFor) continue;
    const answers = (person.survey_json ?? {}) as SurveyAnswers;
    if (answerValue(answers, "age_bracket") === "under_18") continue;
    try {
      const board = await boardForNewlyReady(live, person.id, new Date());
      const sidequests = await sidequestPromptIfNew(person.id, answers);
      const text = [board, sidequests].filter(Boolean).join("\n\n");
      if (text) await sendDM(person.phone, text);
    } catch (err) {
      console.error("[japlan.bootstrap] ready DM failed", { participantId: person.id, err });
    }
  }
  return line;
}

export async function bootstrapGroupIfNeeded(
  chatId: string,
  opts: {
    isGroup: boolean;
    // Sender of the triggering message. Linq never reports who added the bot,
    // so the first person to message the group becomes the organizer.
    senderPhone?: string | null;
    senderName?: string | null;
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
      // Someone added to the group after setup joins the trip the first time
      // they speak, instead of being told they are not on it.
      if (opts.senderPhone) {
        await joinLateParticipant(existing, opts.senderPhone, opts.senderName ?? null);
      }
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

    step = "organizer.assign";
    const organizer =
      participants.find((p) => p.id === trip.organizer_participant_id) ??
      participants.find((p) => opts.senderPhone && p.phone === opts.senderPhone) ??
      participants[0];
    const organizerId = trip.organizer_participant_id ?? organizer.id;
    const setupState = isSetupQuestion(trip.setup_state) ? trip.setup_state : "destination";
    if (!trip.organizer_participant_id || trip.setup_state !== setupState) {
      const { error: orgErr } = await getServiceClient()
        .from("trips")
        .update({ organizer_participant_id: organizerId, setup_state: setupState })
        .eq("id", trip.id);
      if (orgErr) throw orgErr;
      logStep("organizer.assign", {
        chatId,
        tripId: trip.id,
        fromSender: organizer.phone === opts.senderPhone,
      });
    }

    step = "intro.send";
    const publicTrip = {
      id: trip.id,
      linq_chat_id: trip.linq_chat_id,
      name: displayName || trip.name,
      state: trip.state,
      organizerName: personLabel(organizer.display_name),
    };
    const setup = setupPrompt(setupState, null, { first: true, inGroup: true });
    const introPosts = [...buildIntroGroupMessages(publicTrip), setup];
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
        for (const post of introPosts) await sendText(trip.linq_chat_id, post);
        logStep("intro.send", { chatId, ok: true, messages: introPosts.length });
        await shareContactCardSafely(trip.linq_chat_id);
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

    step = "state.setup";
    const { error } = await getServiceClient()
      .from("trips")
      .update({ state: "setup" })
      .eq("id", trip.id)
      .eq("state", "bootstrapping");
    if (error) throw error;
    logStep("state.setup", { chatId, tripId: trip.id });
    return { ...trip, organizer_participant_id: organizerId, setup_state: setupState, state: "setup" };
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
  if (first && !looksLikeRawHandle(first)) {
    patch.display_name = displayNameFromFirstName(first, first);
  }
  const { error } = await getServiceClient()
    .from("participants")
    .update(patch)
    .eq("id", opts.participantId);
  if (error) throw error;
}
