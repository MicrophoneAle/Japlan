import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// On-demand boards and the board_time cron, end to end: dispatchLinqEvent in,
// runDailyBoards for the ticks. Faked edges only: Supabase (in memory), Linq,
// Foursquare, and Gemini (returns nothing, so generation falls back to the
// deterministic templates through the same validation and scoring).

const MIKE = "+15550000001";
const SAM = "+15550000002";
const GROUP = "chat-group";
const DM = { [MIKE]: "dm-mike", [SAM]: "dm-sam" } as Record<string, string>;

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
    const chatId = DM[phone] ?? `dm:${phone}`;
    h.sent.push({ chatId, text });
    return { chatId, messageId: `out-${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
}));
vi.mock("@/lib/places/foursquare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/places/foursquare")>()),
  resolveNearArea: vi.fn(async () => null),
  searchPlaces: vi.fn(async () => {
    throw new Error("no credits");
  }),
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  let proposal = 0;
  // Stands in for the model: task generation gets three fresh proposals
  // (axes only, never points), which then go through the real parse,
  // validation, scoring and code assignment.
  class FakeModel {
    async complete(opts: { schema?: { type?: string } }) {
      if (opts.schema?.type !== "array") return "";
      const tasks = [1, 2, 3].map(() => {
        proposal += 1;
        return {
          code: "",
          title: `find street mural number ${proposal}`,
          axes: { boldness: 2, physical: 1, time: 1, scarcity: 2, cultural: 2, aesthetics: 3 },
          verification: "photo",
          photo_bonus_max: 2,
          neighborhood: "Shibuya",
        };
      });
      return JSON.stringify(tasks);
    }
    async completeTurn() {
      return { text: "ok", functionCalls: [] };
    }
  }
  return { ...actual, GeminiProvider: FakeModel, matchClaimText: vi.fn(async () => null) };
});

import { dispatchLinqEvent } from "./dispatch";
import { runDailyBoards } from "./daily-board";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";
import { PROVISIONAL_NOTE } from "@/lib/game/copy";

let n = 0;
async function say(from: string, chatId: string, text: string) {
  n += 1;
  await dispatchLinqEvent({
    event_id: `evt-${n}`,
    event_type: "message.received",
    data: {
      id: `msg-${n}`,
      chat_id: chatId,
      chat: { id: chatId, is_group: chatId === GROUP },
      sender_handle: { handle: from, is_me: false, display_name: from === MIKE ? "Mike" : "Sam" },
      parts: [{ type: "text", value: text }],
    },
  });
}
const jst = (local: string) => new Date(`${local}+09:00`);
const at = (local: string) => vi.setSystemTime(jst(local));
const to = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
const last = (chatId: string) => to(chatId).at(-1);
const board = (day: number) => h.db.table("boards").find((b) => b.day === day);
const tasksOn = (day: number) => h.db.table("tasks").filter((t) => t.day === day);

function seedTrip(opts: {
  solo?: boolean;
  start?: string;
  end?: string;
  timezone?: string;
  boardTime?: string;
}) {
  const solo = opts.solo ?? true;
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: solo ? DM[MIKE] : GROUP,
      name: "tokyo",
      destination: "Tokyo",
      start_date: opts.start ?? "2026-09-19",
      end_date: opts.end ?? "2026-09-23",
      state: "active",
      timezone: opts.timezone ?? "Asia/Tokyo",
      is_solo: solo,
      board_time: opts.boardTime ?? "08:00",
      setup_state: "done",
      destination_profile_json: TOKYO_HAND_PROFILE,
      intro_sent_at: "2026-09-18T00:00:00Z",
    },
  ]);
  const people = [{ id: "p-mike", phone: MIKE, display_name: "Mike" }];
  if (!solo) people.push({ id: "p-sam", phone: SAM, display_name: "Sam" });
  h.db.seed(
    "participants",
    people.map((p) => ({ ...p, trip_id: "trip-1", survey_state: "done", survey_json: {} })),
  );
  h.db.table("trips")[0].organizer_participant_id = "p-mike";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-09-19T12:00:00");
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "true";
  h.db = new FakeSupabase();
  h.sent.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("asking for a board makes one", () => {
  it("generates today's board on request instead of explaining the cron", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan plans");
    const reply = last(DM[MIKE])!;
    expect(reply).toMatch(/^Day 1/);
    expect(reply).toMatch(/A1 · /);
    expect(reply).not.toMatch(/scheduled|timezone|no board yet/);
    expect(board(1)).toMatchObject({ status: "ready", provisional: false });
    expect(tasksOn(1).length).toBeGreaterThan(0);
    expect(h.db.table("board_requests")).toHaveLength(1);
  });

  it("lists the existing board the second time, generating nothing", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan plans");
    const count = tasksOn(1).length;
    await say(MIKE, DM[MIKE], "what's on the board?");
    expect(last(DM[MIKE])).toMatch(/^Day 1/);
    expect(tasksOn(1).length).toBe(count);
    expect(h.db.table("board_requests")).toHaveLength(1);
  });

  it("makes a future day provisional", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan tomorrow");
    expect(last(DM[MIKE])).toMatch(/^Day 2/);
    expect(last(DM[MIKE])).toContain(PROVISIONAL_NOTE);
    expect(board(2)).toMatchObject({ status: "ready", provisional: true });
  });

  it("allows one on-demand generation per person per day", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan plans");
    await say(MIKE, DM[MIKE], "japlan day 3");
    expect(last(DM[MIKE])).toBe(
      "you've already had one board made today. the next one lands tomorrow at 8am.",
    );
    expect(board(3)).toBeUndefined();
  });

  it("says when the trip starts for a day before it", async () => {
    seedTrip({ start: "2026-09-25", end: "2026-09-28" });
    await say(MIKE, DM[MIKE], "japlan plans");
    expect(last(DM[MIKE])).toBe("the trip starts sep 25. first board lands sep 25 at 8am.");
    expect(h.db.table("boards")).toHaveLength(0);
  });

  it("says the trip is over for a day after it", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan day 9");
    expect(last(DM[MIKE])).toBe("the trip ends sep 23, so there's no board for that day.");
  });

  it("offers a refill when today's board is cleared", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan plans");
    for (const task of tasksOn(1)) {
      h.db.seed("claims", [{ task_id: task.id, participant_id: "p-mike", status: "awarded", awarded_points: 5 }]);
    }
    h.db.tables.board_requests = []; // a new local day's slot
    await say(MIKE, DM[MIKE], "japlan plans");
    expect(last(DM[MIKE])).toMatch(/^you cleared today's board, so here's a refill\.\nDay 1/);
  });
});

describe("in a group", () => {
  it("DMs the asker's board and tells the group so", async () => {
    seedTrip({ solo: false });
    at("2026-09-19T06:00:00"); // before board_time
    await say(MIKE, GROUP, "japlan plans");
    expect(last(GROUP)).toBe("your board's in your dm.");
    expect(last(DM[MIKE])).toMatch(/^Day 1/);
    expect(to(DM[SAM])).toEqual([]); // Sam's arrives at board_time
    expect(board(1)?.delivered_at ?? null).toBeNull();

    // The 08:00 tick delivers to Sam, not Mike again, and posts standings.
    at("2026-09-19T08:05:00");
    h.sent.length = 0;
    await runDailyBoards({});
    expect(to(DM[SAM])).toHaveLength(1);
    expect(to(DM[MIKE])).toHaveLength(0);
    expect(to(GROUP)).toHaveLength(1);
    expect(board(1)?.delivered_at).toBeTruthy();
  });

  it("delivers to everyone at once when asked after board_time", async () => {
    seedTrip({ solo: false });
    at("2026-09-19T12:00:00"); // after 08:00, no board made
    await say(MIKE, GROUP, "japlan plans");
    expect(to(DM[SAM])).toHaveLength(1); // not left waiting for tomorrow's tick
    expect(board(1)?.delivered_at).toBeTruthy();
  });
});

describe("the cron", () => {
  it("posts at or after board_time, once, and recovers a late tick", async () => {
    seedTrip({});
    at("2026-09-20T07:30:00");
    expect(await runDailyBoards({})).toEqual({ ran: [], skipped: ["trip-1"] });

    at("2026-09-20T23:10:00"); // the day's only tick, hours late
    expect((await runDailyBoards({})).ran).toEqual(["trip-1"]);
    expect(tasksOn(2).length).toBeGreaterThan(0);
    const sent = h.sent.length;

    at("2026-09-20T23:40:00");
    expect((await runDailyBoards({})).ran).toEqual([]);
    expect(h.sent.length).toBe(sent); // no second post
  });

  it("works outside UTC+9 and follows board_time", async () => {
    seedTrip({ timezone: "America/New_York", boardTime: "10:30" });
    vi.setSystemTime(new Date("2026-09-20T14:05:00Z")); // 10:05 EDT
    expect((await runDailyBoards({})).ran).toEqual([]);
    vi.setSystemTime(new Date("2026-09-20T14:35:00Z")); // 10:35 EDT
    expect((await runDailyBoards({})).ran).toEqual(["trip-1"]);
  });

  it("skips trips that have not started", async () => {
    seedTrip({ start: "2026-09-25", end: "2026-09-28" });
    at("2026-09-20T09:00:00");
    expect((await runDailyBoards({})).skipped).toEqual(["trip-1"]);
    expect(h.db.table("tasks")).toHaveLength(0);
    // Skipped before trying, not tried and failed: no board was even locked.
    expect(h.db.table("boards")).toHaveLength(0);
  });

  it("regenerates a provisional board on its morning", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan tomorrow");
    const before = tasksOn(2).map((t) => t.id).sort();

    at("2026-09-20T08:05:00");
    await runDailyBoards({});
    const after = tasksOn(2).map((t) => t.id).sort();
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before); // remade with that morning's inputs
    expect(board(2)).toMatchObject({ provisional: false, status: "ready" });
    expect(board(2)?.delivered_at).toBeTruthy();
  });

  it("keeps a provisional board once something on it is claimed", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan tomorrow");
    const claimed = tasksOn(2)[0];
    h.db.seed("claims", [{ task_id: claimed.id, participant_id: "p-mike", status: "awarded", awarded_points: 5 }]);
    const before = tasksOn(2).map((t) => t.id).sort();

    at("2026-09-20T08:05:00");
    await runDailyBoards({});
    expect(tasksOn(2).map((t) => t.id).sort()).toEqual(before);
    expect(board(2)).toMatchObject({ provisional: false });
  });
});

describe("board time command", () => {
  it("lets the organizer set it, and nobody else", async () => {
    seedTrip({ solo: false });
    await say(MIKE, GROUP, "japlan board time 7am");
    expect(h.db.table("trips")[0].board_time).toBe("07:00");
    expect(last(GROUP)).toBe("boards now land at 7am each morning.");

    await say(SAM, GROUP, "japlan board time 10:30");
    expect(last(GROUP)).toBe("only Mike can change the board time.");
    expect(h.db.table("trips")[0].board_time).toBe("07:00");

    await say(MIKE, GROUP, "japlan board time whenever");
    expect(last(GROUP)).toMatch(/^couldn't read that time\./);
  });
});
