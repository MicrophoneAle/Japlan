import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import {
  categoryIdsForBuckets,
  type InterestBucket,
} from "@/lib/places/categories";
import { searchPlaces, type FoursquarePlace } from "@/lib/places/foursquare";

export type ProfileNeighborhood = {
  name: string;
  lat: number | null;
  lng: number | null;
};

export type ProfileLandmark = {
  name: string;
  lat: number | null;
  lng: number | null;
  category: string | null;
};

export type DestinationProfile = {
  assembled_at: string;
  destination: string;
  neighborhoods: ProfileNeighborhood[];
  transit_lines: string[];
  dishes: string[];
  landmarks: ProfileLandmark[];
  price_bands: number[];
  center: { lat: number; lng: number } | null;
  // Set by the organizer setup when the destination changes: only the name
  // and centre are known. assembleDestinationProfile treats it as a cache miss
  // and tries Foursquare, and falls back to it if that fails.
  partial?: boolean;
};

export function partialDestinationProfile(
  destination: string,
  center: { lat: number; lng: number } | null,
): DestinationProfile {
  return {
    assembled_at: new Date().toISOString(),
    destination,
    neighborhoods: [],
    transit_lines: [],
    dishes: [],
    landmarks: [],
    price_bands: [],
    center,
    partial: true,
  };
}

function interestBuckets(people: ParticipantRow[]): InterestBucket[] {
  const buckets = new Set<InterestBucket>(["outdoors", "culture"]);
  for (const person of people) {
    const answers = (person.survey_json ?? {}) as SurveyAnswers;
    const interests = answerValue(answers, "interests");
    if (interests === "food_heavy" || interests === "balanced" || !interests) {
      buckets.add("food");
    }
    if (answerValue(answers, "nightlife") === "yes") {
      buckets.add("nightlife");
    }
  }
  return [...buckets];
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function looksLikeTransit(name: string, categories: string[]): boolean {
  const blob = `${name} ${categories.join(" ")}`.toLowerCase();
  return /\b(station|metro|subway|tram|rail|line|bus)\b/.test(blob);
}

export function profileFromPlaces(
  destination: string,
  foursquare: FoursquarePlace[],
  chatPlaces: {
    name: string;
    lat: number | null;
    lng: number | null;
    category: string | null;
  }[],
): DestinationProfile {
  const neighborhoods: ProfileNeighborhood[] = [];
  const landmarks: ProfileLandmark[] = [];
  const dishes: string[] = [];
  const transit: string[] = [];
  const prices: number[] = [];
  const coords: { lat: number; lng: number }[] = [];

  for (const place of foursquare) {
    if (place.neighborhood) {
      neighborhoods.push({
        name: place.neighborhood,
        lat: place.latitude,
        lng: place.longitude,
      });
    }
    if (place.latitude !== null && place.longitude !== null) {
      coords.push({ lat: place.latitude, lng: place.longitude });
    }
    if (place.price !== null) prices.push(place.price);
    dishes.push(...place.tastes);
    if (looksLikeTransit(place.name, place.categories)) {
      transit.push(place.name);
    } else {
      landmarks.push({
        name: place.name,
        lat: place.latitude,
        lng: place.longitude,
        category: place.categories[0] ?? null,
      });
    }
  }

  for (const place of chatPlaces) {
    landmarks.push({
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      category: place.category,
    });
    if (place.lat !== null && place.lng !== null) {
      coords.push({ lat: place.lat, lng: place.lng });
    }
  }

  const center =
    coords.length === 0
      ? null
      : {
          lat: coords.reduce((sum, c) => sum + c.lat, 0) / coords.length,
          lng: coords.reduce((sum, c) => sum + c.lng, 0) / coords.length,
        };

  const namedNeighborhoods = new Map<string, ProfileNeighborhood>();
  for (const row of neighborhoods) {
    const key = row.name.toLowerCase();
    if (!namedNeighborhoods.has(key)) namedNeighborhoods.set(key, row);
  }

  return {
    assembled_at: new Date().toISOString(),
    destination,
    neighborhoods: [...namedNeighborhoods.values()].slice(0, 12),
    transit_lines: uniq(transit).slice(0, 8),
    dishes: uniq(dishes).slice(0, 12),
    landmarks: landmarks.slice(0, 12),
    price_bands: [...new Set(prices)].sort((a, b) => a - b),
    center,
  };
}

async function existingChatPlaces(tripId: string): Promise<{
  name: string;
  lat: number | null;
  lng: number | null;
  category: string | null;
}[]> {
  const { data, error } = await getServiceClient()
    .from("places")
    .select("name, lat, lng, category, source")
    .eq("trip_id", tripId);
  if (error) throw error;
  return (data ?? [])
    .filter((row) => (row as { source: string | null }).source !== "foursquare")
    .map((row) => ({
      name: (row as { name: string }).name,
      lat: (row as { lat: number | null }).lat,
      lng: (row as { lng: number | null }).lng,
      category: (row as { category: string | null }).category,
    }));
}

async function cacheFoursquarePlaces(
  tripId: string,
  places: FoursquarePlace[],
): Promise<void> {
  if (places.length === 0) return;
  const rows = places.map((place) => ({
    trip_id: tripId,
    fsq_place_id: place.fsq_place_id,
    name: place.name,
    lat: place.latitude,
    lng: place.longitude,
    category: place.categories[0] ?? null,
    source: "foursquare",
    hours_json: place.hours_json,
    price_band: place.price,
  }));
  const { error } = await getServiceClient()
    .from("places")
    .upsert(rows, { onConflict: "trip_id,fsq_place_id" });
  if (error) throw error;
}

export function cachedDestinationProfile(
  trip: Pick<TripRow, "destination_profile_json">,
): DestinationProfile | null {
  const raw = trip.destination_profile_json;
  if (!raw || typeof raw !== "object") return null;
  return raw as DestinationProfile;
}

export function needsFoursquareFetch(
  trip: Pick<TripRow, "destination_profile_json">,
): boolean {
  return cachedDestinationProfile(trip) === null;
}

export async function loadDestinationProfile(
  trip: TripRow,
): Promise<DestinationProfile | null> {
  return cachedDestinationProfile(trip);
}

export async function assembleDestinationProfile(opts: {
  trip: TripRow;
  people: ParticipantRow[];
}): Promise<DestinationProfile> {
  const cached = await loadDestinationProfile(opts.trip);
  if (cached && !cached.partial) {
    console.info("[japlan.destination] using cached profile", {
      tripId: opts.trip.id,
    });
    return cached;
  }

  const destination = opts.trip.destination?.trim();
  if (!destination) {
    throw new Error("trip.destination is empty; cannot assemble a profile");
  }

  const chatPlaces = await existingChatPlaces(opts.trip.id);
  const buckets = interestBuckets(opts.people);
  const categoryIds = categoryIdsForBuckets(buckets);

  // Two batched searches at trip-profile time. Never call this from the webhook.
  let byInterest: FoursquarePlace[];
  let landmarks: FoursquarePlace[];
  try {
    [byInterest, landmarks] = await Promise.all([
      searchPlaces({
        near: destination,
        fsq_category_ids: categoryIds.join(","),
        limit: 20,
      }),
      searchPlaces({
        near: destination,
        query: "landmark",
        limit: 10,
      }),
    ]);
  } catch (err) {
    // A destination changed mid-trip must not stop the board: generate from
    // the name and centre alone until Foursquare answers.
    if (cached?.partial) {
      console.error("[japlan.destination] refresh failed; using partial profile", {
        tripId: opts.trip.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return cached;
    }
    throw err;
  }

  const byId = new Map<string, FoursquarePlace>();
  for (const place of [...byInterest, ...landmarks]) {
    byId.set(place.fsq_place_id, place);
  }
  const merged = [...byId.values()];
  await cacheFoursquarePlaces(opts.trip.id, merged);

  const profile = profileFromPlaces(destination, merged, chatPlaces);
  const { error } = await getServiceClient()
    .from("trips")
    .update({ destination_profile_json: profile })
    .eq("id", opts.trip.id);
  if (error) throw error;
  return profile;
}
