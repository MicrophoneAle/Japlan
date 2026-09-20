import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import type { ToolContent } from "@/lib/llm";

// A live solo run, end to end through dispatchLinqEvent. Faked edges only:
// Supabase (in memory), Linq sends, Foursquare `near`, and Gemini.

const ME = "+15550000009";
const DM = "dm-solo";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  turns: [] as { contents: ToolContent[]; toolMode: string }[],
  script: [] as unknown[],
  modelCalls: 0,
  shareContactCard: vi.fn(async () => {}),
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
  // A solo player's DM chat is the trip chat.
  sendDM: vi.fn(async (_phone: string, text: string) => {
    h.sent.push({ chatId: DM, text });
    return { chatId: DM, messageId: `out-${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
  react: vi.fn(async () => {}),
  shareContactCardSafely: h.shareContactCard,
}));
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { search: vi.fn(async () => ({ results: [] })) },
}));
vi.mock("@/lib/places/foursquare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/places/foursquare")>()),
  resolveNearArea: vi.fn(async () => null), // out of credits
  searchPlaces: vi.fn(async () => {
    throw new Error("foursquare out of credits");
  }),
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  // Every model call is counted; completeTurn follows h.script.
  class ScriptedProvider {
    async complete() {
      h.modelCalls += 1;
      return "";
    }
    async completeTurn(opts: { contents: ToolContent[]; toolMode: string }) {
      h.modelCalls += 1;
      h.turns.push({ contents: JSON.parse(JSON.stringify(opts.contents)), toolMode: opts.toolMode });
      return h.script.shift() ?? { text: "ok", functionCalls: [] };
    }
  }
  return {
    ...actual,
    GeminiProvider: ScriptedProvider,
    inferPlaceTimezone: vi.fn(async () => {
      h.modelCalls += 1;
      throw new Error("model down");
    }),
    extractTripDates: vi.fn(async () => {
      h.modelCalls += 1;
      throw new Error("model down");
    }),
    matchClaimText: vi.fn(async () => {
      h.modelCalls += 1;
      return null;
    }),
  };
});

import { dispatchLinqEvent } from "./dispatch";
import { runDailyBoardForTrip } from "./daily-board";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";
import type { TripRow } from "@/lib/db/types";
import { browserbase } from "@browserbasehq/stagehand";

let n = 0;
async function say(text: string) {
  n += 1;
  await dispatchLinqEvent({
    event_id: `evt-${n}`,
    event_type: "message.received",
    data: {
      id: `msg-${n}`,
      chat_id: DM,
      chat: { id: DM, is_group: false },
      sender_handle: { handle: ME, is_me: false, display_name: "Mike" },
      parts: [{ type: "text", value: text }],
    },
  });
}
const trip = () => h.db.table("trips")[0];
const last = () => h.sent.at(-1)?.text;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T03:00:00Z")); // noon in Tokyo
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "true";
  process.env.BROWSERBASE_API_KEY = "test-key";
  vi.mocked(browserbase.search).mockReset().mockResolvedValue({ query: "", requestId: "req-0", results: [] });
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.turns.length = 0;
  h.script.length = 0;
  h.modelCalls = 0;
  h.shareContactCard.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function soloThroughSetup() {
  await say("japlan solo");
  await say("Tokyo");
  await say("Oct 17-20");
  await say("chill");
}

describe("solo setup and survey", () => {
  it("asks three setup questions, no stake, and no group questions", async () => {
    await say("japlan solo");
    expect(last()).toMatch(/^trip setup, 3 quick ones\. ok where we headed\?/);
    expect(h.shareContactCard).toHaveBeenCalledWith(DM);
    await say("Tokyo");
    await say("Oct 17-20");
    await say("chill");
    // Solo folds the setup close and the survey opening into one message:
    // this DM is the trip chat, so there is nowhere else to put it.
    expect(last()).toMatch(/^chill, noted\. setup's done, we're so back\./);
    expect(last()).toMatch(/replies stay in this dm/);
    expect(last()).toMatch(/what should i call you\?$/);
    expect(trip().setup_state).toBe("done");
    expect(trip().stake_text ?? null).toBeNull();

    const surveyStart = h.sent.length;
    for (let i = 0; i < 25 && trip().state !== "active"; i++) await say("skip");
    const surveyText = h.sent.slice(surveyStart).map((m) => m.text).join("\n");
    expect(surveyText).not.toMatch(/group splits|travelled with|as a couple|here to win/);
    expect(surveyText).not.toMatch(/PLACEHOLDER|reply skip to skip/i);
    expect(trip().state).toBe("active");
    // One closing message: the close and "we're live", then their day 1
    // board (the trip has not started, so marked as provisional), then the
    // sidequest question last, so their next reply answers it.
    expect(last()).toMatch(
      /^done\. you're less mysterious than you think\. we're live 🔥 every morning your tasks land in your dms, and a code like A1 claims one\. first board drops oct 17 at 8am\.\n\nDay 1, might still change[\s\S]+\n\nbtw i'm turning on sidequests\./,
    );
    const surveyAsked = h.sent.slice(surveyStart).length;
    // At most eight questions, then the close.
    expect(surveyAsked).toBeLessThanOrEqual(9);
    expect(h.sent.filter((m) => /we're live/.test(m.text))).toHaveLength(1);
  });
});

describe("asking for the day's plan", () => {
  it("shows day 1 before the trip starts instead of refusing", async () => {
    await soloThroughSetup();
    for (let i = 0; i < 25 && trip().state !== "active"; i++) await say("skip");
    trip().destination_profile_json = TOKYO_HAND_PROFILE;

    // The trip (oct 17-20) has not started: "the plans" means its first day.
    await say("Please give me the first day plans");
    expect(last()).toMatch(/^Day 1, might still change( · [^\n]+)?\n/);
    expect(last()).not.toMatch(/starts|scheduled|timezone/);
    expect(h.sent.some((m) => /something broke/.test(m.text))).toBe(false);
  });

  it("lists today's open tasks once a board exists", async () => {
    await soloThroughSetup();
    for (let i = 0; i < 25 && trip().state !== "active"; i++) await say("skip");
    const me = h.db.table("participants")[0];
    trip().start_date = "2026-09-19"; // the trip is underway today
    h.db.seed("tasks", [
      {
        trip_id: trip().id, participant_id: me.id, team_id: null, code: "A1",
        title: "eat something starting with a-d", tier: "Light", axes_json: {},
        base_points: 8, photo_bonus_max: 2, verification: "honor", day: 1,
      },
    ]);
    await say("what's on the board?");
    expect(last()).toContain("A1 · eat something starting with a-d\n   light · 8 pts");
  });
});

describe("solo morning board", () => {
  it("sends the board only, no one-person standings post", async () => {
    await soloThroughSetup();
    for (let i = 0; i < 25 && trip().state !== "active"; i++) await say("skip");
    trip().destination_profile_json = TOKYO_HAND_PROFILE;
    vi.setSystemTime(new Date("2026-09-19T23:00:00Z")); // 8am Tokyo
    h.sent.length = 0;

    await runDailyBoardForTrip(trip() as TripRow);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].text).toMatch(/^Day /);
    expect(h.sent[0].text).not.toMatch(/Mike \d+ ·|standings/i);
  });
});

describe("conversation tool loop", () => {
  it("replays each tool call with its thought signature", async () => {
    await soloThroughSetup();
    for (let i = 0; i < 25 && trip().state !== "active"; i++) await say("skip");
    h.script.push(
      {
        text: "",
        functionCalls: [{ id: "c1", name: "get_standings", args: {}, thoughtSignature: "sig-abc" }],
      },
      { text: "you're on 0, nobody to beat yet.", functionCalls: [] },
    );
    await say("japlan how am i doing");

    expect(h.turns).toHaveLength(2);
    const replayed = h.turns[1].contents.find((c) => c.role === "model");
    expect(replayed?.parts[0]).toEqual({
      functionCall: { id: "c1", name: "get_standings", args: {}, thoughtSignature: "sig-abc" },
    });
    expect(last()).toBe("you're on 0, nobody to beat yet.");
  });

  it("calls search_web for a real place question and answers with what it returns", async () => {
    await soloThroughSetup();
    for (let i = 0; i < 25 && trip().state !== "active"; i++) await say("skip");
    vi.mocked(browserbase.search).mockResolvedValue({
      query: "teriyaki restaurants osaka",
      requestId: "req-1",
      results: [{ id: "r1", title: "Teriyaki House Momiji", url: "https://example.com/momiji" }],
    });
    h.script.push(
      {
        text: "",
        functionCalls: [{ id: "c1", name: "search_web", args: { query: "teriyaki restaurants osaka" } }],
      },
      { text: "teriyaki house momiji looks solid: https://example.com/momiji", functionCalls: [] },
    );
    await say("japlan any good teriyaki spots in osaka?");

    expect(browserbase.search).toHaveBeenCalledWith({
      apiKey: "test-key",
      query: "teriyaki restaurants osaka",
      numResults: 5,
    });
    expect(last()).toBe("teriyaki house momiji looks solid: https://example.com/momiji");
  });
});
