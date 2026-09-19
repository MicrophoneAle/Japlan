export type Axes = {
  boldness: number;
  physical: number;
  time: number;
  scarcity: number;
  cultural: number;
  aesthetics: number;
};

export type Tier = "Light" | "Medium" | "Challenging";

export const AXIS_WEIGHTS = {
  boldness: 1.5,
  physical: 1.3,
  time: 1.3,
  scarcity: 1.2,
  cultural: 1.0,
  aesthetics: 0.7,
} as const;

export const TIER_BANDS: Record<Tier, { min: number; max: number }> = {
  Light: { min: 1, max: 10 },
  Medium: { min: 11, max: 20 },
  Challenging: { min: 21, max: 30 },
};

export function computePoints(axes: Axes): number {
  const tenths =
    15 * axes.boldness +
    13 * axes.physical +
    13 * axes.time +
    12 * axes.scarcity +
    10 * axes.cultural +
    7 * axes.aesthetics;
  return Math.round(tenths / 10);
}

export function tierForPoints(points: number): Tier | null {
  if (points >= 1 && points <= 10) return "Light";
  if (points >= 11 && points <= 20) return "Medium";
  if (points >= 21 && points <= 30) return "Challenging";
  // TODO: weighted totals can exceed 30 (all-5s rounds to 35); plan has no band above Challenging.
  return null;
}

export const BAND_CEILING = TIER_BANDS.Challenging.max;

export function dayLetter(day: number): string {
  if (day < 1 || day > 26) {
    throw new Error(`day ${day} has no letter`);
  }
  return String.fromCharCode(64 + day);
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
