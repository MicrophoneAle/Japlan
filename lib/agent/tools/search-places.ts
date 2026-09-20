import { z } from "zod";
import { searchPlaces } from "@/lib/places/foursquare";
import { getServiceClient } from "@/lib/db/client";
import type { DestinationProfile } from "@/lib/game/destination";
import { foursquareCandidate } from "@/lib/itinerary/fast-research";
import type { CandidateActivity } from "@/lib/itinerary/schemas";
import type { AgentTool, AgentToolResult } from "../types";

export const SearchPlacesArgsSchema = z.object({
  query: z.string().min(1).max(200),
  near: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

function profileCandidates(
  profile: DestinationProfile | null,
  destination: string,
  query: string,
): CandidateActivity[] {
  if (!profile) return [];
  const q = query.toLowerCase();
  const out: CandidateActivity[] = [];
  let index = 0;
  for (const landmark of profile.landmarks) {
    const hay = `${landmark.name} ${landmark.category ?? ""}`.toLowerCase();
    if (q && !hay.includes(q) && !q.split(/\s+/).some((w) => w.length > 2 && hay.includes(w))) {
      // Keep a broad "attractions" style query from matching everything.
      if (!/attraction|landmark|place|nearby|things to do/i.test(query)) continue;
    }
    out.push({
      id: `profile-${index}-${landmark.name.replace(/\W+/g, "-").slice(0, 40)}`,
      name: landmark.name,
      category: landmark.category ?? "landmark",
      description: `Trip landmark in ${destination}.`,
      destination,
      address: null,
      estimatedDurationMinutes: null,
      estimatedCost: null,
      priceLevel: "unknown",
      openingHours: null,
      accessibilityNotes: null,
      dietaryNotes: null,
      reservationRequired: null,
      sourceUrls: [`https://maps.google.com/?q=${encodeURIComponent(landmark.name + " " + destination)}`],
      unverifiedFields: ["address", "duration", "opening hours", "accessibility", "price"],
      translatedFromSource: false,
    });
    index += 1;
  }
  return out;
}

async function placesFromDb(tripId: string, query: string): Promise<CandidateActivity[]> {
  const { data, error } = await getServiceClient()
    .from("places")
    .select("id, name, category, lat, lng, source")
    .eq("trip_id", tripId)
    .limit(30);
  if (error || !data) return [];
  const q = query.toLowerCase();
  return (data as { id: string; name: string; category: string | null }[])
    .filter((row) => {
      const hay = `${row.name} ${row.category ?? ""}`.toLowerCase();
      return !q || hay.includes(q) || /attraction|place|nearby/i.test(query);
    })
    .map((row, index) => ({
      id: `place-${index}-${row.id}`,
      name: row.name,
      category: row.category ?? "place",
      description: `Saved place on this trip${row.category ? ` (${row.category})` : ""}.`,
      destination: "trip",
      address: null,
      estimatedDurationMinutes: null,
      estimatedCost: null,
      priceLevel: "unknown" as const,
      openingHours: null,
      accessibilityNotes: null,
      dietaryNotes: null,
      reservationRequired: null,
      sourceUrls: [`https://maps.google.com/?q=${encodeURIComponent(row.name)}`],
      unverifiedFields: ["address", "duration", "opening hours", "accessibility"],
      translatedFromSource: false,
    }));
}

export const searchPlacesTool: AgentTool = {
  name: "search_places",
  description:
    "Find real venues. Lab: live Foursquare discovery. Chat: only places already on the trip profile or saved places (no live Foursquare). Returns source-backed candidates with ids.",
  parameters: SearchPlacesArgsSchema,
  capabilities: "both",
  async execute(raw, ctx): Promise<AgentToolResult> {
    const args = SearchPlacesArgsSchema.parse(raw);
    const limit = args.limit ?? 10;

    if (ctx.capability === "lab") {
      const near = args.near ?? ctx.tripConfig?.destination;
      if (!near) {
        return { result: { ok: false, reason: "need_destination" }, candidates: [] };
      }
      const places = await searchPlaces({ near, query: args.query, limit });
      const candidates = places.map((place, index) =>
        foursquareCandidate(
          place,
          ctx.tripConfig ?? {
            destination: near,
            startDate: "2026-01-01",
            endDate: "2026-01-02",
            groupSize: 1,
            budget: "medium",
            foodPreferences: { dietaryRestrictions: [], allergies: [] },
            accessibilityPreferences: { mobilityRestrictions: [], physicalLimitations: [] },
          },
          index,
        ),
      );
      return {
        result: {
          ok: true,
          source: "foursquare",
          count: candidates.length,
          candidates: candidates.map((c) => ({
            id: c.id,
            name: c.name,
            category: c.category,
            unverifiedFields: c.unverifiedFields,
          })),
        },
        candidates,
      };
    }

    // Webhook: profile + DB only. Never call live Foursquare here.
    const trip = ctx.trip ?? ctx.miss?.trip;
    if (!trip) {
      return { result: { ok: false, reason: "no_trip" }, candidates: [] };
    }
    const destination = trip.destination ?? "the trip";
    const profile = (trip.destination_profile_json ?? null) as DestinationProfile | null;
    const fromProfile = profileCandidates(profile, destination, args.query);
    const fromDb = await placesFromDb(trip.id, args.query);
    const merged = [...fromProfile, ...fromDb].slice(0, limit);
    return {
      result: {
        ok: true,
        source: "trip_profile",
        count: merged.length,
        candidates: merged.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          unverifiedFields: c.unverifiedFields,
        })),
        note: "Live Foursquare is not available on the chat path; these are places the trip already knows.",
      },
      candidates: merged,
    };
  },
};
