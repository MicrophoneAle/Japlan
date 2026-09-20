import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Special days, end to end through dispatchLinqEvent: the multiplier has to
// reach the award, the confirmation and the cap, not just the pure module.
//
// The multiplier lives ON THE TASK, written when the board was generated, so
// every task here is seeded the way lib/handlers/daily-board.ts would have
// written it. That is the whole contract: a claim pays what the board line
// promised, and neither the clock nor a later lookup can change it.
//
// The trip runs thursday 2026-09-17 to monday 2026-09-21.

const MIKE = "+15550000001";
const JESS = "+15550000002";
const GROUP = "chat-group";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
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
    matchClaimText: vi.fn(async () => null),
    extractFreeformActivity: vi.fn(async () => ""),
    judgeRelevance: vi.fn(async () => null),
    judgeStillEngaged: vi.fn(async () => null),
    judgeShouldJoin: vi.fn(async () => null),
  };
});

import { dispatchLinqEvent } from "./dispatch";
import { persistableTask } from "./daily-board";
import { taskMultiplierFor, type MultiplierDay } from "@/lib/game/multipliers";

let evt = 0;
function say(phone: string, text: string) {
  evt += 1;
  return dispatchLinqEvent({
    event_id: `evt-${evt}`,
    event_type: "message.received",
    data: {
      id: `msg-${evt}`,
      chat_id: GROUP,
      chat: { id: GROUP, is_group: true },
      sender_handle: { handle: phone, is_me: false, display_name: phone === MIKE ? "Mike" : "Jess" },
      parts: [{ type: "text", value: text }],
    },
  });
}

const lastIn = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).at(-1)?.text;
// The confirmation can carry a second line inviting a photo; the award is
// always the first one.
const confirmIn = (chatId: string) => lastIn(chatId)?.split("\n")[0];
const score = (id: string) => h.db.table("participants").find((p) => p.id === id)!.score as number;
const awarded = (taskId: string) =>
  h.db.table("claims").filter((c) => c.task_id === taskId && c.status === "awarded");

// Noon in Tokyo on a given local date.
const noonTokyo = (date: string) => new Date(`${date}T03:00:00Z`);

function seedTrip(): void {
  h.db = new FakeSupabase();
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: GROUP,
      name: "tokyo",
      destination: "Tokyo",
      start_date: "2026-09-17",
      end_date: "2026-09-21",
      state: "active",
      timezone: "Asia/Tokyo",
      intro_sent_at: "2026-09-16T00:00:00Z",
      setup_state: "done",
      board_time: "08:00",
      daily_points_cap: 120,
    },
  ]);
  h.db.seed("participants", [
    { id: "p-mike", trip_id: "trip-1", phone: MIKE, display_name: "Mike", survey_state: "done", survey_json: {} },
    { id: "p-jess", trip_id: "trip-1", phone: JESS, display_name: "Jess", survey_state: "done", survey_json: {} },
  ]);
  const task = (id: string, code: string, day: number, extra: Record<string, unknown> = {}) => ({
    id,
    trip_id: "trip-1",
    participant_id: "p-mike",
    team_id: null,
    code,
    title: `task ${code}`,
    tier: "Light",
    axes_json: {},
    base_points: 20,
    photo_bonus_max: 2,
    verification: "honor",
    day,
    day_multiplier: null,
    multiplier_reason: null,
    ...extra,
  });
  h.db.seed("tasks", [
    // An ordinary day.
    task("t-A1", "A1", 1),
    task("t-A2", "A2", 1),
    // A board generated on a 3x national holiday.
    task("t-B1", "B1", 2, { day_multiplier: 3, multiplier_reason: "respect for the aged day" }),
    task("t-B2", "B2", 2, { day_multiplier: 3, multiplier_reason: "respect for the aged day" }),
    // A 1.25x friday.
    task("t-C1", "C1", 3, { day_multiplier: 1.25, multiplier_reason: "friday" }),
    // A 2x festival day, and a team task on it.
    task("t-D1", "D1", 4, { day_multiplier: 2, multiplier_reason: "golden week" }),
    task("t-E1", "E1", 5, {
      participant_id: null,
      team_id: "team-1",
      day_multiplier: 2,
      multiplier_reason: "golden week",
    }),
  ]);
  h.db.seed("teams", [
    { id: "team-1", trip_id: "trip-1", name: "the pair", color: "red", formed_at: "2026-09-17T00:00:00Z", day: null },
  ]);
  h.db.seed("team_members", [
    { team_id: "team-1", participant_id: "p-mike" },
    { team_id: "team-1", participant_id: "p-jess" },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.sent.length = 0;
  seedTrip();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a special day is worth more, for everyone", () => {
  it("pays the plain points on a task that carries no multiplier", async () => {
    vi.setSystemTime(noonTokyo("2026-09-17"));
    await say(MIKE, "A1");
    expect(score("p-mike")).toBe(20);
    expect(confirmIn(GROUP)).toBe("✅ A1 · Mike +20 · 20");
  });

  it("pays the number stored on the task, and says why the points are bigger", async () => {
    vi.setSystemTime(noonTokyo("2026-09-18"));
    await say(MIKE, "B1");
    expect(score("p-mike")).toBe(60);
    expect(confirmIn(GROUP)).toBe("✅ B1 · Mike +60 🔥 3x respect for the aged day · 60");
  });

  it("pays a festival day at 2x", async () => {
    vi.setSystemTime(noonTokyo("2026-09-20"));
    await say(MIKE, "D1");
    expect(score("p-mike")).toBe(40);
    expect(lastIn(GROUP)).toContain("🔥 2x golden week");
  });

  // The promise is on the task, so it survives anything that happens to the
  // clock afterwards. This is the whole reason it is stored at generation.
  it("still pays what the board promised after the local day has rolled over", async () => {
    // The board went out on the holiday; the claim lands after midnight, on an
    // ordinary day, in the trip's own timezone.
    vi.setSystemTime(new Date("2026-09-18T16:30:00Z")); // 1:30am on the 19th in Tokyo
    await say(MIKE, "B1");
    expect(score("p-mike")).toBe(60);
    expect(confirmIn(GROUP)).toContain("3x respect for the aged day");
  });

  it("pays a friday at 1.25x, rounding once", async () => {
    vi.setSystemTime(noonTokyo("2026-09-19"));
    await say(MIKE, "C1");
    expect(score("p-mike")).toBe(25);
    expect(confirmIn(GROUP)).toBe("✅ C1 · Mike +25 🔥 1.25x friday · 25");
  });

  it("pays every team member the full multiplied value, never a split", async () => {
    vi.setSystemTime(noonTokyo("2026-09-21"));
    await say(MIKE, "E1");
    expect(awarded("t-E1")).toHaveLength(2);
    expect(score("p-mike")).toBe(40);
    expect(score("p-jess")).toBe(40);
  });

  it("records why an award was bigger than the board line, for a dispute", async () => {
    vi.setSystemTime(noonTokyo("2026-09-18"));
    await say(MIKE, "B1");
    const claim = awarded("t-B1")[0];
    expect((claim.resolution_json as { multiplier?: unknown }).multiplier).toEqual({
      value: 3,
      label: "respect for the aged day",
    });
  });

  // The cap SCALES with the day. Without it a 3x day just means hitting the
  // ceiling in a third of the claims, which is the opposite of the incentive.
  it("scales the daily cap with the day, instead of swallowing the bonus", async () => {
    h.db.table("trips")[0].daily_points_cap = 100;
    vi.setSystemTime(noonTokyo("2026-09-18"));
    await say(MIKE, "B1");
    await say(MIKE, "B2");
    // Both 60 point claims pay in full: the cap for the day is 300, not 100.
    expect(score("p-mike")).toBe(120);
    expect(h.db.table("claims").every((c) => c.capped === false)).toBe(true);
  });

  it("still caps eventually, and says so without inventing a multiplier", async () => {
    h.db.table("trips")[0].daily_points_cap = 20;
    vi.setSystemTime(noonTokyo("2026-09-18"));
    await say(MIKE, "B1"); // 60, over the scaled cap of 60 already
    await say(MIKE, "B2");
    expect(score("p-mike")).toBe(60);
    const capped = h.db.table("claims").filter((c) => c.capped === true);
    expect(capped).toHaveLength(1);
    expect(lastIn(GROUP)).not.toContain("🔥 3x");
  });
});

// The other half of the contract: what the board generator writes onto a row.
// Every test above seeds those columns by hand, so this is what proves the
// generator would have written them the same way.
describe("what generation writes onto a task", () => {
  const proposed = {
    code: "A1",
    title: "find the loudest street in koenji",
    axes: { boldness: 3, physical: 2, time: 2, scarcity: 3, cultural: 3, aesthetics: 2 },
    verification: "honor" as const,
    photo_bonus_max: 2,
    neighborhood: "Koenji",
  };
  const row = (multiplier: ReturnType<typeof taskMultiplierFor>, day = 1) =>
    persistableTask({
      tripId: "trip-1",
      day,
      tripDays: 5,
      task: proposed,
      participantId: "p-mike",
      teamId: null,
      expiresAt: new Date("2026-09-17T14:59:59Z"),
      multiplier,
    }).row;

  const holidayOn = (date: string, day: number) =>
    taskMultiplierFor({
      localDate: date,
      day,
      tripDays: 5,
      days: [{ local_date: date, multiplier: 3, label: "sports day", source: "holiday" }] as MultiplierDay[],
    });

  it("leaves an ordinary day's task with no multiplier at all", () => {
    const task = row(null);
    expect(task.day_multiplier).toBeNull();
    expect(task.multiplier_reason).toBeNull();
  });

  it("writes the multiplier and its reason, and keeps the tier the task's own", () => {
    const special = holidayOn("2026-09-17", 1);
    const task = row(special);
    expect(task.day_multiplier).toBe(3);
    expect(task.multiplier_reason).toBe("sports day");
    // Day 1 has no day-of-trip scaling to drop, so the printed points are the
    // same as an ordinary day 1 and the tier band still describes the task.
    expect(task.base_points).toBe(row(null).base_points);
    expect(task.tier).toBe(row(null).tier);
  });

  // The multiplier replaces the day-of-trip scaling rather than compounding
  // with it, so on a multiplier day the board prints the task's unscaled worth
  // and "everything's 3x" is true of that number.
  it("drops the day-of-trip scaling from the points it prints", () => {
    const special = holidayOn("2026-09-21", 5);
    const task = row(special, 5);
    const plainFinalDay = row(null, 5);
    const plainDayOne = row(null, 1);
    expect(task.day_multiplier).toBe(3);
    expect(task.base_points).toBe(plainDayOne.base_points);
    expect(task.base_points).toBeLessThan(plainFinalDay.base_points);
    // And the total is exactly 3x the task's raw worth, never the 6x a
    // product with the final day's doubling would have given.
    expect(task.base_points * (task.day_multiplier as number)).toBe(plainDayOne.base_points * 3);
  });
});
