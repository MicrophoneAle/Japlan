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
