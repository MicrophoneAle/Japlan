import { describe, expect, it } from "vitest";
import { hardNoWords, parseConstraints, readYesNo } from "./constraints";
import { isStopCommand, entrySignal, obviousDisengage, OTHERS_IN_A_ROW } from "./engagement";
import { matchDifficulty } from "./setup";
import {
  compatAnswers,
  hasPreferenceSignal,
  prefsOf,
  v2View,
  effectiveWeight,
  nudge,
  prefDimsFor,
  prefsFromAnswers,
  profileStale,
  setWeight,
  withBasis,
} from "./prefs";
import { constraintLine, groupProfile, personProfile } from "./profile";
import { changedState, checkReply, type ReplyFacts } from "./reply-check";
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
  it("stop needs the name, and takes the phrasings people actually use", () => {
    for (const t of [
      "japlan quiet",
      "japlan stop",
      "japlan shut up",
      "shut up japlan",
      "stop japlan",
      "we're good japlan",
      "Japlan, quiet.",
      "japlan be quiet",
      "japlan that's all",
    ]) {
      expect(isStopCommand(t)).toBe(true);
    }
    for (const t of ["stop", "quiet", "japlan what's the score", "we should chill at the park"]) {
      expect(isStopCommand(t)).toBe(false);
    }
  });

  // "chill" is a difficulty level, not the mute. Engagement is decided before
  // setup answers are read, so while this was a stop word "japlan chill"
  // muted the bot instead of setting the difficulty.
  it("never mutes on 'chill', which means difficulty and only difficulty", () => {
    for (const t of ["japlan chill", "chill japlan", "Japlan, chill.", "japlan chill!"]) {
      expect(isStopCommand(t)).toBe(false);
    }
    expect(matchDifficulty("chill")).toBe("chill");
    expect(matchDifficulty("easy")).toBe("chill");
  });

  // None of the mute phrasings may be readable as a difficulty either, or the
  // collision just moves rather than going away.
  it("keeps the mute vocabulary and the difficulty vocabulary disjoint", () => {
    for (const t of [
      "quiet",
      "stop",
      "shut up",
      "be quiet",
      "shush",
      "enough",
      "mute",
      "we're good",
      "that's all",
      "go away",
      "not now",
    ]) {
      expect(matchDifficulty(t)).toBeNull();
    }
    for (const t of ["chill", "normal", "unhinged", "easy", "chilled", "relaxed", "low", "hard", "wild"]) {
      expect(isStopCommand(`japlan ${t}`)).toBe(false);
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
    stateChanged: false,
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

describe("the first survey still counts", () => {
  const first = {
    pace: v("early_and_moving"),
    budget: v("high"),
    dietary: v("has_restriction"),
    dietary_detail: v("no pork"),
    mobility: v("no_limits"),
    nightlife: v("yes"),
    interest_picks: v("weird"),
  } as SurveyAnswers;

  it("reads its answers as weights, not as 'no preferences'", () => {
    const w = prefsFromAnswers(first).weights;
    expect(w.nightlife.c).toBe("medium");
    expect(w.local_discovery).toEqual({ w: 0.8, c: "medium" });
    expect(hasPreferenceSignal(prefsFromAnswers(first))).toBe(true);
  });

  it("lets its answers replace a stored low-confidence guess, and keeps what was learned", () => {
    const stored = { version: 2, weights: { ...prefsFromAnswers({}).weights, food: { w: 0.9, c: "high" } } };
    const merged = prefsOf(stored, first);
    expect(merged.weights.nightlife.c).toBe("medium");
    expect(merged.weights.food).toEqual({ w: 0.9, c: "high" });
  });

  it("describes pace, budget and constraints from it", () => {
    const view = v2View(first);
    expect(view.ab_pace?.value).toBe("a");
    expect(view.budget_band?.value).toBe("100_200");
    expect(view.hard_constraints?.value).toBe("no pork");
    const text = personProfile({ name: "you", answers: first });
    expect(text).toMatch(/^you lean/);
    expect(text).toContain("You are fine spending $100-200 a day.");
    expect(text).not.toMatch(/don't know your preferences/);
  });
});

describe("the group profile only claims what was answered", () => {
  it("does not say everyone is fine splitting up when one of four said so", () => {
    const text = groupProfile(
      [{ answers: { splitting: v("yes"), ab_pace: v("b") } as SurveyAnswers }, { answers: {} }, { answers: {} }, { answers: {} }],
      { groupSize: 4 },
    );
    expect(text).not.toContain("Everyone is fine splitting up");
    expect(text).toContain("1 of 4 said they're fine splitting up; 3 haven't said.");
    expect(text).toContain("Mostly want slower days (1 of 4 answered).");
  });

  it("says everyone only when everyone answered", () => {
    const yes = { answers: { splitting: v("yes") } as SurveyAnswers };
    expect(groupProfile([yes, yes], { groupSize: 2 })).toContain("Everyone is fine splitting up.");
  });

  it("counts people who never answered in the group size", () => {
    expect(groupProfile([{ answers: {} }], { groupSize: 3 })).toMatch(/^A group of 3\. Nobody has said what they're into yet\./);
  });
});

// The bug class this exists for: "got it bob, profile locked in" when nothing
// changed. A reply may only claim a state change if a tool actually made one.
describe("a reply may not promise what no tool did", () => {
  const base: ReplyFacts = {
    taskCodes: ["A1"],
    people: ["Dev"],
    toolText: "",
    // Carries "day 3" so the number rule is not what fires in these cases.
    userText: "can we do shibuya sky on day 3",
    contextText: "",
    stateChanged: false,
  };

  it("discards a claim that something was added when nothing wrote it", () => {
    for (const reply of [
      "ooh i'll add that to the board",
      "added it to day 3",
      "bet, saved",
      "locked in 🔒",
      "ok say less, putting it on the board",
    ]) {
      expect(checkReply(reply, base)).toMatchObject({ ok: false, reason: "narrated_uncompleted_action" });
    }
  });

  it("lets the same claim through once a tool actually changed something", () => {
    for (const reply of ["added it to day 3", "locked in 🔒"]) {
      expect(checkReply(reply, { ...base, stateChanged: true })).toEqual({ ok: true });
    }
    expect(changedState(["add_suggestion"])).toBe(true);
    expect(changedState(["get_standings", "search_web"])).toBe(false);
  });

  it("never touches an offer, a question, or ordinary chat", () => {
    for (const reply of [
      "want me to add it?",
      "should i put it on day 3?",
      "shibuya sky is unreal at sunset, go at golden hour",
      "yeah the views there are worth it",
      "lemme know if you want it on a specific day",
    ]) {
      expect(checkReply(reply, base)).toEqual({ ok: true });
    }
  });

  // "sort" is a deferral in ordinary speech, and this is real survey copy.
  // A rule that discards it costs a good reply and catches nothing.
  it("lets a deferral through rather than reading it as a promise", () => {
    expect(checkReply("no clue yet, i'll sort that once we're done here.", base)).toEqual({ ok: true });
  });
});
