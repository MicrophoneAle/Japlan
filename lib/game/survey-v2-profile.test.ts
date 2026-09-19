import { describe, expect, it } from "vitest";
import { hardNoWords, parseConstraints, readYesNo } from "./constraints";
import { isStopCommand, entrySignal, obviousDisengage, OTHERS_IN_A_ROW } from "./engagement";
import {
  compatAnswers,
  effectiveWeight,
  nudge,
  prefDimsFor,
  prefsFromAnswers,
  profileStale,
  setWeight,
  withBasis,
} from "./prefs";
import { constraintLine, groupProfile, personProfile } from "./profile";
import { checkReply, type ReplyFacts } from "./reply-check";
import type { SurveyAnswers } from "./survey";
import { validateGeneratedTask, type ProposedTask } from "./validate";

const v = (value: string, extra: Record<string, unknown> = {}) => ({ value, ...extra });

describe("hard constraints, parsed in code", () => {
  it("reads none, vague and real answers", () => {
    expect(parseConstraints("nope").none).toBe(true);
    expect(parseConstraints("a few things")).toMatchObject({ none: false, vague: true, items: [] });
    expect(parseConstraints("no idea honestly")).toMatchObject({ vague: true, items: [] });
    const parse = parseConstraints("shellfish allergy, no heights, bad knee");
    expect(parse.items.map((i) => i.kind)).toEqual(["allergy", "hard_no", "mobility"]);
    // Verbatim, never reworded.
    expect(parse.items[0].text).toBe("shellfish allergy");
    expect(parse.followUp).toBe("allergy_strictness");
    expect(hardNoWords(parse.items)).toEqual(["heights"]);
  });

  it("asks nothing when strictness was already said", () => {
    expect(parseConstraints("severe peanut allergy, even traces").followUp).toBeNull();
    expect(parseConstraints("strict vegetarian").followUp).toBeNull();
    expect(parseConstraints("vegetarian but not that strict").followUp).toBe("diet_strictness");
    expect(parseConstraints("vegetarian but not strict").items[0].strict).toBe(false);
  });

  it("reads yes and no loosely", () => {
    expect(readYesNo("yeah it matters")).toBe(true);
    expect(readYesNo("nah traces are fine")).toBe(false);
    expect(readYesNo("hmm")).toBeNull();
  });
});

describe("weights with confidence", () => {
  it("either-or answers start at medium; vague and skipped answers stay low and near the middle", () => {
    const picked = prefsFromAnswers({ ab_food_outdoors: v("a", { confidence: "medium" }) } as SurveyAnswers);
    expect(picked.weights.food).toEqual({ w: 0.8, c: "medium" });
    expect(picked.weights.outdoors).toEqual({ w: 0.3, c: "medium" });
    const vague = prefsFromAnswers({ ab_food_outdoors: v("both", { confidence: "low" }) } as SurveyAnswers);
    expect(vague.weights.food.c).toBe("low");
    const skipped = prefsFromAnswers({ ab_food_outdoors: { skipped: true, confidence: "low" } } as SurveyAnswers);
    expect(skipped.weights.food).toEqual({ w: 0.5, c: "low" });
    // Confidence pulls toward the middle.
    expect(effectiveWeight({ w: 0.8, c: "low" })).toBeLessThan(effectiveWeight({ w: 0.8, c: "medium" }));
    expect(effectiveWeight({ w: 0.8, c: "high" })).toBeCloseTo(0.8);
  });

  it("learns from behaviour a little at a time, and rewrites the profile only on a real move", () => {
    const base = withBasis(prefsFromAnswers({}));
    expect(profileStale(base)).toBe(false);
    const once = nudge(base, ["food"], 1);
    expect(once.weights.food.w).toBeGreaterThan(0.5);
    expect(profileStale(once)).toBe(false);
    let many = base;
    for (let i = 0; i < 6; i++) many = nudge(many, ["food"], 1);
    expect(profileStale(many)).toBe(true);
    // A stated preference is set outright, high confidence.
    expect(setWeight(base, ["food"], 0.2).weights.food).toEqual({ w: 0.2, c: "high" });
  });

  it("maps phrases to the dimensions they are about", () => {
    expect(prefDimsFor("food")).toContain("food");
    expect(prefDimsFor("museums")).toContain("culture");
    expect(prefDimsFor("the weather")).toEqual([]);
  });
});

describe("the old keys still work", () => {
  it("writes pace, budget, diet, mobility and sociability for the filters", () => {
    const answers = {
      ab_pace: v("a"),
      budget_band: v("under_50"),
      hard_constraints: v("vegetarian but not strict, bad knee"),
      fu_diet_strict: v("preference"),
      sidequest_level: v("2"),
      sidequest_red_lines: v("strangers"),
      splitting: v("no"),
    } as SurveyAnswers;
    const out = compatAnswers(answers, prefsFromAnswers(answers));
    expect(out.pace?.value).toBe("early_and_moving");
    expect(out.budget?.value).toBe("low");
    expect(out.dietary?.value).toBe("has_restriction");
    expect(out.dietary_strictness?.value).toBe("preference");
    expect(out.mobility?.value).toBe("has_limits");
    expect(out.sociability?.value).toBe("rather_not");
    expect(out.social_couples?.value).toBe("together");
  });

  it("an allergy stays a hard filter, never a preference", () => {
    const answers = { hard_constraints: v("peanut allergy"), fu_diet_strict: v("preference") } as SurveyAnswers;
    expect(compatAnswers(answers, prefsFromAnswers(answers)).dietary_strictness?.value).toBe("allergy");
  });
});

describe("written profiles", () => {
  const maya = {
    ab_food_outdoors: v("a", { confidence: "high" }),
    ab_pace: v("b"),
    hard_constraints: v("shellfish allergy"),
    fu_allergy_cc: v("yes"),
    must_have: v("eat at a standing sushi bar"),
    budget_band: v("50_100"),
  } as SurveyAnswers;

  it("keeps hard constraints verbatim, with what the follow-up established", () => {
    const text = personProfile({ name: "Maya", answers: maya });
    expect(text).toContain("shellfish allergy (cross-contamination matters)");
    expect(text).toMatch(/^Maya leans hard toward food/);
    expect(text).toContain("waste if they don't eat at a standing sushi bar");
    const veg = { hard_constraints: v("vegetarian but not strict"), fu_diet_strict: v("preference") } as SurveyAnswers;
    expect(personProfile({ name: "Sam", answers: veg })).toContain("vegetarian but not strict (a preference, not a hard rule)");
    const firm = { hard_constraints: v("vegetarian but not strict"), fu_diet_strict: v("hard") } as SurveyAnswers;
    expect(personProfile({ name: "Sam", answers: firm })).toContain("vegetarian but not strict (a hard rule)");
    expect(constraintLine({ kind: "diet", text: "vegetarian", strict: false })).toBe(
      "vegetarian (a preference, not a hard rule)",
    );
  });

  it("the group profile unions constraints and never names anyone", () => {
    const sam = { ab_food_outdoors: v("b"), hard_constraints: v("no heights") } as SurveyAnswers;
    const text = groupProfile([{ answers: maya }, { answers: sam }]);
    expect(text).toContain("shellfish allergy (cross-contamination matters)");
    expect(text).toContain("no heights");
    expect(text).toMatch(/Split on food/);
    expect(text).not.toMatch(/Maya|Sam/);
  });
});

describe("filters from the new answers", () => {
  const task = (title: string, physical = 1): ProposedTask => ({
    code: "",
    title,
    axes: { boldness: 2, physical, time: 2, scarcity: 2, cultural: 2, aesthetics: 2 },
    verification: "honor",
    photo_bonus_max: 0,
    neighborhood: "",
  });
  const check = (title: string, answers: SurveyAnswers, physical = 1) =>
    validateGeneratedTask(task(title, physical), { assignees: [{ answers }], completedTitles: [] });

  it("a hard no rules out the thing and its relatives", () => {
    const answers = { hard_constraints: v("no heights") } as SurveyAnswers;
    expect(check("go up tokyo tower", answers)).toBe("hard_no");
    expect(check("find the best bowl of ramen nearby", answers)).toBeNull();
  });

  it("sidequest red lines hold", () => {
    expect(check("sing one line of karaoke", { sidequest_red_lines: v("embarrassment") } as SurveyAnswers)).toBe("red_line");
    expect(check("climb every stair in the shrine", { sidequest_red_lines: v("physical stuff") } as SurveyAnswers, 4)).toBe(
      "red_line",
    );
  });

  it("a diet preference is a weight, not a filter", () => {
    const soft = { dietary: v("has_restriction"), dietary_detail: v("vegetarian"), dietary_strictness: v("preference") };
    const hard = { ...soft, dietary_strictness: v("allergy") };
    expect(check("eat a pork bun from a street stall", soft as SurveyAnswers)).toBeNull();
    expect(check("eat a pork bun from a street stall", hard as SurveyAnswers)).not.toBeNull();
  });
});

describe("engagement rules", () => {
  it("stop needs the name", () => {
    for (const t of ["japlan chill", "shut up japlan", "stop japlan", "we're good japlan", "Japlan, chill."]) {
      expect(isStopCommand(t)).toBe(true);
    }
    for (const t of ["stop", "chill", "japlan what's the score", "we should chill at the park"]) {
      expect(isStopCommand(t)).toBe(false);
    }
  });

  it("entry signals are reasons to ask, found by topic", () => {
    expect(entrySignal("who's winning rn")).toBe("score");
    expect(entrySignal("what's the plan for today")).toBe("plan");
    expect(entrySignal("we should go to the fish market")).toBe("suggestion");
    expect(entrySignal("heading to yanaka later", ["Yanaka"])).toBe("place");
    expect(entrySignal("lol my feet hurt")).toBeNull();
  });

  it("leaves on a long gap or when people talk among themselves", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    expect(obviousDisengage([{ role: "user", at: at(1) }], now)).toBe("bot_not_in_recent_chat");
    expect(obviousDisengage([{ role: "bot", at: at(30) }, { role: "user", at: at(1) }], now)).toBe("long_gap");
    const others = Array.from({ length: OTHERS_IN_A_ROW }, () => ({ role: "user" as const, at: at(1) }));
    expect(obviousDisengage([{ role: "bot", at: at(2) }, ...others], now)).toBe("others_talking");
    expect(obviousDisengage([{ role: "bot", at: at(2) }, { role: "user", at: at(1) }], now)).toBeNull();
  });
});

describe("reply checks", () => {
  const facts: ReplyFacts = {
    taskCodes: ["A1", "A2"],
    people: ["Maya Lin", "Sam"],
    toolText: '{"standings":[{"name":"Maya","points":40}]}',
    userText: "who's winning",
    contextText: "Yoyogi Park | Senso-ji",
  };

  it("passes a reply built from what tools returned", () => {
    expect(checkReply("maya's up on 40. go do A1 before sam catches up", facts)).toEqual({ ok: true });
    expect(checkReply("yoyogi park is right there", facts)).toEqual({ ok: true });
    expect(checkReply("go visit yoyogi park then", facts)).toEqual({ ok: true });
  });

  it("discards invented codes, numbers, people and places, and empty text", () => {
    expect(checkReply("do C4 next", facts)).toEqual({ ok: false, reason: "unknown_code:C4" });
    expect(checkReply("maya has 55", facts)).toMatchObject({ ok: false, reason: "unsourced_number:55" });
    expect(checkReply("jordan is winning", facts)).toMatchObject({ ok: false, reason: "unknown_person:jordan" });
    expect(checkReply("meet at hachiko square", facts)).toMatchObject({ ok: false, reason: "unknown_place:hachiko square" });
    expect(checkReply(" .. ", facts)).toMatchObject({ ok: false, reason: "empty" });
    expect(checkReply("your score is undefined", facts)).toMatchObject({ ok: false, reason: "malformed" });
  });
});
