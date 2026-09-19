import { describe, expect, it } from "vitest";
import { claimConfirmedLine } from "./copy";
import {
  hasFreeformClaimToday,
  isClaimantTapback,
  parseFreeformExtraction,
} from "./freeform";
import { applyDailyPointsCap } from "./scoring";
import { wrappedQuestCount } from "./wrapped-stats";

describe("freeform extraction", () => {
  it("ignores a model point field and requires a completed activity", () => {
    const extracted = parseFreeformExtraction(
      JSON.stringify({
        is_completed_activity: true,
        title: "hiked to the Roppongi observatory",
        place_name: "Roppongi Hills",
        neighborhood: "Roppongi",
        duration_minutes: 90,
        lat: 35.66,
        lng: 139.73,
        category: "Observatory",
        axes: {
          boldness: 2,
          physical: 4,
          time: 3,
          scarcity: 2,
          cultural: 3,
          aesthetics: 4,
        },
        points: 999,
      }),
    );
    expect(extracted?.title).toContain("Roppongi");
    expect(extracted).not.toHaveProperty("points");
  });

  it("returns null when the message is not a completed activity", () => {
    expect(
      parseFreeformExtraction(
        JSON.stringify({
          is_completed_activity: false,
          title: "what should we do",
          axes: {
            boldness: 1,
            physical: 1,
            time: 1,
            scarcity: 1,
            cultural: 1,
            aesthetics: 1,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("one freeform per person per day", () => {
  const tasks = [
    {
      id: "t-free",
      source: "freeform",
      day: 1,
      participant_id: "p1",
    },
  ];

  it("refuses a second freeform claim in the same day", () => {
    expect(
      hasFreeformClaimToday({
        tasks,
        claims: [
          { task_id: "t-free", participant_id: "p1", status: "awarded" },
        ],
        participantId: "p1",
        day: 1,
      }),
    ).toBe(true);
  });

  it("allows a freeform when the person has none today", () => {
    expect(
      hasFreeformClaimToday({
        tasks,
        claims: [],
        participantId: "p1",
        day: 1,
      }),
    ).toBe(false);
  });
});

describe("daily points cap", () => {
  it("writes awarded_points 0 past the cap and still counts for Wrapped", () => {
    const result = applyDailyPointsCap({
      pointsToday: 120,
      incoming: 18,
      cap: 120,
    });
    expect(result).toEqual({ awarded_points: 0, capped: true });
    expect(
      claimConfirmedLine({
        code: "C2",
        name: "Michael",
        base: 18,
        photoBonus: 0,
        total: 160,
        capped: true,
      }),
    ).toBe(
      "✅ C2 · Michael · 160 · that's your cap for today, but claims still count for the recap.",
    );

    const wrapped = wrappedQuestCount([
      { status: "awarded", awarded_points: 18, capped: false },
      { status: "awarded", awarded_points: 0, capped: true },
    ]);
    expect(wrapped).toBe(2);
  });

  it("awards incoming points while under the cap", () => {
    expect(
      applyDailyPointsCap({ pointsToday: 40, incoming: 18, cap: 120 }),
    ).toEqual({ awarded_points: 18, capped: false });
  });
});

describe("freeform peer tapback", () => {
  it("does not treat the claimant's own tapback as confirmation", () => {
    expect(isClaimantTapback("+15551212", "+15551212")).toBe(true);
    expect(isClaimantTapback("+15550000", "+15551212")).toBe(false);
    expect(isClaimantTapback(null, "+15551212")).toBe(false);
  });
});
