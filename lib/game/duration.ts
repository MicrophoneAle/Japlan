// How long a task takes, from data we already have. No API: a hand-written
// venue table, straight-line distance between known coordinates, and the time
// it takes to work up to something bold.
//
//   minutes = venue_time(category) + travel_time(from, to) + friction_time(boldness)
//
// The model proposes the time axis; this estimate decides when they disagree
// by more than one band (reconcileTimeAxis). Same rule as points.

export type DurationBand = "sidequest" | "light" | "medium" | "challenging";

export const DURATION_BANDS: DurationBand[] = ["sidequest", "light", "medium", "challenging"];

// Lower bounds in minutes. A sidequest is under ~20 minutes; even a light
// task takes meaningfully longer.
export const BAND_START_MINUTES: Record<DurationBand, number> = {
  sidequest: 0,
  light: 20,
  medium: 45,
  challenging: 120,
};

export function bandForMinutes(minutes: number): DurationBand {
  if (minutes >= BAND_START_MINUTES.challenging) return "challenging";
  if (minutes >= BAND_START_MINUTES.medium) return "medium";
  if (minutes >= BAND_START_MINUTES.light) return "light";
  return "sidequest";
}

// Time axis 1 is a sidequest, 2 light, 3 medium, 4 and 5 challenging.
export function bandForTimeAxis(time: number): DurationBand {
  if (time <= 1) return "sidequest";
  if (time === 2) return "light";
  if (time === 3) return "medium";
  return "challenging";
}

export function timeAxisForMinutes(minutes: number): number {
  if (minutes < BAND_START_MINUTES.light) return 1;
  if (minutes < BAND_START_MINUTES.medium) return 2;
  if (minutes < BAND_START_MINUTES.challenging) return 3;
  if (minutes < 240) return 4;
  return 5;
}

// What a time axis means in minutes when nothing better is known.
export const MINUTES_FOR_TIME_AXIS = [12, 32, 80, 180, 300];

export function minutesForTimeAxis(time: number): number {
  const index = Math.min(5, Math.max(1, Math.round(time))) - 1;
  return MINUTES_FOR_TIME_AXIS[index];
}

// Minutes spent at a venue, by the Foursquare category names that show up
// under the four parents we search (dining and drinking, nightlife,
// landmarks and outdoors, arts and entertainment). First match wins, so the
// specific rows come before the general ones. Restaurants go by price band.
type VenueRow = { match: RegExp; minutes: number | ((priceBand: number | null) => number) };

const RESTAURANT_BY_PRICE = [35, 35, 55, 80, 110];

export const VENUE_TIMES: VenueRow[] = [
  { match: /convenience|vending|kiosk/, minutes: 10 },
  { match: /bakery|dessert|ice cream|sweet|candy|snack|crepe|taiyaki/, minutes: 15 },
  { match: /street food|food stand|food truck|stall|standing/, minutes: 20 },
  { match: /coffee|caf[eé]|tea room|tea house|kissaten/, minutes: 30 },
  { match: /ramen|noodle|udon|soba/, minutes: 35 },
  { match: /izakaya/, minutes: 90 },
  { match: /food hall|market|fish market/, minutes: 45 },
  { match: /sushi|kaiseki|omakase|steak/, minutes: (p) => RESTAURANT_BY_PRICE[p ?? 3] ?? 80 },
  { match: /restaurant|diner|eatery|bistro|grill|yakitori|tonkatsu|okonomiyaki|food/, minutes: (p) => RESTAURANT_BY_PRICE[p ?? 2] ?? 55 },
  { match: /cocktail|wine bar|sake|beer|brewery|pub|\bbar\b/, minutes: 60 },
  { match: /karaoke|nightclub|club|live house/, minutes: 120 },
  { match: /department store|shopping mall|mall/, minutes: 60 },
  { match: /bookstore|record|thrift|vintage|boutique|shop|store/, minutes: 25 },
  { match: /arcade|game center|pachinko/, minutes: 40 },
  { match: /onsen|sento|bath|spa/, minutes: 75 },
  { match: /aquarium|zoo/, minutes: 150 },
  { match: /theme park|amusement/, minutes: 240 },
  { match: /museum/, minutes: 120 },
  { match: /gallery/, minutes: 60 },
  { match: /theater|theatre|cinema|concert|music venue|performing arts/, minutes: 150 },
  { match: /stadium|arena/, minutes: 180 },
  { match: /observation|tower|skyscraper/, minutes: 45 },
  { match: /viewpoint|scenic lookout|lookout/, minutes: 15 },
  { match: /temple|shrine|church|cathedral|mosque/, minutes: 30 },
  { match: /castle|palace/, minutes: 60 },
  { match: /monument|landmark|statue|memorial|historic/, minutes: 15 },
  { match: /garden|park/, minutes: 45 },
  { match: /beach/, minutes: 90 },
  { match: /trail|hiking|mountain/, minutes: 120 },
  { match: /bridge|plaza|square|street|alley|crossing/, minutes: 15 },
  { match: /station|metro|subway/, minutes: 10 },
];

export function venueMinutes(category: string | null | undefined, priceBand: number | null = null): number | null {
  if (!category) return null;
  const text = category.toLowerCase();
  for (const row of VENUE_TIMES) {
    if (row.match.test(text)) {
      return typeof row.minutes === "function" ? row.minutes(priceBand) : row.minutes;
    }
  }
  return null;
}

export type LatLng = { lat: number; lng: number };

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Streets are not straight lines. City speed is door to door by public
// transport including the walk to the station and the wait; walking is for
// tasks that take a transport mode away.
export const ROUTE_FACTOR = 1.3;
export const CITY_KMH = 15;
export const WALK_KMH = 4.5;
// Getting anywhere at all costs this much, however close it is.
export const MIN_LEG_MINUTES = 5;

export function travelMinutes(from: LatLng, to: LatLng, mode: "city" | "walk" = "city"): number {
  const km = haversineKm(from, to) * ROUTE_FACTOR;
  const kmh = mode === "walk" ? WALK_KMH : CITY_KMH;
  return Math.max(MIN_LEG_MINUTES, Math.round((km / kmh) * 60));
}

// Working up to it is most of the cost of a bold task: a stranger task has
// no venue and no travel and still takes 20+ minutes.
export const FRICTION_MINUTES = [0, 5, 20, 30, 40];

export function frictionMinutes(boldness: number): number {
  const index = Math.min(5, Math.max(1, Math.round(boldness))) - 1;
  return FRICTION_MINUTES[index];
}

export type DurationInputs = {
  boldness: number;
  // Category of where it happens (a template's venue, or the resolved place).
  venueCategory?: string | null;
  priceBand?: number | null;
  // A leg inside the task itself ("get from A to B without a train").
  leg?: { from: LatLng; to: LatLng; mode: "city" | "walk" } | null;
  // Time a template always takes on top (an hour sitting still, a ride to the
  // end of a line whose coordinates we do not have).
  fixedMinutes?: number;
};

// null when nothing concrete is known (no venue, no leg, no fixed time):
// the model's time axis stands, since friction alone would undercount it.
export function estimateTaskMinutes(input: DurationInputs): number | null {
  const venue = venueMinutes(input.venueCategory ?? null, input.priceBand ?? null);
  const leg = input.leg ? travelMinutes(input.leg.from, input.leg.to, input.leg.mode) : null;
  const fixed = input.fixedMinutes ?? 0;
  const friction = frictionMinutes(input.boldness);
  // Nothing but a little friction known: not enough to overrule the model.
  if (venue === null && leg === null && fixed === 0 && input.boldness < 3) return null;
  return (venue ?? 0) + (leg ?? 0) + fixed + friction;
}

// Model proposes the time axis; code computes the estimate and overrides when
// they are more than one band apart. Within one band, the model's finer
// judgement stands.
export function reconcileTimeAxis(
  proposed: number,
  estimatedMinutes: number | null,
): { time: number; minutes: number; overridden: boolean } {
  if (estimatedMinutes === null) {
    return { time: proposed, minutes: minutesForTimeAxis(proposed), overridden: false };
  }
  const gap = Math.abs(
    DURATION_BANDS.indexOf(bandForTimeAxis(proposed)) -
      DURATION_BANDS.indexOf(bandForMinutes(estimatedMinutes)),
  );
  if (gap > 1) {
    return { time: timeAxisForMinutes(estimatedMinutes), minutes: estimatedMinutes, overridden: true };
  }
  // The axis stands, so the minutes stay inside its band: the schedule and
  // the points never describe two different tasks.
  const band = bandForTimeAxis(proposed);
  const next = DURATION_BANDS[DURATION_BANDS.indexOf(band) + 1];
  const low = BAND_START_MINUTES[band];
  const high = next ? BAND_START_MINUTES[next] - 1 : Infinity;
  return { time: proposed, minutes: Math.min(high, Math.max(low, estimatedMinutes)), overridden: false };
}
