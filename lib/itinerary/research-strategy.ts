export function itineraryResearchStrategy(): "fast" | "deep" {
  const strategy = process.env.ITINERARY_RESEARCH_STRATEGY ?? "fast";
  if (strategy !== "fast" && strategy !== "deep") {
    throw new Error("ITINERARY_RESEARCH_STRATEGY must be fast or deep");
  }
  return strategy;
}
