import { describe, expect, it } from "vitest";
import { evaluateAddress, shouldRespond } from "./addressing";

const base = {
  isDm: false,
  openTaskContext: false,
  wakeKeyword: "japlan",
};

describe("addressing gate", () => {
  it("ignores ordinary chatter", () => {
    const decision = evaluateAddress({
      ...base,
      text: "should we do sushi or ramen tonight?",
    });
    expect(decision).toEqual({ respond: false, reason: "silent" });
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

  it("matches a task code", () => {
    expect(shouldRespond({ ...base, text: "I did A1" })).toBe(true);
    expect(shouldRespond({ ...base, text: "b12 is done" })).toBe(true);
    expect(
      evaluateAddress({ ...base, text: "claim A1" }).reason,
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
