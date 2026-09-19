import { describe, expect, expectTypeOf, it } from "vitest";
import { SETUP_COMPLETE, SURVEY_DONE_DM, surveyDoneLine } from "./copy";
import {
  allParticipantsComplete,
  applyReply,
  buildSetupCompleteGroupPost,
  displayNameFromFirstName,
  includeQuestion,
  isSkip,
  startSidequestOnboarding,
  startSurvey,
  type PublicTripFields,
  type SurveyAnswers,
  type SurveyAwaiting,
} from "./survey";

const PRIVATE_ANSWERS: SurveyAnswers = {
  budget: { value: "low" },
  dietary: { value: "has_restriction" },
  dietary_strictness: { value: "allergy" },
  social_with: { value: "Michael" },
  social_travelled: { value: "Alex only" },
  social_couples: { value: "together" },
};

describe("survey helpers", () => {
  it("counts a trip complete only when everyone is done", () => {
    expect(allParticipantsComplete(["done", "done"])).toBe(true);
    expect(allParticipantsComplete(["done", "ab_pace"])).toBe(false);
    expect(allParticipantsComplete([])).toBe(false);
  });

  it("reads skip exactly", () => {
    expect(isSkip("  Skip ")).toBe(true);
    expect(isSkip("skip this one")).toBe(false);
  });
});

describe("first name for standings", () => {
  it("uses the first token of the survey answer", () => {
    expect(displayNameFromFirstName("Michael Chen", "+19055550100")).toBe(
      "Michael",
    );
    expect(displayNameFromFirstName("  ", "+19055550100")).toBe("+19055550100");
  });
});

describe("survey v2: eight quick ones, anything accepted", () => {
  const at = (awaiting: SurveyAwaiting, answers: SurveyAnswers = {}) => ({ awaiting, answers });
  const walk = (replies: string[], isSolo = false) => {
    let step = startSurvey();
    const asked = [step.state.awaiting as string];
    for (const reply of replies) {
      step = applyReply(step.state, reply, { isSolo });
      asked.push(step.state.awaiting as string);
      if (step.completed) break;
    }
    return { step, asked };
  };

  it("opens with the intro and asks for a preferred name before the personality questions", () => {
    const first = startSurvey();
    expect(first.prompt).toMatch(/^quick personality test, because asking "what do you like" is useless\./);
    expect(first.prompt).toMatch(/what should i call you\?$/);
    const { step, asked } = walk(["sam", "food", "wander", "museum", "cram", "$80", "none", "eat something i can't identify", "yes"]);
    expect(step.completed).toBe(true);
    expect(asked.filter((id) => id !== "done")).toHaveLength(9);
    expect(step.prompt).toBe("done. you're less mysterious than you think.");
  });

  it("reads either-or answers loosely, and stores vague ones as vague, never re-asking", () => {
    const pick = (text: string) => applyReply(at("ab_food_outdoors"), text).state.answers.ab_food_outdoors;
    expect(pick("the food one obviously")).toEqual({ value: "a", confidence: "high" });
    expect(pick("kayak")).toEqual({ value: "b", confidence: "medium" });
    expect(pick("b")).toEqual({ value: "b", confidence: "medium" });
    expect(pick("both honestly")).toEqual({ value: "both", confidence: "low" });
    expect(pick("somewhere in between")).toEqual({ value: "both", confidence: "low" });
    expect(pick("whatever the group wants")).toEqual({ value: "both", confidence: "low" });
    expect(pick("neither tbh")).toEqual({ value: "none", confidence: "low" });
    // A vague answer moves on.
    expect(applyReply(at("ab_food_outdoors"), "idk").state.awaiting).toBe("ab_discover_iconic");
    // Skip is a low-confidence middle, still stored.
    expect(applyReply(at("ab_food_outdoors"), "skip").state.answers.ab_food_outdoors).toEqual({ skipped: true, confidence: "low" });
  });

  it("flags an off-topic reply as unclear, keeps the question, and re-asks it another way", () => {
    const step = applyReply(at("ab_discover_iconic"), "wait is it raining in tokyo rn");
    expect(step.unclear).toBe(true);
    expect(step.state.awaiting).toBe("ab_discover_iconic");
    expect(step.prompt).toBe("wandering and finding random stuff, or the famous thing?");
  });

  it("clarifies budget once when it is unusable, then settles on the middle", () => {
    const vague = applyReply(at("budget_band"), "not too expensive");
    expect(vague.state.awaiting).toBe("fu_budget");
    const settled = applyReply(vague.state, "idk, normal");
    expect(settled.state.answers.budget_band).toEqual({ value: "50_100", confidence: "low" });
    expect(applyReply(at("budget_band"), "like $80 a day").state.answers.budget_band).toEqual({ value: "50_100", confidence: "medium" });
    expect(applyReply(at("budget_band"), "don't make me think about money").state.answers.budget_band?.value).toBe("no_limit");
  });

  it("asks a follow-up only when it changes a decision", () => {
    const allergy = applyReply(at("hard_constraints"), "shellfish allergy");
    expect(allergy.state.awaiting).toBe("fu_allergy_cc");
    expect(allergy.prompt).toBe("actual allergy where cross-contamination matters too?");
    const said = applyReply(at("hard_constraints"), "severe peanut allergy, even traces");
    expect(said.state.awaiting).toBe("must_have");
    const veg = applyReply(at("hard_constraints"), "vegetarian but not that strict on vacation");
    expect(veg.state.awaiting).toBe("fu_diet_strict");
    expect(veg.prompt).toBe("got it, preference not a hard rule?");
    expect(applyReply(at("hard_constraints"), "none").state.awaiting).toBe("must_have");
    expect(applyReply(at("hard_constraints"), "a few things").state.awaiting).toBe("fu_constraints");
    const depends = applyReply(at("splitting"), "depends");
    expect(depends.state.awaiting).toBe("fu_split");
    expect(depends.prompt).toBe("depends on what? someone you want to stick with, or just what we're doing?");
  });

  it("keeps an answer that arrives early and skips that question later", () => {
    const step = applyReply(at("budget_band"), "also i'm vegetarian lol, 60 a day");
    expect(step.state.answers.budget_band?.value).toBe("50_100");
    expect(step.state.answers.hard_constraints).toMatchObject({ value: "i'm vegetarian lol", early: true });
    expect(includeQuestion("hard_constraints", step.state.answers)).toBe(false);
    const early = applyReply(at("ab_pace"), "cram it all in. oh and i'm allergic to peanuts");
    expect(early.state.answers.hard_constraints?.early).toBe(true);
    expect(early.state.awaiting).toBe("budget_band");
  });

  it("goes back on 'wait, go back'", () => {
    const first = applyReply(at("ab_food_outdoors"), "food");
    const back = applyReply(first.state, "wait, go back");
    expect(back.state.awaiting).toBe("ab_food_outdoors");
    expect(back.state.answers.ab_food_outdoors).toBeUndefined();
    expect(back.prompt).toMatch(/^sure\. insane local food spot/);
  });

  it("skips the splitting question solo", () => {
    const { asked } = walk(["sam", "a", "a", "a", "a", "$30", "none", "ramen"], true);
    expect(asked).not.toContain("splitting");
    expect(asked.at(-1)).toBe("done");
  });

  it("runs the sidequest onboarding on its own, with red lines only for 2 or 3", () => {
    const start = startSidequestOnboarding({});
    expect(start.prompt).toMatch(/^btw i'm turning on sidequests\. how unhinged am i allowed to get\?/);
    const two = applyReply(start.state, "2");
    expect(two.state.awaiting).toBe("sidequest_red_lines");
    const done = applyReply(two.state, "strangers");
    expect(done.completed).toBe(true);
    expect(applyReply(start.state, "absolutely not").completed).toBe(true);
    expect(applyReply(start.state, "civilized").prompt).toBe("civilized it is. i'll keep it polite.");
  });
});

describe("survey ending", () => {
  it("says what happens next", () => {
    expect(surveyDoneLine(0)).toBe(`${SURVEY_DONE_DM} your first board drops in the morning.`);
    expect(surveyDoneLine(1)).toContain("waiting on 1 more person");
    expect(surveyDoneLine(3)).toContain("waiting on 3 more people");
    expect(surveyDoneLine(2)).not.toContain("\n");
  });
});

describe("DM stays in DM", () => {
  it("group-post path cannot read survey_json fields", () => {
    expectTypeOf<PublicTripFields>().not.toHaveProperty("survey_json");

    const trip: PublicTripFields = {
      id: "trip-1",
      linq_chat_id: "chat-1",
      name: "Osaka",
      state: "surveying",
    };
    const post = buildSetupCompleteGroupPost(trip);

    expect(post).toBe(SETUP_COMPLETE);
    expect(post).not.toMatch(/low|allergy|Michael|Alex|together|has_restriction/i);

    const stuffed = {
      ...trip,
      survey_json: PRIVATE_ANSWERS,
    };
    const stillPublic = buildSetupCompleteGroupPost(stuffed);
    expect(stillPublic).toBe(SETUP_COMPLETE);
    expect(stillPublic).not.toContain("Michael");
    expect(stillPublic).not.toContain("allergy");
    expect(stillPublic).not.toContain("low");
  });
});
