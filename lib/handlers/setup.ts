import { getServiceClient } from "@/lib/db/client";
import { refreshTripMultipliers } from "./holidays";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import {
  BOARD_TIME_UNREADABLE_LINE,
  boardTimeSetLine,
  datesRetryLine,
  datesSetLine,
  destinationSetLine,
  difficultySetLine,
  formatShortDate,
  setupFinishedLine,
  setupNowAboutYouLine,
  setupPrompt,
  STAKE_SET_LINE,
  groupSetupCompleteLine,
  organizerOnlySetupLine,
  surveyReaskLine,
} from "@/lib/game/copy";
import { partialDestinationProfile } from "@/lib/game/destination";
import {
  DIFFICULTIES,
  SETUP_DEFERRED,
  SETUP_DONE,
  checkDateRange,
  isSetupQuestion,
  isSetupSkip,
  matchPlayMode,
  matchDifficulty,
  missingRequiredSetup,
  nextSetupQuestion,
  playModeLabel,
  parseLooseDates,
  type SetupFields,
  type SetupQuestionId,
} from "@/lib/game/setup";
import { lookupCityTimezone } from "@/lib/game/city-timezones";
import { formatBoardTime, parseBoardTime } from "@/lib/game/board-schedule";
import { isSidequestQuestion, startSurvey, type SurveyAnswers } from "@/lib/game/survey";
import { QUESTIONS, type QuestionId } from "@/lib/game/survey-questions";
import {
  isValidTimeZone,
  localDateString,
  zonePlausibleForLongitude,
} from "@/lib/game/time";
import type { LLMProvider } from "@/lib/llm";
import { extractTripDates, inferPlaceTimezone } from "@/lib/llm/gemini";
import { resolveNearArea } from "@/lib/places/foursquare";
import {
  findParticipantOnTrip,
  getTripByChatId,
  getTripById,
  maybeActivateTrip,
  persistSurveyProgress,
  sidequestPromptIfNew,
  startTripSurveys,
} from "./bootstrap";
import { sendText } from "@/lib/linq/send";
import { defaultWakeKeyword, stripWakeKeyword } from "@/lib/game/addressing";

export type SetupDeps = { provider?: LLMProvider; now?: Date };

function setupStep(step: string, fields: Record<string, unknown> = {}): void {
  console.log("[japlan.setup] step", { step, ...fields });
}

function currentValue(trip: TripRow, id: SetupQuestionId): string | null {
  switch (id) {
    case "destination":
      return trip.destination ?? null;
    case "dates":
      return trip.start_date && trip.end_date
        ? `${formatShortDate(trip.start_date)} to ${formatShortDate(trip.end_date)}`
        : null;
    case "play_mode":
      return trip.play_mode ? playModeLabel(trip.play_mode) : null;
    case "difficulty":
      return trip.difficulty ?? null;
    case "stake":
      return trip.stake_text ?? null;
  }
}

export function setupPromptFor(trip: TripRow, id: SetupQuestionId, first = false): string {
  const prompt = setupPrompt(id, currentValue(trip, id), { first, isSolo: Boolean(trip.is_solo) });
  return trip.is_solo ? prompt : `${prompt} Reply here with “japlan” + your answer.`;
}

async function saveTrip(tripId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await getServiceClient().from("trips").update(patch).eq("id", tripId);
  if (error) throw error;
}

export type ResolvedDestination = {
  destination: string;
  timezone: string | null;
  resolved: boolean;
  center: { lat: number; lng: number } | null;
};

export type TimezonePath = "lookup" | "gemini" | "none";

// Timezone, in order, logging which path set it and why:
//  1. Plain lookup (lib/game/city-timezones): "tokyo" -> Asia/Tokyo, no API.
//  2. Gemini, only when the lookup has nothing: ambiguous or unusual places.
//     Kept only if it is a real IANA zone that fits the longitude.
// The places layer (Foursquare `near`) runs regardless for the centre and a
// clean name; while it has no credits the raw text is stored as typed.
export async function resolveDestinationAnswer(
  text: string,
  deps: SetupDeps = {},
): Promise<ResolvedDestination & { timezonePath: TimezonePath }> {
  const raw = text.trim().replace(/\s+/g, " ").slice(0, 100);

  const looked = lookupCityTimezone(raw);
  setupStep("destination.timezone.lookup", {
    input: raw,
    hit: looked ? `${looked.matched} -> ${looked.timezone} (${looked.source})` : null,
  });

  setupStep("destination.places.before", { input: raw });
  const area = await resolveNearArea(raw);
  setupStep("destination.places.after", {
    resolved: Boolean(area),
    country: area?.country ?? null,
    lat: area?.lat ?? null,
    lng: area?.lng ?? null,
  });
  const lng = area?.lng ?? null;
  if (looked && !zonePlausibleForLongitude(looked.timezone, lng)) {
    // The lookup wins for a name it knows; log so a wrong alias shows up.
    setupStep("destination.timezone.lookup_disagrees_with_places", {
      timezone: looked.timezone,
      lng,
    });
  }

  let timezone: string | null = looked?.timezone ?? null;
  let timezonePath: TimezonePath = looked ? "lookup" : "none";
  let named: { display: string; timezone: string } | null = null;

  if (!looked || area) {
    // Gemini: the timezone when the lookup missed, and a clean display name
    // when the places layer resolved the place.
    setupStep("destination.gemini.before", { input: raw, placesResolved: Boolean(area) });
    try {
      named = await inferPlaceTimezone({ provider: deps.provider, text: raw, area });
      setupStep("destination.gemini.after", { response: named });
    } catch (err) {
      setupStep("destination.gemini.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!looked) {
      const valid = named ? isValidTimeZone(named.timezone) : false;
      const plausible = named && valid ? zonePlausibleForLongitude(named.timezone, lng) : false;
      if (named && valid && plausible) {
        timezone = named.timezone;
        timezonePath = "gemini";
      }
      setupStep("destination.timezone.gemini_check", {
        proposed: named?.timezone ?? null,
        validIana: valid,
        fitsLongitude: plausible,
        kept: timezone,
      });
    }
  }

  setupStep("destination.timezone.result", { input: raw, path: timezonePath, timezone });
  const center =
    area && area.lat !== null && area.lng !== null ? { lat: area.lat, lng: area.lng } : null;
  return {
    // Spec: an unresolved destination is stored as the raw string.
    destination: area && named?.display ? named.display : raw,
    timezone,
    timezonePath,
    resolved: Boolean(area),
    center,
  };
}

// Continue (or start) the organizer's personal survey after setup, returning
// the prompt to append, or null when their survey is already done.
async function surveyPromptAfterSetup(organizer: ParticipantRow): Promise<string | null> {
  const state = organizer.survey_state;
  // Done, or only the sidequest question pending (that is not the survey).
  if (state === "done" || isSidequestQuestion(state)) return null;
  if (state && state !== "not_started") {
    return QUESTIONS[state as QuestionId]?.prompt ?? null;
  }
  const started = startSurvey();
  await persistSurveyProgress({
    participantId: organizer.id,
    awaiting: started.state.awaiting,
    answers: started.state.answers,
  });
  return started.prompt;
}

// "japlan setup", or the first question at bootstrap. Walks the shared trip
// settings with the current value shown; optional skips keep what is there.
export async function beginSetup(trip: TripRow, opts: { first?: boolean } = {}): Promise<string> {
  await saveTrip(trip.id, { setup_state: "destination" });
  setupStep("begin", { tripId: trip.id, first: Boolean(opts.first) });
  return setupPromptFor(trip, "destination", opts.first);
}

// The organizer skipped a required answer earlier: ask the first missing one.
export function needsSetupResume(trip: TripRow): boolean {
  return (
    !isSetupQuestion(trip.setup_state) &&
    missingRequiredSetup(trip as SetupFields).length > 0
  );
}

export async function resumeSetup(trip: TripRow): Promise<string> {
  const missing = missingRequiredSetup(trip as SetupFields);
  const id = missing[0] ?? "destination";
  await saveTrip(trip.id, { setup_state: id });
  setupStep("resume", { tripId: trip.id, question: id });
  return setupPromptFor(trip, id);
}

// One trip setting from the organizer's words: the patch to save and the
// line that confirms it, or a re-ask. Shared by the setup flow and later
// changes ("japlan make it unhinged", "move the trip to oct 18-21").
async function setupChange(
  trip: TripRow,
  id: SetupQuestionId,
  text: string,
  deps: SetupDeps,
): Promise<{ patch: Record<string, unknown>; said: string } | { retry: string }> {
  const patch: Record<string, unknown> = {};
  let said = "";
  switch (id) {
    case "destination": {
      const resolved = await resolveDestinationAnswer(text, deps);
      patch.destination = resolved.destination;
      if (resolved.timezone) patch.timezone = resolved.timezone;
      const changed =
        (trip.destination ?? "").trim().toLowerCase() !==
        resolved.destination.trim().toLowerCase();
      if (changed) {
        // New destination: the old profile's places and the old timezone
        // belong to the wrong city.
        patch.destination_profile_json = partialDestinationProfile(
          resolved.destination,
          resolved.center,
        );
        if (!resolved.timezone) patch.timezone = null;
        // Another country's holidays are not this trip's. Clearing the mark
        // makes the next lookup run instead of backing off for a week.
        patch.multipliers_checked_at = null;
        setupStep("destination.profile_refresh", { tripId: trip.id });
      }
      said = destinationSetLine(
        resolved.destination,
        Boolean(resolved.timezone ?? (changed ? null : trip.timezone)),
      );
      break;
    }
    case "dates": {
      const today = localDateString(deps.now ?? new Date(), trip.timezone);
      // Deterministic parser first ("oct 17-20", "28 oct - 2 nov",
      // "next weekend"); the model only for anything it cannot read.
      const parsed = parseLooseDates(text, today);
      let range: { start: string; end: string } | null = parsed;
      let path = parsed ? `parser:${parsed.form}` : "none";
      setupStep("dates.parser", { input: text, today, result: parsed });
      if (!range) {
        setupStep("dates.gemini.before", { input: text, today });
        try {
          range = await extractTripDates({ provider: deps.provider, text, today });
          path = range ? "gemini" : "gemini:not_understood";
          setupStep("dates.gemini.after", { response: range });
        } catch (err) {
          path = "gemini:error";
          setupStep("dates.gemini.failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      setupStep("dates.path", { input: text, path, range });
      if (!range) return { retry: datesRetryLine("unclear") };
      const check = checkDateRange(range.start, range.end, today);
      setupStep("dates.check", { ...range, today, path, ok: check.ok, reason: check.ok ? null : check.reason });
      if (!check.ok) return { retry: datesRetryLine(check.reason) };
      patch.start_date = check.start;
      patch.end_date = check.end;
      said = datesSetLine(check.start, check.end);
      break;
    }
    case "difficulty": {
      const difficulty = matchDifficulty(text);
      if (!difficulty) return { retry: surveyReaskLine([...DIFFICULTIES]) };
      patch.difficulty = difficulty;
      said = difficultySetLine(difficulty);
      break;
    }
    case "play_mode": {
      const mode = matchPlayMode(text);
      if (!mode) return { retry: "reply 1 for individual, 2 for teams, or 3 for full group." };
      patch.play_mode = mode;
      said = `got it: ${playModeLabel(mode)}.`;
      break;
    }
    case "stake": {
      patch.stake_text = text.slice(0, 200);
      said = STAKE_SET_LINE;
      break;
    }
  }
  return { patch, said };
}

// The organizer changing a trip setting at any time, outside the setup
// flow: destination, dates, difficulty, stake, board time. Saves and
// returns the confirming line.
export type TripSetting = SetupQuestionId | "board_time";

export function tripSettingFor(name: string): TripSetting | null {
  const lower = name.toLowerCase();
  if (/play ?mode|individual|full group|\bteams?\b/.test(lower)) return "play_mode";
  if (/board ?time|morning time|when .* board/.test(lower)) return "board_time";
  if (/destination|city|where|place/.test(lower)) return "destination";
  if (/date|when|day|length/.test(lower)) return "dates";
  if (/difficult|hard|chill|unhinged|normal/.test(lower)) return "difficulty";
  if (/stake|loser|forfeit|bet/.test(lower)) return "stake";
  return null;
}

export async function applyTripSetting(
  trip: TripRow,
  setting: TripSetting,
  value: string,
  deps: SetupDeps = {},
): Promise<{ ok: boolean; line: string }> {
  if (setting === "board_time") {
    const time = parseBoardTime(value);
    if (!time) return { ok: false, line: BOARD_TIME_UNREADABLE_LINE };
    await saveTrip(trip.id, { board_time: time });
    return { ok: true, line: boardTimeSetLine(formatBoardTime(time)) };
  }
  const change = await setupChange(trip, setting, value.trim(), deps);
  if ("retry" in change) return { ok: false, line: change.retry };
  await saveTrip(trip.id, change.patch);
  setupStep("setting.changed", { tripId: trip.id, setting });
  return { ok: true, line: change.said };
}

// One setup answer in, one DM out.
export async function answerSetup(opts: {
  trip: TripRow;
  organizer: ParticipantRow;
  text: string;
  deps?: SetupDeps;
  viaGroup?: boolean;
}): Promise<string> {
  const deps = opts.deps ?? {};
  const trip = opts.trip;
  const id = trip.setup_state;
  if (!isSetupQuestion(id)) throw new Error(`answerSetup with setup_state ${String(id)}`);
  const text = opts.text.trim();
  const patch: Record<string, unknown> = {};
  let said = "";

  if (!text) return setupPromptFor(trip, id);

  if (isSetupSkip(text) && (id === "destination" || id === "dates" || id === "play_mode")) {
    const reason = id === "play_mode" ? "choose how the trip should run" : `set the ${id}`;
    return `we need to ${reason} before i can send everyone's private survey.\n${setupPromptFor(trip, id)}`;
  }

  if (!isSetupSkip(text)) {
    const change = await setupChange(trip, id, text, deps);
    if ("retry" in change) return change.retry;
    Object.assign(patch, change.patch);
    said = change.said;
  }

  const updated = { ...trip, ...patch } as TripRow;
  const next = nextSetupQuestion(id, { isSolo: Boolean(trip.is_solo) });
  if (next) {
    await saveTrip(trip.id, { ...patch, setup_state: next });
    return `${said} ${setupPromptFor(updated, next)}`.trim();
  }

  const missing = missingRequiredSetup(updated as SetupFields) as ("destination" | "dates")[];
  await saveTrip(trip.id, { ...patch, setup_state: missing.length > 0 ? SETUP_DEFERRED : SETUP_DONE });
  setupStep("finish", { tripId: trip.id, missing });
  // Trip creation, so this is the moment to learn which days are worth more:
  // the destination and the dates are both settled and the first board is
  // about to be built. Holidays only (`festivals: false`), because that tier
  // is one keyless JSON GET with its own 6s cap; the festival scrape needs
  // Browserbase and stays on the cron, off the webhook path. Never fatal: a
  // trip with no special days is an ordinary trip.
  if (missing.length === 0) {
    const forLookup = (await getTripById(trip.id)) ?? updated;
    await refreshTripMultipliers(forLookup, { festivals: false, force: true }).catch((err) => {
      setupStep("multipliers.failed", {
        tripId: trip.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  const finished = `${said} ${setupFinishedLine(missing)}`.trim();
  const surveyPrompt = opts.viaGroup ? null : await surveyPromptAfterSetup(opts.organizer);
  // Solo: the trip chat is this DM, so "we're live" rides in this reply.
  const live = await maybeActivateTrip((await getTripById(trip.id)) ?? updated, {
    announce: !trip.is_solo,
    // Their own board rides in this reply, not a second DM.
    quietFor: opts.organizer.id,
  });
  if (surveyPrompt) return setupNowAboutYouLine(finished, surveyPrompt);
  const head = trip.is_solo && live ? `${finished} ${live}` : finished;
  // Setup was the last thing missing and they finished their survey earlier:
  // their board and the sidequest question now, in this same message.
  if (!live) return head;
  const { boardForNewlyReady } = await import("./board-request");
  const fresh = (await getTripById(trip.id)) ?? updated;
  const organizer = await findParticipantById(opts.organizer.id);
  const answers = (organizer?.survey_json ?? {}) as SurveyAnswers;
  const board = await boardForNewlyReady(fresh, opts.organizer.id, deps.now ?? new Date());
  const sidequests = organizer ? await sidequestPromptIfNew(organizer.id, answers) : null;
  return [head, board, sidequests].filter(Boolean).join("\n\n");
}

async function findParticipantById(id: string): Promise<ParticipantRow | null> {
  const { data, error } = await getServiceClient().from("participants").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ParticipantRow | null) ?? null;
}

// Group trips use their group chat as the shared setup surface. Only the
// named organizer may answer these questions; personal surveys remain in DMs.
export async function handleGroupSetupMessage(opts: {
  chatId: string;
  senderPhone: string | null;
  text: string;
  deps?: SetupDeps;
}): Promise<boolean> {
  const trip = await getTripByChatId(opts.chatId);
  if (!trip || trip.is_solo || !isSetupQuestion(trip.setup_state)) return false;

  const answer = stripWakeKeyword(opts.text, defaultWakeKeyword());
  if (!answer.trim()) return true;
  if (/^(?:help|commands?|menu|lb|leaders?|leaderboards?|standings?|scores?|rankings?|board|plans?|today|day\s+\d+|setup|settings|preferences|profile)\??$/i.test(answer)) {
    return false;
  }

  const sender = opts.senderPhone
    ? await findParticipantOnTrip(trip.id, opts.senderPhone)
    : null;
  const organizer = sender && sender.id === trip.organizer_participant_id ? sender : null;
  if (!organizer) {
    const people = await getServiceClient()
      .from("participants")
      .select("id, display_name")
      .eq("id", trip.organizer_participant_id ?? "");
    if (people.error) throw people.error;
    const name = (people.data?.[0] as { display_name?: string } | undefined)?.display_name ?? "the organizer";
    await sendText(opts.chatId, organizerOnlySetupLine(name));
    return true;
  }

  const reply = await answerSetup({
    trip,
    organizer,
    text: answer,
    deps: opts.deps,
    viaGroup: true,
  });
  const updated = (await getTripById(trip.id)) ?? trip;
  if (!isSetupQuestion(updated.setup_state)) {
    const firstSetup = trip.state === "setup" || trip.state === "bootstrapping";
    const missingRequired = missingRequiredSetup(updated as SetupFields);
    if (firstSetup && (missingRequired.length > 0 || !updated.play_mode)) {
      await sendText(opts.chatId, `${reply}\n${await resumeSetup(updated)}`);
      return true;
    }
    const dateRange = updated.start_date && updated.end_date
      ? `${formatShortDate(updated.start_date)} to ${formatShortDate(updated.end_date)}`
      : null;
    const summary = groupSetupCompleteLine({
      destination: updated.destination,
      dates: dateRange,
      mode: playModeLabel(updated.play_mode),
      organizer: organizer.display_name,
    });
    await sendText(opts.chatId, `${reply}\n\n${summary}`);
    if (firstSetup) await startTripSurveys(updated);
    return true;
  }
  await sendText(opts.chatId, reply);
  return true;
}
