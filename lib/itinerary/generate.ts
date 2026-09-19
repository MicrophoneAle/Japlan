import { GeminiProvider } from "@/lib/llm/gemini";
import type { LLMProvider } from "@/lib/llm";
import { inclusiveTripDates, type TripConfig } from "./config";
import { ItineraryModelSchema, type CandidateActivity, type DraftItinerary, type ItineraryModel } from "./schemas";
import { activityGroup, hasUsefulTripVariety, isEnglishFacing } from "./quality";

const schema = { type: "object", properties: { days: { type: "array", items: { type: "object", properties: { date: { type: "string" }, dayNumber: { type: "integer" }, summary: { type: "string" }, activities: { type: "array", items: { type: "object", properties: { candidateActivityId: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, notes: { type: "string" } }, required: ["candidateActivityId", "startTime", "endTime", "notes"] } }, diningPlan: { type: "object", properties: { candidateActivityId: { type: ["string", "null"] }, startTime: { type: "string" }, endTime: { type: "string" }, notes: { type: "string" } }, required: ["candidateActivityId", "startTime", "endTime", "notes"] } }, required: ["date", "dayNumber", "summary", "activities", "diningPlan"] } } }, required: ["days"] };

function minutes(value: string) { const [hours, mins] = value.split(":").map(Number); return hours * 60 + mins; }
export function validateModelItinerary(model: ItineraryModel, config: TripConfig, candidates: CandidateActivity[]): DraftItinerary {
  const dates = inclusiveTripDates(config); const available = new Map(candidates.map(candidate => [candidate.id, candidate])); const used = new Set<string>();
  if (model.days.length !== dates.length || model.days.some((day, index) => day.date !== dates[index] || day.dayNumber !== index + 1)) throw new Error("model itinerary does not cover the exact trip dates");
  const selectedGroups = new Set<string>();
  const draft = { destination: config.destination, startDate: config.startDate, endDate: config.endDate, status: "draft" as const, days: model.days.map(day => {
    let lastEnd = -1; const slots: Array<{ start: number; end: number }> = [];
    if (!isEnglishFacing(day.summary)) throw new Error("itinerary summaries must be in English");
    const activities = day.activities.map(activity => {
      const candidate = available.get(activity.candidateActivityId); if (!candidate) throw new Error(`model referenced unknown candidate ${activity.candidateActivityId}`);
      if (used.has(candidate.id)) throw new Error(`model duplicated candidate ${candidate.id}`); used.add(candidate.id);
      const start = minutes(activity.startTime); const end = minutes(activity.endTime); if (end <= start || start < lastEnd) throw new Error("overlapping or invalid itinerary times"); lastEnd = end; slots.push({ start, end });
      if (candidate.category === "restaurant" && /allergy-safe|peanut-safe/i.test(activity.notes) && candidate.unverifiedFields.some(field => /allergy/i.test(field))) throw new Error("model overstated unverified allergy safety");
      if (!isEnglishFacing(activity.notes)) throw new Error("itinerary notes must be in English");
      selectedGroups.add(activityGroup(candidate));
      return { ...candidate, startTime: activity.startTime, endTime: activity.endTime, notes: activity.notes, verificationStatus: "unvalidated" as const };
    });
    const diningCandidate = day.diningPlan.candidateActivityId === null ? null : available.get(day.diningPlan.candidateActivityId) ?? null;
    if (day.diningPlan.candidateActivityId !== null && !diningCandidate) throw new Error("model referenced an unknown dining candidate");
    if (diningCandidate) { if (used.has(diningCandidate.id)) throw new Error(`model duplicated candidate ${diningCandidate.id}`); used.add(diningCandidate.id); }
    if (!isEnglishFacing(day.diningPlan.notes)) throw new Error("dining notes must be in English");
    if (diningCandidate && /allergy-safe|peanut-safe/i.test(day.diningPlan.notes) && diningCandidate.unverifiedFields.some(field => /allergy/i.test(field))) throw new Error("model overstated unverified allergy safety");
    const diningStart = minutes(day.diningPlan.startTime); const diningEnd = minutes(day.diningPlan.endTime); if (diningEnd <= diningStart) throw new Error("invalid dining time"); slots.push({ start: diningStart, end: diningEnd });
    const ordered = [...slots].sort((a, b) => a.start - b.start); if (ordered.some((slot, index) => index > 0 && slot.start < ordered[index - 1]!.end)) throw new Error("overlapping or invalid itinerary times");
    const span = ordered.at(-1)!.end - ordered[0]!.start;
    const longestActivity = Math.max(...activities.map(activity => minutes(activity.endTime) - minutes(activity.startTime)));
    if (span < 360) throw new Error("each day needs at least six hours of planned coverage");
    if (activities.length < 2 && longestActivity < 300) throw new Error("each day needs multiple activities unless it has a five-hour anchor experience");
    return { date: day.date, dayNumber: day.dayNumber, summary: day.summary, activities, diningPlan: { candidate: diningCandidate, startTime: day.diningPlan.startTime, endTime: day.diningPlan.endTime, notes: day.diningPlan.notes, verificationStatus: "unvalidated" as const } };
  }) };
  const selectedNonFood = draft.days.flatMap(day => day.activities);
  const cultureCount = selectedNonFood.filter(activity => activityGroup(activity) === "culture").length;
  const viableNonCulture = candidates.filter(candidate => activityGroup(candidate) !== "culture" && activityGroup(candidate) !== "food").length;
  if (hasUsefulTripVariety(candidates) && selectedGroups.size < 2) throw new Error("itinerary ignored the available category variety");
  if (viableNonCulture >= Math.ceil(selectedNonFood.length / 2) && cultureCount > Math.ceil(selectedNonFood.length / 2)) throw new Error("itinerary overused culture activities despite varied researched alternatives");
  return draft;
}

export async function generateDraftItinerary(config: TripConfig, candidates: CandidateActivity[], provider: LLMProvider = new GeminiProvider()): Promise<DraftItinerary> {
  const context = JSON.stringify({ config, candidates }); let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) try {
    const raw = await provider.complete({ system: "Create a lively, duration-aware draft itinerary for a younger group using ONLY supplied candidateActivityId values. Use a varied mix across culture, neighborhoods, outdoors, food, and local/social experiences whenever the candidates support it; do not make the trip museum-only. Every date needs substantial planned coverage plus a diningPlan, but NEVER use a fixed daily timetable: vary start and end times according to researched opening hours, reservation timing, activity duration, and whether an evening experience is selected. A day may start early for a market or tour, later for an evening plan, or finish at night; do not force 10:00 starts or 16:00 endings. A long five-hour anchor can be the only activity; otherwise include at least two activities. Give every activity and dining plan non-overlapping tentative local times in chronological order. diningPlan.candidateActivityId may be null only for an explicit English recommendation to confirm a nearby vegetarian option and peanut cross-contact directly with the venue. Do not invent a place, factual field, source, distance, or safety claim. All summaries and notes must be clear English, translating source-derived wording faithfully where necessary. Return JSON only.", messages: [{ role: "user", content: context }], schema, tier: "smart", thinkingBudget: 0 });
    return validateModelItinerary(ItineraryModelSchema.parse(JSON.parse(raw)), config, candidates);
  } catch (error) { lastError = error; }
  throw new Error(`itinerary model output was invalid after retry: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

/** Explicit development-only companion to mock research; it never runs in real mode. */
export function generateMockDraftItinerary(config: TripConfig, candidates: CandidateActivity[]): DraftItinerary {
  const dates = inclusiveTripDates(config);
  if (candidates.length < dates.length) throw new Error("mock research does not contain enough candidates");
  if (candidates.length < dates.length * 2) throw new Error("mock research does not contain enough candidates for duration-aware days");
  return validateModelItinerary({ days: dates.map((date, index) => ({ date, dayNumber: index + 1, summary: "Development-only draft. Confirm venue suitability and availability before using.", activities: [{ candidateActivityId: candidates[index * 2]!.id, startTime: "10:00", endTime: "12:00", notes: "Unvalidated development draft; no schedule or safety claim is implied." }, { candidateActivityId: candidates[index * 2 + 1]!.id, startTime: "13:30", endTime: "17:00", notes: "Unvalidated development draft; no schedule or safety claim is implied." }], diningPlan: { candidateActivityId: null, startTime: "12:00", endTime: "13:30", notes: "Choose a nearby vegetarian option and confirm peanut cross-contact directly with the venue." } })) }, config, candidates);
}
