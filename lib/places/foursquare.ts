import { fetchWithTimeout } from "@/lib/timeout";

export const PLACES_API_BASE = "https://places-api.foursquare.com";

// Core fields only. photos, tips, rating, popularity, price, tastes, and
// hours are Premium on Places API and have no free tier.
export const SEARCH_FIELDS = [
  "fsq_place_id",
  "name",
  "latitude",
  "longitude",
  "location",
  "categories",
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

export type NearArea = {
  lat: number | null;
  lng: number | null;
  locality: string | null;
  region: string | null;
  country: string | null;
};

// Pure. A search with `near` returns the geocoded area as context.geo_bounds
// plus places inside it; either proves Foursquare understood the place.
export function parseNearArea(payload: unknown): NearArea | null {
  if (!isRecord(payload)) return null;
  const context = isRecord(payload.context) ? payload.context : null;
  const bounds = context && isRecord(context.geo_bounds) ? context.geo_bounds : null;
  const circle = bounds && isRecord(bounds.circle) ? bounds.circle : null;
  const center = circle && isRecord(circle.center) ? circle.center : null;
  const first = Array.isArray(payload.results) && isRecord(payload.results[0])
    ? payload.results[0]
    : null;
  const location = first && isRecord(first.location) ? first.location : null;
  const lat = numberField(center?.latitude) ?? numberField(first?.latitude);
  const lng = numberField(center?.longitude) ?? numberField(first?.longitude);
  if (lat === null && lng === null && !location) return null;
  return {
    lat,
    lng,
    locality: stringField(location?.locality),
    region: stringField(location?.region),
    country: stringField(location?.country),
  };
}

export const NEAR_TIMEOUT_MS = 6_000;
// Batched profile search, off the webhook path but still on the cron clock.
export const SEARCH_TIMEOUT_MS = 10_000;

// Resolve a free-text destination ("tokyo") to an area, for the organizer
// setup. One request per destination answer, at trip setup time. Null when
// Foursquare cannot place it or the call fails (including no credits); the
// caller then stores the raw string.
export async function resolveNearArea(text: string): Promise<NearArea | null> {
  const url = new URL("/places/search", PLACES_API_BASE);
  url.searchParams.set("near", text.trim().slice(0, 100));
  url.searchParams.set("limit", "1");
  url.searchParams.set("fields", "latitude,longitude,location");
  try {
    const res = await fetchWithTimeout(url, NEAR_TIMEOUT_MS, "foursquare.near", {
      headers: placesHeaders(),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error("[japlan.places] near did not resolve", {
        status: res.status,
        body: bodyText.slice(0, 200),
      });
      return null;
    }
    return parseNearArea(JSON.parse(bodyText));
  } catch (err) {
    console.error("[japlan.places] near failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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

  // Timed like resolveNearArea: this runs during board generation, and an
  // unbounded await here is the same silent-hang shape that cost four
  // outages. searchPlaces was the last raw fetch in this file.
  const res = await fetchWithTimeout(url, SEARCH_TIMEOUT_MS, "foursquare.search", {
    headers: placesHeaders(),
  });
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
