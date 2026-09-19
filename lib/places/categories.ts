export type InterestBucket = "food" | "nightlife" | "outdoors" | "culture";

// Foursquare Category Taxonomy IDs. Survey buckets are a filter, not a prompt.
// https://docs.foursquare.com/data-products/docs/categories
export const FSQ_CATEGORY_IDS: Record<InterestBucket, string[]> = {
  food: ["4d4b7105d754a06374d81259"],
  nightlife: ["4d4b7105d754a06376d81259"],
  outdoors: ["4d4b7105d754a06377d81259"],
  culture: ["4d4b7104d754a06370d81259"],
};

export function categoryIdsForBuckets(buckets: InterestBucket[]): string[] {
  const ids = new Set<string>();
  for (const bucket of buckets) {
    for (const id of FSQ_CATEGORY_IDS[bucket]) ids.add(id);
  }
  return [...ids];
}
