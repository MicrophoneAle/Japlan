import { describe, expect, it } from "vitest";
import { decideClaim } from "./claims";
import {
  CONVERSATION_REPLY_CAP,
  conversationalCapReached,
  conversationalRepliesInWindow,
  finalizeConversationReply,
  foreignSurveySecrets,
  leaksForeignSurvey,
  nextOffTopicCount,
  offTopicPolicy,
  recordConversationalReply,
  resetConversationStore,
  resetOffTopicOnClaim,
  runToolLoop,
  shouldEnterConversation,
  stripPointFields,
  surveySliceForConversation,
  toolResultHasInventedPoints,
} from "./conversation";
import {
  CONVERSATION_FALLBACK,
  CONVERSATION_PRIVACY_LINE,
  CONVERSATION_SYSTEM_PROMPT,
  conversationRedirect,
} from "./copy";
import { pointsForFreeform } from "./scoring";

const addressed = {
  hasPhoto: false,
  recentCode: null,
  isDm: false,
  openTaskContext: false,
};

describe("conversation layer entry", () => {
  it("never reaches this layer for a valid task code", () => {
    const claim = decideClaim({
      ...addressed,
      text: "A1",
      isDm: true,
    });
    expect(claim.type).toBe("code");
    expect(shouldEnterConversation(claim)).toBe(false);
  });

  it("does reach this layer after a fuzzy miss", () => {
    expect(
      shouldEnterConversation({
        type: "fuzzy",
        text: "japlan is pineapple on pizza a crime",
      }),
    ).toBe(true);
  });
});

describe("the model cannot return a point value", () => {
  it("strips invented point fields before scoring.ts prices axes", () => {
    const stripped = stripPointFields({
      title: "climbed the tower",
      points: 999,
      base_points: 40,
      axes: { boldness: 3, physical: 4, time: 3, scarcity: 2, cultural: 3, aesthetics: 2, points: 50 },
    });
    expect(stripped).not.toHaveProperty("points");
    expect(stripped).not.toHaveProperty("base_points");
    expect(stripped.axes).not.toHaveProperty("points");
    const axes = stripped.axes as {
      boldness: number;
      physical: number;
      time: number;
      scarcity: number;
      cultural: number;
      aesthetics: number;
    };
    const scored = pointsForFreeform(axes, { day: 1, tripDays: null });
    expect(scored.points).not.toBe(999);
    expect(scored.points).toBeLessThanOrEqual(20);
    expect(toolResultHasInventedPoints({ title: "x", points: 12 })).toBe(true);
    expect(toolResultHasInventedPoints({ title: "x", ok: true })).toBe(false);
  });

  it("keeps point values out of the system prompt", () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/never a point value/i);
    expect(CONVERSATION_SYSTEM_PROMPT).not.toMatch(/\b\d+\s*points?\b/i);
  });
});

describe("off-topic tracking", () => {
  it("answers the first two off-topic turns without a redirect", () => {
    expect(offTopicPolicy(1).redirect).toBe(false);
    expect(offTopicPolicy(2).redirect).toBe(false);
    const first = finalizeConversationReply({
      text: "pineapple belongs there",
      others: [],
      policy: offTopicPolicy(1),
      redirect: "A3 is still open.",
      fallback: CONVERSATION_FALLBACK,
      privacyLine: CONVERSATION_PRIVACY_LINE,
    });
    expect(first).toBe("pineapple belongs there");
    expect(first).not.toContain("A3");
  });

  it("adds a redirect on the third consecutive off-topic reply", () => {
    const third = finalizeConversationReply({
      text: "pineapple belongs there",
      others: [],
      policy: offTopicPolicy(3),
      redirect: "A3 is still open.",
      fallback: CONVERSATION_FALLBACK,
      privacyLine: CONVERSATION_PRIVACY_LINE,
    });
    expect(third).toContain("pineapple belongs there");
    expect(third).toContain("A3 is still open.");
    expect(third.toLowerCase()).not.toContain("let's get back to the game");
  });

  it("resets the counter on an on-topic message or a claim", () => {
    expect(nextOffTopicCount(3, true)).toBe(4);
    expect(nextOffTopicCount(3, false)).toBe(0);
    resetConversationStore();
    resetOffTopicOnClaim("chat-1");
    expect(offTopicPolicy(nextOffTopicCount(4, false)).consecutive).toBe(0);
  });
});

describe("hourly conversational cap", () => {
  it("trips after 6 conversational replies in an hour", () => {
    resetConversationStore();
    const now = Date.parse("2026-09-19T12:00:00Z");
    for (let i = 0; i < CONVERSATION_REPLY_CAP; i += 1) {
      recordConversationalReply("chat-1", now + i * 1000);
    }
    expect(conversationalRepliesInWindow("chat-1", now + 10_000)).toBe(6);
    expect(conversationalCapReached("chat-1", now + 10_000)).toBe(true);
    expect(conversationalCapReached("chat-2", now + 10_000)).toBe(false);
    expect(conversationalCapReached("chat-1", now + 60 * 60 * 1000 + 20_000)).toBe(
      false,
    );
  });
});

describe("DM stays in DM", () => {
  it("never puts another person's budget answer in a reply", () => {
    const people = [
      {
        id: "p1",
        display_name: "Michael",
        survey_json: { interests: { value: "food_heavy" } },
      },
      {
        id: "p2",
        display_name: "Sarah",
        survey_json: { budget: { value: "low" }, social_with: { value: "Alex only" } },
      },
    ];
    const slice = surveySliceForConversation(
      people[0].survey_json,
      false,
    );
    expect(JSON.stringify(slice)).not.toContain("low");
    expect(JSON.stringify(slice)).not.toContain("Alex only");
    const others = foreignSurveySecrets(people, "p1");
    expect(others[0]?.secrets).toEqual(["Alex only"]);
    expect(others[0]?.enums.map((e) => e.value)).toEqual(["low"]);
    const leaked = finalizeConversationReply({
      text: "sarah's budget is low",
      others,
      policy: offTopicPolicy(1),
      redirect: "A3 is still open.",
      fallback: CONVERSATION_FALLBACK,
      privacyLine: CONVERSATION_PRIVACY_LINE,
    });
    expect(leaked).toBe(CONVERSATION_PRIVACY_LINE);
    expect(leaked).not.toContain("low");
    expect(leaked).not.toContain("budget");
  });

  it("does not flag ordinary words that contain an answer value", () => {
    const others = foreignSurveySecrets(
      [
        { id: "p1", display_name: "Michael", survey_json: {} },
        {
          id: "p2",
          display_name: "Sam",
          survey_json: {
            budget: { value: "low" },
            dietary: { value: "none" },
            mobility: { value: "no_limits" },
            blackout: { value: "no" },
          },
        },
      ],
      "p1",
    );
    for (const text of [
      "sam is not far behind, follow them to A2",
      "sam is below you by 4",
      "sam leads with 40, nobody close",
      "sam walked slowly but got there",
    ]) {
      expect(leaksForeignSurvey(text, others), text).toBe(false);
    }
  });

  it("still catches a free-text answer as a whole phrase", () => {
    const others = foreignSurveySecrets(
      [
        { id: "p1", display_name: "Michael", survey_json: {} },
        {
          id: "p2",
          display_name: "Sam",
          survey_json: { blackout: { value: "prayer at 1pm" } },
        },
      ],
      "p1",
    );
    expect(leaksForeignSurvey("sam has prayer at 1pm", others)).toBe(true);
    expect(leaksForeignSurvey("sam is winning", others)).toBe(false);
  });

  it("catches a legacy raw dietary answer as a secret", () => {
    const others = foreignSurveySecrets(
      [
        { id: "p1", display_name: "Michael", survey_json: {} },
        {
          id: "p2",
          display_name: "Sam",
          survey_json: { dietary: { value: "peanut allergy" } },
        },
      ],
      "p1",
    );
    expect(others[0]?.secrets).toEqual(["peanut allergy"]);
    expect(leaksForeignSurvey("careful, sam has a peanut allergy", others)).toBe(true);
  });
});

describe("conversation redirect copy", () => {
  it("points at something real instead of lecturing", () => {
    expect(conversationRedirect({ task: { code: "A3" } })).toBe("A3 is still open.");
    expect(conversationRedirect({ nearby: "asakusa" })).toBe("asakusa is right there.");
  });
});

describe("tool loop", () => {
  it("stops after 3 tool iterations and then forces a reply", async () => {
    let generates = 0;
    const result = await runToolLoop({
      generate: async ({ forceReply }) => {
        generates += 1;
        if (forceReply) return { text: "ok then", calls: [] };
        return {
          text: "",
          calls: [{ name: "no_action", args: {} }],
        };
      },
      execute: async () => ({ result: { ok: true }, sent: false }),
    });
    expect(generates).toBe(4);
    expect(result.text).toBe("ok then");
    expect(result.toolNames).toEqual(["no_action", "no_action", "no_action"]);
  });
});
