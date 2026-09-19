import { afterEach, describe, expect, it, vi } from "vitest";
import { clampPhotoBonusMax, photoBonusCeiling, photoBonusMaxFor, PHOTO_BONUS_HARD_MAX } from "./scoring";
import { persistableTask } from "@/lib/handlers/daily-board";

// The photo bonus sweetens a claim, never dominates it: at most 5, and at most
// 40% of base points, whichever is lower. Live generation stored 100-250.

afterEach(() => vi.restoreAllMocks());

describe("photo bonus ceiling", () => {
  it("is the lower of 5 and 40% of base points", () => {
    expect(photoBonusCeiling(12)).toBe(4);
    expect(photoBonusCeiling(19)).toBe(5);
    expect(photoBonusCeiling(34)).toBe(5);
    expect(photoBonusCeiling(7)).toBe(2);
    expect(photoBonusCeiling(2)).toBe(0);
  });

  it("never exceeds either bound, for any proposal and any base", () => {
    for (let base = 0; base <= 40; base++) {
      for (const proposed of [-3, 0, 1, 2, 3, 5, 6, 10, 100, 250, 1e9, Number.NaN]) {
        const { value } = clampPhotoBonusMax(proposed, base);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(PHOTO_BONUS_HARD_MAX);
        expect(value).toBeLessThanOrEqual(base * 0.4);
      }
    }
  });

  it("reports when it had to clamp", () => {
    expect(clampPhotoBonusMax(250, 19)).toEqual({ value: 5, clamped: true });
    expect(clampPhotoBonusMax(3, 19)).toEqual({ value: 3, clamped: false });
  });

  it("bounds rows written before the clamp at claim time", () => {
    expect(photoBonusMaxFor({ photo_bonus_max: 250, base_points: 19 })).toBe(5);
    expect(photoBonusMaxFor({ photo_bonus_max: 100, base_points: 12 })).toBe(4);
  });
});

describe("every generated task row", () => {
  const axes = { boldness: 2, physical: 1, time: 2, scarcity: 2, cultural: 2, aesthetics: 2 };

  it("stores a clamped ceiling and logs the model's original", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { row } = persistableTask({
      tripId: "t",
      day: 1,
      tripDays: 5,
      task: { code: "A1", title: "find the oldest shop", axes, verification: "photo", photo_bonus_max: 250, neighborhood: "" },
      participantId: "p",
      teamId: null,
      expiresAt: new Date(),
    });
    expect(row.photo_bonus_max).toBeLessThanOrEqual(PHOTO_BONUS_HARD_MAX);
    expect(row.photo_bonus_max).toBeLessThanOrEqual(row.base_points * 0.4);
    const log = info.mock.calls.find((c) => c[0] === "[japlan.generate] photo_bonus_max clamped");
    expect(log?.[1]).toMatchObject({ original: 250, clamped: row.photo_bonus_max, basePoints: row.base_points });
  });
});
