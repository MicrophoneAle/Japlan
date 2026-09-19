import { describe, expect, it } from "vitest";
import {
  applyDailyPointsCap,
  AXIS_WEIGHTS,
  computePoints,
  pointsForBoard,
  pointsForFreeform,
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
