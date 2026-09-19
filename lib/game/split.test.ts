import { describe, expect, it } from "vitest";
import { dayGroups, matchPerson, parseLooseTime, resolveSplit, type SplitPerson } from "./split";
import { fitSuggestion, splitPlaceList } from "./suggestions";
import { boardPreferencesFor, taskPriority, type Candidate } from "./plan-board";

const people: SplitPerson[] = [
  { id: "mike", display_name: "Mike", answers: {} },
  { id: "jess", display_name: "Jessica", answers: {} },
  { id: "sam", display_name: "Sam", answers: {} },
  { id: "dev", display_name: "Dev", answers: {} },
];
const NOON = 12 * 60;

describe("placing people from what they said", () => {
  it("places me and named people, and leaves descriptions it cannot place", () => {
    const split = resolveSplit(
      { groups: [{ who: ["me", "jess"], where: "shimokita" }, { who: ["the boys"], where: "akihabara" }] },
      people,
      "mike",
      NOON,
    );
    expect(split.groups[0]).toMatchObject({ memberIds: ["mike", "jess"], area: "shimokita" });
    expect(split.groups[1]).toMatchObject({ memberIds: [], area: "akihabara", unresolved: ["the boys"] });
    // Only the people nobody could place are asked about.
    expect(split.unplaced.map((p) => p.id)).toEqual(["sam", "dev"]);
  });

  it("'you guys go ahead' is everyone else; sleeping in is a later start, converging later", () => {
    const split = resolveSplit(
      { groups: [{ who: ["me"], starts: "sleeping in" }, { who: ["you guys"], starts: "now" }] },
      people,
      "sam",
      9 * 60,
    );
    expect(split.groups[0]).toMatchObject({ memberIds: ["sam"], startsAt: 11 * 60 + 30 });
    expect(split.groups[1].memberIds.sort()).toEqual(["dev", "jess", "mike"]);
    expect(split.unplaced).toEqual([]);
    // Nobody said when they meet: three hours after the late start.
    expect(split.rejoinAt).toBe(14 * 60 + 30);
  });

  it("'we're splitting after lunch' with nobody named places nobody", () => {
    const split = resolveSplit({ groups: [], from: "after lunch" }, people, "mike", NOON);
    expect(split.startsAt).toBe(13 * 60 + 30);
    expect(split.unplaced).toHaveLength(4);
  });

  it("keeps a couple together when their own survey said so, without asking", () => {
    const withCouple = people.map((p) =>
      p.id === "dev"
        ? { ...p, answers: { social_couples: { value: "together" }, social_with: { value: "sam obviously" } } }
        : p,
    );
    const split = resolveSplit({ groups: [{ who: ["sam"], where: "akihabara" }] }, withCouple, "mike", NOON);
    expect(split.groups[0].memberIds).toEqual(["sam", "dev"]);
  });

  it("matches names loosely but never guesses between two", () => {
    expect(matchPerson("jess", people)?.id).toBe("jess");
    expect(matchPerson("DEV", people)?.id).toBe("dev");
    expect(matchPerson("s", people)).toBeNull();
    expect(parseLooseTime("3", NOON)).toBe(15 * 60);
    expect(parseLooseTime("10:30am", NOON)).toBe(10 * 60 + 30);
  });
});

describe("a day's groups", () => {
  it("is one group with no split", () => {
    expect(dayGroups(["a", "b"], [])).toEqual([
      expect.objectContaining({ key: "together", memberIds: ["a", "b"], teamId: null }),
    ]);
  });

  it("gives each team its own hours, then everyone together after the rejoin", () => {
    const groups = dayGroups(
      ["early1", "early2", "late"],
      [
        { id: "t1", name: "early", memberIds: ["early1", "early2"], startsAt: 480, rejoinAt: 870, rejoinPlace: "Ueno", area: "Asakusa" },
        { id: "t2", name: "late", memberIds: ["late"], startsAt: 690, rejoinAt: 870, rejoinPlace: "Ueno", area: "Ueno" },
      ],
    );
    expect(groups.map((g) => [g.key, g.startAt, g.endAt, g.endNear, g.startNear])).toEqual([
      ["team:t1", 480, 870, "Ueno", "Asakusa"],
      ["team:t2", 690, 870, "Ueno", "Ueno"],
      ["together:after", 870, null, null, "Ueno"],
    ]);
    expect(groups[2].memberIds).toEqual(["early1", "early2", "late"]);
  });
});

describe("where a suggestion goes", () => {
  const UENO = { lat: 35.7142, lng: 139.7773 };
  const SHIBUYA = { lat: 35.6595, lng: 139.7004 };
  const days = [
    { day: 2, points: [SHIBUYA], area: "Shibuya" },
    { day: 3, points: [UENO], area: "Ueno" },
    { day: 4, points: [], area: null },
  ];

  it("goes to the earliest day it is near", () => {
    expect(fitSuggestion({ coords: { lat: 35.7148, lng: 139.7714 }, days })).toMatchObject({ kind: "near", day: 3, area: "Ueno" });
  });

  it("else to a day with nothing planned yet, else says which day it suits", () => {
    const far = { lat: 35.63, lng: 139.88 };
    expect(fitSuggestion({ coords: far, days })).toEqual({ kind: "open_day", day: 4 });
    expect(fitSuggestion({ coords: far, days: days.slice(0, 2) })).toMatchObject({ kind: "no_fit", bestDay: 3 });
    expect(fitSuggestion({ coords: null, days })).toEqual({ kind: "no_location" });
    expect(fitSuggestion({ coords: far, days, askedDay: 2 })).toEqual({ kind: "asked_day", day: 2 });
  });

  it("splits a survey list into places", () => {
    expect(splitPlaceList("teamLab, a jazz bar in golden gai and the fish market")).toEqual([
      "teamLab",
      "a jazz bar in golden gai",
      "the fish market",
    ]);
    expect(splitPlaceList("nothing")).toEqual([]);
  });
});

describe("what the group asked for, and asked to avoid", () => {
  const task = (title: string, extra: Partial<Candidate> = {}): Candidate => ({
    code: "",
    title,
    axes: { boldness: 3, physical: 1, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
    verification: "honor",
    photo_bonus_max: 0,
    neighborhood: "",
    minutes: 60,
    coords: null,
    stranger: false,
    interests: [],
    categories: [],
    resolvedNeighborhood: null,
    timeOverridden: false,
    ...extra,
  });

  it("prefers tasks at a place someone suggested", () => {
    const prefs = boardPreferencesFor({
      answers: [{}],
      difficulty: null,
      suggestions: [{ name: "teamLab Planets", coords: { lat: 35.649, lng: 139.79 }, by: "Dev" }],
    });
    const near = task("find the quietest room at teamlab planets");
    const elsewhere = task("find the quietest room at a museum");
    expect(taskPriority(near, prefs)).toBeGreaterThan(taskPriority(elsewhere, prefs) * 2);
  });

  it("weights down a category the group asked to avoid", () => {
    const avoid = boardPreferencesFor({ answers: [{}], difficulty: null, avoid: { temples: 0.3 } });
    const plain = boardPreferencesFor({ answers: [{}], difficulty: null });
    const temple = task("walk through the gate at senso-ji", { categories: ["temples"] });
    expect(taskPriority(temple, avoid)).toBeCloseTo(taskPriority(temple, plain) * 0.3);
  });
});
