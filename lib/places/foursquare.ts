export const PLACES_API_BASE = "https://places-api.foursquare.com";

export const SEARCH_FIELDS = [
  "fsq_place_id",
  "name",
  "latitude",
  "longitude",
  "location",
  "categories",
  "price",
  "tastes",
  "hours",
].join(",");

export type FoursquareSearchParams = {
  query?: string;
  ll?: string;
  near?: string;
  radius?: number;
  fsq_category_ids?: string;
  limit?: number;
  fields?: string;
};

export type FoursquarePlace = {
  fsq_place_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  neighborhood: string | null;
  locality: string | null;
  categories: string[];
  price: number | null;
  tastes: string[];
  hours_json: unknown;
  raw: Record<string, unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function neighborhoodFromLocation(location: unknown): string | null {
  if (!isRecord(location)) return null;
  const n = location.neighborhood;
  if (typeof n === "string") return n;
  if (Array.isArray(n) && typeof n[0] === "string") return n[0];
  return null;
}

export function parseFoursquarePlace(raw: unknown): FoursquarePlace | null {
  if (!isRecord(raw)) return null;
  const fsq_place_id = stringField(raw.fsq_place_id);
  const name = stringField(raw.name);
  if (!fsq_place_id || !name) return null;
  const categories = Array.isArray(raw.categories)
    ? raw.categories
        .map((entry) =>
          isRecord(entry) ? stringField(entry.name) : null,
        )
        .filter((value): value is string => Boolean(value))
    : [];
  const tastes = Array.isArray(raw.tastes)
    ? raw.tastes.filter((value): value is string => typeof value === "string")
    : [];
  return {
    fsq_place_id,
    name,
    latitude: numberField(raw.latitude),
    longitude: numberField(raw.longitude),
    neighborhood: neighborhoodFromLocation(raw.location),
    locality: isRecord(raw.location) ? stringField(raw.location.locality) : null,
    categories,
    price: numberField(raw.price),
    tastes,
    hours_json: raw.hours ?? null,
    raw,
  };
}

export async function searchPlaces(
  params: FoursquareSearchParams,
): Promise<FoursquarePlace[]> {
  const url = new URL("/places/search", PLACES_API_BASE);
  if (params.query) url.searchParams.set("query", params.query);
  if (params.ll) url.searchParams.set("ll", params.ll);
  if (params.near) url.searchParams.set("near", params.near);
  if (params.radius !== undefined) {
    url.searchParams.set("radius", String(params.radius));
  }
  if (params.fsq_category_ids) {
    url.searchParams.set("fsq_category_ids", params.fsq_category_ids);
  }
  url.searchParams.set("limit", String(params.limit ?? 20));
  url.searchParams.set("fields", params.fields ?? SEARCH_FIELDS);

  const res = await fetch(url, { headers: placesHeaders() });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Foursquare search HTTP ${res.status}: ${bodyText.slice(0, 400)}`);
  }
  const payload = JSON.parse(bodyText) as { results?: unknown };
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .map(parseFoursquarePlace)
    .filter((place): place is FoursquarePlace => place !== null);
}
