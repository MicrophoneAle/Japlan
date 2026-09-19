import { describe, expect, it } from "vitest";
import { dietClashes, parseDiet } from "./diet";
import { usableWindow, paceFor } from "./day-plan";
import { fillTemplatesDeterministically } from "./generate";
import {
  boardPreferencesFor,
  planFromProposals,
  templatesAllowedFor,
  type PlannedTask,
} from "./plan-board";
import { groupBlackouts, parseBlackouts } from "./preferences";
import type { SurveyAnswers } from "./survey";
import { boardTemplates, templateById } from "./templates";
import { TOKYO_HAND_PROFILE } from "./tokyo-profile";
import { estimateTaskCost, BUDGET_CEILING, validateGeneratedTask, type ProposedTask } from "./validate";

// The survey's effect on the board, pinned on the OUTPUT. Every board below
// gets the same model proposals (a broad menu across the template bank) and
// the same fallback; only survey_json changes. So any difference is the
// survey acting, through filters (validate.ts, selection) and weights.

const axes = (b: number, t: number, p = 1) => ({ boldness: b, physical: p, time: t, scarcity: 3, cultural: 3, aesthetics: 2 });
const menu: ProposedTask[] = [
  { template: "stranger_best_rec", title: "ask a stranger in asakusa for their single best recommendation, then actually do it", places: ["Asakusa"], axes: axes(5, 3, 2) },
  { template: "compliment_outfit", title: "compliment a stranger's outfit in japanese in shibuya", places: ["Shibuya"], axes: axes(5, 2) },
  { template: "phrase_wrong", title: "learn a greeting from someone in koenji, then use it wrong in public", places: ["Koenji"], axes: axes(4, 2) },
  { template: "order_what_neighbour_ordered", title: "ask what the person next to you ordered in nakameguro, then order that", places: ["Nakameguro"], axes: axes(4, 3) },
  { template: "museum_staff_pick", title: "ask someone working at the tokyo national museum which piece they would save in a fire, then go find it", places: ["Ueno Park"], axes: axes(4, 4) },
  { template: "oldest_thing", title: "find the oldest thing you can touch in yanaka, and find out how old it is", places: ["Yanaka"], axes: axes(3, 3, 2) },
  { template: "neighborhood_dish", title: "eat okonomiyaki in kichijoji", places: ["Kichijoji"], axes: axes(2, 3, 2) },
  { template: "dish_where_from", title: "eat takoyaki where it is actually from, not a tourist version", places: ["Tokyo Tower"], axes: axes(2, 3, 2) },
  { template: "cheapest_meal", title: "find the cheapest full meal in shimokitazawa, photograph the receipt", places: ["Shimokitazawa"], axes: axes(2, 3, 2) },
  { template: "order_unreadable", title: "order something you cannot read, in ueno", places: ["Ueno"], axes: axes(2, 2) },
  { template: "bartender_pick", title: "get a bartender in shibuya to make you whatever they are proudest of", places: ["Shibuya Crossing"], axes: axes(3, 3) },
  { template: "a_to_b_without", title: "get from senso-ji to ueno park without the train", places: ["Senso-ji", "Ueno Park"], axes: axes(3, 3, 5) },
  { template: "highest_point", title: "find the highest publicly accessible point in shibuya", places: ["Meiji Jingu"], axes: axes(3, 3, 4) },
  { template: "wrong_train", title: "take the wrong train deliberately, one stop, get off, look around", places: [], axes: axes(3, 3, 2) },
  { template: "buy_keep", title: "buy something under 1,000 yen you will actually keep", places: [], axes: axes(2, 2) },
  { template: "stay_one_hour", title: "stay in one place for an hour doing nothing", places: [], axes: axes(2, 3) },
].map((t) => ({
  code: "",
  verification: "photo" as const,
  photo_bonus_max: 2,
  neighborhood: "",
  ...t,
  place: t.places?.[0],
}));

const weather = { summary: "clear", indoorPreferred: false, temperatureC: 22, precipitationChance: 0 };

function boardFor(
  people: SurveyAnswers[],
  opts: { difficulty?: string | null; solo?: boolean } = {},
): PlannedTask[] {
  const window = usableWindow({
    boardTime: "08:00",
    pace: paceFor(people.map((a) => a.pace?.value)),
    blackouts: groupBlackouts(people),
  });
  const templates = templatesAllowedFor(boardTemplates({ solo: opts.solo ?? true }), people);
  const fallback = [0, 1, 2, 3].flatMap((v) =>
    fillTemplatesDeterministically({ profile: TOKYO_HAND_PROFILE, weather, templates, count: templates.length, seed: 14 + v * 5 }),
  );
  const { tasks } = planFromProposals({
    proposals: menu,
    fallback,
    ctx: {
      profile: TOKYO_HAND_PROFILE,
      solo: opts.solo ?? true,
      window,
      assignees: people.map((a) => ({ answers: a })),
      completedTitles: [],
      expiresAt: new Date("2026-10-18T15:00:00Z"),
      now: new Date("2026-10-17T00:00:00Z"),
    },
    prefs: boardPreferencesFor({ answers: people, difficulty: opts.difficulty ?? "normal" }),
  });
  return tasks;
}

const v = (value: string) => ({ value });
const base: SurveyAnswers = { sociability: v("love_it"), pace: v("two_things_and_lunch") };
const needsStranger = (t: PlannedTask) => t.stranger || Boolean(templateById(t.template)?.needs_stranger);
const hasInterest = (t: PlannedTask, key: string) => t.interests.includes(key as never);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe("the survey changes the board", () => {
  it("food-heavy and museum-heavy picks give measurably different kind mixes", () => {
    const food = boardFor([{ ...base, interest_picks: v("food") }]);
    const museums = boardFor([{ ...base, interest_picks: v("museums,architecture") }]);
    const share = (b: PlannedTask[], key: string) => b.filter((t) => hasInterest(t, key)).length / b.length;
    expect(share(food, "food")).toBeGreaterThan(share(museums, "food") + 0.2);
    expect(share(museums, "museums")).toBeGreaterThan(share(food, "museums"));
    expect(museums.some((t) => t.template === "museum_staff_pick" || t.template === "oldest_thing")).toBe(true);
  });

  it("'rather not' on strangers: zero tasks that need one, and still some boldness", () => {
    const board = boardFor([{ ...base, sociability: v("rather_not") }]);
    expect(board.length).toBeGreaterThan(0);
    expect(board.filter(needsStranger)).toEqual([]);
    expect(board.some((t) => t.axes.boldness >= 3)).toBe(true);
  });

  it("'love it': at least one social task on every board", () => {
    for (const difficulty of ["chill", "normal", "unhinged"]) {
      const board = boardFor([{ ...base, sociability: v("love_it") }], { difficulty });
      expect(board.filter(needsStranger).length, difficulty).toBeGreaterThanOrEqual(1);
    }
  });

  it("'fine in small doses': at most one", () => {
    const board = boardFor([{ ...base, sociability: v("small_doses") }], { difficulty: "unhinged" });
    expect(board.filter(needsStranger).length).toBeLessThanOrEqual(1);
    // Compare: the same everything with "love it" has more.
    const love = boardFor([{ ...base, sociability: v("love_it") }], { difficulty: "unhinged" });
    expect(love.filter(needsStranger).length).toBeGreaterThan(1);
  });

  it("a shared board takes the most restrictive answer", () => {
    const board = boardFor(
      [{ ...base, sociability: v("love_it") }, { ...base, sociability: v("rather_not") }],
      { solo: false },
    );
    expect(board.filter(needsStranger)).toEqual([]);
  });

  it("a shellfish allergy: no food task involving shellfish, no blind food, but food is not all gone", () => {
    const allergic = { ...base, interest_picks: v("food"), dietary: v("has_restriction"), dietary_detail: v("shellfish"), dietary_strictness: v("allergy") };
    const board = boardFor([allergic]);
    const keys = parseDiet("shellfish").keys;
    expect(board.filter((t) => dietClashes(t.title, keys).length > 0)).toEqual([]);
    expect(board.some((t) => templateById(t.template)?.blind_food)).toBe(false);
    expect(board.some((t) => t.title.includes("takoyaki"))).toBe(false);
    expect(board.some((t) => t.kind === "food")).toBe(true);
    // An allergy nobody named still fails closed: no food at all.
    const unknown = boardFor([{ ...base, interest_picks: v("food"), dietary: v("has_restriction"), dietary_strictness: v("allergy") }]);
    expect(unknown.some((t) => t.kind === "food")).toBe(false);
  });

  it("a low budget: nothing over the cost ceiling", () => {
    const board = boardFor([{ ...base, budget: v("low") }]);
    for (const t of board) {
      expect(estimateTaskCost(t.title, templateById(t.template)?.typical_cost), t.title).toBeLessThanOrEqual(BUDGET_CEILING.low);
    }
    // The same survey on a high budget does get a medium-cost task.
    const rich = boardFor([{ ...base, budget: v("high"), interest_picks: v("food,museums") }]);
    expect(rich.some((t) => templateById(t.template)?.typical_cost === "medium")).toBe(true);
  });

  it("mobility limits: no climb, hike, stairs, long walk, or physically hard template", () => {
    const board = boardFor([{ ...base, mobility: v("has_limits") }]);
    for (const t of board) {
      expect(t.title).not.toMatch(/climb|hike|stairs|steep|long walk|highest|without (?:a |the )?(?:train|taxi)|on foot/);
      expect(templateById(t.template)?.axes.physical.min ?? 0, t.title).toBeLessThan(3);
    }
  });

  it("chill and unhinged sit at different boldness, and chill is not forced to 1", () => {
    const chill = boardFor([base], { difficulty: "chill" });
    const unhinged = boardFor([base], { difficulty: "unhinged" });
    const chillMean = mean(chill.map((t) => t.axes.boldness));
    expect(mean(unhinged.map((t) => t.axes.boldness))).toBeGreaterThan(chillMean + 0.5);
    expect(chill.some((t) => t.axes.boldness >= 3)).toBe(true);
    expect(chill.every((t) => t.axes.boldness === 1)).toBe(false);
  });

  it("a relaxed pace gets fewer main tasks than a chaotic one", () => {
    const relaxed = boardFor([{ ...base, pace: v("two_things_and_lunch") }]);
    const chaotic = boardFor([{ ...base, pace: v("early_and_moving") }]);
    expect(chaotic.length).toBeGreaterThan(relaxed.length);
  });

  it("no drinking: no bar or alcohol task", () => {
    const board = boardFor([{ ...base, interest_picks: v("nightlife"), drinking: v("no") }]);
    expect(board.some((t) => templateById(t.template)?.alcohol || /bar|sake|beer/.test(t.title))).toBe(false);
  });

  it("blackout times shrink the day", () => {
    expect(parseBlackouts("work calls 9-11am")).toEqual([[540, 660]]);
    expect(parseBlackouts("mornings")).toEqual([[0, 720]]);
    expect(parseBlackouts("prayer at 1pm")).toEqual([[780, 840]]);
    const free = boardFor([base]);
    const busy = boardFor([{ ...base, blackout: v("mornings, and calls 3-5pm") }]);
    const minutes = (b: PlannedTask[]) => b.reduce((sum, t) => sum + t.minutes, 0);
    expect(minutes(busy)).toBeLessThan(minutes(free));
    expect(busy.every((t) => t.slot !== "morning")).toBe(true);
  });
});

describe("diet parsing", () => {
  it("reads what people write, and which dishes carry it", () => {
    expect(parseDiet("shellfish").keys).toEqual(["shellfish"]);
    expect(parseDiet("vegetarian").keys).toEqual(["meat"]);
    expect(parseDiet("no pork, and nuts").keys.sort()).toEqual(["peanut", "pork", "tree_nut"]);
    expect(parseDiet("i just don't like cilantro").understood).toBe(false);
    expect(dietClashes("eat takoyaki where it is actually from", ["shellfish"])).toEqual(["shellfish"]);
    expect(dietClashes("eat okonomiyaki in kichijoji", ["shellfish"])).toEqual([]);
    expect(dietClashes("eat tonkatsu in ueno", parseDiet("halal").keys)).toEqual(["pork"]);
  });
});

describe("the filters live in validation, not the prompt", () => {
  const facts = (id: string) => {
    const t = templateById(id)!;
    return { needs_stranger: t.needs_stranger, blind_food: t.blind_food, alcohol: t.alcohol, kind: t.kind, typical_cost: t.typical_cost, physicalMin: t.axes.physical.min };
  };
  const check = (id: string, title: string, answers: SurveyAnswers) =>
    validateGeneratedTask(
      { code: "", title, axes: axes(3, 3), verification: "honor", photo_bonus_max: 0, neighborhood: "" },
      { assignees: [{ answers }], completedTitles: [], template: facts(id) },
    );

  it("rejects by the template's needs_stranger flag, whatever the title says", () => {
    const rather = { sociability: v("rather_not") };
    expect(check("compliment_outfit", "say something nice in shibuya", rather)).toBe("sociability");
    expect(check("wrong_train", "take the wrong train one stop", rather)).toBeNull();
    // A title that adds a person to a quiet template is caught too (fail closed).
    expect(check("wrong_train", "take the wrong train and ask a local where to go", rather)).toBe("sociability");
    expect(check("compliment_outfit", "say something nice in shibuya", { sociability: v("love_it") })).toBeNull();
  });

  it("rejects alcohol for a non-drinker and anyone under 18", () => {
    expect(check("bartender_pick", "get a bartender to make you something", { drinking: v("no") })).toBe("alcohol");
    expect(check("bartender_pick", "get a bartender to make you something", { age_bracket: v("under_18") })).toBe("alcohol");
    expect(check("bartender_pick", "get a bartender to make you something", { drinking: v("yes") })).toBeNull();
  });

  it("rejects blind food for a cautious eater", () => {
    expect(check("order_unreadable", "order something you cannot read", { food_adventure: v("honestly not very adventurous") })).toBe("blind_food");
    expect(check("order_unreadable", "order something you cannot read", { food_adventure: v("anything goes") })).toBeNull();
  });
});
