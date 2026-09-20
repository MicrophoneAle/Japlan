import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// "What do you know about me" told someone who had filled in the survey that
// it knew nothing (live, 2026-09-19). The row was right; the profile writer
// only read the current survey's fields, and Michael took the first one.

const PHONES = { michael: "+15550000077", sam: "+15550000049" };
const GROUP = "chat-group";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  toolResults: [] as unknown[],
  modelTurns: 0,
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
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class FakeModel {
    async complete() {
      return "";
    }
    async completeTurn(opts: { contents: { parts: { functionResponse?: { response?: unknown } }[] }[] }) {
      h.modelTurns += 1;
      const responses = opts.contents.flatMap((c) => c.parts.map((p) => p.functionResponse).filter(Boolean));
      if (responses.length > 0) {
        h.toolResults.push(...responses.map((r) => r?.response));
        return { text: "you're a late-night, cram-it-all-in type", functionCalls: [] };
      }
      const next = h.calls.shift();
      return next
        ? { text: "", functionCalls: [{ id: "c1", name: next.name, args: next.args }] }
        : { text: "ok", functionCalls: [] };
    }
  }
  return {
    ...actual,
    GeminiProvider: FakeModel,
    matchClaimText: vi.fn(async () => null),
    judgeRelevance: vi.fn(async () => null),
    judgeStillEngaged: vi.fn(async () => null),
    judgeShouldJoin: vi.fn(async () => null),
  };
});

import { dispatchLinqEvent } from "./dispatch";
import { CONVERSATION_PRIVACY_LINE, PROFILE_IN_DM_LINE } from "@/lib/game/copy";

const v = (value: string) => ({ value });
// Michael's live answers: the first survey, before the either-ors existed.
const FIRST_SURVEY = {
  first_name: v("Michael"),
  age_bracket: v("18_24"),
  dietary: v("none"),
  mobility: v("no_limits"),
  budget: v("high"),
  blackout: v("no"),
  interests: v("balanced"),
  nightlife: v("yes"),
  drinking: v("sometimes"),
  pace: v("early_and_moving"),
  chaos: v("high"),
  competitiveness: v("win"),
  interest_picks: v("nightlife,weird"),
};
// What was stored for him: neutral weights (the first survey was not read)
// and a 60-character "no lean yet" paragraph.
const NEUTRAL_PREFS = {
  version: 2,
  weights: Object.fromEntries(
    ["food", "outdoors", "adventure", "local_discovery", "iconic", "culture", "chill", "activity", "nightlife"].map((d) => [
      d,
      { w: 0.5, c: "low" },
    ]),
  ),
};

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
      sender_handle: { handle: PHONES[who], is_me: false, display_name: who === "michael" ? "Michael" : "Sam" },
      parts: [{ type: "text", value: text }],
    },
  });
}
const dm = (who: keyof typeof PHONES) => `dm:${PHONES[who]}`;
const lastIn = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).at(-1)?.text;

function seed(sam: Record<string, unknown> = {}) {
  h.db.seed("trips", [
    // An older trip with the same phones on it: the lookup must not use it.
    { id: "trip-old", linq_chat_id: "chat-old", name: "old", state: "complete", timezone: "Asia/Tokyo", created_at: "2026-09-01T00:00:00Z" },
    {
      id: "trip-1",
      linq_chat_id: GROUP,
      name: "osaka",
      destination: "Osaka",
      start_date: "2026-09-20",
      end_date: "2026-09-24",
      state: "active",
      timezone: "Asia/Tokyo",
      is_solo: false,
      board_time: "08:00",
      setup_state: "done",
      intro_sent_at: "2026-09-19T00:00:00Z",
      organizer_participant_id: "p-michael",
      category_weights: {},
    },
  ]);
  h.db.seed("participants", [
    { id: "old-michael", trip_id: "trip-old", phone: PHONES.michael, display_name: "Michael", survey_state: "first_name", survey_json: {} },
    {
      id: "p-michael",
      trip_id: "trip-1",
      phone: PHONES.michael,
      display_name: "Michael",
      survey_state: "done",
      survey_json: FIRST_SURVEY,
      prefs_json: NEUTRAL_PREFS,
      profile_md: "They hasn't shown a strong lean yet. (mostly guesses so far.)",
    },
    { id: "p-sam", trip_id: "trip-1", phone: PHONES.sam, display_name: "Sam", survey_state: "done", survey_json: {}, ...sam },
  ]);
}

let info: ReturnType<typeof vi.spyOn>;
const logged = (label: string, step?: string) =>
  info.mock.calls
    .filter((c: unknown[]) => c[0] === label && (!step || (c[1] as { step?: string }).step === step))
    .map((c: unknown[]) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-20T10:00:00+09:00"));
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.calls.length = 0;
  h.toolResults.length = 0;
  h.modelTurns = 0;
  info = vi.spyOn(console, "info");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("japlan what do you know about me", () => {
  it("in a group: answered in the DM, with real content from the first survey", async () => {
    seed();
    await say("michael", "japlan what do you know about me");
    expect(lastIn(GROUP)).toBe(PROFILE_IN_DM_LINE);
    const text = lastIn(dm("michael"))!;
    expect(text).not.toMatch(/don't know your preferences|don't know much/);
    expect(text).toMatch(/late nights out/);
    expect(text).toMatch(/cram a day full/);
    expect(text).toMatch(/\$100-200/);
    // The row it used: this trip's, by (trip_id, phone), with its data.
    expect(logged("[japlan.profile] step", "lookup")[0]).toMatchObject({
      tripId: "trip-1",
      participantId: "p-michael",
      sameTrip: true,
      hasPrefsJson: true,
      hasProfileMd: true,
      surveyState: "done",
    });
    // Nothing private in the group.
    for (const m of h.sent.filter((s) => s.chatId === GROUP)) expect(m.text).not.toMatch(/nights|\$/);
  });

  it("in a DM: answered there", async () => {
    seed();
    await say("michael", "japlan what do you know about me", dm("michael"));
    expect(lastIn(dm("michael"))).toMatch(/late nights out/);
  });

  it("catches the live phrasings without asking a model", async () => {
    seed();
    for (const text of ["japlan what do u know about me", "Hi japlan what can you tell me about myself", "japlan what can you tell me based on my survey answers"]) {
      await say("michael", text);
      expect(lastIn(dm("michael")), text).toMatch(/late nights out/);
    }
    expect(h.modelTurns).toBe(0);
  });

  it("about someone else: refused, and nothing of theirs sent anywhere", async () => {
    seed();
    await say("sam", "japlan what do you know about michael");
    expect(lastIn(GROUP)).toBe(CONVERSATION_PRIVACY_LINE);
    expect(h.sent.filter((m) => m.chatId === dm("sam"))).toEqual([]);
    expect(h.modelTurns).toBe(0);
    await say("sam", "japlan what's michael's budget");
    expect(lastIn(GROUP)).toBe(CONVERSATION_PRIVACY_LINE);
  });

  it("not finished: says so and offers the next question, instead of 'i know nothing'", async () => {
    seed({ survey_state: "first_name", survey_json: {} });
    await say("sam", "japlan what do you know about me");
    expect(lastIn(dm("sam"))).toBe(
      "you haven't finished the quick questions yet, so i only know the basics.\nwant to keep going?\n\nnext one: what should i call you?",
    );
    // The next DM answers that question.
    expect(h.db.table("participants").find((p) => p.id === "p-sam")!.survey_state).toBe("first_name");
  });
});

describe("the conversation's get_my_profile tool", () => {
  it("in a DM, gives the model the sender's own profile to answer from", async () => {
    seed();
    h.calls.push({ name: "get_my_profile", args: {} });
    await say("michael", "japlan so based on everything, what kind of traveller am i", dm("michael"));
    const result = h.toolResults[0] as { finished: boolean; profile: string };
    expect(result.finished).toBe(true);
    expect(result.profile).toMatch(/late nights out/);
    expect(logged("[japlan.conversation] profile")[0].passedToModel).toBeGreaterThan(50);
  });

  it("in a group, DMs it and never hands the content to the model", async () => {
    seed();
    h.calls.push({ name: "get_my_profile", args: {} });
    await say("michael", "japlan so based on everything, what kind of traveller am i");
    expect(lastIn(GROUP)).toBe(PROFILE_IN_DM_LINE);
    expect(lastIn(dm("michael"))).toMatch(/late nights out/);
    // The model learns only that it went to the DM: no content to repeat.
    expect(h.toolResults).toEqual([{ ok: true, sent_to: "dm" }]);
    expect(logged("[japlan.conversation] profile")[0]).toMatchObject({ passedToModel: 0, sentTo: "dm" });
  });
});
