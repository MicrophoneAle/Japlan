import { describe, expect, it } from "vitest";
import {
  allowsOutbound,
  evaluateAddress,
  isHelpIntent,
  shouldRespond,
} from "./addressing";
import { decideClaim } from "./claims";
import { HELP_TEXT, helpText } from "./copy";

const base = {
  isDm: false,
  openTaskContext: false,
  wakeKeyword: "japlan",
};

const HELP_TRIGGERS = [
  "japlan help",
  "japlan what do you do",
  "japlan how does this work",
  "japlan commands",
  "japlan ?",
];

describe("addressing gate", () => {
  it("ignores ordinary chatter", () => {
    const decision = evaluateAddress({
      ...base,
      text: "should we do sushi or ramen tonight?",
    });
    expect(decision).toEqual({
      respond: false,
      reason: "silent",
      intent: "none",
      bypassRateLimit: false,
    });
    expect(shouldRespond({ ...base, text: "lol" })).toBe(false);
  });

  it("matches the keyword mid-sentence", () => {
    expect(
      shouldRespond({ ...base, text: "hey japlan what's the plan" }),
    ).toBe(true);
    expect(
      evaluateAddress({ ...base, text: "hey japlan what's the plan" }).reason,
    ).toBe("wake_keyword");
  });

  it("matches a lowercase keyword", () => {
    expect(shouldRespond({ ...base, text: "japlan" })).toBe(true);
    expect(shouldRespond({ ...base, text: "JAPLAN are you there" })).toBe(true);
  });

  it("does not match japlanning (word boundary)", () => {
    expect(shouldRespond({ ...base, text: "we are japlanning the trip" })).toBe(
      false,
    );
  });

  it("matches a task code sent as the whole message", () => {
    expect(evaluateAddress({ ...base, text: "A1" }).reason).toBe("task_code");
    expect(evaluateAddress({ ...base, text: "b12." }).reason).toBe("task_code");
    expect(shouldRespond({ ...base, text: "japlan A1" })).toBe(true);
  });

  it("treats a code in a short message as a tentative claim", () => {
    for (const text of ["I did A1", "done with A1", "A1 done!", "see you b4 dinner"]) {
      expect(evaluateAddress({ ...base, text }).reason, text).toBe("loose_task_code");
    }
  });

  it("stays silent on a code buried in a long message", () => {
    expect(
      shouldRespond({ ...base, text: "we should grab food b4 the show tonight honestly" }),
    ).toBe(false);
  });

  it("finds a code anywhere once the keyword is present", () => {
    expect(
      evaluateAddress({
        ...base,
        text: "japlan we finally finished the whole of A1 this afternoon",
      }).reason,
    ).toBe("task_code");
  });

  it("always responds to DMs", () => {
    expect(
      shouldRespond({ ...base, isDm: true, text: "random chatter" }),
    ).toBe(true);
  });

  it("responds when openTaskContext is true", () => {
    expect(
      shouldRespond({
        ...base,
        openTaskContext: true,
        text: "here is the photo",
      }),
    ).toBe(true);
  });
});

describe("help intent", () => {
  it("routes each trigger phrase to help, not to a claim", () => {
    for (const text of HELP_TRIGGERS) {
      const address = evaluateAddress({ ...base, text });
      expect(address, text).toEqual({
        respond: true,
        reason: "help",
        intent: "help",
        bypassRateLimit: true,
      });
      expect(isHelpIntent({ ...base, text }), text).toBe(true);
      const claim = decideClaim({
        text,
        hasPhoto: false,
        recentCode: null,
        isDm: false,
        openTaskContext: false,
      });
      expect(claim, text).toEqual({ type: "silent", reason: "help" });
      expect(claim.type, text).not.toBe("fuzzy");
      expect(claim.type, text).not.toBe("code");
    }
  });

  it("treats a DM help question without the keyword as help", () => {
    expect(
      evaluateAddress({ ...base, isDm: true, text: "help" }).intent,
    ).toBe("help");
    expect(
      evaluateAddress({ ...base, isDm: true, text: "how does this work" })
        .intent,
    ).toBe("help");
  });

  it("ignores help without the keyword in a group", () => {
    expect(
      evaluateAddress({ ...base, text: "help" }),
    ).toEqual({
      respond: false,
      reason: "silent",
      intent: "none",
      bypassRateLimit: false,
    });
    expect(isHelpIntent({ ...base, text: "can you help" })).toBe(false);
    expect(
      decideClaim({
        text: "help",
        hasPhoto: false,
        recentCode: null,
        isDm: false,
        openTaskContext: false,
      }).type,
    ).toBe("silent");
  });

  it("is not rate-limited by the ambient cap", () => {
    expect(
      allowsOutbound({ kind: "help", repliesInWindow: 50, cap: 1 }),
    ).toBe(true);
    expect(
      allowsOutbound({ kind: "ambient", repliesInWindow: 50, cap: 1 }),
    ).toBe(false);
    const decision = evaluateAddress({ ...base, text: "japlan help" });
    expect(decision.bypassRateLimit).toBe(true);
  });
});

describe("help copy", () => {
  it("stays practical and covers the load-bearing commands", () => {
    for (const text of [HELP_TEXT.group, HELP_TEXT.dm]) {
      expect(text).not.toMatch(/welcome to/i);
      expect(text.toLowerCase()).toContain("task code");
      expect(text.toLowerCase()).toContain("photo");
      expect(text.toLowerCase()).toMatch(/lb|standings/);
      expect(text.toLowerCase()).toContain("japlan help");
      expect(text.toLowerCase()).toContain("rent a car");
      expect(text.toLowerCase()).toContain("enterprise");
      expect(text).not.toMatch(/axes|verification|scoring/i);
      // No fixed task count: the model quoted "3 personal tasks" back as a cap.
      expect(text).not.toMatch(/[0-9]+ (?:personal )?tasks/);
    }
    expect(HELP_TEXT.dm).toContain("want more? just ask");
    expect(HELP_TEXT.group.toLowerCase()).toContain("your board lands in your dm");
    expect(helpText(true)).toBe(HELP_TEXT.dm);
    expect(helpText(false)).toBe(HELP_TEXT.group);
  });
});
