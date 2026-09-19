export const PLACES_API_BASE = "https://places-api.foursquare.com";

export type FoursquareSearchParams = {
  query?: string;
  ll?: string;
  near?: string;
  radius?: number;
  fsq_category_ids?: string;
  limit?: number;
};

export function placesHeaders(): HeadersInit {
  const apiKey = process.env.FOURSQUARE_API_KEY;
  const version = process.env.FOURSQUARE_API_VERSION;
  if (!apiKey) throw new Error("missing FOURSQUARE_API_KEY");
  if (!version) throw new Error("missing FOURSQUARE_API_VERSION");

  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Places-Api-Version": version,
  };
}

export async function searchPlaces(
  params: FoursquareSearchParams,
): Promise<unknown> {
  void params;
  throw new Error("not implemented");
}
