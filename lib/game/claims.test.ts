import { describe, expect, it } from "vitest";
import { formatDailyBoard, formatMorningStandings, formatPersonalBoard } from "./board";
import {
  applyPhotoBonusRules,
  awardFanout,
  canResolveNow,
  decideClaim,
  extractTaskCode,
  hashAlreadyUsed,
  isOpenTask,
  ladder,
} from "./claims";
import { HAND_WRITTEN_DAY1_TASKS } from "./hand-written-tasks";
import { computePoints, tierForPoints } from "./scoring";
import { claimConfirmedLine } from "./copy";

describe("hand-written board scoring", () => {
  it("lands every seed task in a real tier via scoring.ts", () => {
    const byTier = { Light: 0, Medium: 0, Challenging: 0 };
    const byVerification = { photo: 0, honor: 0, peer: 0 };
    for (const task of HAND_WRITTEN_DAY1_TASKS) {
      const points = computePoints(task.axes);
      const tier = tierForPoints(points);
      expect(tier, `${task.code} scored ${points}`).not.toBeNull();
      if (tier) byTier[tier] += 1;
      byVerification[task.verification] += 1;
    }
    expect(HAND_WRITTEN_DAY1_TASKS).toHaveLength(10);
    expect(byTier.Light).toBeGreaterThan(0);
    expect(byTier.Medium).toBeGreaterThan(0);
    expect(byTier.Challenging).toBeGreaterThan(0);
    expect(byVerification.photo).toBeGreaterThan(0);
    expect(byVerification.honor).toBeGreaterThan(0);
    expect(byVerification.peer).toBeGreaterThan(0);
  });
});

describe("claim ladder", () => {
  it("hits step 1 on an explicit code", () => {
    expect(extractTaskCode("I did A1")).toBe("A1");
    expect(ladder({ text: "claim a10", hasPhoto: false, recentCode: null })).toEqual({
      step: 1,
      code: "A10",
    });
  });

  it("binds a photo to a code within 60 seconds", () => {
    expect(
      ladder({ text: "", hasPhoto: true, recentCode: "A3" }),
    ).toEqual({ step: 2, code: "A3" });
  });

  it("sends a photo alone to vision", () => {
    expect(ladder({ text: "", hasPhoto: true, recentCode: null }).step).toBe(3);
  });

  it("sends a description to fuzzy match", () => {
    expect(
      ladder({
        text: "the vending machine drink",
        hasPhoto: false,
        recentCode: null,
      }).step,
    ).toBe(4);
  });

  it("does not crash on a media-only message with empty text", () => {
    expect(ladder({ text: "", hasPhoto: true, recentCode: null }).step).toBe(3);
    expect(extractTaskCode("")).toBeNull();
  });
});

describe("silence on no match", () => {
  const outbound: string[] = [];
  function maybeSend(decision: ReturnType<typeof decideClaim>): void {
    if (decision.type === "silent") return;
    outbound.push(decision.type);
  }

  it("an unrelated photo and an unrelated sentence produce zero outbound calls", () => {
    outbound.length = 0;
    maybeSend(
      decideClaim({
        text: "",
        hasPhoto: true,
        recentCode: null,
        isDm: false,
        openTaskContext: false,
      }),
    );
    maybeSend(
      decideClaim({
        text: "should we do sushi or ramen tonight?",
        hasPhoto: false,
        recentCode: null,
        isDm: false,
        openTaskContext: false,
      }),
    );
    expect(outbound).toEqual([]);
  });

  it("does not treat a bare photo as a claim without addressing", () => {
    const decision = decideClaim({
      text: "",
      hasPhoto: true,
      recentCode: null,
      isDm: false,
      openTaskContext: false,
    });
    expect(decision).toEqual({ type: "silent", reason: "addressing" });
  });
});

describe("hash rejection and team fanout", () => {
  it("rejects a hash already claimed this trip", () => {
    expect(hashAlreadyUsed(["aaa", "bbb"], "bbb")).toBe(true);
    expect(hashAlreadyUsed(["aaa"], "ccc")).toBe(false);
  });

  it("writes the full point value to every team member, never a split", () => {
    const rows = awardFanout({
      teamId: "team-1",
      claimantId: "p1",
      teamMemberIds: ["p1", "p2", "p3", "p4"],
      basePoints: 20,
      photoBonus: 2,
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.points === 22)).toBe(true);
  });

  it("includes the claimant even if team_members is missing them", () => {
    const rows = awardFanout({
      teamId: "team-1",
      claimantId: "p1",
      teamMemberIds: ["p2"],
      basePoints: 10,
      photoBonus: 0,
    });
    expect(rows.map((row) => row.participantId).sort()).toEqual(["p1", "p2"]);
  });
});

describe("photo verification gates", () => {
  it("does not resolve a photo task without a photo", () => {
    expect(canResolveNow("photo", false)).toBe(false);
    expect(canResolveNow("photo", true)).toBe(true);
    expect(canResolveNow("honor", false)).toBe(true);
    expect(canResolveNow("peer", false)).toBe(true);
  });

  it("caps the bonus at 1 when EXIF is missing", () => {
    expect(
      applyPhotoBonusRules({
        fidelity: 4,
        hasExif: false,
        takenAt: null,
        tripStart: null,
        tripEnd: null,
      }),
    ).toEqual({ bonus: 1, reject: false });
  });

  it("rejects a timestamp outside the trip window", () => {
    expect(
      applyPhotoBonusRules({
        fidelity: 3,
        hasExif: true,
        takenAt: new Date("2020-01-01T12:00:00"),
        tripStart: "2026-09-01",
        tripEnd: "2026-09-10",
      }).reject,
    ).toBe(true);
  });
});

describe("open tasks", () => {
  it("treats awarded and pending_peer as claimed", () => {
    expect(isOpenTask("t1", [{ task_id: "t1", status: "awarded" }])).toBe(false);
    expect(isOpenTask("t1", [{ task_id: "t1", status: "pending_peer" }])).toBe(
      false,
    );
    expect(isOpenTask("t1", [{ task_id: "t1", status: "rejected" }])).toBe(true);
  });
});

describe("board and confirmation copy", () => {
  it("posts tasks and standings without itinerary anchors", () => {
    const text = formatDailyBoard({
      day: 1,
      tasks: [
        { code: "A2", title: "second", base_points: 10 },
        { code: "A1", title: "first", base_points: 7 },
      ],
      standings: [
        { display_name: "Sarah", score: 10 },
        { display_name: "Michael", score: 20 },
      ],
    });
    expect(text).toContain("Day 1");
    expect(text).toContain("A1 · first (7)");
    expect(text).toContain("A2 · second (10)");
    expect(text).toContain("Michael 20 · Sarah 10");
    expect(text).not.toContain("⚓");
  });

  it("keeps the group morning post to standings only", () => {
    const text = formatMorningStandings({
      day: 1,
      weatherLine: "22° clear",
      standings: [{ display_name: "Michael", score: 20 }],
    });
    expect(text).toContain("Day 1");
    expect(text).toContain("Michael 20");
    expect(text).not.toContain("A1");
  });

  it("formats a personal board for DM", () => {
    const text = formatPersonalBoard({
      day: 1,
      tasks: [{ code: "A1", title: "first", base_points: 7 }],
    });
    expect(text).toContain("A1 · first (7)");
    expect(text).not.toContain("Michael");
  });

  it("formats the one-line confirmation", () => {
    expect(
      claimConfirmedLine({
        code: "C2",
        name: "Michael",
        base: 20,
        photoBonus: 0,
        total: 160,
      }),
    ).toBe("✅ C2 · Michael +20 · 160");
    expect(
      claimConfirmedLine({
        code: "C2",
        name: "Michael",
        base: 20,
        photoBonus: 2,
        total: 162,
      }),
    ).toBe("✅ C2 · Michael +20 +2 photo · 162");
    expect(
      claimConfirmedLine({
        code: "C2",
        name: "Michael",
        base: 20,
        photoBonus: 0,
        total: 160,
        capped: true,
      }),
    ).toBe("✅ C2 · Michael · daily cap reached · 160");
  });
});
