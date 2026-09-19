import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import {
  datesRetryLine,
  datesSetLine,
  destinationSetLine,
  formatShortDate,
  setupFinishedLine,
  setupNowAboutYouLine,
  setupPrompt,
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
import { startSurvey } from "@/lib/game/survey";
import { QUESTIONS, type QuestionId } from "@/lib/game/survey-questions";
import {
  isValidTimeZone,
  localDateString,
  zonePlausibleForLongitude,
} from "@/lib/game/time";
import type { LLMProvider } from "@/lib/llm";
import { extractTripDates, inferPlaceTimezone } from "@/lib/llm/gemini";
import { resolveNearArea } from "@/lib/places/foursquare";
import { getTripById, maybeActivateTrip, persistSurveyProgress } from "./bootstrap";

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
  return setupPrompt(id, currentValue(trip, id), { first });
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
  if (state === "done") return null;
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
        if (!range) return datesRetryLine("unclear");
        const check = checkDateRange(range.start, range.end, today);
        setupStep("dates.check", { ...range, today, path, ok: check.ok, reason: check.ok ? null : check.reason });
        if (!check.ok) return datesRetryLine(check.reason);
        patch.start_date = check.start;
        patch.end_date = check.end;
        said = datesSetLine(check.start, check.end);
        break;
      }
      case "difficulty": {
        const difficulty = matchDifficulty(text);
        if (!difficulty) return surveyReaskLine([...DIFFICULTIES]);
        patch.difficulty = difficulty;
        said = `got it: ${difficulty}.`;
        break;
      }
      case "stake": {
        patch.stake_text = text.slice(0, 200);
        said = "got it.";
        break;
      }
    }
  }

  const updated = { ...trip, ...patch } as TripRow;
  const next = nextSetupQuestion(id);
  if (next) {
    await saveTrip(trip.id, { ...patch, setup_state: next });
    return `${said} ${setupPromptFor(updated, next)}`.trim();
  }

  const missing = missingRequiredSetup(updated as SetupFields) as ("destination" | "dates")[];
  await saveTrip(trip.id, { ...patch, setup_state: missing.length > 0 ? SETUP_DEFERRED : SETUP_DONE });
  setupStep("finish", { tripId: trip.id, missing });
  const finished = `${said} ${setupFinishedLine(missing)}`.trim();
  const surveyPrompt = await surveyPromptAfterSetup(opts.organizer);
  await maybeActivateTrip((await getTripById(trip.id)) ?? updated);
  return surveyPrompt ? setupNowAboutYouLine(finished, surveyPrompt) : finished;
}
