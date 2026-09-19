import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentTripConfig, inclusiveTripDates, researchMode } from "./config";
import { generateDraftItinerary, generateMockDraftItinerary, validateModelItinerary } from "./generate";
import { mockResearch } from "./mock-research";
import { isExplicitlyIncompatible } from "./quality";
import type { LLMProvider } from "@/lib/llm";

function validModel(candidateIds: string[]) {
  return { days: inclusiveTripDates(developmentTripConfig).map((date, index) => ({
    date, dayNumber: index + 1, summary: "A varied day of discovery.",
    activities: [{ candidateActivityId: candidateIds[index * 2]!, startTime: "10:00", endTime: "12:00", notes: "Tentative draft timing." }, { candidateActivityId: candidateIds[index * 2 + 1]!, startTime: "13:30", endTime: "17:00", notes: "Tentative draft timing." }],
    diningPlan: { candidateActivityId: null, startTime: "12:00", endTime: "13:30", notes: "Choose a nearby vegetarian option and confirm peanut cross-contact directly with the venue." },
  })) };
}

afterEach(() => { vi.unstubAllEnvs(); });
describe("itinerary draft boundaries", () => {
  it("uses inclusive calendar days without a UTC off-by-one", () => {
    const dates = inclusiveTripDates(developmentTripConfig);
    expect(dates[0]).toBe(developmentTripConfig.startDate);
    expect(dates.at(-1)).toBe(developmentTripConfig.endDate);
  });
  it("marks deterministic research as mock, varied, and uncertain", () => {
    const result = mockResearch(developmentTripConfig);
    expect(result.candidates.length).toBeGreaterThanOrEqual(inclusiveTripDates(developmentTripConfig).length * 2);
    expect(result.candidates.every(candidate => candidate.sourceUrls.length > 0)).toBe(true);
    expect(result.candidates.find(candidate => candidate.id === "mock-dining")?.unverifiedFields).toContain("allergy safety");
  });
  it("never permits mock research in production", () => { vi.stubEnv("ITINERARY_RESEARCH_MODE", "mock"); vi.stubEnv("NODE_ENV", "production"); expect(() => researchMode()).toThrow(/not permitted/); });
  it("removes candidates that explicitly require extensive walking", () => {
    const walkingTour = { ...mockResearch(developmentTripConfig).candidates[0]!, name: "Historic walking tour", description: "Requires 90 minutes walking through back alleys and bridges." };
    expect(isExplicitlyIncompatible(walkingTour, developmentTripConfig)).toBe(true);
  });
  it("rejects a model reference that did not come from research", () => {
    const model = validModel(mockResearch(developmentTripConfig).candidates.map(candidate => candidate.id));
    model.days[0]!.activities[0]!.candidateActivityId = "invented";
    expect(() => validateModelItinerary(model, developmentTripConfig, mockResearch(developmentTripConfig).candidates)).toThrow(/unknown candidate/);
  });
  it("rejects sparse and untranslated daily plans", () => {
    const candidates = mockResearch(developmentTripConfig).candidates;
    const sparse = validModel(candidates.map(candidate => candidate.id));
    sparse.days[0]!.activities = [sparse.days[0]!.activities[0]!];
    expect(() => validateModelItinerary(sparse, developmentTripConfig, candidates)).toThrow(/six hours|multiple activities/);
    const untranslated = validModel(candidates.map(candidate => candidate.id));
    untranslated.days[0]!.summary = "東京の一日";
    expect(() => validateModelItinerary(untranslated, developmentTripConfig, candidates)).toThrow(/English/);
  });
  it("uses the model only to choose source-backed candidates with full-day coverage", async () => {
    const candidates = mockResearch(developmentTripConfig).candidates;
    const provider: LLMProvider = { complete: async () => JSON.stringify(validModel(candidates.map(candidate => candidate.id))) };
    const itinerary = await generateDraftItinerary(developmentTripConfig, candidates, provider);
    expect(itinerary.days).toHaveLength(inclusiveTripDates(developmentTripConfig).length);
    expect(itinerary.days.every(day => day.activities.length >= 2 && day.diningPlan.notes.length > 0)).toBe(true);
  });
  it("keeps explicit mock generation duration-aware and draft-only", () => {
    const draft = generateMockDraftItinerary(developmentTripConfig, mockResearch(developmentTripConfig).candidates);
    expect(draft.status).toBe("draft");
    expect(draft.days).toHaveLength(inclusiveTripDates(developmentTripConfig).length);
    expect(draft.days.every(day => day.activities[0]?.verificationStatus === "unvalidated" && day.diningPlan.candidate === null)).toBe(true);
  });
});
