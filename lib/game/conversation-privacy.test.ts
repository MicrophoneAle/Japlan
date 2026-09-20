import { describe, expect, it } from "vitest";
import { PRIVATE_SURVEY_IDS, PUBLIC_SURVEY_IDS, surveySliceForConversation } from "./conversation";
import { SURVEY_V2_ORDER } from "./survey-questions";
import type { QuestionId } from "./survey-questions";
import type { SurveyAnswers } from "./survey";

// DM stays in DM. The group slice is an ALLOWLIST, and until now it had no
// test at all: the one rule in CLAUDE.md that says "enforce in the prompt and
// with a test" was enforced only in the prompt.

// A full set of answers, one per id the allowlist mentions, so a leak shows up
// as a value rather than as an absence.
const ANSWERS = {
  first_name: "Sarah",
  interests: "food, music",
  interest_picks: "food",
  pace: "steady",
  chaos: "medium",
  nightlife: "yes",
  competitiveness: "high",
  attractions: "teamLab",
  must_have: "see a show",
  // Everything below must never reach a group prompt.
  budget: "100 a day",
  budget_band: "under_100",
  dietary: "vegetarian",
  dietary_detail: "no fish either",
  dietary_strictness: "strict",
  sociability: "rather_not",
  age_bracket: "under_18",
  mobility: "bad knee",
  blackout: "22:00-08:00",
  social_with: "jess",
  social_travelled: "jess",
  social_couples: "me and jess",
  hard_constraints: "severe peanut allergy",
  fu_budget: "maybe 80",
  fu_allergy_cc: "yes, cross contact matters",
  fu_diet_strict: "strict",
} as unknown as SurveyAnswers;

// Anything about someone's body, money, or who they want to be with.
const NEVER_PUBLIC: QuestionId[] = [
  "budget",
  "budget_band",
  "fu_budget",
  "dietary",
  "dietary_detail",
  "dietary_strictness",
  "fu_diet_strict",
  "fu_allergy_cc",
  "hard_constraints",
  "mobility",
  "age_bracket",
  "blackout",
  "sociability",
  "social_with",
  "social_travelled",
  "social_couples",
];

describe("what a group prompt may see", () => {
  it("shares the must-have, because it is the person's pitch to the group", () => {
    const group = surveySliceForConversation(ANSWERS, false);
    expect(group.must_have).toBe("see a show");
    expect(PUBLIC_SURVEY_IDS).toContain("must_have");
  });

  it("never lets a private answer into a group slice", () => {
    const group = surveySliceForConversation(ANSWERS, false);
    for (const id of NEVER_PUBLIC) {
      expect(group[id], `${id} must stay in dm`).toBeUndefined();
      expect(PUBLIC_SURVEY_IDS, `${id} must not be on the allowlist`).not.toContain(id);
    }
  });

  it("never lets a private VALUE appear anywhere in a group slice", () => {
    // Not just the right keys: the serialised slice is what reaches the model,
    // so check no private answer's text is in it under any key.
    const serialised = JSON.stringify(surveySliceForConversation(ANSWERS, false)).toLowerCase();
    for (const leak of [
      "peanut",
      "vegetarian",
      "bad knee",
      "under_18",
      "jess",
      "100 a day",
      "under_100",
      "rather_not",
      "22:00",
    ]) {
      expect(serialised, `"${leak}" leaked into a group slice`).not.toContain(leak);
    }
  });

  it("gives a DM everything, so the person can still talk about their own answers", () => {
    const dm = surveySliceForConversation(ANSWERS, true);
    expect(dm.must_have).toBe("see a show");
    expect(dm.dietary).toBe("vegetarian");
    expect(dm.mobility).toBe("bad knee");
    // Survey v2 fields that used to reach no prompt at all.
    expect(dm.budget_band).toBe("under_100");
    expect(dm.hard_constraints).toBe("severe peanut allergy");
    expect(dm.fu_allergy_cc).toBe("yes, cross contact matters");
  });

  // The property that matters for every field added after this test: the
  // allowlist is closed, so a new survey question is private by default and
  // becomes shareable only when somebody puts it on the list on purpose.
  it("is fail-closed: a survey id on neither list reaches no prompt at all", () => {
    const unknown = { ...ANSWERS, some_new_question: "a secret" } as unknown as SurveyAnswers;
    expect(JSON.stringify(surveySliceForConversation(unknown, false))).not.toContain("a secret");
    expect(JSON.stringify(surveySliceForConversation(unknown, true))).not.toContain("a secret");
  });

  it("keeps the two lists disjoint, so nothing is both public and private", () => {
    const overlap = PUBLIC_SURVEY_IDS.filter((id) => PRIVATE_SURVEY_IDS.includes(id));
    expect(overlap).toEqual([]);
  });

  // Every question the live survey actually asks is either deliberately
  // shareable or deliberately not. A new one shows up here as a failure with
  // its own name, rather than silently defaulting either way.
  it("has a deliberate decision recorded for every question survey v2 asks", () => {
    const asked = SURVEY_V2_ORDER;
    const undecided = asked.filter(
      (id) => !PUBLIC_SURVEY_IDS.includes(id) && !PRIVATE_SURVEY_IDS.includes(id),
    );
    // Every question survey v2 asks is now classified, so this is empty. A
    // new one lands here by name rather than defaulting either way.
    expect(undecided).toEqual([]);
  });
});
