import type { ResearchSnapshot } from "./schemas";
import type { TripConfig } from "./config";

export function mockResearch(config: TripConfig): ResearchSnapshot {
  const source = "https://www.toronto.ca/explore-enjoy/";
  const restaurantSource = "https://www.destinationtoronto.com/restaurants/";
  const fixtures = [
    ["mock-ago", "Art Gallery of Ontario", "culture", "Development culture candidate; confirm current access details before use."],
    ["mock-waterfront", "Waterfront exploration", "outdoors", "Development outdoor candidate; confirm route and access details before use."],
    ["mock-market", "Local market visit", "neighborhood", "Development neighborhood candidate; confirm opening details before use."],
    ["mock-workshop", "Local creative workshop", "experience", "Development experience candidate; confirm availability before use."],
    ["mock-rom", "Royal Ontario Museum", "culture", "Development museum candidate; confirm current access details before use."],
    ["mock-park", "Public garden visit", "outdoors", "Development outdoor candidate; confirm route and access details before use."],
    ["mock-street", "Historic neighborhood stroll", "neighborhood", "Development neighborhood candidate; confirm reduced-walking options before use."],
    ["mock-music", "Live local music", "experience", "Development evening candidate; confirm accessibility and date-specific availability before use."],
    ["mock-dining", "Vegetarian dining recommendation", "restaurant", "Unresolved dining placeholder. Verify vegetarian choices and peanut cross-contact directly with a venue."],
    ["mock-cafe", "Vegetarian café recommendation", "restaurant", "Unresolved dining placeholder. Verify vegetarian choices and peanut cross-contact directly with a venue."],
  ] as const;
  return {
    mode: "mock", status: "researched", sessionId: null, dashboardUrl: null, visitedUrls: [source, restaurantSource], error: null,
    actions: [{ at: new Date().toISOString(), type: "search", detail: `Development fixture research for ${config.destination}`, url: source }, { at: new Date().toISOString(), type: "extract", detail: "Loaded deterministic development candidates; factual fields not independently verified.", url: restaurantSource }],
    candidates: fixtures.map(([id, name, category, description]) => ({ id, name, category, description, destination: config.destination, address: null, estimatedDurationMinutes: null, estimatedCost: null, priceLevel: "unknown" as const, openingHours: null, accessibilityNotes: null, dietaryNotes: category === "restaurant" ? "Vegetarian and peanut cross-contact information is unverified." : null, reservationRequired: null, sourceUrls: [category === "restaurant" ? restaurantSource : source], unverifiedFields: ["address", "duration", "cost", "hours", "accessibility", ...(category === "restaurant" ? ["allergy safety"] : [])], translatedFromSource: false })),
  };
}
