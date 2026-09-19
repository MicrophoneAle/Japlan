import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// handleConversation, end to end through dispatchLinqEvent. Faked edges only:
// Supabase in memory, Linq sends/reactions (recorded, not transmitted), web
// search, and the Gemini turn itself (scripted per test). These tests do not
// judge the model's writing (that needs a live model and a human), only the
// mechanical guarantees around it: addressed messages always produce a real
// reply, a tool that already sent its own reply never gets a second one from
// the model, deterministic paths like the leaderboard never touch the model
// at all, and a tool result (including a failed search) reaches the model
// faithfully instead of being invented or dropped.

const PHONES = { maya: "+15550000001", sam: "+15550000002" };
const GROUP = "chat-group";
const DM = { maya: "dm-maya", sam: "dm-sam" };

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  reactions: [] as { messageId: string; reaction: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  toolResponses: [] as unknown[],
  reply: "ok",
  turnCalls: 0,
  relevance: vi.fn(),
  searchWeb: vi.fn(),
}));

vi.mock("@/lib/game/weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/game/weather")>()),
  fetchDayWeather: vi.fn(async () => ({ temperatureC: 20, precipitationChance: 0, summary: "clear", indoorPreferred: false })),
}));
vi.mock("@/lib/places/foursquare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/places/foursquare")>()),
  resolveNearArea: vi.fn(async () => null),
  searchPlaces: vi.fn(async () => {
    throw new Error("no credits");
  }),
}));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => {
  const out = (chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    h.db.seed("chat_messages", [{ chat_id: chatId, role: "bot", sender_handle: null, sender_name: null, text }]);
    return { chatId, messageId: `out-${h.sent.length}` };
  };
  return {
    sendText: vi.fn(async (chatId: string, text: string) => out(chatId, text)),
    sendDM: vi.fn(async (phone: string, text: string) =>
      out(phone === PHONES.maya ? DM.maya : phone === PHONES.sam ? DM.sam : `dm:${phone}`, text),
    ),
    markRead: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    react: vi.fn(async (messageId: string, reaction: unknown) => {
      h.reactions.push({ messageId, reaction });
    }),
  };
});
vi.mock("@/lib/handlers/web-search", () => ({ searchTheWeb: h.searchWeb }));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class FakeModel {
    async completeTurn(opts: { contents: { parts: { functionResponse?: unknown }[] }[] }) {
      h.turnCalls += 1;
      const responses = opts.contents.flatMap((c) =>
        c.parts.flatMap((p) => (p.functionResponse ? [(p.functionResponse as { response: unknown }).response] : [])),
      );
      h.toolResponses.push(...responses);
      const answered = responses.length > 0;
      const next = answered ? undefined : h.calls.shift();
      return next
        ? { text: "", functionCalls: [{ id: "c1", name: next.name, args: next.args }] }
        : { text: h.reply, functionCalls: [] };
    }
  }
  return {
    ...actual,
    GeminiProvider: FakeModel,
    matchClaimText: vi.fn(async () => null),
    judgeStillEngaged: vi.fn(async () => null),
    judgeShouldJoin: vi.fn(async () => null),
    judgeRelevance: h.relevance,
  };
});

import { dispatchLinqEvent } from "./dispatch";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";
import { CONVERSATION_FALLBACK } from "@/lib/game/copy";

let evt = 0;
let clock = 0;
async function say(who: keyof typeof PHONES, text: string, chatId: string = GROUP) {
  evt += 1;
  clock += 1000;
  vi.setSystemTime(new Date(Date.parse("2026-09-19T09:00:00+09:00") + clock));
  await dispatchLinqEvent({
    event_id: `evt-${evt}`,
    event_type: "message.received",
    data: {
      id: `msg-${evt}`,
      chat_id: chatId,
      chat: { id: chatId, is_group: chatId === GROUP },
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who === "maya" ? "Maya" : "Sam" },
      parts: [{ type: "text", value: text }],
    },
  });
}
const lastIn = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).at(-1)?.text;
const sentTo = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).map((m) => m.text);

function seed(opts: { mayaScore?: number; samScore?: number } = {}) {
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
      organizer_participant_id: "p-sam",
      category_weights: {},
    },
  ]);
  h.db.seed("participants", [
    { id: "p-maya", trip_id: "trip-1", phone: PHONES.maya, display_name: "Maya", survey_state: "done", survey_json: {}, score: opts.mayaScore ?? 0 },
    { id: "p-sam", trip_id: "trip-1", phone: PHONES.sam, display_name: "Sam", survey_state: "done", survey_json: {}, score: opts.samScore ?? 0 },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = 0;
  vi.setSystemTime(new Date("2026-09-19T09:00:00+09:00"));
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.reactions.length = 0;
  h.calls.length = 0;
  h.toolResponses.length = 0;
  h.reply = "ok";
  h.turnCalls = 0;
  h.relevance.mockReset().mockResolvedValue(null);
  h.searchWeb.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the leaderboard command never touches the model", () => {
  it("answers straight from the database", async () => {
    seed({ mayaScore: 30, samScore: 90 });
    await say("sam", "japlan leaderboard");
    expect(h.turnCalls).toBe(0);
    const board = lastIn(GROUP) ?? "";
    expect(board).toMatch(/sam.*90/i);
    expect(board).toMatch(/maya.*30/i);
    expect(board.indexOf("sam")).toBeLessThan(board.toLowerCase().indexOf("maya"));
  });
});

describe("search_web plumbing", () => {
  it("passes real results through to the model untouched", async () => {
    seed();
    h.searchWeb.mockResolvedValue({ ok: true, results: [{ title: "Ichiran Shibuya", url: "https://ichiran.example/shibuya" }] });
    h.calls.push({ name: "search_web", args: { query: "ramen shibuya" } });
    h.reply = "ichiran in shibuya, link's in the last text";
    await say("sam", "japlan where's good ramen nearby");
    expect(h.searchWeb).toHaveBeenCalledWith("ramen shibuya");
    expect(h.toolResponses).toContainEqual({ ok: true, results: [{ title: "Ichiran Shibuya", url: "https://ichiran.example/shibuya" }] });
    expect(lastIn(GROUP)).toBe(h.reply);
  });

  it("reports a failed search plainly instead of letting the model invent one", async () => {
    seed();
    h.searchWeb.mockResolvedValue({ ok: false, reason: "no_results" });
    h.calls.push({ name: "search_web", args: { query: "michelin star izakaya nowhereville" } });
    h.reply = "couldn't find a real one, wanna just wing it nearby instead";
    await say("sam", "japlan find me a michelin izakaya in the middle of nowhere");
    expect(h.toolResponses).toContainEqual({ ok: false, reason: "no_results" });
    // The model never gets to claim it found something when the tool came up empty.
    expect(lastIn(GROUP)).toBe(h.reply);
  });
});

describe("a tool that already replied is never followed by a second, model-written reply", () => {
  it("sends exactly one message for a settings change", async () => {
    seed();
    h.calls.push({ name: "update_my_setting", args: { setting: "pace", value: "faster" } });
    await say("maya", "japlan pace faster", DM.maya);
    expect(sentTo(DM.maya)).toHaveLength(1);
    expect(lastIn(DM.maya)).not.toBe(CONVERSATION_FALLBACK);
  });
});

describe("an addressed message always gets a real reply", () => {
  it("falls back rather than sending nothing when the model returns empty text", async () => {
    seed();
    h.reply = "";
    await say("maya", "japlan just checking you're there", DM.maya);
    expect(sentTo(DM.maya)).toHaveLength(1);
    expect(lastIn(DM.maya)).toBe(CONVERSATION_FALLBACK);
  });
});

describe("react_to_message", () => {
  it("tapbacks the inbound message and still sends the turn's text", async () => {
    seed();
    h.calls.push({ name: "react_to_message", args: { emoji: "💀" } });
    h.reply = "respectfully, no";
    await say("sam", "japlan i'm going to eat 12 conveyor belt plates and call it a task");
    expect(h.reactions).toHaveLength(1);
    expect(h.reactions[0].reaction).toEqual({ emoji: "💀" });
    expect(lastIn(GROUP)).toBe(h.reply);
  });
});
