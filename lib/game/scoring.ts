export type Axes = {
  boldness: number;
  physical: number;
  time: number;
  scarcity: number;
  cultural: number;
  aesthetics: number;
};

export type Tier = "Light" | "Medium" | "Challenging";

// Points reward what makes a story: social boldness, rarity, and being
// specific to this place. Not length, effort or prettiness: walking further
// must never out-earn talking to a stranger.
export const AXIS_WEIGHTS = {
  boldness: 1.6,
  scarcity: 1.5,
  cultural: 1.4,
  time: 0.9,
  physical: 0.8,
  aesthetics: 0.6,
} as const;

// All-1s scores 7 and all-5s scores 34 (weights sum to 6.8); three bands
// across that range.
export const TIER_BANDS: Record<Tier, { min: number; max: number }> = {
  Light: { min: 1, max: 15 },
  Medium: { min: 16, max: 24 },
  Challenging: { min: 25, max: 34 },
};

// Integer tenths, so the weights never meet floating point.
export function computePoints(axes: Axes): number {
  const tenths =
    16 * axes.boldness +
    15 * axes.scarcity +
    14 * axes.cultural +
    9 * axes.time +
    8 * axes.physical +
    6 * axes.aesthetics;
  return Math.round(tenths / 10);
}

export function tierForPoints(points: number): Tier | null {
  for (const tier of ["Light", "Medium", "Challenging"] as const) {
    const band = TIER_BANDS[tier];
    if (points >= band.min && points <= band.max) return tier;
  }
  return null;
}

export const BAND_CEILING = TIER_BANDS.Challenging.max;
export const MEDIUM_CEILING = TIER_BANDS.Medium.max;
export const DEFAULT_DAILY_POINTS_CAP = 120;

// Day 1 is A. Past day 26 the letters cycle (day 27 is A again), so a long
// trip is never refused for running out of letters; code lookup prefers the
// most recent day that uses a code (findTaskByCodeFor).
export function dayLetter(day: number): string {
  if (!Number.isInteger(day) || day < 1) {
    throw new Error(`day ${day} has no letter`);
  }
  return String.fromCharCode(65 + ((day - 1) % 26));
}

export function tripLengthDays(
  startDate: string | null,
  endDate: string | null,
): number | null {
  if (!startDate || !endDate) return null;
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

export function dayValueMultiplier(
  day: number,
  tripDays: number | null,
): number {
  if (tripDays && day === tripDays) return 2;
  if (day <= 1) return 1;
  return 1 + 0.15 * (day - 1);
}

export function pointsForBoard(
  axes: Axes,
  opts: { day: number; tripDays: number | null } = { day: 1, tripDays: null },
): { points: number; tier: Tier } {
  const raw = computePoints(axes);
  const scaled = Math.round(raw * dayValueMultiplier(opts.day, opts.tripDays));
  const points = Math.min(BAND_CEILING, Math.max(1, scaled));
  const tier = tierForPoints(points) ?? "Challenging";
  return { points, tier };
}

export function pointsForFreeform(
  axes: Axes,
  opts: { day: number; tripDays: number | null } = { day: 1, tripDays: null },
): { points: number; tier: Tier } {
  const scored = pointsForBoard(axes, opts);
  const points = Math.min(scored.points, MEDIUM_CEILING);
  const tier = tierForPoints(points) ?? "Medium";
  return { points, tier };
}

export function applyDailyPointsCap(opts: {
  pointsToday: number;
  incoming: number;
  cap: number;
}): { awarded_points: number; capped: boolean } {
  if (opts.pointsToday >= opts.cap) {
    return { awarded_points: 0, capped: true };
  }
  return { awarded_points: opts.incoming, capped: false };
}
