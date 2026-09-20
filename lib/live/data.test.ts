import { describe, expect, it } from "vitest";
import { zeroStats } from "@/lib/game/stats";
import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { buildLiveTripData, type LiveTeamInput } from "./data";

const NOW = new Date("2026-09-20T05:00:00Z"); // 2pm JST

const trip = {
  id: "trip-1",
  linq_chat_id: "chat-1",
  name: "tokyo crew",
  destination: "Tokyo",
  start_date: "2026-09-18",
  end_date: "2026-09-22",
  timezone: "Asia/Tokyo",
  state: "active",
  difficulty: "normal",
  stake_text: null,
} as TripRow;

function person(id: string, name: string, score: number): ParticipantRow {
  return {
    id,
    trip_id: "trip-1",
    phone: `+1555000000${id}`,
    display_name: name,
    score,
    survey_json: { budget: { value: "secret" } } as unknown as ParticipantRow["survey_json"],
    survey_state: "done",
    sidequests_muted: false,
    consented_at: "2026-09-17T00:00:00Z",
  };
}

function task(opts: Partial<TaskRow> & { id: string; code: string }): TaskRow {
  return {
    trip_id: "trip-1",
    participant_id: null,
    team_id: null,
    title: "a task",
    tier: "Medium",
    axes_json: {},
    base_points: 20,
    photo_bonus_max: 3,
    verification: "honor",
    day: 3,
    expires_at: null,
    neighborhood: null,
    ...opts,
  };
}

function claim(opts: Partial<ClaimRow> & { task_id: string; participant_id: string }): ClaimRow {
  return {
    id: `claim-${opts.task_id}-${opts.participant_id}`,
    evidence_url: null,
    image_hash: null,
    status: "awarded",
    awarded_points: 20,
    resolved_by: "code",
    resolution_json: {},
    created_at: "2026-09-20T04:00:00Z",
    ...opts,
  };
}

const people = [person("p1", "Sarah", 160), person("p2", "Michael", 145), person("p3", "Dev", 132), person("p4", "Jess", 95)];

describe("buildLiveTripData: standings", () => {
  it("ranks individuals by their own score, ties sharing a rank", () => {
    const data = buildLiveTripData({
      trip,
      people: [person("a", "Ana", 40), person("b", "Ben", 25), person("c", "Cy", 25)],
      tasks: [],
      claims: [],
      teams: [],
      itinerary: [],
      places: [],
      stats: {},
      sidequests: [],
      sidequestOffers: [],
      now: NOW,
      day: 3,
    });
    expect(data.standings.map((s) => [s.name, s.rank, s.score])).toEqual([
      ["Ana", 1, 40],
      ["Ben", 2, 25],
      ["Cy", 2, 25],
    ]);
  });

  it("annotates a paired person's team without changing their own score", () => {
    const teams: LiveTeamInput[] = [{ id: "t1", name: "Team Sigma", color: "#fff", formedAt: "2026-09-18T00:00:00Z", memberIds: ["p1", "p4"] }];
    const data = buildLiveTripData({
      trip, people, tasks: [], claims: [], teams, itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    const sarah = data.standings.find((s) => s.name === "Sarah")!;
    const michael = data.standings.find((s) => s.name === "Michael")!;
    expect(sarah.teamName).toBe("Team Sigma");
    expect(sarah.score).toBe(160); // individual score, never the team total
    expect(michael.teamName).toBeNull();
  });

  it("sums points awarded today, not the whole trip, per person", () => {
    const t1 = task({ id: "t1", code: "A1", participant_id: "p1", day: 3, base_points: 20 });
    const t2 = task({ id: "t2", code: "A2", participant_id: "p1", day: 2, base_points: 15 }); // yesterday
    const claims = [claim({ task_id: "t1", participant_id: "p1", awarded_points: 20 }), claim({ task_id: "t2", participant_id: "p1", awarded_points: 15 })];
    const data = buildLiveTripData({
      trip, people, tasks: [t1, t2], claims, teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.standings.find((s) => s.name === "Sarah")?.pointsToday).toBe(20);
  });
});

describe("buildLiveTripData: teams", () => {
  it("sums a team's combined score from its members' own scores", () => {
    const teams: LiveTeamInput[] = [
      { id: "tA", name: "Team A", color: "#f00", formedAt: "2026-09-18T00:00:00Z", memberIds: ["p1", "p4"] },
      { id: "tB", name: "Team B", color: "#00f", formedAt: "2026-09-18T00:00:00Z", memberIds: ["p2", "p3"] },
    ];
    const data = buildLiveTripData({
      trip, people, tasks: [], claims: [], teams, itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.teams).toEqual([
      { id: "tA", name: "Team A", color: "#f00", memberNames: ["Sarah", "Jess"], score: 255, tasksCompleted: 0 },
      { id: "tB", name: "Team B", color: "#00f", memberNames: ["Michael", "Dev"], score: 277, tasksCompleted: 0 },
    ]);
  });
});

describe("buildLiveTripData: tasks", () => {
  it("splits today's tasks into open (active) vs awarded (completed), across all days for completed", () => {
    const openToday = task({ id: "open", code: "A1", day: 3, participant_id: "p1" });
    const doneToday = task({ id: "done", code: "A2", day: 3, participant_id: "p2" });
    const doneYesterday = task({ id: "old", code: "B1", day: 2, participant_id: "p3" });
    const claims = [claim({ task_id: "done", participant_id: "p2" }), claim({ task_id: "old", participant_id: "p3" })];
    const data = buildLiveTripData({
      trip, people, tasks: [openToday, doneToday, doneYesterday], claims, teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.tasks.active.map((t) => t.code)).toEqual(["A1"]);
    expect(data.tasks.completed.map((t) => t.code).sort()).toEqual(["A2", "B1"]);
  });

  it("marks an unclaimed task past its deadline as expired, not open", () => {
    const expired = task({ id: "x", code: "C1", day: 3, expires_at: "2026-09-20T04:00:00Z" }); // before NOW
    const stillOpen = task({ id: "y", code: "C2", day: 3, expires_at: "2026-09-20T10:00:00Z" }); // after NOW
    const data = buildLiveTripData({
      trip, people, tasks: [expired, stillOpen], claims: [], teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.tasks.active.map((t) => t.code)).toEqual(["C2"]);
  });

  it("resolves the assignee name from a participant or a team", () => {
    const teams: LiveTeamInput[] = [{ id: "t1", name: "Team Sigma", color: "#fff", formedAt: "x", memberIds: ["p1"] }];
    const personal = task({ id: "a", code: "A1", day: 3, participant_id: "p1" });
    const teamTask = task({ id: "b", code: "A2", day: 3, team_id: "t1" });
    const shared = task({ id: "c", code: "A3", day: 3 });
    const data = buildLiveTripData({
      trip, people, tasks: [personal, teamTask, shared], claims: [], teams, itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    const byCode = Object.fromEntries(data.tasks.active.map((t) => [t.code, t.assignee]));
    expect(byCode).toEqual({ A1: "Sarah", A2: "Team Sigma", A3: null });
  });

  it("shows the multiplier badge and boosted value only on a multiplier day, keyed off the unscaled base_points", () => {
    const boosted = task({ id: "a", code: "A1", day: 3, base_points: 20, day_multiplier: 2, multiplier_reason: "holiday" });
    const plain = task({ id: "b", code: "A2", day: 3, base_points: 20 });
    const data = buildLiveTripData({
      trip, people, tasks: [boosted, plain], claims: [], teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    const a1 = data.tasks.active.find((t) => t.code === "A1")!;
    const a2 = data.tasks.active.find((t) => t.code === "A2")!;
    expect(a1.points).toBe(20); // the task's own unscaled worth
    expect(a1.multiplier).toEqual({ points: 40, label: "2x" });
    expect(a2.multiplier).toBeNull();
  });

  it("only shows a photo for an awarded claim with actual evidence", () => {
    const withPhoto = task({ id: "a", code: "A1", day: 3, participant_id: "p1" });
    const noPhoto = task({ id: "b", code: "A2", day: 3, participant_id: "p2" });
    const claims = [
      claim({ task_id: "a", participant_id: "p1", evidence_url: "https://cdn.example/x.jpg", photo_claimed_at: "2026-09-20T04:00:00Z" }),
      claim({ task_id: "b", participant_id: "p2" }), // no evidence
    ];
    const data = buildLiveTripData({
      trip, people, tasks: [withPhoto, noPhoto], claims, teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    const a1 = data.tasks.completed.find((t) => t.code === "A1")!;
    const a2 = data.tasks.completed.find((t) => t.code === "A2")!;
    expect(a1.photo).toBe("/live/photo/claim-a-p1");
    expect(a2.photo).toBeNull();
    expect(data.proof.map((t) => t.code)).toEqual(["A1"]);
  });
});

describe("buildLiveTripData: itinerary", () => {
  it("marks a past anchor done once a later one has started, the live one current, and the rest upcoming", () => {
    const data = buildLiveTripData({
      trip, people: [], tasks: [], claims: [], teams: [],
      itinerary: [
        { order: 1, place_id: "senso-ji", planned_time: "2026-09-20T01:00:00Z" }, // 10am JST, past
        { order: 2, place_id: "ueno", planned_time: "2026-09-20T05:00:00Z" }, // 2pm JST, == now
        { order: 3, place_id: "ameyoko", planned_time: "2026-09-20T10:00:00Z" }, // 7pm JST, future
      ],
      places: [{ id: "senso-ji", name: "Senso-ji" }, { id: "ueno", name: "Ueno Park" }, { id: "ameyoko", name: "Ameyoko" }],
      stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.itinerary.map((a) => [a.place, a.status])).toEqual([
      ["Senso-ji", "done"],
      ["Ueno Park", "current"],
      ["Ameyoko", "upcoming"],
    ]);
  });

  it("falls back to the first anchor as current when nothing has a planned time", () => {
    const data = buildLiveTripData({
      trip, people: [], tasks: [], claims: [], teams: [],
      itinerary: [{ order: 1, place_id: "x", planned_time: null }, { order: 2, place_id: "y", planned_time: null }],
      places: [{ id: "x", name: "X" }, { id: "y", name: "Y" }],
      stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.itinerary.map((a) => a.status)).toEqual(["current", "upcoming"]);
  });
});

describe("buildLiveTripData: activity feed", () => {
  it("merges claims, team formation and sidequest events, newest first", () => {
    const t = task({ id: "a", code: "A1", day: 3, participant_id: "p1" });
    const claims = [claim({ task_id: "a", participant_id: "p1", created_at: "2026-09-20T03:00:00Z", awarded_points: 30 })];
    const teams: LiveTeamInput[] = [{ id: "t1", name: "Team Sigma", color: "#fff", formedAt: "2026-09-18T00:00:00Z", memberIds: ["p1", "p2"] }];
    const sidequests = [{ id: "sq1", title: "find a cat cafe", points: 10 }];
    const sidequestOffers = [
      { sidequest_id: "sq1", participant_id: "p3", status: "live", fired_at: "2026-09-20T02:00:00Z", resolved_at: null, awarded_points: null },
      { sidequest_id: "sq1", participant_id: "p4", status: "won", fired_at: "2026-09-20T01:00:00Z", resolved_at: "2026-09-20T04:00:00Z", awarded_points: 10 },
    ];
    const data = buildLiveTripData({
      trip, people, tasks: [t], claims, teams, itinerary: [], places: [], stats: {}, sidequests, sidequestOffers, now: NOW, day: 3,
    });
    expect(data.activity.map((e) => e.text)).toEqual([
      "Jess won find a cat cafe · +10", // 04:00, latest
      "Sarah completed A1 · +30", // 03:00
      "Japlan issued a sidequest to Dev", // 02:00
      "Team Sigma formed: Sarah + Michael", // 09-18
    ]);
  });
});

describe("buildLiveTripData: privacy", () => {
  it("never puts a phone number or survey answer anywhere in the payload", () => {
    const teams: LiveTeamInput[] = [{ id: "t1", name: "Team A", color: "#fff", formedAt: "x", memberIds: ["p1"] }];
    const t = task({ id: "a", code: "A1", day: 3, participant_id: "p1" });
    const claims = [claim({ task_id: "a", participant_id: "p1" })];
    const data = buildLiveTripData({
      trip, people, tasks: [t], claims, teams, itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    const serialized = JSON.stringify(data);
    for (const p of people) {
      expect(serialized).not.toContain(p.phone);
    }
    expect(serialized).not.toContain("secret"); // the survey_json payload above
    expect(serialized).not.toMatch(/survey_json|prefs_json|resolution_json/);
  });
});

describe("buildLiveTripData: stats and header", () => {
  it("sums group totals from participant_stats, and counts quests from awarded claims", () => {
    const t1 = task({ id: "a", code: "A1", day: 3, participant_id: "p1" });
    const t2 = task({ id: "b", code: "A2", day: 2, participant_id: "p2" });
    const claims = [claim({ task_id: "a", participant_id: "p1" }), claim({ task_id: "b", participant_id: "p2" })];
    const data = buildLiveTripData({
      trip, people, tasks: [t1, t2], claims, teams: [], itinerary: [], places: [], sidequests: [], sidequestOffers: [], now: NOW, day: 3,
      stats: { p1: { ...zeroStats(), photos_submitted: 2, places_visited: 1 }, p2: { ...zeroStats(), photos_submitted: 1, places_visited: 2 } },
    });
    expect(data.stats).toEqual({ questsCompleted: 2, questsAttempted: 2, photosSubmitted: 3, placesVisited: 3, totalPoints: 160 + 145 + 132 + 95 });
  });

  it("builds the header from the trip's legs and today's task neighborhoods", () => {
    const t1 = task({ id: "a", code: "A1", day: 3, neighborhood: "Asakusa" });
    const t2 = task({ id: "b", code: "A2", day: 3, neighborhood: "Ueno", slot: "evening" });
    const data = buildLiveTripData({
      trip, people, tasks: [t1, t2], claims: [], teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.trip).toMatchObject({ destination: "Tokyo", day: 3, totalDays: 5, peopleCount: 4, teamCount: 0 });
    expect(data.trip.route).toBe("Asakusa → Ueno");
  });
});

describe("buildLiveTripData: japlan says", () => {
  it("names today's leader once someone has scored", () => {
    const t = task({ id: "a", code: "A1", day: 3, participant_id: "p1" });
    const claims = [claim({ task_id: "a", participant_id: "p1", awarded_points: 25 })];
    const data = buildLiveTripData({
      trip, people, tasks: [t], claims, teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.japlanSays).toBe("Sarah leads today with +25.");
  });

  it("says nothing when nobody has scored yet today", () => {
    const data = buildLiveTripData({
      trip, people, tasks: [], claims: [], teams: [], itinerary: [], places: [], stats: {}, sidequests: [], sidequestOffers: [], now: NOW, day: 3,
    });
    expect(data.japlanSays).toBeNull();
  });
});
