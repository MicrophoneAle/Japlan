import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import { fakeHeic } from "@/lib/test/images";
import { compareStats, deriveStats, groupTotals, zeroStats } from "@/lib/game/stats";

// Live per-person stats: counters bumped as things happen, checked against a
// full recount from claims and tasks after a simulated trip through the real
// handlers. Counters drift; the recount is how we know they have not.

const PHONES = { ana: "+15550000001", ben: "+15550000002" };
const GROUP = "chat-group";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string; id: string }[],
  vision: vi.fn(),
  freeform: vi.fn(),
  calls: [] as string[],
  n: 0,
}));

vi.mock("@/lib/game/weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/game/weather")>()),
  fetchDayWeather: vi.fn(async () => ({ temperatureC: 20, precipitationChance: 0, summary: "clear", indoorPreferred: false })),
}));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => {
  const out = (chatId: string, text: string) => {
    const id = `out-${h.sent.length + 1}`;
    h.sent.push({ chatId, text, id });
    return { chatId, messageId: id };
  };
  return {
    sendText: vi.fn(async (chatId: string, text: string) => out(chatId, text)),
    sendDM: vi.fn(async (phone: string, text: string) => out(`dm:${phone}`, text)),
    markRead: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    shareContactCardSafely: vi.fn(async () => {}),
  };
});
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
        [
          ["wrong_train", "Asakusa"],
          ["oldest_thing", "Yanaka"],
          ["buy_keep", "Ueno"],
          ["stranger_best_rec", "Shibuya"],
        ].map(([template, place]) => {
          h.n += 1;
          return {
            template,
            title: `${template.replace(/_/g, " ")} ${h.n}`,
            axes: { boldness: 3, physical: 1, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
            verification: "honor",
            photo_bonus_max: 3,
            neighborhood: place,
            places: [place],
            involves_stranger: template === "stranger_best_rec",
          };
        }),
      );
    }
    // Conversation: the model suggests a freeform claim when a test queues
    // one; the server then re-extracts it from the message.
    async completeTurn(opts: { contents: { parts: { functionResponse?: unknown }[] }[] }) {
      const answered = opts.contents.some((c) => c.parts.some((p) => p.functionResponse));
      const next = answered ? undefined : h.calls.shift();
      return next ? { text: "", functionCalls: [{ id: "c1", name: next, args: {} }] } : { text: "ok", functionCalls: [] };
    }
  }
  return {
    ...actual,
    GeminiProvider: FakeModel,
    matchClaimText: vi.fn(async () => null),
    scorePhotoFidelity: h.vision,
    extractFreeformActivity: h.freeform,
    judgeRelevance: vi.fn(async () => null),
    judgeStillEngaged: vi.fn(async () => null),
    judgeShouldJoin: vi.fn(async () => null),
  };
});

import { dispatchLinqEvent } from "./dispatch";
import { readStats, recomputeStats, statsDrift, bumpStats } from "./stats";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";

let evt = 0;
function msg(who: keyof typeof PHONES, parts: Record<string, unknown>[], chatId = GROUP) {
  evt += 1;
  return {
    event_id: `evt-${evt}`,
    event_type: "message.received",
    data: {
      id: `msg-${evt}`,
      chat_id: chatId,
      chat: { id: chatId, is_group: chatId === GROUP },
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who === "ana" ? "Ana" : "Ben" },
      parts,
    },
  };
}
const say = (who: keyof typeof PHONES, text: string, chatId = GROUP) => dispatchLinqEvent(msg(who, [{ type: "text", value: text }], chatId));
const photo = (who: keyof typeof PHONES, caption = "") =>
  dispatchLinqEvent(
    msg(who, [
      { type: "media", url: `https://cdn.example/${evt}.heic`, mime_type: "image/heic" },
      ...(caption ? [{ type: "text", value: caption }] : []),
    ]),
  );
const tapback = (who: keyof typeof PHONES, messageId: string) =>
  dispatchLinqEvent({
    event_id: `evt-r-${++evt}`,
    event_type: "reaction.added",
    data: { reaction_type: "like", message_id: messageId, chat_id: GROUP, from: PHONES[who], is_from_me: false },
  });
const stats = async () => Object.fromEntries((await readStats("trip-1")).map((s) => [s.participant_id, s]));
const owned = (pid: string) => h.db.table("tasks").filter((t) => t.participant_id === pid && t.source !== "freeform");
const verdict = (relates: boolean, fidelity: number) => ({
  shows_task: relates,
  fidelity,
  seen: "a photo",
  raw: { relates: JSON.stringify({ seen: "a photo", relates }), fidelity: relates ? `{"fidelity":${fidelity}}` : null },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T01:00:00Z")); // 10:00 in Tokyo, day 1
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.vision.mockReset().mockResolvedValue(verdict(true, 2));
  h.freeform.mockReset();
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
      organizer_participant_id: "p-ana",
      category_weights: {},
    },
  ]);
  h.db.seed("participants", [
    { id: "p-ana", trip_id: "trip-1", phone: PHONES.ana, display_name: "Ana", survey_state: "done", survey_json: {} },
    { id: "p-ben", trip_id: "trip-1", phone: PHONES.ben, display_name: "Ben", survey_state: "done", survey_json: {} },
  ]);
  let seed = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(fakeHeic(++seed)), { status: 200, headers: { "content-type": "image/heic" } })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stats move on real events, and match a full recount", () => {
  it("everyone starts at zero", async () => {
    expect(await recomputeStats("trip-1")).toEqual({ "p-ana": zeroStats(), "p-ben": zeroStats() });
    expect(await readStats("trip-1")).toEqual([]);
  });

  it("after a simulated trip, every stored counter equals the recount", async () => {
    // A board: generated items land on each person's count.
    await say("ana", "japlan plans");
    let s = await stats();
    expect(s["p-ana"].itinerary_items_total).toBe(owned("p-ana").length);
    expect(s["p-ben"].itinerary_items_total).toBe(owned("p-ben").length);
    expect(s["p-ana"].itinerary_items_total).toBeGreaterThan(0);

    // Claims: a code, then a late photo bonus on it; a code with a photo.
    const [a1, a2] = owned("p-ana").sort((x, y) => String(x.code).localeCompare(String(y.code)));
    await say("ana", String(a1.code));
    await photo("ana");
    await photo("ana", String(a2.code));
    const b1 = owned("p-ben")[0];
    await say("ben", String(b1.code));

    // A freeform claim, confirmed by a tapback from someone else.
    h.freeform.mockResolvedValue(
      JSON.stringify({
        is_completed_activity: true,
        title: "ate a melon pan in one go",
        place_name: "Asakusa",
        neighborhood: "Asakusa",
        axes: { boldness: 2, physical: 1, time: 1, scarcity: 2, cultural: 3, aesthetics: 1 },
      }),
    );
    h.calls.push("propose_freeform_claim");
    await say("ben", "japlan i just ate a whole melon pan in one go");
    const peerPrompt = h.sent.filter((m) => m.chatId === GROUP).at(-1)!;
    await tapback("ana", peerPrompt.id);

    // A reroll replaces, never adds: Ana's count follows her real board.
    await say("ana", "japlan redo today");
    s = await stats();
    expect(s["p-ana"].itinerary_items_total).toBe(owned("p-ana").length);

    s = await stats();
    expect(s["p-ana"].tasks_completed).toBe(2);
    expect(s["p-ana"].photos_submitted).toBe(2);
    expect(s["p-ana"].photo_bonuses_earned).toBe(2);
    expect(s["p-ana"].days_with_activity).toBe(1);
    expect(s["p-ben"].tasks_completed).toBe(2);
    expect(s["p-ben"].freeform_claims).toBe(1);
    expect(s["p-ben"].photos_submitted).toBe(0);

    // The point: nothing drifted.
    expect(await statsDrift("trip-1")).toEqual([]);
  });

  it("concurrent bumps on one person lose nothing", async () => {
    await Promise.all(Array.from({ length: 40 }, () => bumpStats("trip-1", "p-ana", { tasks_completed: 1 })));
    expect((await stats())["p-ana"].tasks_completed).toBe(40);
  });

  it("drift is caught, not hidden", async () => {
    await bumpStats("trip-1", "p-ana", { tasks_completed: 3 });
    const drift = await statsDrift("trip-1");
    expect(drift).toEqual([{ participantId: "p-ana", field: "tasks_completed", stored: 3, derived: 0 }]);
  });
});

describe("definitions", () => {
  it("counts capped claims as done, days and places as distinct, freeform apart from the itinerary", () => {
    const tasks = [
      { id: "t1", participant_id: "p", team_id: null, day: 1, neighborhood: "Asakusa", source: "generated" },
      { id: "t2", participant_id: "p", team_id: null, day: 1, neighborhood: "the Asakusa", source: "generated" },
      { id: "t3", participant_id: "p", team_id: null, day: 2, neighborhood: null, source: "freeform" },
      { id: "t4", participant_id: null, team_id: "team", day: 2, neighborhood: "Ueno", source: "generated" },
    ];
    const claim = (task_id: string, extra = {}) => ({ task_id, participant_id: "p", status: "awarded", evidence_url: null, resolution_json: {}, ...extra });
    const out = deriveStats({
      participantIds: ["p"],
      tasks,
      claims: [claim("t1", { resolution_json: { capped: true } }), claim("t2", { evidence_url: "x", resolution_json: { photo_bonus: 2 } }), claim("t3")],
      teamMembers: { team: ["p"] },
    }).p;
    expect(out.itinerary_items_total).toBe(3); // t1, t2, and the team's t4; not the freeform t3
    expect(out.tasks_completed).toBe(3);
    expect(out.photos_submitted).toBe(1);
    expect(out.photo_bonuses_earned).toBe(1);
    expect(out.freeform_claims).toBe(1);
    expect(out.days_with_activity).toBe(2);
    expect(out.places_visited).toBe(1); // "Asakusa" and "the Asakusa" are one place
  });

  it("group totals are sums, computed on read", () => {
    const a = { ...zeroStats(), tasks_completed: 3, photos_submitted: 1 };
    const b = { ...zeroStats(), tasks_completed: 4 };
    expect(groupTotals([a, b])).toMatchObject({ tasks_completed: 7, photos_submitted: 1 });
    expect(compareStats({ p: a }, { p: a })).toEqual([]);
  });
});
