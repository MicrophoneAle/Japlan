import { describe, expect, it } from "vitest";
import { detectTeamNameCommand, isStandingsRequest } from "./commands";

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

describe("detectTeamNameCommand", () => {
  it("renames on 'we're team <name>' and the other explicit forms", () => {
    expect(detectTeamNameCommand("japlan we're team sigmas")).toEqual({ name: "team sigmas" });
    expect(detectTeamNameCommand("japlan call us the chuds")).toEqual({ name: "the chuds" });
    expect(detectTeamNameCommand("japlan our team is sigmas")).toEqual({ name: "sigmas" });
  });

  it("leaves ordinary 'we're ...' talk to the conversation", () => {
    for (const text of ["japlan we're back together", "japlan we're splitting up after lunch", "japlan we're gonna wander a bit"]) {
      expect(detectTeamNameCommand(text), text).toBeNull();
    }
  });
});
