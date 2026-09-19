import { describe, expect, it } from "vitest";
import {
  assignOwnedDayCodes,
  buildGenerationPrompt,
  nextFreeformCode,
  parseGeneratedTasks,
  pickBounty,
} from "./generate";
import { pointsForBoard } from "./scoring";
import type { SurveyAnswers } from "./survey";
import {
  BUDGET_CEILING,
  lowestBudgetCeiling,
  validateGeneratedTask,
  type ProposedTask,
} from "./validate";

const allFives = {
  boldness: 5,
  physical: 5,
  time: 5,
  scarcity: 5,
  cultural: 5,
  aesthetics: 5,
};

const baseTask: ProposedTask = {
  code: "B1",
  title: "eat something starting with a-d",
  axes: {
    boldness: 1,
    physical: 1,
    time: 1,
    scarcity: 1,
    cultural: 1,
    aesthetics: 1,
  },
  verification: "honor",
  photo_bonus_max: 0,
  neighborhood: "anywhere",
};

describe("generated scoring", () => {
  it("lands all-5s axes in Challenging, not above the band ceiling", () => {
    const scored = pointsForBoard(allFives, { day: 1, tripDays: 5 });
    expect(scored.points).toBe(30);
    expect(scored.tier).toBe("Challenging");
  });

  it("computes points from scoring.ts and ignores a model point field", () => {
    const tasks = parseGeneratedTasks(
      JSON.stringify([
        {
          code: "B1",
          title: "photograph a doorway older than you",
          axes: {
            boldness: 3,
            physical: 2,
            time: 1,
            scarcity: 1,
            cultural: 1,
            aesthetics: 2,
          },
          verification: "photo",
          photo_bonus_max: 2,
          neighborhood: "Asakusa",
          points: 999,
          base_points: 999,
        },
      ]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).not.toHaveProperty("points");
    const scored = pointsForBoard(tasks[0].axes, { day: 1, tripDays: null });
    expect(scored.points).toBe(12);
    expect(scored.points).not.toBe(999);
  });
});

describe("generation validation", () => {
  it("rejects an allergy conflict", () => {
    const reason = validateGeneratedTask(
      { ...baseTask, title: "eat unidentifiable street food" },
      {
        assignees: [
          {
            answers: {
              dietary: { value: "has_restriction" },
              dietary_strictness: { value: "allergy" },
            },
          },
        ],
        completedTitles: [],
      },
    );
    expect(reason).toBe("allergy");
  });

  it("rejects an over-budget task", () => {
    const reason = validateGeneratedTask(
      { ...baseTask, title: "a private helicopter tour" },
      {
        assignees: [{ answers: { budget: { value: "low" } } }],
        completedTitles: [],
      },
    );
    expect(reason).toBe("over_budget");
  });

  it("rejects a repeat of a completed task", () => {
    const reason = validateGeneratedTask(baseTask, {
      assignees: [{ answers: {} }],
      completedTitles: ["Eat something starting with a-d"],
    });
    expect(reason).toBe("duplicate");
  });
});

describe("day codes", () => {
  const mine = (participantId: string): ProposedTask => ({
    ...baseTask,
    participantId,
    teamId: null,
  });
  const forTeam = (teamId: string): ProposedTask => ({
    ...baseTask,
    participantId: null,
    teamId,
  });
  const sharedTask: ProposedTask = { ...baseTask, participantId: null, teamId: null };

  it("gives every person their own A1-A3", () => {
    const coded = assignOwnedDayCodes(
      [mine("p1"), mine("p1"), mine("p1"), mine("p2"), mine("p2"), mine("p2")],
      1,
      { participantIds: ["p1", "p2"], teamMembers: {} },
    );
    expect(coded.map((t) => t.code)).toEqual(["A1", "A2", "A3", "A1", "A2", "A3"]);
  });

  it("numbers a bounty after the person's own board", () => {
    const coded = assignOwnedDayCodes(
      [mine("p1"), mine("p1"), mine("p2"), mine("p1")],
      2,
      { participantIds: ["p1", "p2"], teamMembers: {} },
    );
    expect(coded.map((t) => t.code)).toEqual(["B1", "B2", "B1", "B3"]);
  });

  it("keeps team and personal codes apart for a team member", () => {
    const coded = assignOwnedDayCodes(
      [mine("p1"), forTeam("red"), forTeam("red"), forTeam("blue")],
      1,
      { participantIds: ["p1", "p2"], teamMembers: { red: ["p1"], blue: ["p2"] } },
    );
    expect(coded.map((t) => t.code)).toEqual(["A3", "A1", "A2", "A1"]);
  });

  it("puts shared tasks after everyone's owned codes", () => {
    const coded = assignOwnedDayCodes(
      [sharedTask, mine("p1"), mine("p2"), mine("p2")],
      1,
      { participantIds: ["p1", "p2"], teamMembers: {} },
    );
    expect(coded.map((t) => t.code)).toEqual(["A3", "A1", "A1", "A2"]);
  });

  it("continues a refill after what the claimant can already see", () => {
    const coded = assignOwnedDayCodes([mine("p1"), mine("p1")], 1, {
      participantIds: ["p1"],
      teamMembers: {},
      existing: [
        { code: "A1", participantId: "p1", teamId: null },
        { code: "A2", participantId: "p1", teamId: null },
        { code: "A3", participantId: "p1", teamId: null },
        { code: "A7", participantId: "p2", teamId: null },
        { code: "X1", participantId: "p1", teamId: null },
      ],
    });
    expect(coded.map((t) => t.code)).toEqual(["A4", "A5"]);
    expect(nextFreeformCode(["A1", "X1", "X2"])).toBe("X3");
  });
});

describe("catch-up bounty", () => {
  const profile = {
    assembled_at: "2026-09-19T00:00:00Z",
    destination: "Tokyo",
    neighborhoods: [{ name: "Asakusa" }, { name: "Shimokitazawa" }, { name: "Nakameguro" }],
    transit_lines: ["Ginza"],
    dishes: ["monjayaki", "takoyaki", "katsu sando"],
    landmarks: [{ name: "Senso-ji" }, { name: "Tokyo Tower" }],
    price_bands: [],
    center: null,
  } as unknown as Parameters<typeof pickBounty>[0]["profile"];
  const trailer = { id: "p9", answers: {} as SurveyAnswers };
  const expiresAt = new Date("2099-01-01T00:00:00Z");

  it("changes from day to day", () => {
    const titles = [1, 2, 3, 4].map(
      (day) =>
        pickBounty({ profile, day, trailer, avoidTitles: [], expiresAt })?.title,
    );
    expect(new Set(titles).size).toBeGreaterThan(1);
  });

  it("never repeats a task the trailer already completed", () => {
    const first = pickBounty({ profile, day: 2, trailer, avoidTitles: [], expiresAt });
    expect(first).not.toBeNull();
    const second = pickBounty({
      profile,
      day: 2,
      trailer,
      avoidTitles: [first!.title],
      expiresAt,
    });
    expect(second).not.toBeNull();
    expect(second!.title).not.toBe(first!.title);
    expect(second!.participantId).toBe("p9");
  });

  it("gives up rather than duplicating when everything is used", () => {
    const every = new Set<string>();
    for (let day = 0; day < 40; day++) {
      for (let i = 0; i < 20; i++) {
        const b = pickBounty({ profile, day, trailer, avoidTitles: [...every], expiresAt });
        if (b) every.add(b.title);
      }
    }
    expect(
      pickBounty({ profile, day: 5, trailer, avoidTitles: [...every], expiresAt }),
    ).toBeNull();
  });
});

describe("validation of pre-existing raw survey text", () => {
  const eat = { ...baseTask, title: "eat unidentifiable street food" };
  const hike = { ...baseTask, title: "hike to the shrine" };
  const check = (task: ProposedTask, answers: SurveyAnswers) =>
    validateGeneratedTask(task, { assignees: [{ answers }], completedTitles: [] });

  it("treats unrecognised dietary text as an allergy", () => {
    expect(check(eat, { dietary: { value: "yes, peanuts" } })).toBe("allergy");
    expect(
      check(eat, {
        dietary: { value: "has_restriction" },
        dietary_strictness: { skipped: true },
      }),
    ).toBe("allergy");
    expect(check(eat, { dietary: { value: "none" } })).toBeNull();
    expect(
      check(eat, {
        dietary: { value: "has_restriction" },
        dietary_strictness: { value: "cheat_on_vacation" },
      }),
    ).toBeNull();
  });

  it("treats an unrecognised budget as the low ceiling", () => {
    expect(lowestBudgetCeiling([{ answers: { budget: { value: "cheap-ish" } } }])).toBe(
      BUDGET_CEILING.low,
    );
  });

  it("does not reject hikes for someone with no mobility limits", () => {
    expect(check(hike, { mobility: { value: "no_limits" } })).toBeNull();
    expect(check(hike, { mobility: { value: "none" } })).toBeNull();
    expect(check(hike, { mobility: { value: "has_limits" } })).toBe("mobility");
    expect(check(hike, { mobility: { value: "bad knee" } })).toBe("mobility");
  });
});

describe("generation prompt", () => {
  it("tells the model photo is a bonus, not a claim gate", () => {
    const prompt = buildGenerationPrompt({
      profile: {
        assembled_at: "2026-09-19T00:00:00Z",
        destination: "Tokyo",
        neighborhoods: [],
        transit_lines: [],
        dishes: [],
        landmarks: [],
        price_bands: [],
        center: null,
      },
      weather: {
        summary: "clear",
        indoorPreferred: false,
        temperatureC: 22,
        precipitationChance: 0,
      },
      preferenceText: "food",
      completedTitles: [],
      yesterdayRatings: "",
      scoreGap: "",
      day: 1,
    });
    expect(prompt).toContain("Verification is not a photo gate");
    expect(prompt).toContain("Only peer requires someone else's tapback");
  });
});
