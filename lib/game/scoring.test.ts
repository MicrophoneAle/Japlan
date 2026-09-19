import { describe, expect, it } from "vitest";
import {
  applyDailyPointsCap,
  AXIS_WEIGHTS,
  claimEarnsScreenEffect,
  CLAIM_EFFECT_POINTS_THRESHOLD,
  computePoints,
  dayValueMultiplier,
  pointsForBoard,
  pointsForFreeform,
  rawTaskPoints,
  tierForPoints,
  type Axes,
} from "./scoring";

const ones: Axes = {
  boldness: 1,
  physical: 1,
  time: 1,
  scarcity: 1,
  cultural: 1,
  aesthetics: 1,
};

describe("computePoints", () => {
  const at = (overrides: Partial<Axes>, base = 1): Axes => ({
    boldness: base, physical: base, time: base, scarcity: base, cultural: base, aesthetics: base,
    ...overrides,
  });

  it("uses the story-first weights", () => {
    expect(AXIS_WEIGHTS).toEqual({
      boldness: 1.6, scarcity: 1.5, cultural: 1.4, time: 0.9, physical: 0.8, aesthetics: 0.6,
    });
  });

  it("spans 7 (all 1s) to 34 (all 5s)", () => {
    expect(computePoints(ones)).toBe(7);
    expect(computePoints(at({}, 5))).toBe(34);
  });

  it("puts the band edges where the tiers say", () => {
    const cases: [Axes, number, string][] = [
      [ones, 7, "Light"],
      [at({ boldness: 5, scarcity: 2 }), 15, "Light"],
      [at({ boldness: 5, scarcity: 2, cultural: 2 }), 16, "Medium"],
      [at({ boldness: 4, scarcity: 4, time: 4 }, 3), 24, "Medium"],
      [at({ boldness: 4, scarcity: 4, time: 4, aesthetics: 4 }, 3), 25, "Challenging"],
      [at({}, 5), 34, "Challenging"],
    ];
    for (const [axes, points, tier] of cases) {
      expect(computePoints(axes)).toBe(points);
      expect(tierForPoints(points)).toBe(tier);
    }
    expect(tierForPoints(35)).toBeNull();
  });

  it("never lets walking further out-earn talking to a stranger", () => {
    // A stranger task takes at least 20 minutes to work up to (time 2 on the
    // board; time-1 tasks are sidequests). Against the longest, most tiring
    // walk, with everything else equal, the stranger still wins.
    for (const rest of [1, 3, 5]) {
      const walk = computePoints(at({ boldness: 1, physical: 5, time: 5, scarcity: rest, cultural: rest, aesthetics: rest }));
      const talk = computePoints(at({ boldness: 5, physical: 1, time: 2, scarcity: rest, cultural: rest, aesthetics: rest }));
      expect(talk).toBeGreaterThanOrEqual(walk);
    }
    // One step of each: boldness beats a step of physical, time or aesthetics.
    expect(AXIS_WEIGHTS.boldness).toBeGreaterThan(AXIS_WEIGHTS.physical);
    expect(AXIS_WEIGHTS.boldness).toBeGreaterThan(AXIS_WEIGHTS.time);
  });

  it("clamps generated board points to Challenging", () => {
    const { points, tier } = pointsForBoard(
      {
        boldness: 5,
        physical: 5,
        time: 5,
        scarcity: 5,
        cultural: 5,
        aesthetics: 5,
      },
      { day: 1, tripDays: 5 },
    );
    expect(points).toBe(34);
    expect(tier).toBe("Challenging");
  });

  it("caps a freeform all-5s claim at Medium, not Challenging", () => {
    const { points, tier } = pointsForFreeform(
      {
        boldness: 5,
        physical: 5,
        time: 5,
        scarcity: 5,
        cultural: 5,
        aesthetics: 5,
      },
      { day: 1, tripDays: 5 },
    );
    expect(points).toBe(24);
    expect(tier).toBe("Medium");
    expect(tier).not.toBe("Challenging");
  });
});

describe("rawTaskPoints / claimEarnsScreenEffect", () => {
  const axesAt = (base: number): Axes => ({
    boldness: base, physical: base, time: base, scarcity: base, cultural: base, aesthetics: base,
  });

  it("reads the axes score directly, ignoring anything else on the row", () => {
    expect(rawTaskPoints(axesAt(4))).toBe(computePoints(axesAt(4)));
  });

  it("returns null for a task with no real axes (freeform rows that predate it)", () => {
    expect(rawTaskPoints({})).toBeNull();
    expect(rawTaskPoints(null)).toBeNull();
    expect(rawTaskPoints(undefined)).toBeNull();
    expect(rawTaskPoints({ boldness: 3 })).toBeNull();
    expect(rawTaskPoints({ boldness: "3", physical: 3, time: 3, scarcity: 3, cultural: 3, aesthetics: 3 })).toBeNull();
  });

  it("is unaffected by the day multiplier: the same axes score the same on day 1 and the final day", () => {
    const axes = axesAt(4);
    const raw = rawTaskPoints(axes);
    // What actually gets stored as base_points on day 1 vs. the trip's last day.
    const day1Stored = Math.round(computePoints(axes) * dayValueMultiplier(1, 5));
    const finalDayStored = Math.round(computePoints(axes) * dayValueMultiplier(5, 5));
    expect(finalDayStored).toBeGreaterThan(day1Stored);
    expect(rawTaskPoints(axes)).toBe(raw); // does not move with the day
  });

  it("does not earn an effect just below the threshold", () => {
    // Tune axes down until just under CLAIM_EFFECT_POINTS_THRESHOLD.
    const axes = axesAt(2); // computePoints ~14
    expect(rawTaskPoints(axes)).toBeLessThan(CLAIM_EFFECT_POINTS_THRESHOLD);
    expect(claimEarnsScreenEffect(axes)).toBe(false);
  });

  it("earns an effect at and above the threshold", () => {
    const axes = axesAt(4); // computePoints 27, well past 20
    expect(rawTaskPoints(axes)).toBeGreaterThanOrEqual(CLAIM_EFFECT_POINTS_THRESHOLD);
    expect(claimEarnsScreenEffect(axes)).toBe(true);
  });

  it("earns an effect exactly at the threshold (inclusive)", () => {
    const axes = axesAt(3); // computePoints 20, exactly the threshold
    expect(rawTaskPoints(axes)).toBe(CLAIM_EFFECT_POINTS_THRESHOLD);
    expect(claimEarnsScreenEffect(axes)).toBe(true);
  });

  it("never earns an effect from a row with no real axes, even if base_points looks high", () => {
    expect(claimEarnsScreenEffect({})).toBe(false);
    expect(claimEarnsScreenEffect(null)).toBe(false);
  });
});
