import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Finishing the survey when the board cannot be made: the old line, never
// nothing, and still one message.

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

vi.mock("./board-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./board-request")>()),
  // Generation failed, for whatever reason.
  boardForNewlyReady: vi.fn(async () => null),
}));

import { dispatchLinqEvent } from "./dispatch";
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

describe("finishing the survey when the board cannot be made", () => {
  it("falls back to the old line, with the sidequest question, in one message", async () => {
    seed();
    await finish("mike");
    expect(to(DM.mike)).toEqual([
      expect.stringMatching(/^done\. you're less mysterious than you think\. your first board drops in the morning\.\n\nbtw i'm turning on sidequests/),
    ]);
  });
});
