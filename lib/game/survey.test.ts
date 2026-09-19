import { describe, expect, expectTypeOf, it } from "vitest";
import { SETUP_COMPLETE } from "./copy";
import {
  allParticipantsComplete,
  applyReply,
  buildSetupCompleteGroupPost,
  includeQuestion,
  isSkip,
  startSurvey,
  type PublicTripFields,
  type SurveyAnswers,
} from "./survey";

const PRIVATE_ANSWERS: SurveyAnswers = {
  budget: { value: "low" },
  dietary: { value: "has_restriction" },
  dietary_strictness: { value: "allergy" },
  social_with: { value: "Michael" },
  social_travelled: { value: "Alex only" },
  social_couples: { value: "together" },
};

function answerUntil(
  stopAt: string,
  replies: Partial<Record<string, string>>,
) {
  let step = startSurvey();
  const seen: string[] = [step.state.awaiting as string];
  while (step.state.awaiting !== "done" && step.state.awaiting !== stopAt) {
    const awaiting = step.state.awaiting;
    const reply = replies[awaiting] ?? "skip";
    step = applyReply(step.state, reply);
    seen.push(step.state.awaiting);
  }
  return { step, seen };
}

describe("survey skip and branching", () => {
  it("always accepts skip", () => {
    expect(isSkip("skip")).toBe(true);
    expect(isSkip(" SKIP ")).toBe(true);
    const started = startSurvey();
    const skipped = applyReply(started.state, "skip");
    expect(skipped.state.answers.age_bracket).toEqual({ skipped: true });
    expect(skipped.state.awaiting).toBe("dietary");
  });

  it("asks dietary_strictness only when there is a restriction", () => {
    const withRestriction = answerUntil("mobility", {
      age_bracket: "skip",
      dietary: "has_restriction",
      dietary_strictness: "allergy",
    });
    expect(withRestriction.seen).toContain("dietary_strictness");

    const none = answerUntil("mobility", {
      age_bracket: "skip",
      dietary: "none",
    });
    expect(none.seen).not.toContain("dietary_strictness");
    expect(includeQuestion("dietary_strictness", { dietary: { value: "none" } })).toBe(
      false,
    );
  });

  it("asks food_adventure only for food-heavy allocation", () => {
    expect(
      includeQuestion("food_adventure", { interests: { value: "food_heavy" } }),
    ).toBe(true);
    expect(
      includeQuestion("food_adventure", { interests: { value: "balanced" } }),
    ).toBe(false);
  });

  it("asks drinking only when nightlife is yes", () => {
    expect(includeQuestion("drinking", { nightlife: { value: "yes" } })).toBe(
      true,
    );
    expect(includeQuestion("drinking", { nightlife: { value: "no" } })).toBe(
      false,
    );
  });

  it("skips paid attractions on low budget", () => {
    expect(
      includeQuestion("paid_attractions", { budget: { value: "low" } }),
    ).toBe(false);
    expect(
      includeQuestion("paid_attractions", { budget: { value: "high" } }),
    ).toBe(true);
  });

  it("branches chaos high vs low", () => {
    expect(includeQuestion("chaos_dares", { chaos: { value: "high" } })).toBe(
      true,
    );
    expect(
      includeQuestion("chaos_alternative", { chaos: { value: "high" } }),
    ).toBe(false);
    expect(includeQuestion("chaos_dares", { chaos: { value: "low" } })).toBe(
      false,
    );
    expect(
      includeQuestion("chaos_alternative", { chaos: { value: "low" } }),
    ).toBe(true);
  });

  it("completes after the last included question", () => {
    let step = startSurvey();
    let guard = 0;
    while (step.state.awaiting !== "done" && guard < 40) {
      step = applyReply(step.state, "skip");
      guard += 1;
    }
    expect(step.completed).toBe(true);
    expect(step.state.awaiting).toBe("done");
    expect(allParticipantsComplete(["done"])).toBe(true);
    expect(allParticipantsComplete(["done", "done", "done"])).toBe(true);
    expect(allParticipantsComplete(["age_bracket"])).toBe(false);
    expect(allParticipantsComplete(["done", "age_bracket"])).toBe(false);
    expect(allParticipantsComplete([])).toBe(false);
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
