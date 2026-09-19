import { describe, expect, it } from "vitest";
import { withoutClaimedCollisions } from "./daily-board";

describe("forced board re-run", () => {
  it("never overwrites a task that already has a claim", () => {
    const rows = [
      { code: "A1", participant_id: "p1", team_id: null, title: "new A1" },
      { code: "A2", participant_id: "p1", team_id: null, title: "new A2" },
      { code: "A1", participant_id: "p2", team_id: null, title: "p2's A1" },
      { code: "A1", participant_id: null, team_id: "red", title: "team A1" },
    ];
    const kept = withoutClaimedCollisions(
      rows,
      [
        { code: "A1", participantId: "p1", teamId: null },
        { code: "A1", participantId: null, teamId: "red" },
      ],
      "trip-1",
    );
    expect(kept.map((r) => r.title)).toEqual(["new A2", "p2's A1"]);
  });
});
