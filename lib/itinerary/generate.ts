import { GeminiProvider } from "@/lib/llm/gemini";
import type { LLMProvider } from "@/lib/llm";
import { inclusiveTripDates, type TripConfig } from "./config";
import { ItineraryModelSchema, type CandidateActivity, type DraftItinerary, type ItineraryModel } from "./schemas";

const schema = { type: "object", properties: { days: { type: "array", items: { type: "object", properties: { date: { type: "string" }, dayNumber: { type: "integer" }, summary: { type: "string" }, activities: { type: "array", items: { type: "object", properties: { candidateActivityId: { type: "string" }, startTime: { type: ["string", "null"] }, endTime: { type: ["string", "null"] }, notes: { type: "string" } }, required: ["candidateActivityId", "startTime", "endTime", "notes"] } } }, required: ["date", "dayNumber", "summary", "activities"] } } }, required: ["days"] };

function minutes(value: string) { const [hours, mins] = value.split(":").map(Number); return hours * 60 + mins; }
export function validateModelItinerary(model: ItineraryModel, config: TripConfig, candidates: CandidateActivity[]): DraftItinerary {
  const dates = inclusiveTripDates(config); const available = new Map(candidates.map(candidate => [candidate.id, candidate])); const used = new Set<string>();
  if (model.days.length !== dates.length || model.days.some((day, index) => day.date !== dates[index] || day.dayNumber !== index + 1)) throw new Error("model itinerary does not cover the exact trip dates");
  return { destination: config.destination, startDate: config.startDate, endDate: config.endDate, status: "draft", days: model.days.map(day => {
    let lastEnd = -1;
    const activities = day.activities.map(activity => {
      const candidate = available.get(activity.candidateActivityId); if (!candidate) throw new Error(`model referenced unknown candidate ${activity.candidateActivityId}`);
      if (used.has(candidate.id)) throw new Error(`model duplicated candidate ${candidate.id}`); used.add(candidate.id);
      if ((activity.startTime === null) !== (activity.endTime === null)) throw new Error("time slots require both a start and end time");
      if (activity.startTime && activity.endTime) { const start = minutes(activity.startTime); const end = minutes(activity.endTime); if (end <= start || start < lastEnd) throw new Error("overlapping or invalid itinerary times"); lastEnd = end; }
      if (candidate.category === "restaurant" && /allergy-safe|peanut-safe/i.test(activity.notes) && candidate.unverifiedFields.some(field => /allergy/i.test(field))) throw new Error("model overstated unverified allergy safety");
      return { ...candidate, startTime: activity.startTime, endTime: activity.endTime, notes: activity.notes, verificationStatus: "unvalidated" as const };
    });
    return { ...day, activities };
  }) };
}

export async function generateDraftItinerary(config: TripConfig, candidates: CandidateActivity[], provider: LLMProvider = new GeminiProvider()): Promise<DraftItinerary> {
  const context = JSON.stringify({ config, candidates }); let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) try {
    const raw = await provider.complete({ system: "Create a draft itinerary using ONLY supplied candidateActivityId values. Do not invent a place, factual field, source, distance, or safety claim. Preserve unresolved constraints in notes. Return JSON only.", messages: [{ role: "user", content: context }], schema, tier: "smart", thinkingBudget: 0 });
    return validateModelItinerary(ItineraryModelSchema.parse(JSON.parse(raw)), config, candidates);
  } catch (error) { lastError = error; }
  throw new Error(`itinerary model output was invalid after retry: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

/** Explicit development-only companion to mock research; it never runs in real mode. */
export function generateMockDraftItinerary(config: TripConfig, candidates: CandidateActivity[]): DraftItinerary {
  const dates = inclusiveTripDates(config);
  if (candidates.length < dates.length) throw new Error("mock research does not contain enough candidates");
  return validateModelItinerary({ days: dates.map((date, index) => ({ date, dayNumber: index + 1, summary: "Development-only draft. Confirm venue suitability and availability before using.", activities: [{ candidateActivityId: candidates[index]!.id, startTime: null, endTime: null, notes: "Unvalidated development draft; no schedule or safety claim is implied." }] })) }, config, candidates);
}
