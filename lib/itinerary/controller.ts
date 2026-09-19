import { researchMode, resolveDevelopmentTrip } from "./config";
import { generateDraftItinerary, generateMockDraftItinerary } from "./generate";
import { researchActivities } from "./research";
import { saveDraftGeneration, type SavedGeneration } from "./repository";

const activeTrips = new Set<string>();
export async function generateItineraryForDevelopmentTrip(tripId: string): Promise<SavedGeneration> {
  if (activeTrips.has(tripId)) throw new Error("itinerary generation is already running for this trip");
  activeTrips.add(tripId);
  try { const config = resolveDevelopmentTrip(tripId); const mode = researchMode(); const research = await researchActivities(config); const itinerary = mode === "mock" ? generateMockDraftItinerary(config, research.candidates) : await generateDraftItinerary(config, research.candidates); return saveDraftGeneration(tripId, config, research, itinerary); }
  finally { activeTrips.delete(tripId); }
}
