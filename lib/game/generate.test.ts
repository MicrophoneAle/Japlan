import { describe, expect, it } from "vitest";
import {
  assignOwnedDayCodes,
  boldTasksWanted,
  buildGenerationPrompt,
  nextFreeformCode,
  parseGeneratedTasks,
  pickBounty,
} from "./generate";
import { pointsForBoard } from "./scoring";
import type { SurveyAnswers } from "./survey";
import { TEMPLATES } from "./templates";
import {
  BUDGET_CEILING,
  enforceBoardMix,
  lowestBudgetCeiling,
  placeKey,
  TASK_KINDS,
  validateGeneratedTask,
  type ProposedTask,
  type TaskKind,
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
    expect(scored.points).toBe(34);
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
    // 1.6*3 + 0.8*2 + 0.9*1 + 1.5*1 + 1.4*1 + 0.6*2 = 11.4
    expect(scored.points).toBe(11);
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

describe("boldness and variety", () => {
  const input = (difficulty: string | null, boardTitles: string[] = []) => ({
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
    weather: { summary: "clear", indoorPreferred: false, temperatureC: 22, precipitationChance: 0 },
    preferenceText: "food",
    completedTitles: [],
    yesterdayRatings: "",
    scoreGap: "",
    day: 2,
    difficulty,
    boardTitles,
  });

  it("asks for bold tasks by count, even on chill", () => {
    expect(boldTasksWanted("unhinged", 3)).toBe(3);
    expect(boldTasksWanted("normal", 3)).toBe(2);
    expect(boldTasksWanted(null, 3)).toBe(2);
    expect(boldTasksWanted("chill", 3)).toBe(1);
    const prompt = buildGenerationPrompt(input("chill"));
    expect(prompt).toContain("At least 1 of the 3 tasks must honestly rate boldness 3 or more.");
    expect(prompt).not.toMatch(/favour low boldness/i);
  });

  it("shows the model what is already on the trip's boards", () => {
    const prompt = buildGenerationPrompt(input(null, ["find a bench in yoyogi park"]));
    expect(prompt).toContain("do not repeat or rephrase): find a bench in yoyogi park");
  });

  it("reads kind and place from the model, ignoring unknown kinds", () => {
    const [a, b] = parseGeneratedTasks(
      JSON.stringify([
        { code: "", title: "t1", axes: {}, verification: "honor", photo_bonus_max: 0, neighborhood: "Shibuya", kind: "social", place: " Yoyogi Park " },
        { code: "", title: "t2", axes: {}, verification: "honor", photo_bonus_max: 0, neighborhood: "Shibuya", kind: "sightseeing", place: "" },
      ]),
    );
    expect(a).toMatchObject({ kind: "social", place: "Yoyogi Park" });
    expect(b.kind).toBeUndefined();
    expect(b.place).toBeUndefined();
  });

  const task = (title: string, kind?: TaskKind, place?: string): ProposedTask => ({
    code: "",
    title,
    axes: { boldness: 1, physical: 1, time: 1, scarcity: 1, cultural: 1, aesthetics: 1 },
    verification: "photo",
    photo_bonus_max: 2,
    neighborhood: "Shibuya",
    kind,
    place,
  });

  it("drops a second task at the same place", () => {
    const { kept, rejected } = enforceBoardMix([
      task("find a bench in yoyogi park", "explore", "Yoyogi Park"),
      task("ask a local for their favourite ramen", "social", ""),
      task("rest on a shaded bench", "explore", "the yoyogi park."),
    ]);
    expect(kept.map((t) => t.title)).toEqual(["find a bench in yoyogi park", "ask a local for their favourite ramen"]);
    expect(rejected.map((r) => r.reason)).toEqual(["same_place"]);
    expect(placeKey("Meiji Jingu")).not.toBe(placeKey("Yoyogi Park"));
  });

  it("never keeps a board that is all one kind", () => {
    const { kept, rejected } = enforceBoardMix([
      task("look at a pine", "explore", "Kokyo Gaien"),
      task("look at a statue", "explore", "Kusunoki statue"),
      task("look at a waterfall", "explore", "Shinjuku Chuo Park"),
    ]);
    expect(kept).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual(["one_kind", "one_kind"]);
    // Mixed kinds, distinct places: all kept.
    expect(
      enforceBoardMix([task("a", "explore", "x"), task("b", "social", "y"), task("c", "explore", "z")]).kept,
    ).toHaveLength(3);
  });

  it("gives template fallbacks a kind so the same rules apply", () => {
    for (const t of TEMPLATES) expect(TASK_KINDS).toContain(t.kind);
  });
});

describe("generation prompt: quality and time", () => {
  const base = {
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
    weather: { summary: "clear", indoorPreferred: false, temperatureC: 22, precipitationChance: 0 },
    preferenceText: "food",
    completedTitles: [],
    yesterdayRatings: "",
    scoreGap: "",
    day: 1,
  };

  it("says what a weak task is and what every board needs", () => {
    const prompt = buildGenerationPrompt(base);
    expect(prompt).toContain(
      "A task that can be completed without speaking to anyone, without going somewhere unusual, and without doing anything slightly embarrassing is a weak task.",
    );
    expect(prompt).toContain('"Go look at X" (find a bench, locate a statue, view a waterfall) is the weakest possible archetype.');
    expect(prompt).toContain("At least one task on the board must involve a stranger");
    expect(prompt).toContain("No two tasks on the board share a location, and no two use the same template.");
    // The bank offered is main tasks only.
    expect(prompt).not.toContain("eat_letter_range");
    expect(prompt).not.toContain("buy_unidentifiable");
  });

  it("tells the model the time it has, so duration shapes the board", () => {
    const prompt = buildGenerationPrompt({
      ...base,
      count: 4,
      plan: { windowText: "19:00 to 21:00", usableMinutes: 110, targetMinutes: 72, maxTaskMinutes: 120, lateStart: true },
    });
    expect(prompt).toContain("It is already late in the day: the board covers 19:00 to 21:00");
    expect(prompt).toContain("No task may take longer than 120 minutes");
    expect(prompt).toContain("Return exactly 4 tasks");
  });

  it("asks for a curveball only on a curveball board", () => {
    expect(buildGenerationPrompt(base)).not.toContain('template "curveball"');
    expect(buildGenerationPrompt({ ...base, curveball: true })).toContain(
      'Exactly one task uses template "curveball"',
    );
  });

  it("reads the template, places and stranger flag", () => {
    const [task] = parseGeneratedTasks(
      JSON.stringify([
        {
          template: "a_to_b_without",
          title: "get from senso-ji to ueno park on foot",
          axes: allFives,
          verification: "peer",
          photo_bonus_max: 0,
          neighborhood: "Asakusa",
          places: ["Senso-ji", "Ueno Park", "extra"],
          involves_stranger: false,
        },
      ]),
    );
    expect(task).toMatchObject({
      template: "a_to_b_without",
      places: ["Senso-ji", "Ueno Park"],
      place: "Senso-ji",
      stranger: false,
    });
  });
});

// "this trip is a waste if we don't ___" is the highest signal answer in the
// survey. It used to reach the model only as a sentence inside the
// preferences paragraph, where it read like any other lean, and the only
// structured use was four keyword buckets that "see a show" matches none of.
describe("a must-have is a standing constraint, not a lean", () => {
  const base = {
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
    weather: { temperatureC: 18, precipitationChance: 0, summary: "clear", indoorPreferred: false },
    preferenceText: "likes food",
    completedTitles: [],
    yesterdayRatings: "",
    scoreGap: "",
    day: 1,
  };

  it("puts it in the prompt verbatim, and says it outranks the interest leans", () => {
    const prompt = buildGenerationPrompt({
      ...base,
      mustHaves: ["see a show"],
      interests: [{ key: "food", share: 1 }],
    });
    expect(prompt).toContain("see a show");
    expect(prompt).toMatch(/standing constraint/i);
    expect(prompt).toMatch(/outranks the interest leans/i);
    // And it comes before the interest leans it outranks.
    expect(prompt.indexOf("see a show")).toBeLessThan(prompt.indexOf("top interests"));
  });

  it("carries every person's must-have, and says nothing when nobody named one", () => {
    const both = buildGenerationPrompt({ ...base, mustHaves: ["see a show", "eat at a 7-eleven"] });
    expect(both).toContain("see a show");
    expect(both).toContain("eat at a 7-eleven");
    expect(buildGenerationPrompt(base)).not.toMatch(/standing constraint/i);
  });
});
