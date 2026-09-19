import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import type { ParticipantRow, TripRow } from "@/lib/db/types";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));

import { formTeamsForTrip, handleTeamNameCommand, teamsAnnouncement } from "./teams";

function surveyOf(teamPreference: "team" | "solo", socialWith?: string) {
  return {
    team_preference: { value: teamPreference },
    ...(socialWith ? { social_with: { value: socialWith } } : {}),
  };
}

let trip: TripRow;

function personByName(name: string): ParticipantRow {
  return (h.db.table("participants") as ParticipantRow[]).find(
    (p) => p.display_name === name,
  )!;
}

function seedFourPeople(prefs: {
  alice: "team" | "solo";
  bob: "team" | "solo";
  carol: "team" | "solo";
  dave: "team" | "solo";
}) {
  h.db.seed("participants", [
    { trip_id: trip.id, phone: "+1-alice", display_name: "Alice", survey_json: surveyOf(prefs.alice, "Bob") },
    { trip_id: trip.id, phone: "+1-bob", display_name: "Bob", survey_json: surveyOf(prefs.bob, "Alice") },
    { trip_id: trip.id, phone: "+1-carol", display_name: "Carol", survey_json: surveyOf(prefs.carol) },
    { trip_id: trip.id, phone: "+1-dave", display_name: "Dave", survey_json: surveyOf(prefs.dave) },
  ]);
}

beforeEach(() => {
  h.db = new FakeSupabase();
  h.db.seed("trips", [
    {
      linq_chat_id: "chat-1",
      name: "Tokyo trip",
      destination: "Tokyo",
      start_date: "2026-10-17",
      end_date: "2026-10-20",
      state: "surveying",
      timezone: "Asia/Tokyo",
    },
  ]);
  trip = h.db.table("trips")[0] as TripRow;
});

describe("formTeamsForTrip", () => {
  it("pairs the two who opted in and leaves the other two alone", async () => {
    seedFourPeople({ alice: "team", bob: "team", carol: "solo", dave: "solo" });
    const people = h.db.table("participants") as unknown as ParticipantRow[];

    const formed = await formTeamsForTrip(trip, people);

    expect(formed).toHaveLength(1);
    expect(formed[0].name).toBe("team 1");
    expect(new Set(formed[0].members.map((m) => m.display_name))).toEqual(
      new Set(["Alice", "Bob"]),
    );

    expect(h.db.table("teams")).toHaveLength(1);
    const memberIds = h.db.table("team_members").map((m) => m.participant_id);
    expect(new Set(memberIds)).toEqual(new Set([personByName("Alice").id, personByName("Bob").id]));
  });

  it("forms two teams with distinct default names and colors", async () => {
    h.db.seed("participants", [
      { trip_id: trip.id, phone: "+1-a", display_name: "A", survey_json: surveyOf("team", "B") },
      { trip_id: trip.id, phone: "+1-b", display_name: "B", survey_json: surveyOf("team", "A") },
      { trip_id: trip.id, phone: "+1-c", display_name: "C", survey_json: surveyOf("team", "D") },
      { trip_id: trip.id, phone: "+1-d", display_name: "D", survey_json: surveyOf("team", "C") },
    ]);
    const people = h.db.table("participants") as unknown as ParticipantRow[];

    const formed = await formTeamsForTrip(trip, people);

    expect(formed).toHaveLength(2);
    expect(new Set(formed.map((t) => t.name))).toEqual(new Set(["team 1", "team 2"]));
    const colors = h.db.table("teams").map((t) => t.color);
    expect(new Set(colors).size).toBe(2);
  });

  it("creates nothing when nobody opted into a team", async () => {
    seedFourPeople({ alice: "solo", bob: "solo", carol: "solo", dave: "solo" });
    const people = h.db.table("participants") as unknown as ParticipantRow[];

    const formed = await formTeamsForTrip(trip, people);

    expect(formed).toEqual([]);
    expect(h.db.table("teams")).toHaveLength(0);
  });

  it("is a no-op when teams already exist for the trip", async () => {
    h.db.seed("teams", [
      { trip_id: trip.id, name: "team 1", color: "red", formed_at: new Date().toISOString() },
    ]);
    seedFourPeople({ alice: "team", bob: "team", carol: "solo", dave: "solo" });
    const people = h.db.table("participants") as unknown as ParticipantRow[];

    const formed = await formTeamsForTrip(trip, people);

    expect(formed).toEqual([]);
    expect(h.db.table("teams")).toHaveLength(1);
    expect(h.db.table("team_members")).toHaveLength(0);
  });
});

describe("teamsAnnouncement", () => {
  it("returns null when no teams formed", () => {
    expect(teamsAnnouncement([])).toBeNull();
  });

  it("lists each team's roster and how to rename", () => {
    const member = (id: string, display_name: string): ParticipantRow => ({
      id,
      trip_id: "trip-1",
      phone: `+1-${id}`,
      display_name,
      score: 0,
      survey_json: null,
      survey_state: "done",
      sidequests_muted: false,
      consented_at: null,
    });
    const line = teamsAnnouncement([
      {
        id: "t1",
        name: "team 1",
        members: [member("a", "Alice"), member("b", "Bob")],
      },
    ]);
    expect(line).toContain("team 1");
    expect(line).toContain("Alice");
    expect(line).toContain("Bob");
    expect(line).toContain("japlan we're team");
  });
});

describe("handleTeamNameCommand", () => {
  async function seedTeamOf(memberNames: string[], name = "team 1", color = "red") {
    h.db.seed("participants", memberNames.map((n) => ({
      trip_id: trip.id,
      phone: `+1-${n.toLowerCase()}`,
      display_name: n,
    })));
    h.db.seed("teams", [{ trip_id: trip.id, name, color, formed_at: new Date().toISOString() }]);
    const team = h.db.table("teams")[0];
    h.db.seed(
      "team_members",
      memberNames.map((n) => ({ team_id: team.id, participant_id: personByName(n).id })),
    );
    return team;
  }

  it("renames the sender's team", async () => {
    await seedTeamOf(["Alice", "Bob"]);
    const send = vi.fn(async (_chatId: string, _text: string) => ({ messageId: "m1" }));

    await handleTeamNameCommand({ chatId: "chat-1", phone: "+1-alice", name: "team sigmas", send });

    expect(h.db.table("teams")[0].name).toBe("team sigmas");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain("team sigmas");
  });

  it("tells someone with no team there's nothing to rename", async () => {
    h.db.seed("participants", [{ trip_id: trip.id, phone: "+1-alice", display_name: "Alice" }]);
    const send = vi.fn(async () => ({ messageId: "m1" }));

    await handleTeamNameCommand({ chatId: "chat-1", phone: "+1-alice", name: "sigmas", send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(h.db.table("teams")).toHaveLength(0);
  });

  it("asks again when no name could be read", async () => {
    await seedTeamOf(["Alice", "Bob"]);
    const send = vi.fn(async () => ({ messageId: "m1" }));

    await handleTeamNameCommand({ chatId: "chat-1", phone: "+1-alice", name: null, send });

    expect(h.db.table("teams")[0].name).toBe("team 1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a name another team already has", async () => {
    await seedTeamOf(["Alice", "Bob"], "team 1", "red");
    h.db.seed("participants", [
      { trip_id: trip.id, phone: "+1-carol", display_name: "Carol" },
      { trip_id: trip.id, phone: "+1-dave", display_name: "Dave" },
    ]);
    h.db.seed("teams", [
      { trip_id: trip.id, name: "the chuds", color: "blue", formed_at: new Date().toISOString() },
    ]);
    const otherTeam = h.db.table("teams")[1];
    h.db.seed("team_members", [
      { team_id: otherTeam.id, participant_id: personByName("Carol").id },
      { team_id: otherTeam.id, participant_id: personByName("Dave").id },
    ]);
    const send = vi.fn(async () => ({ messageId: "m1" }));

    await handleTeamNameCommand({ chatId: "chat-1", phone: "+1-alice", name: "the chuds", send });

    expect(h.db.table("teams").find((t) => t.color === "red")!.name).toBe("team 1");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
