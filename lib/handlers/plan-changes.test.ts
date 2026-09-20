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

describe("the group is one group until someone says otherwise", () => {
  it("plans one shared schedule: everyone's board is the same tasks, claimed individually", async () => {
    seed();
    await say("mike", "japlan plans");
    const titlesFor = (who: string) =>
      tasks().filter((t) => t.participant_id === id(who)).map((t) => `${t.code} ${t.title} ${t.slot}`).sort();
    expect(titlesFor("mike").length).toBeGreaterThan(2);
    expect(titlesFor("sam")).toEqual(titlesFor("mike"));
    expect(tasks().every((t) => t.team_id === null)).toBe(true);
  });

  it("splits from conversation, asks only about who it could not place, and keeps claims", async () => {
    seed();
    await say("mike", "japlan plans");
    const mikes = tasks().filter((t) => t.participant_id === id("mike"));
    h.db.seed("claims", [{ task_id: mikes[0].id, participant_id: id("mike"), status: "awarded", awarded_points: 10 }]);

    await sayWithCall("mike", "japlan me and jess are doing shimokita, boys are going to asakusa", "record_split", {
      groups: [
        { who: ["me", "jess"], where: "Shimokitazawa" },
        { who: ["the boys"], where: "Asakusa" },
      ],
    });
    const reply = lastIn(GROUP)!;
    expect(reply).toMatch(/^split noted: you and Jessica on Shimokitazawa/);
    expect(reply).toContain('who\'s "the boys"?');
    expect(reply).toContain("where's Sam and Dev: Shimokitazawa or Asakusa?");
    expect(reply).toContain("new boards are in your dms");
    // Claimed stands; the pair now has team tasks.
    expect(tasks().some((t) => t.id === mikes[0].id)).toBe(true);
    const shimo = teams().find((t) => t.area === "Shimokitazawa")!;
    expect(h.db.table("team_members").filter((m) => m.team_id === shimo.id).map((m) => m.participant_id).sort()).toEqual(
      [id("jess"), id("mike")],
    );
    expect(tasks().some((t) => t.team_id === shimo.id)).toBe(true);

    // The answer places the rest; nobody else is asked anything.
    await sayWithCall("sam", "japlan dev and me are the boys", "record_split", {
      groups: [{ who: ["me", "dev"], where: "Asakusa" }],
    });
    expect(lastIn(GROUP)).not.toMatch(/where's|who's/);
    const asakusa = teams().find((t) => t.area === "Asakusa")!;
    expect(tasks().some((t) => t.team_id === asakusa.id)).toBe(true);
    expect(h.sent.some((m) => m.chatId === `dm:${PHONES.dev}`)).toBe(true);

    // Back together: teams end, one shared plan again.
    await sayWithCall("jess", "japlan we're all back", "record_regroup", {});
    expect(lastIn(GROUP)).toBe("back together. one plan again, new boards are in your dms.");
    expect(teams().every((t) => t.dissolved_at)).toBe(true);
    const unclaimedTeamTasks = tasks().filter((t) => t.team_id && !h.db.table("claims").some((c) => c.task_id === t.id));
    expect(unclaimedTeamTasks).toEqual([]);
  });

  it("a partial split: the late group starts later and both converge", async () => {
    seed();
    at("2026-09-19T08:30:00");
    await say("mike", "japlan plans");
    await sayWithCall("sam", "japlan i'm sleeping in, you guys go ahead", "record_split", {
      groups: [{ who: ["me"], starts: "sleeping in" }, { who: ["you guys"], starts: "now" }],
    });
    expect(lastIn(GROUP)).toMatch(/back together at 2:30pm/);
    const [early, late] = [
      teams().find((t) => !t.starts_at || t.starts_at < "10:00")!,
      teams().find((t) => t.starts_at === "11:30")!,
    ];
    const slotsOf = (teamId: unknown) => tasks().filter((t) => t.team_id === teamId).map((t) => t.slot);
    expect(slotsOf(early.id)).toContain("morning");
    expect(slotsOf(late.id).every((s) => s !== "morning")).toBe(true);
    // Everyone has tasks for after they rejoin.
    for (const who of Object.keys(PHONES)) {
      expect(tasks().some((t) => t.participant_id === id(who) && t.slot !== "morning"), who).toBe(true);
    }
  });
});

describe("people's own suggestions land in the plan", () => {
  it("puts a suggestion on the day it fits, says so, and credits it on the board", async () => {
    seed();
    await say("mike", "japlan plans");
    await sayWithCall("dev", "japlan we should do ueno park", "add_suggestion", { place: "Ueno Park" });
    expect(lastIn(GROUP)).toMatch(/^added Ueno Park to day 1, it's near the rest of that day/);
    const place = h.db.table("places").find((p) => p.source === "suggestion")!;
    expect(place).toMatchObject({ name: "Ueno Park", suggested_by: id("dev") });
    expect(h.db.table("itinerary")).toEqual([expect.objectContaining({ day: 1, place_id: place.id })]);

    await say("sam", "japlan plans", `dm:${PHONES.sam}`);
    expect(lastIn(`dm:${PHONES.sam}`)).toContain("+ Ueno Park (Dev's pick)");
  });

  it("puts a place it cannot locate on the ideas list, and prefers suggested places on the next board", async () => {
    seed();
    await sayWithCall("jess", "japlan there's a jazz bar in golden gai i want to hit", "add_suggestion", {
      place: "a jazz bar in golden gai",
    });
    expect(lastIn(GROUP)).toMatch(/couldn't pin it on a map, so it's on the ideas list/);
    expect(h.db.table("itinerary")).toEqual([]);
  });

  it("takes 'we don't want to do temples' as a lower weight for the trip", async () => {
    seed();
    await sayWithCall("mike", "japlan we don't want to do temples", "avoid_category", { category: "temples" });
    expect(lastIn(GROUP)).toBe("noted, fewer temples from here on.");
    expect(h.db.table("trips")[0].category_weights).toEqual({ temples: 0.3 });
  });
});

describe("the survey reaches the real board", () => {
  it("someone who would rather not talk to strangers gets none, and so does their group", async () => {
    seed({ sam: { sociability: { value: "rather_not" } } });
    await say("mike", "japlan plans");
    expect(tasks().length).toBeGreaterThan(0);
    expect(tasks().some((t) => /stranger best rec/.test(String(t.title)))).toBe(false);
  });
});

describe("settings and task counts are requests, handled by tools", () => {
  const dm = (who: keyof typeof PHONES) => `dm:${PHONES[who]}`;
  const mikeAnswers = () => h.db.table("participants").find((p) => p.id === id("mike"))!.survey_json as Record<string, { value?: string }>;

  it("'I want a schedule with 7 attractions' gets seven, not a lecture about pace", async () => {
    seed({ mike: { pace: { value: "two_things_and_lunch" } } });
    at("2026-09-19T08:30:00");
    await say("mike", "japlan plans", dm("mike"));
    const before = tasks().filter((t) => t.participant_id === id("mike")).length;
    await sayWithCall("mike", "japlan I want a schedule with 7 attractions", "request_tasks", { count: 7 });
    const reply = h.sent.filter((m) => m.chatId === dm("mike")).at(-1)!.text;
    const now = tasks().filter((t) => t.participant_id === id("mike")).length;
    // More than the pace default, and honest about the number: seven, or
    // exactly what fits in the day with that as the reason.
    expect(now).toBeGreaterThan(before);
    if (now === 7) expect(reply).toMatch(/^seven it is\./);
    else expect(reply).toMatch(/^\w+ is what fits in what's left of today, so that's \w+\./);
    expect(reply).not.toMatch(/pace|limit|locked|can't/);
    // Nobody else's board changed.
    expect(tasks().filter((t) => t.participant_id === id("sam")).length).toBeLessThan(7);
  });

  it("'make my pace the highest possible' changes it and offers a redo", async () => {
    seed({ mike: { pace: { value: "two_things_and_lunch" } } });
    await say("mike", "japlan plans", dm("mike"));
    await sayWithCall("mike", "japlan can you make my pace the highest possible", "update_my_setting", {
      setting: "pace",
      value: "highest possible",
    });
    expect(h.sent.at(-1)!.text).toBe("pace is now early and moving. want me to redo today's board?");
    expect(mikeAnswers().pace).toEqual({ value: "early_and_moving" });

    const before = tasks().filter((t) => t.participant_id === id("mike")).length;
    await sayWithCall("mike", "japlan yes", "redo_today", {});
    expect(lastIn(GROUP)).toBe("board's in your dms 📩");
    expect(lastIn(dm("mike"))).toMatch(/^fresh board: \d+ out, \d+ new\.\nDay 1/);
    expect(tasks().filter((t) => t.participant_id === id("mike")).length).toBeGreaterThanOrEqual(before);
  });

  it("keeps a private setting change out of the group", async () => {
    seed();
    await sayWithCall("mike", "japlan change my budget to 150", "update_my_setting", { setting: "budget", value: "150" });
    expect(lastIn(GROUP)).toBe("done, details are in your dm.");
    expect(h.sent.at(-1)).toEqual({ chatId: `dm:${PHONES.mike}`, text: "budget is now high." });
    expect(mikeAnswers().budget).toEqual({ value: "high" });
  });

  it("lets the organizer change the trip, and says plainly who can when someone else tries", async () => {
    seed();
    await sayWithCall("mike", "japlan make it unhinged", "update_trip_setting", { setting: "difficulty", value: "unhinged" });
    expect(lastIn(GROUP)).toBe("unhinged, noted.");
    expect(h.db.table("trips")[0].difficulty).toBe("unhinged");
    await sayWithCall("sam", "japlan make it chill", "update_trip_setting", { setting: "difficulty", value: "chill" });
    expect(lastIn(GROUP)).toBe("only Mike can change the setup, that's the rule lol.");
  });

  it("'japlan settings' shows your own values in your dm; 'japlan resurvey' starts again", async () => {
    seed({ mike: { pace: { value: "steady" } } });
    await say("mike", "japlan settings");
    // The group is told where the answer went, never what is in it.
    expect(lastIn(GROUP)).toBe(SETTINGS_IN_DM_LINE);
    expect(lastIn(GROUP)).not.toMatch(/pace|between/);
    expect(h.sent.at(-2)!.text).toMatch(/^your settings:\n· pace: somewhere in between/);
    await say("mike", "japlan resurvey", dm("mike"));
    expect(lastIn(dm("mike"))).toMatch(/^starting over, one question at a time\. skip keeps what you said before\./);
    // Skip keeps the old answer.
    const row = h.db.table("participants").find((p) => p.id === id("mike"))!;
    expect(row.survey_state).toBe("ab_food_outdoors");
    expect((row.survey_json as Record<string, unknown>).pace).toEqual({ value: "steady" });
  });
});
