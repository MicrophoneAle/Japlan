import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import type { ParticipantRow, TripRow } from "@/lib/db/types";

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

  function trip(playMode: TripRow["play_mode"] = null): TripRow {
    return {
      id: "trip-1",
      linq_chat_id: "group-1",
      name: "Tokyo trip",
      destination: "Tokyo",
      start_date: "2026-10-17",
      end_date: "2026-10-20",
      play_mode: playMode,
      state: "active",
      difficulty: null,
      stake_text: null,
      timezone: "Asia/Tokyo",
    };
  }

  function person(id: string, display_name: string, interests: string[] = []): ParticipantRow {
    return {
      id,
      trip_id: "trip-1",
      phone: `+1-${id}`,
      display_name,
      score: 0,
      survey_json: interests.length
        ? { interest_picks: { value: interests.join(",") } }
        : null,
      survey_state: "done",
      sidequests_muted: false,
      consented_at: null,
    };
  }

  it("keeps legacy trips on one shared board", async () => {
    const people = [person("alice", "Alice"), person("bob", "Bob")];
    const assignees = await loadAssignees(trip(), people, 1);
    expect(assignees).toHaveLength(1);
    expect(assignees[0].kind).toBe("group");
    expect(assignees[0].people.map((p) => p.id).sort()).toEqual(["alice", "bob"]);
  });

  it("pairs people with shared interests and leaves unmatched people solo", async () => {
    const people = [
      person("alice", "Alice", ["museums"]),
      person("bob", "Bob", ["museums"]),
      person("carol", "Carol", ["food"]),
      person("dave", "Dave", ["nightlife"]),
    ];

    const assignees = await loadAssignees(trip("teams"), people, 1);

    const teamAssignee = assignees.find((a) => a.kind === "team");
    expect(teamAssignee?.people.map((p) => p.id).sort()).toEqual(["alice", "bob"]);
    const rest = assignees.filter((a) => a.kind === "group").flatMap((a) => a.people.map((p) => p.id));
    expect(rest.sort()).toEqual(["carol", "dave"]);
  });

  it("gives each person their own assignment in individual mode", async () => {
    const people = [person("alice", "Alice"), person("bob", "Bob")];
    const assignees = await loadAssignees(trip("individual"), people, 1);

    expect(assignees.map((assignee) => assignee.people.map((p) => p.id))).toEqual([
      ["alice"],
      ["bob"],
    ]);
  });
});
