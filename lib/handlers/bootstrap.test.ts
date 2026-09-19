import { describe, expect, it } from "vitest";
import { pickOpenSurveyMatch } from "./bootstrap";

describe("pickOpenSurveyMatch", () => {
  it("prefers an in-progress survey when the same phone has two trip rows", () => {
    const picked = pickOpenSurveyMatch([
      { survey_state: "done", trip: "solo" },
      { survey_state: "dietary", trip: "group" },
    ]);
    expect(picked?.trip).toBe("group");
  });

  it("falls back to the first row when every survey is done", () => {
    const picked = pickOpenSurveyMatch([
      { survey_state: "done", trip: "group" },
      { survey_state: "done", trip: "solo" },
    ]);
    expect(picked?.trip).toBe("group");
  });
});
