import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import { fakeHeic } from "@/lib/test/images";

// Task ownership with two people on one trip, end to end through
// dispatchLinqEvent. Everyone's personal board is A1-A3, so codes repeat per
// owner; a claim must resolve against the claimant's own tasks on every
// route, and the database constraint (one winner per task) must hold under a
// real race. The fake enforces schema.sql's unique indexes, including
// claims_one_winner_per_task.

const PHONES = { a: "+15550000001", b: "+15550000002" };
const GROUP = "chat-group";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  vision: vi.fn(),
  match: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return { chatId, messageId: `out-${h.sent.length}` };
  }),
  sendDM: vi.fn(async (phone: string, text: string) => {
    h.sent.push({ chatId: `dm:${phone}`, text });
    return { chatId: `dm:${phone}`, messageId: `out-${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
  react: vi.fn(async () => {}),
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class NoNetworkProvider {
    async complete() {
      return "";
    }
    async completeTurn() {
      return { text: "ok", functionCalls: [] };
    }
  }
  return {
    ...actual,
    GeminiProvider: NoNetworkProvider,
    scorePhotoFidelity: h.vision,
    matchClaimText: h.match,
    extractFreeformActivity: vi.fn(async () => ""),
    judgeRelevance: vi.fn(async () => null),
    judgeStillEngaged: vi.fn(async () => null),
    judgeShouldJoin: vi.fn(async () => null),
  };
});

import { dispatchLinqEvent } from "./dispatch";

let evt = 0;
function message(who: keyof typeof PHONES, parts: Record<string, unknown>[]) {
  evt += 1;
  return {
    event_id: `evt-${evt}`,
    event_type: "message.received",
    data: {
      id: `msg-${evt}`,
      chat_id: GROUP,
      chat: { id: GROUP, is_group: true },
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who === "a" ? "Ana" : "Ben" },
      parts,
    },
  };
}
const say = (who: keyof typeof PHONES, text: string) => dispatchLinqEvent(message(who, [{ type: "text", value: text }]));
const photo = (who: keyof typeof PHONES, text = "japlan") =>
  dispatchLinqEvent(
    message(who, [
      { type: "media", url: `https://cdn.example/${evt}.heic`, mime_type: "image/heic" },
      ...(text ? [{ type: "text", value: text }] : []),
    ]),
  );
const lastIn = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).at(-1)?.text;
const claims = () => h.db.table("claims");
const claimsOn = (taskId: string) => claims().filter((c) => c.task_id === taskId);
const score = (id: string) => h.db.table("participants").find((p) => p.id === id)!.score as number;
const verdict = (relates: boolean, fidelity: number) => ({
  shows_task: relates,
  fidelity,
  seen: "a photo",
  raw: { relates: JSON.stringify({ seen: "a photo", relates }), fidelity: relates ? `{"fidelity":${fidelity}}` : null },
});

function task(id: string, code: string, owner: { participant_id?: string | null; team_id?: string | null }, extra = {}) {
  return {
    id,
    trip_id: "trip-1",
    participant_id: owner.participant_id ?? null,
    team_id: owner.team_id ?? null,
    code,
    title: `task ${id}`,
    tier: "Light",
    axes_json: {},
    base_points: 10,
    photo_bonus_max: 2,
    verification: "honor",
    day: 1,
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T03:00:00Z")); // noon in Tokyo, day 1
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.sent.length = 0;
  h.vision.mockReset();
  h.match.mockReset().mockResolvedValue(null);
  h.db = new FakeSupabase();
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: GROUP,
      name: "tokyo",
      destination: "Tokyo",
      start_date: "2026-09-19",
      end_date: "2026-09-23",
      state: "active",
      timezone: "Asia/Tokyo",
      intro_sent_at: "2026-09-18T00:00:00Z",
      setup_state: "done",
      board_time: "08:00",
    },
  ]);
  h.db.seed("participants", [
    { id: "p-a", trip_id: "trip-1", phone: PHONES.a, display_name: "Ana", survey_state: "done", survey_json: {} },
    { id: "p-b", trip_id: "trip-1", phone: PHONES.b, display_name: "Ben", survey_state: "done", survey_json: {} },
  ]);
  h.db.seed("teams", [{ id: "team-a", trip_id: "trip-1", name: "ana's team", color: "red", formed_at: "2026-09-19T00:00:00Z", day: 1 }]);
  h.db.seed("team_members", [{ team_id: "team-a", participant_id: "p-a" }]);
  h.db.seed("tasks", [
    // Everyone has an A1.
    task("a-A1", "A1", { participant_id: "p-a" }),
    task("b-A1", "A1", { participant_id: "p-b" }),
    // Only Ana has an A2.
    task("a-A2", "A2", { participant_id: "p-a" }),
    // Shared board (no owner): anyone, first write wins.
    task("shared-A3", "A3", {}),
    task("shared-A5", "A5", {}),
    // Ana's team only.
    task("team-A4", "A4", { team_id: "team-a" }),
  ]);
  // Each fetch returns different bytes, so no photo reads as a reused one.
  let seed = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(fakeHeic(++seed)), { status: 200, headers: { "content-type": "image/heic" } })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("two people, one trip", () => {
  it("1. B claims their own A1: awarded to B, not to A's A1", async () => {
    await say("b", "A1");
    expect(claimsOn("b-A1")).toHaveLength(1);
    expect(claimsOn("b-A1")[0]).toMatchObject({ participant_id: "p-b", status: "awarded" });
    expect(claimsOn("a-A1")).toHaveLength(0);
    expect(score("p-b")).toBe(10);
    expect(score("p-a")).toBe(0);
  });

  it("2. B sends a code only on A's board: 'isn't on your board', no award, no row", async () => {
    await say("b", "A2");
    expect(lastIn(GROUP)).toMatch(/^A2 isn't on your board/);
    expect(claims()).toHaveLength(0);
    expect(score("p-b")).toBe(0);
  });

  it("3. B claims a shared task: awarded to B, and A cannot then claim it", async () => {
    await say("b", "A3");
    expect(claimsOn("shared-A3")).toHaveLength(1);
    expect(claimsOn("shared-A3")[0]).toMatchObject({ participant_id: "p-b", status: "awarded" });
    await say("a", "A3");
    expect(lastIn(GROUP)).toMatch(/A3/);
    expect(lastIn(GROUP)).toMatch(/already/);
    expect(claimsOn("shared-A3").filter((c) => c.status === "awarded")).toHaveLength(1);
    expect(score("p-a")).toBe(0);
  });

  it("4. a team task claimed by a non-member is refused", async () => {
    await say("b", "A4");
    expect(lastIn(GROUP)).toMatch(/^A4 isn't on your board/);
    expect(claimsOn("team-A4")).toHaveLength(0);
    // The member can.
    await say("a", "A4");
    expect(claimsOn("team-A4")[0]).toMatchObject({ participant_id: "p-a", status: "awarded" });
  });

  it("5. both send the same shared code at once: exactly one award, the other told it's taken", async () => {
    const log = vi.spyOn(console, "log");
    await Promise.all([say("a", "A5"), say("b", "A5")]);
    // Both passed the application's "already claimed?" check (a true race);
    // the database's one-winner index is what stopped the second award.
    const steps = log.mock.calls
      .filter((c) => c[0] === "[japlan.claim] step")
      .map((c) => c[1] as { step: string; reason?: string });
    expect(steps.some((s) => s.step === "already_claimed.hit")).toBe(false);
    expect(steps.some((s) => s.reason === "claim_conflict")).toBe(true);
    log.mockRestore();
    const awarded = claimsOn("shared-A5").filter((c) => c.status === "awarded");
    expect(awarded).toHaveLength(1);
    const winner = awarded[0].participant_id as string;
    expect(score(winner)).toBe(10);
    expect(score(winner === "p-a" ? "p-b" : "p-a")).toBe(0);
    const replies = h.sent.filter((m) => m.chatId === GROUP).map((m) => m.text);
    expect(replies.filter((t) => /^✅ A5/.test(t))).toHaveLength(1);
    expect(replies.filter((t) => /A5/.test(t) && /already/.test(t))).toHaveLength(1);
  });
});

describe("every claim route is scoped to the claimant's own tasks", () => {
  it("text matching only offers the model B's claimable tasks", async () => {
    await say("b", "japlan we found the weirdest vending machine");
    expect(h.match).toHaveBeenCalled();
    const offered = (h.match.mock.calls[0][0] as { tasks: { code: string; title: string }[] }).tasks.map((t) => t.title);
    expect(offered).toContain("task b-A1");
    expect(offered).toContain("task shared-A3");
    expect(offered).not.toContain("task a-A1");
    expect(offered).not.toContain("task a-A2");
    expect(offered).not.toContain("task team-A4");
  });

  it("even if the model names someone else's task, B gets nothing for it", async () => {
    h.match.mockResolvedValue({ code: "A2", confidence: 0.99 });
    await say("b", "japlan we did the thing");
    expect(claimsOn("a-A2")).toHaveLength(0);
    expect(score("p-b")).toBe(0);
  });

  it("photo matching only scores B's open tasks", async () => {
    h.vision.mockResolvedValue(verdict(false, 0));
    await photo("b");
    const scored = h.vision.mock.calls.map((c) => (c[0] as { title: string }).title);
    expect(scored.length).toBeGreaterThan(0);
    for (const title of scored) expect(["task b-A1", "task shared-A3", "task shared-A5"]).toContain(title);
  });

  it("a late photo bonus binds to B's own claim, never A's", async () => {
    await say("a", "A1");
    await say("b", "A1");
    h.vision.mockResolvedValue(verdict(true, 2));
    await photo("b", "");
    const bonused = claims().filter((c) => c.photo_claimed_at);
    expect(bonused).toHaveLength(1);
    expect(bonused[0]).toMatchObject({ task_id: "b-A1", participant_id: "p-b" });
    expect(score("p-a")).toBe(10);
  });
});
