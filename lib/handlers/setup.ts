import { getServiceClient } from "@/lib/db/client";
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
  matchDifficulty,
  missingRequiredSetup,
  nextSetupQuestion,
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
import { getTripById, maybeActivateTrip, persistSurveyProgress, sidequestPromptIfNew } from "./bootstrap";

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
    case "difficulty":
      return trip.difficulty ?? null;
    case "stake":
      return trip.stake_text ?? null;
  }
}

export function setupPromptFor(trip: TripRow, id: SetupQuestionId, first = false): string {
  return setupPrompt(id, currentValue(trip, id), { first, isSolo: Boolean(trip.is_solo) });
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

// "japlan setup", or the first question at bootstrap. Walks all four with the
// current value shown; skip keeps whatever is there.
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
}): Promise<string> {
  const deps = opts.deps ?? {};
  const trip = opts.trip;
  const id = trip.setup_state;
  if (!isSetupQuestion(id)) throw new Error(`answerSetup with setup_state ${String(id)}`);
  const text = opts.text.trim();
  const patch: Record<string, unknown> = {};
  let said = "";

  if (!text) return setupPromptFor(trip, id);

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
  const finished = `${said} ${setupFinishedLine(missing)}`.trim();
  const surveyPrompt = await surveyPromptAfterSetup(opts.organizer);
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
