import { describe, expect, it } from "vitest";
import { formatDailyBoard, formatMorningStandings, formatPersonalBoard } from "./board";
import {
  applyPhotoBonusRules,
  awardFanout,
  canClaimTask,
  canResolveNow,
  clampPhotoBonus,
  decideClaim,
  DEFAULT_PHOTO_BONUS_WINDOW_MS,
  extractTaskCode,
  findTaskByCodeFor,
  hashAlreadyUsed,
  isOpenTask,
  ladder,
  openCodesFor,
  pickLatePhotoTarget,
  splitTeamsByClaimWindow,
  tasksClaimableBy,
  verificationRequiresPeer,
} from "./claims";
import { findTaskCode } from "./addressing";
import { HAND_WRITTEN_DAY1_TASKS } from "./hand-written-tasks";
import { computePoints, applyDailyPointsCap, dayLetter, tierForPoints } from "./scoring";
import {
  claimConfirmedLine,
  nextStepClause,
  notYourTaskLine,
  photoBonusLine,
  teamTaskExpiredLine,
  unknownCodeLine,
} from "./copy";

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
    expect(extractTaskCode("A1")).toBe("A1");
    expect(extractTaskCode("  a1. ")).toBe("A1");
    expect(extractTaskCode("japlan A1")).toBe("A1");
    expect(extractTaskCode("hey JAPLAN: b12 done")).toBe("B12");
    expect(ladder({ text: "japlan a10", hasPhoto: false, recentCode: null })).toEqual({
      step: 1,
      code: "A10",
    });
  });

  it("matches a standalone code in a message of six words or fewer", () => {
    expect(findTaskCode("I did A1")).toEqual({ code: "A1", strict: false });
    expect(findTaskCode("done with a1!")).toEqual({ code: "A1", strict: false });
    expect(findTaskCode("(B3) finally")).toEqual({ code: "B3", strict: false });
    expect(findTaskCode("b4")).toEqual({ code: "B4", strict: true });
    expect(findTaskCode("A1s are great")).toBeNull();
  });

  it("needs the keyword past six words", () => {
    expect(findTaskCode("one two three four five six A1")).toBeNull();
    expect(findTaskCode("one two three four five A1")).toEqual({
      code: "A1",
      strict: false,
    });
    expect(findTaskCode("japlan one two three four five six A1")).toEqual({
      code: "A1",
      strict: true,
    });
    expect(findTaskCode("japlanning a1 and more words here for sure")).toBeNull();
  });

  it("marks a loose-only code decision as tentative", () => {
    const loose = decideClaim({
      text: "done with A1",
      hasPhoto: false,
      recentCode: null,
      isDm: false,
      openTaskContext: false,
    });
    expect(loose).toMatchObject({ type: "code", code: "A1", tentative: true });
    const strict = decideClaim({
      text: "A1",
      hasPhoto: false,
      recentCode: null,
      isDm: false,
      openTaskContext: false,
    });
    expect(strict).toMatchObject({ type: "code", code: "A1", tentative: false });
    const dm = decideClaim({
      text: "done with A1",
      hasPhoto: false,
      recentCode: null,
      isDm: true,
      openTaskContext: false,
    });
    expect(dm).toMatchObject({ type: "code", code: "A1", tentative: false });
  });

  it("short-circuits a bare A1 in a DM as regex step 1 with no fuzzy/vision", () => {
    const decision = decideClaim({
      text: "A1",
      hasPhoto: false,
      recentCode: null,
      isDm: true,
      openTaskContext: false,
    });
    expect(decision).toEqual({
      type: "code",
      step: 1,
      code: "A1",
      withPhoto: false,
      tentative: false,
    });
    expect(decision.type).not.toBe("fuzzy");
    expect(decision.type).not.toBe("vision");
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

describe("task ownership", () => {
  const personal = (id: string, owner: string, code = "A1") => ({
    id,
    code,
    participant_id: owner,
    team_id: null,
  });
  const team = (id: string, teamId: string, code = "A1") => ({
    id,
    code,
    participant_id: null,
    team_id: teamId,
  });
  const shared = (id: string, code = "A1") => ({
    id,
    code,
    participant_id: null,
    team_id: null,
  });

  it("lets only the owner claim a personal task", () => {
    expect(canClaimTask(personal("t1", "p1"), "p1", [])).toBe(true);
    expect(canClaimTask(personal("t1", "p1"), "p2", [])).toBe(false);
  });

  it("lets only team members claim a team task", () => {
    expect(canClaimTask(team("t1", "red"), "p1", ["red"])).toBe(true);
    expect(canClaimTask(team("t1", "red"), "p2", ["blue"])).toBe(false);
  });

  it("lets anyone claim the shared board", () => {
    expect(canClaimTask(shared("t1"), "p9", [])).toBe(true);
  });

  it("prefers the latest day when letters cycle past day 26", () => {
    expect(dayLetter(1)).toBe("A");
    expect(dayLetter(26)).toBe("Z");
    expect(dayLetter(27)).toBe("A");
    const tasks = [
      { ...personal("day1", "p1"), day: 1 },
      { ...personal("day27", "p1"), day: 27 },
    ];
    const hit = findTaskByCodeFor(tasks, "A1", "p1", []);
    expect(hit.kind === "task" && hit.task.id).toBe("day27");
  });

  it("resolves a repeated code to the claimant's own task", () => {
    const tasks = [personal("mine", "p1"), personal("theirs", "p2")];
    expect(findTaskByCodeFor(tasks, "A1", "p1", [])).toEqual({
      kind: "task",
      task: tasks[0],
    });
    expect(findTaskByCodeFor(tasks, "a1", "p2", [])).toEqual({
      kind: "task",
      task: tasks[1],
    });
  });

  it("reports not_yours when the code exists only on someone else's board", () => {
    const tasks = [personal("theirs", "p2", "A5"), team("red-a1", "red")];
    expect(findTaskByCodeFor(tasks, "A5", "p1", []).kind).toBe("not_yours");
    expect(findTaskByCodeFor(tasks, "A1", "p1", ["blue"]).kind).toBe("not_yours");
    expect(findTaskByCodeFor(tasks, "Z9", "p1", []).kind).toBe("unknown");
  });

  it("prefers personal, then team, then shared on a collision", () => {
    const tasks = [shared("s"), team("t", "red"), personal("p", "p1")];
    const hit = findTaskByCodeFor(tasks, "A1", "p1", ["red"]);
    expect(hit.kind === "task" && hit.task.id).toBe("p");
    const teamHit = findTaskByCodeFor(tasks, "A1", "p2", ["red"]);
    expect(teamHit.kind === "task" && teamHit.task.id).toBe("t");
    const sharedHit = findTaskByCodeFor(tasks, "A1", "p3", []);
    expect(sharedHit.kind === "task" && sharedHit.task.id).toBe("s");
  });

  it("keeps a dissolved team's tasks claimable until end of that local day", () => {
    const tz = "Asia/Tokyo";
    // Dissolved 2026-09-19 15:00 JST; the window closes 23:59:59 JST that day.
    const dissolvedAt = "2026-09-19T06:00:00Z";
    const memberships = [
      { teamId: "red", dissolvedAt },
      { teamId: "blue", dissolvedAt: null },
    ];
    const sameEvening = splitTeamsByClaimWindow(
      memberships,
      tz,
      new Date("2026-09-19T14:00:00Z"), // 23:00 JST
    );
    expect(sameEvening).toEqual({ active: ["red", "blue"], expired: [] });
    const nextMorning = splitTeamsByClaimWindow(
      memberships,
      tz,
      new Date("2026-09-19T15:30:00Z"), // 00:30 JST next day
    );
    expect(nextMorning).toEqual({ active: ["blue"], expired: ["red"] });
  });

  it("says a code expired with the team once the window closes", () => {
    const tasks = [team("red-b2", "red", "B2")];
    expect(findTaskByCodeFor(tasks, "B2", "p1", [], ["red"]).kind).toBe("team_expired");
    expect(findTaskByCodeFor(tasks, "B2", "p1", ["red"], []).kind).toBe("task");
    expect(findTaskByCodeFor(tasks, "B2", "p9", [], []).kind).toBe("not_yours");
  });

  it("lists the claimant's open codes, today's first", () => {
    const tasks = [
      { ...personal("a1", "p1", "A1"), day: 1 },
      { ...personal("b1", "p1", "B1"), day: 2 },
      { ...personal("b2", "p1", "B2"), day: 2 },
      { ...personal("b1-other", "p2", "B1"), day: 2 },
    ];
    const claims = [{ task_id: "b2", status: "awarded" }];
    expect(openCodesFor(tasks, claims, "p1", [])).toEqual(["B1", "A1"]);
  });

  it("filters to claimable tasks", () => {
    const tasks = [personal("a", "p1"), personal("b", "p2"), shared("c", "A4")];
    expect(tasksClaimableBy(tasks, "p1", []).map((t) => t.id)).toEqual(["a", "c"]);
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

describe("photo bonus is never a gate", () => {
  it("resolves honor, photo, and peer code claims without a photo", () => {
    expect(canResolveNow("photo", false)).toBe(true);
    expect(canResolveNow("photo", true)).toBe(true);
    expect(canResolveNow("honor", false)).toBe(true);
    expect(canResolveNow("peer", false)).toBe(true);
  });

  it("keeps peer as the only tapback gate", () => {
    expect(verificationRequiresPeer("peer")).toBe(true);
    expect(verificationRequiresPeer("photo")).toBe(false);
    expect(verificationRequiresPeer("honor")).toBe(false);
    expect(isOpenTask("t1", [{ task_id: "t1", status: "pending_peer" }])).toBe(
      false,
    );
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

  it("counts a fresh photo for a task made before the trip, not an older one", () => {
    const rules = (taken: string) =>
      applyPhotoBonusRules({
        fidelity: 2,
        hasExif: true,
        takenAt: new Date(`${taken}Z`),
        tripStart: "2026-10-17",
        tripEnd: "2026-10-20",
        taskCreatedOn: "2026-09-19",
      });
    expect(rules("2026-09-19T15:00:00")).toEqual({ bonus: 2, reject: false });
    expect(rules("2026-09-04T15:30:32").reject).toBe(true); // camera roll
    expect(rules("2026-10-21T09:00:00").reject).toBe(true); // after the trip
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
    // Code and title on one line, tier and points indented under it.
    expect(text).toContain("A1 · first\n   light · 7 pts");
    expect(text).toContain("A2 · second\n   light · 10 pts");
    // Standings are ranked, highest first, whatever order they arrived in.
    expect(text).toContain("1. Michael · 20 pts");
    expect(text).toContain("2. Sarah · 10 pts");
    expect(text.indexOf("Michael")).toBeLessThan(text.indexOf("Sarah"));
    expect(text).not.toContain("⚓");
  });

  it("keeps the group morning post to standings only", () => {
    const text = formatMorningStandings({
      day: 1,
      weatherLine: "22° clear",
      standings: [{ display_name: "Michael", score: 20 }],
    });
    expect(text).toContain("Day 1");
    expect(text).toContain("Michael · 20 pts");
    // The point of the group post: scores, never anyone's task codes.
    expect(text).not.toContain("A1");
  });

  it("formats a personal board for DM", () => {
    const text = formatPersonalBoard({
      day: 1,
      tasks: [
        { code: "A1", title: "first", base_points: 15 },
        { code: "A2", title: "second", base_points: 16 },
        { code: "A3", title: "third", base_points: 25 },
        { code: "A4", title: "fourth", base_points: 34 },
      ],
    });
    // Tier from the points beside it, one line per task. Older tasks have no
    // time of day, and show without one.
    expect(text.split("\n").slice(2)).toEqual([
      "✨ anytime",
      "A1 · first",
      "   light · 15 pts",
      "A2 · second",
      "   medium · 16 pts",
      "A3 · third",
      "   challenging · 25 pts",
      "A4 · fourth",
      "   challenging · 34 pts",
    ]);
    // A personal board is one person's: no standings, nobody else's name.
    expect(text).not.toContain("Michael");
  });

  it("shows the day's shape: route in the header, time of day on each line", () => {
    const text = formatPersonalBoard({
      day: 3,
      tasks: [
        { code: "A3", title: "order something you can't read", base_points: 11, slot: "evening", neighborhood: "Ueno" },
        { code: "A1", title: "ask a stranger for their best rec", base_points: 18, slot: "morning", neighborhood: "Asakusa" },
        { code: "A2", title: "get to ueno without a train", base_points: 26, slot: "afternoon", neighborhood: null },
      ],
    });
    expect(text).toBe(
      [
        "Day 3 · Asakusa → Ueno",
        "",
        "🌅 morning",
        "A1 · ask a stranger for their best rec",
        "   medium · 18 pts",
        "",
        "☀️ afternoon",
        "A2 · get to ueno without a train",
        "   challenging · 26 pts",
        "",
        "🌙 evening",
        "A3 · order something you can't read",
        "   light · 11 pts",
      ].join("\n"),
    );
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
    ).toBe(
      "✅ C2 · Michael · 160 · that's your cap for today bestie, but it still counts for the recap 📈",
    );
    expect(
      claimConfirmedLine({
        code: "A1",
        name: "Michael",
        base: 12,
        photoBonus: 0,
        total: 12,
        invitePhoto: true,
      }),
    ).toBe("✅ A1 · Michael +12 · 12\nphoto for bonus points? 👀");
    expect(
      photoBonusLine({ code: "A1", bonus: 3, total: 15 }),
    ).toBe("📸 A1 · +3 bonus · 15");
    expect(
      photoBonusLine({ code: "A1", bonus: 0, total: 120, capped: true }),
    ).toBe("📸 A1 · 120 · that's your cap for today bestie, but it still counts for the recap 📈");
  });

  it("offers a next step only when the claim clears the board", () => {
    const routine = claimConfirmedLine({
      code: "A2",
      name: "Michael",
      base: 12,
      photoBonus: 0,
      total: 30,
    });
    expect(routine).toBe("✅ A2 · Michael +12 · 30");
    expect(routine.split("\n")).toHaveLength(1);
    expect(
      claimConfirmedLine({
        code: "A3",
        name: "Michael",
        base: 12,
        photoBonus: 0,
        total: 42,
        invitePhoto: true,
        boardCleared: true,
      }),
    ).toBe("✅ A3 · Michael +12 · 42 · that's your whole board cleared 🔥 new tasks coming by dm.");
  });

  it("names open codes in refusals, never generic encouragement", () => {
    expect(nextStepClause(["A2"])).toBe("A2 is still open btw.");
    expect(nextStepClause(["A2", "A3"])).toBe("still open: A2, A3.");
    expect(nextStepClause([])).toBe("next board lands in the morning, hang tight.");
    expect(notYourTaskLine("A5", nextStepClause(["A1", "A3"]))).toBe(
      "A5 isn't on your board bestie. still open: A1, A3.",
    );
    expect(unknownCodeLine("A9", nextStepClause(["A1"]))).toBe(
      "there's no A9 lol, made that up? A1 is still open btw.",
    );
    for (const line of [
      notYourTaskLine("A5", nextStepClause(["A1"])),
      unknownCodeLine("A9", nextStepClause([])),
      teamTaskExpiredLine("B2", nextStepClause(["B4"])),
    ]) {
      expect(line).not.toMatch(/let me know|you got this|!/i);
      expect(line.split("\n")).toHaveLength(1);
    }
  });
});

describe("late photo bonus window", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  const tasks = [{ id: "task-a1", code: "A1", photo_bonus_max: 5 }];
  const awarded = {
    id: "claim-1",
    task_id: "task-a1",
    participant_id: "p1",
    status: "awarded",
    photo_claimed_at: null as string | null,
    created_at: "2026-09-19T11:00:00Z",
  };

  it("awards base points and invites a photo on a bonus task", () => {
    expect(
      claimConfirmedLine({
        code: "A1",
        name: "Michael",
        base: 12,
        photoBonus: 0,
        total: 12,
        invitePhoto: true,
      }),
    ).toContain("photo for bonus points? 👀");
    expect(clampPhotoBonus(5, 3)).toBe(3);
  });

  it("binds a photo within the window to the claimed task once", () => {
    expect(
      pickLatePhotoTarget({
        hasPhoto: true,
        code: "A1",
        claimantId: "p1",
        claims: [awarded],
        tasks,
        now,
        windowMs: DEFAULT_PHOTO_BONUS_WINDOW_MS,
      }),
    ).toEqual({ kind: "bonus", taskId: "task-a1", claimId: "claim-1" });

    expect(
      pickLatePhotoTarget({
        hasPhoto: true,
        code: null,
        claimantId: "p1",
        claims: [awarded],
        tasks,
        now,
        windowMs: DEFAULT_PHOTO_BONUS_WINDOW_MS,
      }),
    ).toEqual({ kind: "bonus", taskId: "task-a1", claimId: "claim-1" });
  });

  it("adds nothing on a second photo for the same task", () => {
    expect(
      pickLatePhotoTarget({
        hasPhoto: true,
        code: "A1",
        claimantId: "p1",
        claims: [
          {
            ...awarded,
            photo_claimed_at: "2026-09-19T11:10:00Z",
          },
        ],
        tasks,
        now,
        windowMs: DEFAULT_PHOTO_BONUS_WINDOW_MS,
      }),
    ).toEqual({ kind: "already_bonused" });
  });

  it("falls through after the window", () => {
    expect(
      pickLatePhotoTarget({
        hasPhoto: true,
        code: null,
        claimantId: "p1",
        claims: [
          {
            ...awarded,
            created_at: "2026-09-19T09:00:00Z",
          },
        ],
        tasks,
        now,
        windowMs: DEFAULT_PHOTO_BONUS_WINDOW_MS,
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not bind a bonus to a task with photo_bonus_max 0", () => {
    expect(
      pickLatePhotoTarget({
        hasPhoto: true,
        code: "A1",
        claimantId: "p1",
        claims: [awarded],
        tasks: [{ id: "task-a1", code: "A1", photo_bonus_max: 0 }],
        now,
        windowMs: DEFAULT_PHOTO_BONUS_WINDOW_MS,
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not bind a late photo to a pending peer claim", () => {
    expect(
      pickLatePhotoTarget({
        hasPhoto: true,
        code: "A1",
        claimantId: "p1",
        claims: [{ ...awarded, status: "pending_peer" }],
        tasks,
        now,
        windowMs: DEFAULT_PHOTO_BONUS_WINDOW_MS,
      }),
    ).toEqual({ kind: "none" });
    expect(verificationRequiresPeer("peer")).toBe(true);
  });

  it("zeroes a bonus when the daily cap is already reached", () => {
    expect(
      applyDailyPointsCap({ pointsToday: 120, incoming: 3, cap: 120 }),
    ).toEqual({ awarded_points: 0, capped: true });
    expect(
      applyDailyPointsCap({ pointsToday: 40, incoming: 3, cap: 120 }),
    ).toEqual({ awarded_points: 3, capped: false });
  });
});
