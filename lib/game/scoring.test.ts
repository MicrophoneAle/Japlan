import { describe, expect, it } from "vitest";
import {
  computePoints,
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
  it("scores all-1s as Light (7, below the 10/11 boundary)", () => {
    const points = computePoints(ones);
    expect(points).toBe(7);
    expect(tierForPoints(points)).toBe("Light");
  });

  it("treats 10 as Light (upper Light bound)", () => {
    const points = computePoints({ ...ones, boldness: 3 });
    expect(points).toBe(10);
    expect(tierForPoints(points)).toBe("Light");
  });

  it("treats 11 as Medium (lower Medium bound)", () => {
    const points = computePoints({ ...ones, boldness: 3, physical: 2 });
    expect(points).toBe(11);
    expect(tierForPoints(points)).toBe("Medium");
  });

  it("treats 20 as Medium (upper Medium bound)", () => {
    const points = computePoints({
      boldness: 3,
      physical: 3,
      time: 3,
      scarcity: 3,
      cultural: 3,
      aesthetics: 2,
    });
    expect(points).toBe(20);
    expect(tierForPoints(points)).toBe("Medium");
  });

  it("treats 21 as Challenging (lower Challenging bound)", () => {
    const points = computePoints({
      boldness: 3,
      physical: 3,
      time: 3,
      scarcity: 3,
      cultural: 3,
      aesthetics: 3,
    });
    expect(points).toBe(21);
    expect(tierForPoints(points)).toBe("Challenging");
  });

  it("treats 30 as Challenging (upper Challenging bound)", () => {
    const points = computePoints({
      boldness: 5,
      physical: 4,
      time: 4,
      scarcity: 4,
      cultural: 4,
      aesthetics: 4,
    });
    expect(points).toBe(30);
    expect(tierForPoints(points)).toBe("Challenging");
  });

  it("has no tier for totals above 30", () => {
    const points = computePoints({
      boldness: 5,
      physical: 5,
      time: 5,
      scarcity: 5,
      cultural: 5,
      aesthetics: 5,
    });
    expect(points).toBe(35);
    expect(tierForPoints(points)).toBeNull();
  });
});
