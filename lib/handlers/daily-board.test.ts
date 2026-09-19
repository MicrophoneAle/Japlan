import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import type { ParticipantRow } from "@/lib/db/types";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));

import { loadAssignees, withoutClaimedCollisions } from "./daily-board";

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

describe("loadAssignees", () => {
  beforeEach(() => {
    h.db = new FakeSupabase();
  });

  function person(id: string, display_name: string): ParticipantRow {
    return {
      id,
      trip_id: "trip-1",
      phone: `+1-${id}`,
      display_name,
      score: 0,
      survey_json: null,
      survey_state: "done",
      sidequests_muted: false,
      consented_at: null,
    };
  }

  // Boards follow the split model (lib/game/split.ts): no split is one plan
  // for everyone; a day's split makes day-bound teams, and everyone else
  // stays on the group plan.
  it("plans one group board for everyone when nobody has split", async () => {
    const people = [person("alice", "Alice"), person("bob", "Bob")];
    const assignees = await loadAssignees("trip-1", people, 1);
    expect(assignees).toHaveLength(1);
    expect(assignees[0].kind).toBe("group");
    expect(assignees[0].people.map((p) => p.id).sort()).toEqual(["alice", "bob"]);
  });

  it("still plans for people not on any team once a team exists", async () => {
    // Regression: loadAssignees once returned ONLY team assignees the moment
    // any team existed, dropping everyone else from board generation.
    h.db.seed("teams", [{ trip_id: "trip-1", name: "team 1", day: 1, formed_at: new Date().toISOString() }]);
    const team = h.db.table("teams")[0];
    h.db.seed("team_members", [
      { team_id: team.id, participant_id: "alice" },
      { team_id: team.id, participant_id: "bob" },
    ]);
    const people = [person("alice", "Alice"), person("bob", "Bob"), person("carol", "Carol"), person("dave", "Dave")];

    const assignees = await loadAssignees("trip-1", people, 1);

    const teamAssignee = assignees.find((a) => a.kind === "team");
    expect(teamAssignee?.people.map((p) => p.id).sort()).toEqual(["alice", "bob"]);
    const rest = assignees.filter((a) => a.kind === "group").flatMap((a) => a.people.map((p) => p.id));
    expect(rest.sort()).toEqual(["carol", "dave"]);
  });

  it("a survey pairing (trip-long team) pools points but does not split the plan", async () => {
    h.db.seed("teams", [{ trip_id: "trip-1", name: "team 1", color: "red", formed_at: new Date().toISOString() }]);
    const team = h.db.table("teams")[0];
    h.db.seed("team_members", [{ team_id: team.id, participant_id: "alice" }]);
    const assignees = await loadAssignees("trip-1", [person("alice", "Alice"), person("bob", "Bob")], 1);
    expect(assignees.map((a) => a.kind)).toEqual(["group"]);
  });
});
