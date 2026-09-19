import { describe, expect, it } from "vitest";
import { isStandingsRequest } from "./commands";

describe("isStandingsRequest", () => {
  it("recognises the leaderboard command and its short forms", () => {
    for (const text of [
      "japlan lb",
      "japlan leader",
      "japlan leaderboard",
      "japlan standings",
      "japlan standing",
      "japlan scores",
      "japlan score",
      "japlan rankings",
      "leaderboard",
      "LB",
      "japlan what's the leaderboard",
      "japlan whats the standings",
      "japlan show me the scores",
    ]) {
      expect(isStandingsRequest(text), text).toBe(true);
    }
  });

  it("does not trigger on chatter that merely contains those words", () => {
    for (const text of [
      "japlan our team leader bailed on the hike",
      "japlan i scored a great parking spot today",
      "japlan she's a natural leader",
      "japlan did the standings post already",
    ]) {
      expect(isStandingsRequest(text), text).toBe(false);
    }
  });

  it("works without the wake keyword too, for a DM already counted as addressed", () => {
    expect(isStandingsRequest("lb")).toBe(true);
    expect(isStandingsRequest("standings?")).toBe(true);
  });
});
