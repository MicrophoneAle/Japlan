import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentTripConfig, inclusiveTripDates, researchMode } from "./config";
import { generateDraftItinerary, generateMockDraftItinerary, validateModelItinerary } from "./generate";
import { mockResearch } from "./mock-research";
import type { LLMProvider } from "@/lib/llm";

afterEach(() => { vi.unstubAllEnvs(); });
describe("itinerary draft boundaries", () => {
  it("uses inclusive calendar days without a UTC off-by-one", () => expect(inclusiveTripDates(developmentTripConfig)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]));
  it("marks deterministic research as mock and preserves uncertainty", () => { const result = mockResearch(developmentTripConfig); expect(result.candidates).toHaveLength(4); expect(result.candidates.every(candidate => candidate.sourceUrls.length > 0)).toBe(true); expect(result.candidates.find(candidate => candidate.id === "mock-dining")?.unverifiedFields).toContain("allergy safety"); });
  it("never permits mock research in production", () => { vi.stubEnv("ITINERARY_RESEARCH_MODE", "mock"); vi.stubEnv("NODE_ENV", "production"); expect(() => researchMode()).toThrow(/not permitted/); });
  it("rejects a model reference that did not come from research", () => expect(() => validateModelItinerary({ days: inclusiveTripDates(developmentTripConfig).map((date, i) => ({ date, dayNumber: i + 1, summary: "day", activities: [{ candidateActivityId: "invented", startTime: null, endTime: null, notes: "" }] })) }, developmentTripConfig, mockResearch(developmentTripConfig).candidates)).toThrow(/unknown candidate/));
  it("uses the model only to choose research candidates", async () => { const candidates = mockResearch(developmentTripConfig).candidates; const provider: LLMProvider = { complete: async () => JSON.stringify({ days: inclusiveTripDates(developmentTripConfig).map((date, i) => ({ date, dayNumber: i + 1, summary: "draft", activities: [{ candidateActivityId: candidates[i].id, startTime: "10:00", endTime: "11:00", notes: "unvalidated draft" }] })) }) }; const itinerary = await generateDraftItinerary(developmentTripConfig, candidates, provider); expect(itinerary.days).toHaveLength(3); expect(itinerary.days.flatMap(day => day.activities).every(activity => candidates.some(candidate => candidate.id === activity.id))).toBe(true); });
  it("keeps explicit mock generation deterministic and draft-only", () => { const draft = generateMockDraftItinerary(developmentTripConfig, mockResearch(developmentTripConfig).candidates); expect(draft.status).toBe("draft"); expect(draft.days).toHaveLength(3); expect(draft.days.every(day => day.activities[0]?.verificationStatus === "unvalidated")).toBe(true); });
});
