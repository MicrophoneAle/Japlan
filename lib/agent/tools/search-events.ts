import { z } from "zod";
import { eventsForTrip, type TripEvent } from "@/lib/handlers/show-suggestion";
import type { CandidateActivity } from "@/lib/itinerary/schemas";
import type { AgentTool, AgentToolResult } from "../types";

export const SearchEventsArgsSchema = z.object({
  query: z.string().max(200).optional(),
});

function eventCandidate(event: TripEvent, destination: string, index: number): CandidateActivity {
  const when = event.starts_at.slice(0, 16).replace("T", " ");
  return {
    id: `event-${index}-${event.id}`,
    name: event.name,
    category: event.category ?? "event",
    description: event.venue
      ? `${event.name} at ${event.venue} (${when}).`
      : `${event.name} (${when}).`,
    destination,
    address: event.venue,
    estimatedDurationMinutes: null,
    estimatedCost: event.price_note,
    priceLevel: "unknown",
    openingHours: when,
    accessibilityNotes: null,
    dietaryNotes: null,
    reservationRequired: true,
    sourceUrls: [event.url],
    unverifiedFields: [
      "duration",
      "accessibility",
      ...(event.price_note ? [] : ["price"]),
    ],
    translatedFromSource: false,
  };
}

export const searchEventsTool: AgentTool = {
  name: "search_events",
  description:
    "List ticketed events already stored for this trip (trip_events). Does not call Ticketmaster live. Returns source-backed candidates with ids and ticket urls when known.",
  parameters: SearchEventsArgsSchema,
  capabilities: "both",
  async execute(raw, ctx): Promise<AgentToolResult> {
    const args = SearchEventsArgsSchema.parse(raw);
    const trip = ctx.trip ?? ctx.miss?.trip;
    if (!trip) {
      return {
        result: {
          ok: true,
          source: "trip_events",
          count: 0,
          candidates: [],
          note: "No trip id available; event inventory lives in trip_events.",
        },
        candidates: [],
      };
    }
    const events = await eventsForTrip(trip);
    const q = (args.query ?? "").toLowerCase().trim();
    const filtered = q
      ? events.filter((e) =>
          `${e.name} ${e.venue ?? ""} ${e.category ?? ""}`.toLowerCase().includes(q),
        )
      : events;
    const destination = trip.destination ?? "the trip";
    const candidates = filtered.map((event, index) =>
      eventCandidate(event, destination, index),
    );
    return {
      result: {
        ok: true,
        source: "trip_events",
        count: candidates.length,
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          url: c.sourceUrls[0] ?? null,
          unverifiedFields: c.unverifiedFields,
        })),
      },
      candidates,
    };
  },
};
