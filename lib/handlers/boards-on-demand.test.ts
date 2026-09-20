import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// On-demand boards and the board_time cron, end to end: dispatchLinqEvent in,
// runDailyBoards for the ticks. Faked edges only: Supabase (in memory), Linq,
// Foursquare, and Gemini (a fake that proposes template-based tasks, which go
// through the real validation, duration estimate, day plan and scoring).

const MIKE = "+15550000001";
const SAM = "+15550000002";
const ANA = "+15550000003";
const GROUP = "chat-group";
const DM = { [MIKE]: "dm-mike", [SAM]: "dm-sam", [ANA]: "dm-ana" } as Record<string, string>;
const NAMES: Record<string, string> = { [MIKE]: "Mike", [SAM]: "Sam", [ANA]: "Ana" };

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
}));

// No network in tests: board generation asks for the day's weather.
vi.mock("@/lib/game/weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/game/weather")>()),
  fetchDayWeather: vi.fn(async () => ({ temperatureC: 20, precipitationChance: 0, summary: "clear", indoorPreferred: false })),
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
  react: vi.fn(async () => {}),
  shareContactCardSafely: vi.fn(async () => {}),
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
  // Stands in for the model: task generation gets four fresh proposals
  // (axes only, never points), which then go through the real parse,
  // validation, scoring and code assignment.
  class FakeModel {
    async complete(opts: { schema?: { type?: string }; messages?: { content: string }[] }) {
      if (opts.schema?.type !== "array") return "";
      const curveballBoard = /Exactly one task uses template "curveball"/.test(opts.messages?.[0]?.content ?? "");
      // Built from board templates, each at its own place, with fresh titles.
      const picks = [
        { template: "stranger_best_rec", time: 3, boldness: 4, places: ["Asakusa"] },
        { template: "wrong_train", time: 3, boldness: 3, places: [] },
        { template: "order_unreadable", time: 2, boldness: 2, places: ["Ueno"] },
        { template: "buy_keep", time: 2, boldness: 2, places: ["Yanaka"] },
      ];
      const tasks = picks.map((pick) => {
        proposal += 1;
        return {
          template: pick.template,
          title: `${pick.template.replace(/_/g, " ")} number ${proposal}`,
          axes: { boldness: pick.boldness, physical: 1, time: pick.time, scarcity: 2, cultural: 2, aesthetics: 3 },
          verification: "photo",
          photo_bonus_max: 2,
          neighborhood: pick.places[0] ?? "",
          places: pick.places,
          involves_stranger: pick.template === "stranger_best_rec",
        };
      });
      if (curveballBoard) {
        proposal += 1;
        tasks.unshift({
          template: "curveball",
          title: `bow back to a bowing vending machine number ${proposal}`,
          axes: { boldness: 4, physical: 1, time: 2, scarcity: 4, cultural: 5, aesthetics: 2 },
          verification: "photo",
          photo_bonus_max: 2,
          neighborhood: "Shibuya",
          places: ["Shibuya"],
          involves_stranger: false,
          kind: "culture",
        } as (typeof tasks)[number]);
      }
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
import { finishYourSurveyLine } from "@/lib/game/copy";
import { REFILLS_PER_DAY } from "./board-request";

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
      sender_handle: { handle: from, is_me: false, display_name: NAMES[from] },
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
    expect(last(DM[MIKE])).toMatch(/^Day 2, might still change( · [^\n]+)?\n/);
    expect(last(DM[MIKE])).not.toMatch(/provisional|weather/);
    expect(board(2)).toMatchObject({ status: "ready", provisional: true });
  });

  it("lets you look ahead at every day of the trip", async () => {
    seedTrip({});
    for (const ask of ["japlan plans", "japlan tomorrow", "japlan day 3", "japlan the last day"]) {
      await say(MIKE, DM[MIKE], ask);
      expect(last(DM[MIKE]), ask).toMatch(/^Day \d(, might still change)?( · [^\n]+)?\n/);
    }
    expect([1, 2, 3, 5].map((d) => Boolean(board(d)))).toEqual([true, true, true, true]);
    expect(board(3)).toMatchObject({ provisional: true });
    expect(h.sent.some((m) => /already had|limit|plenty/.test(m.text))).toBe(false);
  });

  it("reads a calendar date and names like first and last day", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan sep 21");
    expect(last(DM[MIKE])).toMatch(/^Day 3, might still change( · [^\n]+)?\n/);
    await say(MIKE, DM[MIKE], "japlan first day");
    expect(last(DM[MIKE])).toMatch(/^Day 1( · [^\n]+)?\n/);
  });

  it("shows day 1 when asked before the trip starts", async () => {
    seedTrip({ start: "2026-09-25", end: "2026-09-28" });
    await say(MIKE, DM[MIKE], "japlan plans");
    expect(last(DM[MIKE])).toMatch(/^Day 1, might still change( · [^\n]+)?\n/);
    expect(board(1)).toMatchObject({ provisional: true });
  });

  it("only refuses a day that is not part of the trip, in the person's terms", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan day 9");
    expect(last(DM[MIKE])).toBe("that day isn't part of this trip lol. it runs sep 19 to sep 23.");
  });

  it("does not make a board for a day that is over", async () => {
    seedTrip({});
    at("2026-09-21T12:00:00");
    await say(MIKE, DM[MIKE], "japlan day 1");
    expect(last(DM[MIKE])).toBe("day 1 is over, so there's no board to make for it now.");
    expect(board(1)).toBeUndefined();
  });

  it("refills a cleared day, and only limits endless refills of that same day", async () => {
    seedTrip({});
    await say(MIKE, DM[MIKE], "japlan plans");
    const clearDay1 = () => {
      for (const task of tasksOn(1)) {
        if (h.db.table("claims").some((c) => c.task_id === task.id)) continue;
        h.db.seed("claims", [{ task_id: task.id, participant_id: "p-mike", status: "awarded", awarded_points: 5 }]);
      }
    };
    for (let i = 1; i <= REFILLS_PER_DAY; i++) {
      clearDay1();
      await say(MIKE, DM[MIKE], "japlan plans");
      expect(last(DM[MIKE]), `refill ${i}`).toMatch(/^u cleared that board 🫡 here's more\.\nDay 1/);
    }
    clearDay1();
    await say(MIKE, DM[MIKE], "japlan plans");
    expect(last(DM[MIKE])).toBe(
      `that's ${REFILLS_PER_DAY} refills for today already, plenty for one day.\nnext day's board is yours whenever.`,
    );
    // Other days are never limited by it.
    await say(MIKE, DM[MIKE], "japlan tomorrow");
    expect(last(DM[MIKE])).toMatch(/^Day 2, might still change( · [^\n]+)?\n/);
  });
});

describe("day planning", () => {
  it("stores each task's time of day and duration, in route order", async () => {
    seedTrip({});
    at("2026-09-19T07:00:00"); // before board_time: the whole day ahead
    await say(MIKE, DM[MIKE], "japlan plans");
    const rows = (tasksOn(1) as { code: string; slot: string; duration_minutes: number }[]).sort(
      (a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((t) => ["morning", "afternoon", "evening"].includes(t.slot))).toBe(true);
    expect(rows.every((t) => t.duration_minutes >= 20)).toBe(true); // no sidequests on the board
    const order = { morning: 0, afternoon: 1, evening: 2 } as Record<string, number>;
    const slots = rows.map((t) => order[t.slot]);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(last(DM[MIKE])).toMatch(/\nmorning {4}A1 · /);
  });

  it("stores a curveball as source curveball when one lands", async () => {
    const { isCurveballBoard } = await import("@/lib/game/generate");
    const day = [1, 2, 3, 4, 5].find((d) => isCurveballBoard(`trip-1:${d}:together`));
    expect(day).toBeDefined();
    seedTrip({});
    await say(MIKE, DM[MIKE], `japlan day ${day}`);
    const curveballs = tasksOn(day!).filter((t) => t.source === "curveball");
    expect(curveballs).toHaveLength(1);
    expect(curveballs[0].title).toMatch(/bowing vending machine/);
  });
});

describe("in a group", () => {
  it("DMs the asker's board and tells the group so", async () => {
    seedTrip({ solo: false });
    at("2026-09-19T06:00:00"); // before board_time
    await say(MIKE, GROUP, "japlan plans");
    expect(last(GROUP)).toBe("board's in your dms 📩");
    expect(last(DM[MIKE])).toMatch(/^Day 1/);
    expect(to(DM[SAM])).toEqual([]); // Sam's arrives at board_time
    expect(board(1)?.delivered_at ?? null).toBeNull();

    // The 08:00 tick delivers to Sam, not Mike again, and posts standings.
    // Day 1 is a saturday, so the group also gets the one multiplier
    // announcement for the day, before the standings.
    at("2026-09-19T08:05:00");
    h.sent.length = 0;
    await runDailyBoards({});
    expect(to(DM[SAM])).toHaveLength(1);
    expect(to(DM[MIKE])).toHaveLength(0);
    expect(to(GROUP)).toHaveLength(2);
    expect(to(GROUP)[0]).toContain("everything on the board is worth 1.25x");
    expect(to(GROUP)[1]).toMatch(/^Day 1/);
    expect(board(1)?.delivered_at).toBeTruthy();
  });

  it("delivers to everyone at once when asked after board_time", async () => {
    seedTrip({ solo: false });
    at("2026-09-19T12:00:00"); // after 08:00, no board made
    await say(MIKE, GROUP, "japlan plans");
    expect(to(DM[SAM])).toHaveLength(1); // not left waiting for tomorrow's tick
    expect(board(1)?.delivered_at).toBeTruthy();
  });

  it("adds someone new to the chat instead of telling them they aren't on the trip", async () => {
    seedTrip({ solo: false });
    await say(ANA, GROUP, "japlan plans");
    const ana = h.db.table("participants").find((p) => p.phone === ANA);
    expect(ana).toMatchObject({ display_name: "Ana" });
    expect(to(DM[ANA]).length).toBeGreaterThan(0); // their survey started
    expect(h.sent.some((m) => /not on this trip|aren't on/.test(m.text))).toBe(false);

    // Until they answer, their own tasks can't be checked against their
    // allergies, so they are asked to finish; everyone else's board is made.
    await say(ANA, GROUP, "japlan plans");
    expect(last(GROUP)).toBe(finishYourSurveyLine());
    await say(MIKE, GROUP, "japlan plans");
    expect(last(DM[MIKE])).toMatch(/^Day 1( · [^\n]+)?\n/);
    expect(tasksOn(1).some((t) => t.participant_id === ana!.id)).toBe(false);
    expect(tasksOn(1).some((t) => t.participant_id === "p-mike")).toBe(true);
  });

  it("accepts a claim sent by DM on a group trip and confirms it in both places", async () => {
    seedTrip({ solo: false });
    h.db.seed("tasks", [
      {
        id: "t-honor", trip_id: "trip-1", participant_id: "p-mike", team_id: null, code: "A1",
        title: "say hi to a shopkeeper", tier: "Light", axes_json: {}, base_points: 8,
        photo_bonus_max: 0, verification: "honor", day: 1,
      },
    ]);
    await say(MIKE, DM[MIKE], "A1");
    expect(h.db.table("claims")).toHaveLength(1);
    expect(last(GROUP)).toMatch(/Mike/);
    expect(to(DM[MIKE]).length).toBeGreaterThan(0);
    expect(h.sent.some((m) => /claim it in the group/.test(m.text))).toBe(false);
  });

  it("answers every addressed message, with no hourly cap", async () => {
    seedTrip({ solo: false });
    for (let i = 0; i < 8; i++) await say(MIKE, GROUP, `japlan quick question ${i}`);
    expect(to(GROUP)).toHaveLength(8);
    expect(h.sent.some((m) => /slow down|a lot of questions|hour/.test(m.text))).toBe(false);
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
    expect(last(GROUP)).toBe("boards now land at 7am every morning 🫡");

    await say(SAM, GROUP, "japlan board time 10:30");
    expect(last(GROUP)).toBe("only Mike can change the board time, that's the rule lol.");
    expect(h.db.table("trips")[0].board_time).toBe("07:00");

    await say(MIKE, GROUP, "japlan board time whenever");
    expect(last(GROUP)).toMatch(/^couldn't read that time lol\./);
  });
});
