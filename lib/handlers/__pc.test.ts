import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_IN_DM_LINE } from "@/lib/game/copy";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Splits, regrouping, suggestions and "avoid", end to end through the
// conversation's tool calls: a scripted model makes the call, the real
// handlers place people, re-plan the day and reply. Faked edges only.

const PHONES = { mike: "+15550000001", jess: "+15550000002", sam: "+15550000003", dev: "+15550000004" };
const GROUP = "chat-group";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
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
    h.sent.push({ chatId: `dm:${phone}`, text });
    return { chatId: `dm:${phone}`, messageId: `out-${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
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
  let n = 0;
  class FakeModel {
    // Board generation: a menu across templates and places.
    async complete(opts: { schema?: { type?: string } }) {
      if (opts.schema?.type !== "array") return "";
      const picks = [
        ["stranger_best_rec", "Asakusa", 4],
        ["wrong_train", "", 3],
        ["order_unreadable", "Ueno", 2],
        ["oldest_thing", "Yanaka", 3],
        ["buy_keep", "", 2],
        ["highest_point", "Shibuya", 3],
      ] as const;
      return JSON.stringify(
        picks.map(([template, place, boldness]) => {
          n += 1;
          return {
            template,
            title: `${template.replace(/_/g, " ")} ${n}`,
            axes: { boldness, physical: 1, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
            verification: "photo",
            photo_bonus_max: 2,
            neighborhood: place,
            places: place ? [place] : [],
            involves_stranger: template === "stranger_best_rec",
          };
        }),
      );
    }
    // Conversation: make whatever call the test queued, then say nothing.
    async completeTurn(opts: { contents: { parts: { functionResponse?: unknown }[] }[] }) {
      const answered = opts.contents.some((c) => c.parts.some((p) => p.functionResponse));
      const next = answered ? undefined : h.calls.shift();
      return next
        ? { text: "", functionCalls: [{ id: "c1", name: next.name, args: next.args }] }
        : { text: "ok", functionCalls: [] };
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
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who[0].toUpperCase() + who.slice(1) },
      parts: [{ type: "text", value: text }],
    },
  });
}
// The model's side of an addressed message: one queued tool call.
async function sayWithCall(who: keyof typeof PHONES, text: string, name: string, args: Record<string, unknown>) {
  h.calls.push({ name, args });
  await say(who, text);
}
const at = (local: string) => vi.setSystemTime(new Date(`${local}+09:00`));
const lastIn = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).at(-1)?.text;
const tasks = () => h.db.table("tasks");
const teams = () => h.db.table("teams");
const id = (who: string) => `p-${who}`;

function seed(survey: Record<string, Record<string, unknown>> = {}) {
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
      id: id(who),
      trip_id: "trip-1",
      phone,
      display_name: who === "jess" ? "Jessica" : who[0].toUpperCase() + who.slice(1),
      survey_state: "done",
      survey_json: { sociability: { value: "love_it" }, ...(survey[who] ?? {}) },
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-09-19T09:00:00");
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "true";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.calls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PROBE", () => {
  it("split tasks", async () => {
    seed();
    await say("mike", "japlan plans");
    console.log("BEFORE tasks:", tasks().length, JSON.stringify(tasks().slice(0, 3).map((t) => ({ p: t.participant_id, team: t.team_id, slot: t.slot, code: t.code }))));
    await sayWithCall("mike", "japlan me and jess are doing shimokita, boys are going to asakusa", "record_split", {
      groups: [
        { who: ["me", "jess"], where: "Shimokitazawa" },
        { who: ["the boys"], where: "Asakusa" },
      ],
    });
    console.log("TEAMS:", JSON.stringify(teams().map((t) => ({ id: t.id, area: t.area, starts: t.starts_at, rejoin: t.rejoin_at, day: t.day }))));
    console.log("AFTER tasks:", tasks().length);
    console.log("by team:", JSON.stringify(tasks().map((t) => `${t.code}/${t.participant_id}/${t.team_id}/${t.slot}`)));
  });
});
