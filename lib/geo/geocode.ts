// A place name to coordinates, so a link someone posted lands on the right
// day instead of a plausible one.
//
// Nominatim (OpenStreetMap). Keyless, open data, same class of source as
// Nager.Date for holidays and Open-Meteo for weather. Adapter only: no game
// logic, no database, and it never throws.
//
// MEASURED 2026-10-04, and it decides the shape of this file:
//   "Ramen Break Beats, Tokyo"                  -> HIT, the exact shop
//   "Vegan Ramen UZU Kyoto"                     -> HIT, the exact shop
//   "〒153-0063 Tokyo, Meguro City, 4 Chome−21−19" -> MISS
//   "Meguro 4-21-19, Meguro City, Tokyo, Japan" -> MISS
//
// So we geocode the VENUE NAME plus its city, never the street address. That
// is the opposite of the obvious approach: the address is the part Nominatim
// cannot read, and the name is the part it can. The address we capture from a
// caption is still stored on the place, it just is not the lookup key.
//
// Venue precision or nothing. A result that is really a city or a province is
// rejected rather than used, because placing a suggestion at the city centre
// is a guess dressed up as an answer, and guessing a day is worse than saying
// we do not know.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 6_000;
// Nominatim's usage policy is one request a second and a User-Agent that
// identifies the app. Both are honoured here.
const MIN_GAP_MS = 1_100;
const USER_AGENT = "japlan-trip-bot/1.0 (group trip planner; https://github.com/MicrophoneAle/japlan)";
// place_rank is how specific a match is: 30 is a building or POI, the teens
// are cities and administrative areas. Below this we did not find the venue.
const MIN_PLACE_RANK = 20;
// A venue name can collide across the world ("Blue Bottle"). A hit further
// than this from the trip is the wrong one.
const MAX_KM_FROM_TRIP = 150;

export type GeoPoint = { lat: number; lng: number; label: string };

let lastCallAt = 0;

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.geocode] step", { step, ...fields });
}

async function paceRequests(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

function kmBetween(a: GeoPoint, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

type NominatimRow = {
  lat?: unknown;
  lon?: unknown;
  place_rank?: unknown;
  display_name?: unknown;
  category?: unknown;
};

// The venue, if we can find the venue. Null for anything vaguer than that.
export async function geocodePlace(opts: {
  name: string;
  city?: string | null;
  // The trip's centre, when known, so a same-named venue on another continent
  // is rejected instead of placed.
  near?: { lat: number; lng: number } | null;
}): Promise<GeoPoint | null> {
  const name = opts.name.trim();
  if (name.length < 2) return null;
  const query = opts.city?.trim() ? `${name}, ${opts.city.trim()}` : name;

  try {
    await paceRequests();
    const url =
      `${NOMINATIM}?q=${encodeURIComponent(query)}` +
      `&format=jsonv2&limit=1&addressdetails=0`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let rows: unknown;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
      });
      if (!res.ok) {
        step("not_ok", { status: res.status, query });
        return null;
      }
      rows = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const row = (Array.isArray(rows) ? rows[0] : null) as NominatimRow | null;
    if (!row) {
      step("miss", { query });
      return null;
    }
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    // A city or a prefecture is not the venue. Reject rather than guess.
    const rank = Number(row.place_rank);
    if (Number.isFinite(rank) && rank < MIN_PLACE_RANK) {
      step("too_vague", { query, place_rank: rank, got: String(row.display_name ?? "").slice(0, 60) });
      return null;
    }

    const found: GeoPoint = { lat, lng, label: String(row.display_name ?? query).slice(0, 120) };
    if (opts.near) {
      const km = kmBetween(found, opts.near);
      if (km > MAX_KM_FROM_TRIP) {
        step("too_far", { query, km: Math.round(km) });
        return null;
      }
    }
    step("hit", { query, lat: lat.toFixed(4), lng: lng.toFixed(4) });
    return found;
  } catch (err) {
    step("failed", { query, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
