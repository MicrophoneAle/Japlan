import type { ResearchSnapshot } from "./schemas";
import type { TripConfig } from "./config";

export function mockResearch(config: TripConfig): ResearchSnapshot {
  const source = "https://www.toronto.ca/explore-enjoy/";
  const restaurantSource = "https://www.destinationtoronto.com/restaurants/";
  return { mode: "mock", status: "researched", sessionId: null, dashboardUrl: null, visitedUrls: [source, restaurantSource], error: null,
    actions: [{ at: new Date().toISOString(), type: "search", detail: `Development fixture research for ${config.destination}`, url: source }, { at: new Date().toISOString(), type: "extract", detail: "Loaded deterministic development candidates; factual fields not independently verified.", url: restaurantSource }],
    candidates: [
      { id: "mock-ago", name: "Art Gallery of Ontario", category: "attraction", description: "Development candidate; confirm current access details before use.", destination: config.destination, address: null, estimatedDurationMinutes: null, estimatedCost: null, priceLevel: "unknown", openingHours: null, accessibilityNotes: null, dietaryNotes: null, reservationRequired: null, sourceUrls: [source], unverifiedFields: ["address", "duration", "cost", "hours", "accessibility"] },
      { id: "mock-rom", name: "Royal Ontario Museum", category: "attraction", description: "Development candidate; confirm current access details before use.", destination: config.destination, address: null, estimatedDurationMinutes: null, estimatedCost: null, priceLevel: "unknown", openingHours: null, accessibilityNotes: null, dietaryNotes: null, reservationRequired: null, sourceUrls: [source], unverifiedFields: ["address", "duration", "cost", "hours", "accessibility"] },
      { id: "mock-harbourfront", name: "Harbourfront Centre", category: "experience", description: "Development candidate; confirm date-specific programming before use.", destination: config.destination, address: null, estimatedDurationMinutes: null, estimatedCost: null, priceLevel: "unknown", openingHours: null, accessibilityNotes: null, dietaryNotes: null, reservationRequired: null, sourceUrls: [source], unverifiedFields: ["address", "duration", "cost", "hours", "accessibility", "seasonal availability"] },
      { id: "mock-dining", name: "Vegetarian dining recommendation", category: "restaurant", description: "Unresolved dining placeholder. Verify vegetarian choices and peanut cross-contact directly with a venue.", destination: config.destination, address: null, estimatedDurationMinutes: null, estimatedCost: null, priceLevel: "unknown", openingHours: null, accessibilityNotes: null, dietaryNotes: "Vegetarian and peanut cross-contact information is unverified.", reservationRequired: null, sourceUrls: [restaurantSource], unverifiedFields: ["venue", "allergy safety", "hours", "cost", "accessibility"] },
    ] };
}
