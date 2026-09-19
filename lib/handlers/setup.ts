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
  parseIsoRange,
  type SetupFields,
  type SetupQuestionId,
} from "@/lib/game/setup";
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

// Places layer first (Foursquare `near`), then Gemini names the place and its
// IANA zone from that evidence. The zone is kept only if it is a real zone
// that fits the longitude. Unresolved: the raw text is stored as typed.
export async function resolveDestinationAnswer(
  text: string,
  deps: SetupDeps = {},
): Promise<ResolvedDestination> {
  const raw = text.trim().replace(/\s+/g, " ").slice(0, 100);
  setupStep("destination.resolve.before", { length: raw.length });
  const area = await resolveNearArea(raw);
  setupStep("destination.resolve.after", { resolved: Boolean(area), country: area?.country ?? null });

  let named: { display: string; timezone: string } | null = null;
  try {
    named = await inferPlaceTimezone({ provider: deps.provider, text: raw, area });
  } catch (err) {
    setupStep("destination.timezone.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const lng = area?.lng ?? null;
  const timezone =
    named && isValidTimeZone(named.timezone) && zonePlausibleForLongitude(named.timezone, lng)
      ? named.timezone
      : null;
  setupStep("destination.timezone", { proposed: named?.timezone ?? null, kept: timezone });

  const center =
    area && area.lat !== null && area.lng !== null ? { lat: area.lat, lng: area.lng } : null;
  return {
    // Spec: an unresolved destination is stored as the raw string.
    destination: area && named?.display ? named.display : raw,
    timezone,
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
        let range = parseIsoRange(text);
        if (!range) {
          try {
            range = await extractTripDates({ provider: deps.provider, text, today });
          } catch (err) {
            setupStep("dates.extract_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!range) return datesRetryLine("unclear");
        const check = checkDateRange(range.start, range.end, today);
        setupStep("dates.check", { ...range, today, ok: check.ok });
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
