import { getServiceClient } from "@/lib/db/client";
import type { TripConfig } from "./config";
import type { DraftItinerary, ResearchSnapshot } from "./schemas";

export type SavedGeneration = { generationId: string; itinerary: DraftItinerary; research: ResearchSnapshot };

export async function saveDraftGeneration(tripId: string, config: TripConfig, research: ResearchSnapshot, itinerary: DraftItinerary): Promise<SavedGeneration> {
  const db = getServiceClient();
  const generation = await db.from("itinerary_generations").insert({ trip_id: tripId, status: "saving", mode: research.mode, config_json: config, research_json: research, browserbase_session_id: research.sessionId, browserbase_dashboard_url: research.dashboardUrl }).select("id").single();
  if (generation.error || !generation.data) throw generation.error ?? new Error("could not create itinerary generation");
  const generationId = generation.data.id as string;
  try {
    const places = itinerary.days.flatMap(day => day.activities.map(activity => ({ trip_id: tripId, name: activity.name, category: activity.category, source: "itinerary-research", hours_json: activity.openingHours ? { raw: activity.openingHours } : null, source_metadata: { candidateId: activity.id, sourceUrls: activity.sourceUrls, description: activity.description, address: activity.address, estimatedCost: activity.estimatedCost, priceLevel: activity.priceLevel, accessibilityNotes: activity.accessibilityNotes, dietaryNotes: activity.dietaryNotes, unverifiedFields: activity.unverifiedFields } })));
    const placed = await db.from("places").insert(places).select("id, source_metadata");
    if (placed.error || !placed.data) throw placed.error ?? new Error("could not save researched places");
    const placeByCandidate = new Map((placed.data as Array<{ id: string; source_metadata: { candidateId: string } }>).map(place => [place.source_metadata.candidateId, place.id]));
    const stops = itinerary.days.flatMap(day => day.activities.map((activity, index) => ({ trip_id: tripId, day: day.dayNumber, anchor_order: index + 1, place_id: placeByCandidate.get(activity.id), planned_time: activity.startTime ? `${day.date}T${activity.startTime}:00` : null, planned_end_time: activity.endTime ? `${day.date}T${activity.endTime}:00` : null, draft_status: "draft", draft_generation_id: generationId })));
    if (stops.some(stop => !stop.place_id)) throw new Error("saved place did not map to candidate");
    const savedStops = await db.from("itinerary").insert(stops);
    if (savedStops.error) throw savedStops.error;
    // Existing draft remains intact until the complete replacement is stored.
    const retired = await db.from("itinerary").delete().eq("trip_id", tripId).eq("draft_status", "draft").neq("draft_generation_id", generationId);
    if (retired.error) throw retired.error;
    const completed = await db.from("itinerary_generations").update({ status: "complete", itinerary_json: itinerary, completed_at: new Date().toISOString() }).eq("id", generationId);
    if (completed.error) throw completed.error;
    return { generationId, itinerary, research };
  } catch (error) {
    await db.from("itinerary_generations").update({ status: "failed", error_text: error instanceof Error ? error.message : "save failed" }).eq("id", generationId);
    throw error;
  }
}

export async function latestGeneration(tripId: string): Promise<SavedGeneration | null> {
  const result = await getServiceClient().from("itinerary_generations").select("id, itinerary_json, research_json").eq("trip_id", tripId).eq("status", "complete").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw result.error; if (!result.data?.itinerary_json || !result.data?.research_json) return null;
  return { generationId: result.data.id as string, itinerary: result.data.itinerary_json as DraftItinerary, research: result.data.research_json as ResearchSnapshot };
}
