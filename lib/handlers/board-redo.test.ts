import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import { isBoardRequest, isRedoRequest } from "@/lib/game/board-schedule";

// "Japlan keeps sending me the same board." Live, 2026-09-19: "give me seven
// completely new tasks" matched the board request and resent the stored
// board; "completely different itinerary" went to request_tasks, which only
// tops up. A request for a different board now replaces it.

const PHONES = { mike: "+15550000001", sam: "+15550000002" };
const GROUP = "chat-group";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  prompts: [] as string[],
  n: 0,
  modelCalls: 0,
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
  shareContactCardSafely: vi.fn(async () => {}),
}));
vi.mock("@/lib/places/foursquare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/places/foursquare")>()),
  resolveNearArea: vi.fn(async () => null),
  searchPlaces: vi.fn(async () => {
    throw new Error("no credits");
  }),
}));
vi.mock("@/lib/game/weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/game/weather")>()),
  fetchDayWeather: vi.fn(async () => ({ temperatureC: 20, precipitationChance: 0, summary: "clear", indoorPreferred: false })),
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class FakeModel {
    // Every generation proposes titles it has never used before.
    async complete(opts: { schema?: { type?: string }; system?: string; messages?: { content: string }[] }) {
      if (opts.schema?.type !== "array") return "";
      h.prompts.push([opts.system ?? "", ...(opts.messages ?? []).map((m) => m.content)].join("\n"));
      const picks = [
        ["stranger_best_rec", "Asakusa"],
        ["wrong_train", ""],
        ["order_unreadable", "Ueno"],
        ["oldest_thing", "Yanaka"],
        ["buy_keep", ""],
        ["highest_point", "Shibuya"],
      ] as const;
      return JSON.stringify(
        picks.map(([template, place]) => {
          h.n += 1;
          return {
            template,
            title: `${template.replace(/_/g, " ")} ${h.n}`,
            axes: { boldness: 3, physical: 1, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
            verification: "honor",
            photo_bonus_max: 2,
            neighborhood: place,
            places: place ? [place] : [],
            involves_stranger: template === "stranger_best_rec",
          };
        }),
      );
    }
    async completeTurn() {
      h.modelCalls += 1;
      return { text: "ok", functionCalls: [] };
    }
  }
  return { ...actual, GeminiProvider: FakeModel, matchClaimText: vi.fn(async () => null) };
});

import { dispatchLinqEvent } from "./dispatch";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";

let evt = 0;
async function say(who: keyof typeof PHONES, text: string, chatId = GROUP) {
  evt += 1;
  await dispatchLinqEvent({
    event_id: `evt-${evt}`,
    event_type: "message.received",
    data: {
      id: `msg-${evt}`,
      chat_id: chatId,
      chat: { id: chatId, is_group: chatId === GROUP },
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who === "mike" ? "Mike" : "Sam" },
      parts: [{ type: "text", value: text }],
    },
  });
}
const dmOf = (who: keyof typeof PHONES) => `dm:${PHONES[who]}`;
const lastIn = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).at(-1)?.text;
const mine = () => h.db.table("tasks").filter((t) => t.participant_id === "p-mike");

function seed() {
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
      is_solo: false,
      board_time: "08:00",
      setup_state: "done",
      destination_profile_json: TOKYO_HAND_PROFILE,
      intro_sent_at: "2026-09-18T00:00:00Z",
      organizer_participant_id: "p-mike",
      category_weights: {},
    },
  ]);
  h.db.seed(
    "participants",
    Object.entries(PHONES).map(([who, phone]) => ({
      id: `p-${who}`,
      trip_id: "trip-1",
      phone,
      display_name: who === "mike" ? "Mike" : "Sam",
      survey_state: "done",
      survey_json: { sociability: { value: "love_it" } },
    })),
  );
}

let info: ReturnType<typeof vi.spyOn>;
const steps = () =>
  info.mock.calls.filter((c: unknown[]) => c[0] === "[japlan.board] step").map((c: unknown[]) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T09:00:00+09:00"));
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.prompts.length = 0;
  h.modelCalls = 0;
  info = vi.spyOn(console, "info");
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("which messages ask for a different board", () => {
  it("matches the ways people say it, including the live ones", () => {
    for (const text of [
      "japlan redo today",
      "japlan different tasks",
      "these are boring, give me new ones japlan",
      "japlan I want something else",
      "japlan give me seven completely new tasks",
      "Can you give me a completely different itenerary for day 1 japlan",
      "japlan reroll",
      "japlan i don't like these tasks",
    ]) {
      expect(isRedoRequest(text), text).toBe(true);
    }
  });

  it("leaves showing the board, and ordinary talk, alone", () => {
    for (const text of ["japlan plans", "japlan show me my tasks", "japlan i want something else to eat", "japlan we loved new york"]) {
      expect(isRedoRequest(text), text).toBe(false);
    }
    expect(isBoardRequest("japlan plans")).toBe(true);
  });
});

describe("asking for a different board", () => {
  it("replaces the unclaimed tasks with new ones, keeps claimed ones, and says what changed", async () => {
    await say("mike", "japlan plans");
    const before = mine();
    expect(before.length).toBeGreaterThan(2);
    // One claimed task: it must survive.
    h.db.seed("claims", [{ task_id: before[0].id, participant_id: "p-mike", status: "awarded", awarded_points: 10 }]);
    const oldTitles = before.slice(1).map((t) => t.title);

    await say("mike", "japlan give me seven completely new tasks");
    expect(lastIn(GROUP)).toBe("board's in your dms 📩");
    const reply = lastIn(dmOf("mike"))!;
    expect(reply).toMatch(new RegExp(`^fresh board: ${oldTitles.length} out, \\d+ new, kept ${before[0].code} since you claimed it\\.`));
    const after = mine();
    expect(after.some((t) => t.id === before[0].id)).toBe(true);
    for (const title of oldTitles) expect(after.map((t) => t.title)).not.toContain(title);
    // Routed by the matcher, not by a model guessing a tool.
    expect(h.modelCalls).toBe(0);
    // The generator was told this is a retry, and what not to repeat.
    const retry = h.prompts.at(-1)!;
    expect(retry).toMatch(/They asked for a different board\. This is a retry/);
    for (const title of oldTitles) expect(retry).toContain(title);
    expect(steps().some((s) => s.step === "redo.regenerated" && s.repeated === 0)).toBe(true);
  });

  it("says why when every task is claimed, instead of resending the list", async () => {
    await say("mike", "japlan plans");
    h.db.seed(
      "claims",
      mine().map((t) => ({ task_id: t.id, participant_id: "p-mike", status: "awarded", awarded_points: 10 })),
    );
    await say("mike", "japlan these are boring, give me new ones", dmOf("mike"));
    expect(lastIn(dmOf("mike"))).toBe(
      "every task on today's board is already claimed, so there's nothing left to swap. want more on top? say how many.",
    );
    expect(steps().some((s) => s.step === "redo.refused" && s.reason === "all_claimed")).toBe(true);
  });

  it("allows five redos of a day, then says so out loud", async () => {
    await say("mike", "japlan plans");
    for (let i = 0; i < 5; i++) {
      await say("mike", "japlan redo today", dmOf("mike"));
      expect(lastIn(dmOf("mike"))).toMatch(/^fresh board:/);
    }
    await say("mike", "japlan redo today", dmOf("mike"));
    expect(lastIn(dmOf("mike"))).toBe("that's 5 redos of today already, so this one stays as it is. next day's board is fresh.");
    expect(steps().some((s) => s.step === "redo.refused" && s.reason === "rate_limit")).toBe(true);
  });

  it("logs a plain request to see the board as served_existing", async () => {
    await say("mike", "japlan plans");
    await say("mike", "japlan plans");
    expect(steps().some((s) => s.step === "list" && s.path === "served_existing")).toBe(true);
  });
});
