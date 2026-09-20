import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Survey v2, written profiles, group engagement and reply vetting, end to
// end through dispatchLinqEvent. Faked edges only: Supabase in memory, Linq
// sends (which record the bot's lines to the transcript like the real
// ones), and the Gemini calls, each scripted per test.

const PHONES = { maya: "+15550000001", sam: "+15550000002" };
const GROUP = "chat-group";
const DM = { maya: "dm-maya", sam: "dm-sam" };

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  reply: "ok",
  prompts: [] as string[],
  interpret: vi.fn(),
  stillEngaged: vi.fn(),
  shouldJoin: vi.fn(),
  relevance: vi.fn(),
}));

// No network in tests: board generation asks for the day's weather.
vi.mock("@/lib/game/weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/game/weather")>()),
  fetchDayWeather: vi.fn(async () => ({ temperatureC: 20, precipitationChance: 0, summary: "clear", indoorPreferred: false })),
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
      out(phone === "+15550000001" ? "dm-maya" : phone === "+15550000002" ? "dm-sam" : `dm:${phone}`, text),
    ),
    markRead: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
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
    async complete(opts: { schema?: { type?: string }; system?: string; messages?: { content: string }[] }) {
      if (opts.schema?.type !== "array") return "";
      h.prompts.push([opts.system ?? "", ...(opts.messages ?? []).map((m) => m.content)].join("\n"));
      return JSON.stringify(
        ["wrong_train", "oldest_thing", "buy_keep"].map((template, i) => ({
          template,
          title: `${template.replace(/_/g, " ")} ${i}`,
          axes: { boldness: 2, physical: 1, time: 2, scarcity: 3, cultural: 3, aesthetics: 2 },
          verification: "honor",
          photo_bonus_max: 0,
          neighborhood: "",
          places: [],
          involves_stranger: false,
        })),
      );
    }
    async completeTurn(opts: { contents: { parts: { functionResponse?: unknown }[] }[] }) {
      const answered = opts.contents.some((c) => c.parts.some((p) => p.functionResponse));
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
    interpretSurveyReply: h.interpret,
    judgeStillEngaged: h.stillEngaged,
    judgeShouldJoin: h.shouldJoin,
    judgeRelevance: h.relevance,
  };
});

import { dispatchLinqEvent } from "./dispatch";
import { TOKYO_HAND_PROFILE } from "@/lib/game/tokyo-profile";
import { DISCARD_FALLBACK, PROFILE_IN_DM_LINE, STOP_LINE } from "@/lib/game/copy";

let evt = 0;
let clock = 0;
async function say(who: keyof typeof PHONES, text: string, chatId = GROUP) {
  evt += 1;
  // Transcript lines are ordered by time: one second apart.
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
const trip = () => h.db.table("trips")[0];
const person = (who: keyof typeof PHONES) => h.db.table("participants").find((p) => p.id === `p-${who}`)!;
const v = (value: string) => ({ value });

const MAYA_ANSWERS = {
  ab_food_outdoors: v("a"),
  ab_discover_iconic: v("a"),
  ab_culture_nightlife: v("b"),
  ab_pace: v("a"),
  budget_band: v("50_100"),
  hard_constraints: v("shellfish allergy"),
  fu_allergy_cc: v("yes"),
  must_have: v("eat at a standing sushi bar"),
};

function seed(opts: { state?: string; maya?: Record<string, unknown>; sam?: Record<string, unknown> } = {}) {
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: GROUP,
      name: "tokyo",
      destination: "Tokyo",
      start_date: "2026-09-19",
      end_date: "2026-09-23",
      state: opts.state ?? "active",
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
    { id: "p-maya", trip_id: "trip-1", phone: PHONES.maya, display_name: "Maya", survey_state: "done", survey_json: {}, ...opts.maya },
    { id: "p-sam", trip_id: "trip-1", phone: PHONES.sam, display_name: "Sam", survey_state: "done", survey_json: {}, ...opts.sam },
  ]);
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const logged = (spy: ReturnType<typeof vi.spyOn>, label: string) =>
  spy.mock.calls.filter((c: unknown[]) => c[0] === label).map((c: unknown[]) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = 0;
  vi.setSystemTime(new Date("2026-09-19T09:00:00+09:00"));
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.calls.length = 0;
  h.prompts.length = 0;
  h.reply = "ok";
  h.interpret.mockReset().mockResolvedValue(null);
  h.stillEngaged.mockReset().mockResolvedValue(null);
  h.shouldJoin.mockReset().mockResolvedValue(null);
  h.relevance.mockReset().mockResolvedValue(null);
  info = vi.spyOn(console, "info");
  warn = vi.spyOn(console, "warn");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the survey accepts anything", () => {
  it("answers an off-topic message, then asks the same question again", async () => {
    seed({ state: "surveying", maya: { survey_state: "ab_discover_iconic", survey_json: { ab_food_outdoors: v("a") } } });
    h.interpret.mockResolvedValue({ answer: null, reply: "no clue yet, i'll sort that once we're done here." });
    await say("maya", "wait what time does the trip start", DM.maya);
    expect(lastIn(DM.maya)).toBe(
      "no clue yet, i'll sort that once we're done here. wandering and finding random stuff, or the famous thing?",
    );
    expect(person("maya").survey_state).toBe("ab_discover_iconic");
  });

  it("drops an aside that states a fact it was not given, and just re-asks", async () => {
    seed({ state: "surveying", maya: { survey_state: "ab_discover_iconic", survey_json: {} } });
    h.interpret.mockResolvedValue({ answer: null, reply: "it's 24 degrees there rn." });
    await say("maya", "hows the weather over there", DM.maya);
    expect(lastIn(DM.maya)).toBe("wandering and finding random stuff, or the famous thing?");
    expect(logged(warn, "[japlan.survey] aside discarded")[0]).toMatchObject({ reason: "unsourced_number:24" });
  });

  it("reads a sentence the parser can't through the model, and moves on", async () => {
    seed({ state: "surveying", maya: { survey_state: "ab_discover_iconic", survey_json: {} } });
    h.interpret.mockResolvedValue({ answer: "wandering and finding random stuff", reply: null });
    await say("maya", "ugh i always end up in some back alley so probably that", DM.maya);
    expect(person("maya").survey_state).toBe("ab_culture_nightlife");
  });

  it("goes back a question", async () => {
    seed({ state: "surveying", maya: { survey_state: "ab_discover_iconic", survey_json: { ab_food_outdoors: v("a") } } });
    await say("maya", "wait, go back", DM.maya);
    expect(person("maya").survey_state).toBe("ab_food_outdoors");
    expect(lastIn(DM.maya)).toMatch(/^sure\. insane local food spot/);
  });

  it("finishing writes weights and a written profile, starts the trip, and asks about sidequests", async () => {
    seed({
      state: "surveying",
      maya: { survey_state: "splitting", survey_json: MAYA_ANSWERS },
      sam: { survey_json: { ab_food_outdoors: v("b"), hard_constraints: v("no heights") } },
    });
    await say("maya", "yes", DM.maya);
    const maya = person("maya");
    expect(maya.survey_state).toBe("sidequest_level");
    expect((maya.prefs_json as { version: number }).version).toBe(2);
    expect(maya.profile_md).toContain("shellfish allergy (cross-contamination matters)");
    // Finishing starts the trip; Maya's reply is the close, her board, then
    // the sidequest question. Sam, already done, gets the same in one DM.
    expect(trip().state).toBe("active");
    expect(lastIn(DM.maya)).toMatch(/^done\. you're less mysterious than you think\.\n\nDay 1[\s\S]+\n\nbtw i'm turning on sidequests\. how unhinged am i allowed to get\?/);
    expect(lastIn(DM.sam)).toMatch(/^Day 1[\s\S]+\n\nbtw i'm turning on sidequests/);
    // The group profile unions constraints and names nobody.
    expect(trip().group_profile_md).toContain("shellfish allergy (cross-contamination matters)");
    expect(trip().group_profile_md).toContain("no heights");
    expect(trip().group_profile_md).not.toMatch(/Maya|Sam/);
    // Nothing private reached the group.
    for (const text of sentTo(GROUP)) expect(text).not.toMatch(/shellfish|heights|sushi/);

    // Sidequest level 2 asks for red lines; strangers makes it a hard filter.
    await say("sam", "2", DM.sam);
    expect(person("sam").survey_state).toBe("sidequest_red_lines");
    await say("sam", "talking to strangers", DM.sam);
    expect(person("sam").survey_state).toBe("done");
    expect((person("sam").survey_json as Record<string, { value?: string }>).sociability?.value).toBe("rather_not");
  });
});

describe("profiles are DM-private", () => {
  it("'japlan what do you know about me' in the group goes to the DM", async () => {
    seed({ maya: { survey_json: MAYA_ANSWERS, profile_md: "Maya leans hard toward food. Hard constraints, in their words: shellfish allergy (cross-contamination matters)." } });
    await say("maya", "japlan what do you know about me");
    expect(lastIn(GROUP)).toBe(PROFILE_IN_DM_LINE);
    expect(lastIn(DM.maya)).toContain("shellfish allergy (cross-contamination matters)");
    for (const text of sentTo(GROUP)) expect(text).not.toMatch(/shellfish/);
  });

  it("someone else asking gets their own profile, never another person's", async () => {
    seed({ maya: { survey_json: MAYA_ANSWERS, profile_md: "Maya: shellfish allergy (cross-contamination matters)." } });
    await say("sam", "japlan what do you know about me", DM.sam);
    expect(lastIn(DM.sam)).not.toMatch(/shellfish|Maya/);
  });

  it("a shared board's prompt gets the group profile, not anyone's own", async () => {
    seed({
      maya: { survey_json: MAYA_ANSWERS, profile_md: "PRIVATE-MAYA-PROFILE" },
      sam: { survey_json: { hard_constraints: v("no heights") }, profile_md: "PRIVATE-SAM-PROFILE" },
    });
    await say("maya", "japlan plans");
    expect(h.prompts.length).toBeGreaterThan(0);
    for (const prompt of h.prompts) {
      expect(prompt).not.toMatch(/PRIVATE-(MAYA|SAM)-PROFILE/);
      expect(prompt).not.toMatch(/Maya leans|Sam leans/);
    }
    expect(h.prompts.some((p) => p.includes("shellfish allergy (cross-contamination matters)"))).toBe(true);
  });
});

describe("following a group conversation", () => {
  it("keeps following without the keyword while the model says it's still with the bot", async () => {
    seed();
    await say("maya", "japlan hey");
    expect(sentTo(GROUP)).toHaveLength(1);
    h.stillEngaged.mockResolvedValue({ decision: true, reason: "follow-up" });
    await say("maya", "and what about tomorrow");
    expect(sentTo(GROUP)).toHaveLength(2);
    h.stillEngaged.mockResolvedValue({ decision: false, reason: "talking to each other" });
    await say("sam", "maya did you grab the charger");
    expect(sentTo(GROUP)).toHaveLength(2);
    expect(trip().engagement_json).toMatchObject({ engaged: false, reason: "talking to each other" });
    const decisions = logged(info, "[japlan.engage] decision");
    expect(decisions.map((d) => [d.engaged, d.reason])).toEqual([
      [true, "addressed"],
      [true, "follow-up"],
      [false, "talking to each other"],
    ]);
  });

  it("leaves on its own after a long gap or a run of messages between others, without asking the model", async () => {
    seed();
    await say("maya", "japlan hey");
    clock += 30 * 60 * 1000;
    await say("maya", "ok who wants coffee");
    expect(h.stillEngaged).not.toHaveBeenCalled();
    expect(trip().engagement_json).toMatchObject({ engaged: false, reason: "long_gap" });

  });

  it("leaves without asking the model once people have talked among themselves for a while", async () => {
    seed();
    trip().engagement_json = { engaged: true, stopped: false, reason: "addressed", at: "" };
    const line = (role: string, text: string, sec: number) => ({
      chat_id: GROUP,
      role,
      sender_name: role === "bot" ? null : "Sam",
      text,
      created_at: new Date(Date.parse("2026-09-19T09:00:00+09:00") + sec * 1000 - 60_000).toISOString(),
    });
    h.db.seed("chat_messages", [line("bot", "A1 is still open.", 0), line("user", "lol", 1), line("user", "where are you", 2), line("user", "by the gate", 3)]);
    await say("maya", "coming");
    expect(h.stillEngaged).not.toHaveBeenCalled();
    expect(logged(info, "[japlan.engage] decision").at(-1)).toMatchObject({ engaged: false, reason: "others_talking", via: "rule" });
    expect(sentTo(GROUP)).toHaveLength(0);
  });

  it("joins an unaddressed message only when it's about the game and the model agrees", async () => {
    seed();
    await say("maya", "lol my feet hurt");
    expect(h.shouldJoin).not.toHaveBeenCalled();
    h.shouldJoin.mockResolvedValue({ decision: false, reason: "chatter" });
    await say("maya", "we should go to the fish market later");
    expect(sentTo(GROUP)).toHaveLength(0);
    h.shouldJoin.mockResolvedValue({ decision: true, reason: "asking about standings" });
    await say("sam", "who's winning rn");
    expect(sentTo(GROUP)).toHaveLength(1);
    expect(logged(info, "[japlan.engage] decision").at(-1)).toMatchObject({
      engaged: true,
      reason: "score: asking about standings",
    });
  });

  it("'japlan quiet' goes quiet in three words, and only a mention brings it back", async () => {
    seed();
    await say("maya", "japlan hey");
    await say("sam", "japlan quiet");
    expect(lastIn(GROUP)).toBe(STOP_LINE);
    const count = sentTo(GROUP).length;
    h.shouldJoin.mockResolvedValue({ decision: true, reason: "score" });
    h.stillEngaged.mockResolvedValue({ decision: true, reason: "follow-up" });
    await say("maya", "who's winning rn");
    expect(sentTo(GROUP)).toHaveLength(count);
    expect(h.shouldJoin).not.toHaveBeenCalled();
    await say("maya", "japlan ok you can talk");
    expect(sentTo(GROUP)).toHaveLength(count + 1);
    expect(trip().engagement_json).toMatchObject({ engaged: true, stopped: false });
  });

  // "chill" is a difficulty level. It used to mute, which meant the organizer
  // could not set the difficulty to chill with the keyword attached.
  it("does not go quiet on 'japlan chill', which is a difficulty", async () => {
    seed();
    await say("maya", "japlan hey");
    await say("sam", "japlan chill");
    expect(lastIn(GROUP)).not.toBe(STOP_LINE);
    expect(trip().engagement_json).not.toMatchObject({ stopped: true });
  });
});

describe("replies are checked before they go out", () => {
  it("reads the chat's own recent transcript, and logs how much", async () => {
    seed();
    await say("sam", "morning all");
    await say("maya", "japlan hey");
    expect(logged(info, "[japlan.conversation] context").at(-1)).toMatchObject({ lines: 1, empty: false });
  });

  it("discards a number no tool returned", async () => {
    seed();
    h.reply = "maya's on 90, nobody's close";
    await say("sam", "japlan who's winning");
    expect(lastIn(GROUP)).toBe(DISCARD_FALLBACK);
    expect(logged(warn, "[japlan.conversation] discard")[0]).toMatchObject({ reason: "unsourced_number:90" });
  });

  it("discards an unknown task code", async () => {
    seed();
    h.reply = "go knock out Q7 first";
    await say("sam", "japlan what should i do");
    expect(lastIn(GROUP)).toBe(DISCARD_FALLBACK);
  });

  it("discards a fluent reply that doesn't respond to what was said", async () => {
    seed();
    h.reply = "honestly the vending machines here are elite";
    h.relevance.mockResolvedValue({ decision: false, reason: "ignores the question" });
    await say("sam", "japlan are we splitting up today");
    expect(lastIn(GROUP)).toBe(DISCARD_FALLBACK);
    expect(logged(warn, "[japlan.conversation] discard")[0]).toMatchObject({ reason: "irrelevant: ignores the question" });
  });

  it("sends a reply that passes", async () => {
    seed();
    h.reply = "sounds good, go for it";
    h.relevance.mockResolvedValue({ decision: true, reason: "responds" });
    await say("sam", "japlan we're gonna wander a bit");
    // Code may add its own nudge back to the game; the model's words go out as written.
    expect(lastIn(GROUP)).toMatch(/^sounds good, go for it/);
    expect(logged(warn, "[japlan.conversation] discard")).toHaveLength(0);
  });
});

describe("stated preferences move the weights", () => {
  it("'i'm not that into food' lowers food, high confidence, and rewrites the profile", async () => {
    seed({ maya: { survey_json: MAYA_ANSWERS } });
    h.calls.push({ name: "update_my_setting", args: { setting: "interests", value: "not that into food", mode: "remove" } });
    await say("maya", "japlan i'm not that into food actually", DM.maya);
    expect(lastIn(DM.maya)).toMatch(/^got it, less /);
    const prefs = person("maya").prefs_json as { weights: Record<string, { w: number; c: string }> };
    expect(prefs.weights.food).toEqual({ w: 0.2, c: "high" });
    expect(person("maya").profile_md).not.toMatch(/leans hard toward food/);
  });
});
