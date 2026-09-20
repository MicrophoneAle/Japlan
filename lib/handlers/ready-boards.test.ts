import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SURVEY_DONE_DM } from "@/lib/game/copy";
import { QUESTIONS } from "@/lib/game/survey-questions";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// A person gets a board the moment THEY are ready; someone still answering
// gets their next question instead. Same rule, two sides of it. Plus the
// sweep for messages whose dispatch never finished.

const PHONES = { mike: "+15550000001", sam: "+15550000002" };
const GROUP = "chat-group";
const DM = { mike: "dm:+15550000001", sam: "dm:+15550000002" };

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  n: 0,
}));

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
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class FakeModel {
    async complete(opts: { schema?: { type?: string } }) {
      if (opts.schema?.type !== "array") return "";
      return JSON.stringify(
        ["wrong_train", "oldest_thing", "buy_keep", "stranger_best_rec"].map((template) => {
          h.n += 1;
          return {
            template,
            title: `${template.replace(/_/g, " ")} ${h.n}`,
            axes: { boldness: 3, physical: 1, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
            verification: "honor",
            photo_bonus_max: 1,
            neighborhood: "",
            places: [],
            involves_stranger: template === "stranger_best_rec",
          };
        }),
      );
    }
    async completeTurn() {
      return { text: "ok", functionCalls: [] };
    }
  }
  return { ...actual, GeminiProvider: FakeModel, matchClaimText: vi.fn(async () => null), judgeRelevance: vi.fn(async () => null) };
});

import { dispatchLinqEvent } from "./dispatch";
import { runDailyBoards } from "./daily-board";
import { sweepStalledEvents } from "./event-sweep";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";

let evt = 0;
function envelope(who: keyof typeof PHONES, text: string, chatId: string) {
  evt += 1;
  return {
    event_id: `evt-${evt}`,
    event_type: "message.received",
    data: {
      id: `msg-${evt}`,
      chat_id: chatId,
      chat: { id: chatId, is_group: chatId === GROUP },
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who === "mike" ? "Mike" : "Sam" },
      parts: [{ type: "text", value: text }],
    },
  };
}
const say = (who: keyof typeof PHONES, text: string, chatId: string) => dispatchLinqEvent(envelope(who, text, chatId));
const to = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
const person = (who: keyof typeof PHONES) => h.db.table("participants").find((p) => p.id === `p-${who}`)!;
const trip = () => h.db.table("trips")[0];
const at = (local: string) => vi.setSystemTime(new Date(`${local}+09:00`));

// Answering the last survey question ("yes" to splitting) finishes it.
async function finish(who: keyof typeof PHONES) {
  person(who).survey_state = "splitting";
  person(who).survey_json = { ab_food_outdoors: { value: "a" } };
  await say(who, "yes", DM[who]);
}

function seed(opts: { state?: string; mike?: string; sam?: string } = {}) {
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: GROUP,
      name: "tokyo",
      destination: "Tokyo",
      start_date: "2026-09-19",
      end_date: "2026-09-23",
      state: opts.state ?? "surveying",
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
  h.db.seed("participants", [
    { id: "p-mike", trip_id: "trip-1", phone: PHONES.mike, display_name: "Mike", survey_state: opts.mike ?? "ab_pace", survey_json: {} },
    { id: "p-sam", trip_id: "trip-1", phone: PHONES.sam, display_name: "Sam", survey_state: opts.sam ?? "ab_pace", survey_json: {} },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-09-19T10:00:00");
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("finishing the survey", () => {
  it("goes live on the first finisher, and their reply is the close, their board, then the sidequest question", async () => {
    seed();
    await finish("mike");
    expect(trip().state).toBe("active");
    // The group hears that someone finished and who is left, never a word of
    // what anyone answered, then that the trip is live.
    expect(to(GROUP)).toHaveLength(2);
    expect(to(GROUP)[0]).toMatch(/Mike finished/);
    expect(to(GROUP)[0]).toMatch(/still waiting on: Sam/);
    expect(to(GROUP)[1]).toMatch(/^we're live/);
    // One DM carrying all three things: the close, the board, the sidequest
    // question. One message, never two.
    expect(to(DM.mike)).toHaveLength(1);
    expect(to(DM.mike)[0]).toContain(SURVEY_DONE_DM);
    expect(to(DM.mike)[0]).toContain("Day 1");
    expect(to(DM.mike)[0]).toMatch(/btw i'm turning on sidequests/);
    // Per person: Sam, still answering, gets nothing, and has no tasks.
    expect(to(DM.sam)).toEqual([]);
    expect(h.db.table("tasks").some((t) => t.participant_id === "p-sam")).toBe(false);
    expect(h.db.table("board_requests").map((r) => r.participant_id)).toEqual(["p-mike"]);
  });

  it("a later finisher gets their own board on the spot, and nobody else hears about it", async () => {
    seed({ state: "active", mike: "done" });
    await finish("mike"); // makes the day's board
    h.sent.length = 0;
    await finish("sam");
    expect(to(DM.sam)).toHaveLength(1);
    expect(to(DM.sam)[0]).toContain(SURVEY_DONE_DM);
    expect(to(DM.sam)[0]).toContain("Day 1");
    expect(to(DM.sam)[0]).toMatch(/btw i'm turning on sidequests/);
    // Nobody else gets Sam's board, and Mike hears nothing at all. The group
    // gets the progress line only: who finished, who is left, no answers.
    expect(to(DM.mike)).toEqual([]);
    expect(to(GROUP)).toHaveLength(1);
    expect(to(GROUP)[0]).toMatch(/Sam finished/);
    expect(to(GROUP)[0]).toMatch(/preferences stay private/);
    expect(to(GROUP)[0]).not.toContain("Day 1");
    expect(to(GROUP)[0]).not.toContain("A1");
  });

  it("the morning cron sees the board exists and does not send it again", async () => {
    at("2026-09-19T06:00:00"); // before board time
    seed();
    await finish("mike");
    const mikeBefore = to(DM.mike).length;
    at("2026-09-19T08:05:00");
    await runDailyBoards({});
    expect(to(DM.mike)).toHaveLength(mikeBefore);
  });
});

describe("at board time, for people still answering", () => {
  it("nudges each with their next question, once a day, and no board", async () => {
    seed({ state: "active", mike: "done" });
    at("2026-09-19T08:05:00");
    await runDailyBoards({});
    // Sam's next unanswered question, and nothing else: no board, no nudge
    // about the nudge.
    expect(to(DM.sam)).toHaveLength(1);
    expect(to(DM.sam)[0]).toBe(QUESTIONS.ab_pace.prompt);
    await runDailyBoards({});
    expect(to(DM.sam)).toHaveLength(1);
    // Mike, finished, got a board.
    expect(to(DM.mike).some((t) => /^Day 1/.test(t))).toBe(true);
  });

  it("when nobody has finished, tells the group who it is waiting on, once", async () => {
    seed();
    at("2026-09-19T08:05:00");
    await runDailyBoards({});
    expect(to(GROUP)).toEqual([
      "boards start as soon as someone finishes the quick questions in their dm.\nwaiting on Mike and Sam.",
    ]);
    expect(to(DM.mike)).toHaveLength(1);
    expect(to(DM.sam)).toHaveLength(1);
    expect(trip().state).toBe("surveying");
    at("2026-09-20T08:05:00");
    await runDailyBoards({});
    expect(to(GROUP)).toHaveLength(1);
    // A new day: one more nudge each.
    expect(to(DM.sam)).toHaveLength(2);
  });

  it("goes live at board time if someone finished and nothing activated it", async () => {
    seed({ mike: "done" });
    at("2026-09-19T08:05:00");
    await runDailyBoards({});
    expect(trip().state).toBe("active");
    expect(to(GROUP)[0]).toMatch(/^we're live/);
    expect(to(GROUP).some((t) => /waiting on/.test(t))).toBe(false);
  });
});

describe("messages whose dispatch never finished", () => {
  function stalled(minutesAgo: number, text: string) {
    const env = envelope("mike", text, GROUP);
    h.db.seed("events", [
      {
        linq_event_id: env.event_id,
        type: "message.received",
        payload: env,
        processed_at: null,
        retried_at: null,
        created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      },
    ]);
  }

  it("re-dispatches a recent one once, logs an old one as dropped, and never handles either twice", async () => {
    seed({ state: "active", mike: "done", sam: "done" });
    stalled(5, "japlan lb");
    stalled(120, "japlan test");
    const warn = vi.spyOn(console, "warn");
    const first = await sweepStalledEvents({ force: true });
    expect(first).toEqual({ retried: 1, dropped: 1 });
    expect(to(GROUP)).toHaveLength(1); // the standings, for the recent one only
    expect(warn.mock.calls.some((c) => c[0] === "[japlan.webhook] dropped")).toBe(true);
    const second = await sweepStalledEvents({ force: true });
    expect(second).toEqual({ retried: 0, dropped: 0 });
    expect(to(GROUP)).toHaveLength(1);
  });
});
