import { developmentTripConfig, researchMode } from "./config";
import { generateDraftItinerary, generateMockDraftItinerary } from "./generate";
import { researchActivities } from "./research";
import type { DraftItinerary, ResearchSnapshot } from "./schemas";

let generating = false;
export type DevelopmentGeneration = { itinerary: DraftItinerary; research: ResearchSnapshot };
export async function generateDevelopmentItinerary(): Promise<DevelopmentGeneration> {
  if (generating) throw new Error("itinerary generation is already running");
  generating = true;
  try { const mode = researchMode(); const research = await researchActivities(developmentTripConfig); const itinerary = mode === "mock" ? generateMockDraftItinerary(developmentTripConfig, research.candidates) : await generateDraftItinerary(developmentTripConfig, research.candidates); return { itinerary, research }; }
  finally { generating = false; }
}
