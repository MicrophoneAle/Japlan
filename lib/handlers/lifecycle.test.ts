import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// End to end through dispatchLinqEvent for the organizer setup and the trip
// lifecycle. Faked edges only: Supabase (in memory), Linq (sends and the
// chat member lookup), Foursquare `near`, and the two Gemini setup calls.

const MIKE = "+15550000001";
const SAM = "+15550000002";
const BOT = "+15559999999";
const GROUP = "chat-group";
const MIKE_DM = "dm-mike";
const SAM_DM = "dm-sam";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  near: vi.fn(),
  tz: vi.fn(),
  dates: vi.fn(),
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
    const chatId = phone === MIKE ? MIKE_DM : phone === SAM ? SAM_DM : `dm:${phone}`;
    h.sent.push({ chatId, text });
    return { chatId, messageId: `out-${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
  react: vi.fn(async () => {}),
}));
vi.mock("@/lib/linq/client", () => ({
  getLinqClient: () => ({
    chats: {
      retrieve: () => ({
        asResponse: async () =>
          new Response(
            JSON.stringify({
              display_name: "tokyo crew",
              handles: [
                { handle: MIKE, is_me: false, display_name: "Mike" },
                { handle: SAM, is_me: false, display_name: "Sam" },
                { handle: BOT, is_me: true },
              ],
            }),
            { status: 200 },
          ),
      }),
    },
  }),
}));
vi.mock("@/lib/places/foursquare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/places/foursquare")>()),
  resolveNearArea: h.near,
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class NoNetworkProvider {
    async complete() {
      return "";
    }
  }
  return {
    ...actual,
    GeminiProvider: NoNetworkProvider,
    inferPlaceTimezone: h.tz,
    extractTripDates: h.dates,
    matchClaimText: vi.fn(async () => null),
    scorePhotoFidelity: vi.fn(),
  };
});

import { dispatchLinqEvent } from "./dispatch";

let n = 0;
function msg(from: string, chatId: string, text: string) {
  n += 1;
  const isGroup = chatId === GROUP;
  return {
    event_id: `evt-${n}`,
    event_type: "message.received",
    data: {
      id: `msg-${n}`,
      chat_id: chatId,
      chat: { id: chatId, is_group: isGroup },
      sender_handle: { handle: from, is_me: false, display_name: from === MIKE ? "Mike" : "Sam" },
      parts: [{ type: "text", value: text }],
    },
  };
}
const send = (from: string, chatId: string, text: string) =>
  dispatchLinqEvent(msg(from, chatId, text));

const trips = () => h.db.table("trips");
const openTrip = () => trips().find((t) => t.state !== "complete");
const person = (phone: string) =>
  h.db.table("participants").find((p) => p.phone === phone && p.trip_id === openTrip()?.id);
const lastTo = (chatId: string) => [...h.sent].reverse().find((m) => m.chatId === chatId)?.text;
const allTo = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).map((m) => m.text);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T03:00:00Z"));
  process.env.LINQ_FROM_NUMBER = BOT;
  process.env.JAPLAN_SOLO_MODE = "false";
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.near.mockReset().mockResolvedValue({
    lat: 35.68,
    lng: 139.76,
    locality: "Chiyoda",
    region: "Tokyo",
    country: "JP",
  });
  h.tz.mockReset().mockResolvedValue({ display: "tokyo, japan", timezone: "Asia/Tokyo" });
  h.dates.mockReset().mockResolvedValue({ start: "2026-10-17", end: "2026-10-20" });
});

afterEach(() => {
  vi.useRealTimers();
});

async function bootstrapGroup() {
  await send(MIKE, GROUP, "we're doing this");
}

async function finishSurvey(phone: string, dm: string) {
  // Jump to the last question, then answer it for real.
  const p = person(phone)!;
  p.survey_state = "splitting";
  p.survey_json = {};
  await send(phone, dm, "yes");
}

describe("organizer setup", () => {
  it("asks the first group messager the four setup questions, then their survey", async () => {
    await bootstrapGroup();
    const trip = openTrip()!;
    expect(trip.organizer_participant_id).toBe(person(MIKE)!.id);
    expect(trip.setup_state).toBe("destination");
    expect(lastTo(MIKE_DM)).toBe(
      "trip setup, 4 quick ones. ok where we headed? a city is plenty. (skip and i'll ask again later)",
    );
    expect(lastTo(SAM_DM)).toMatch(/^quick personality test.*stupidly pretty\?$/); // Sam gets the personal survey

    await send(MIKE, MIKE_DM, "tokyo");
    expect(openTrip()!.destination).toBe("tokyo, japan");
    expect(openTrip()!.timezone).toBe("Asia/Tokyo");
    expect(h.near).toHaveBeenCalledWith("tokyo");
    expect(lastTo(MIKE_DM)).toMatch(/^got it: tokyo, japan\. when's this happening\?/);

    await send(MIKE, MIKE_DM, "oct 17-20");
    expect(openTrip()!.start_date).toBe("2026-10-17");
    expect(openTrip()!.end_date).toBe("2026-10-20");
    expect(lastTo(MIKE_DM)).toMatch(/^locked in: oct 17 to oct 20\. how unhinged/);

    await send(MIKE, MIKE_DM, "unhinged");
    expect(openTrip()!.difficulty).toBe("unhinged");

    await send(MIKE, MIKE_DM, "karaoke solo in shinjuku");
    expect(openTrip()!.stake_text).toBe("karaoke solo in shinjuku");
    expect(openTrip()!.setup_state).toBe("done");
    expect(lastTo(MIKE_DM)).toBe(
      `say less, noted. setup's done, we're so back. quick personality test, because asking "what do you like" is useless. pick whatever you'd rather be doing, don't overthink it. say skip whenever. insane local food spot you've never heard of, or kayaking somewhere stupidly pretty?`,
    );
    expect(person(MIKE)!.survey_state).toBe("ab_food_outdoors");
  });

  it("does not go active until destination and dates are set, then does", async () => {
    await bootstrapGroup();
    await send(MIKE, MIKE_DM, "skip");
    await send(MIKE, MIKE_DM, "skip");
    await send(MIKE, MIKE_DM, "chill");
    await send(MIKE, MIKE_DM, "skip");
    expect(openTrip()!.setup_state).toBe("deferred");
    expect(lastTo(MIKE_DM)).toMatch(/setup's paused rq\. still need where and when/);

    await finishSurvey(SAM, SAM_DM);
    // Nobody else holds Sam up; only the missing destination and dates do.
    expect(lastTo(SAM_DM)).toContain("waiting on the trip setup");
    await finishSurvey(MIKE, MIKE_DM);
    expect(openTrip()!.state).toBe("surveying"); // surveys done, setup still blocks
    // Asked again on his next message, in the same reply as the survey end.
    expect(lastTo(MIKE_DM)).toMatch(/ok where we headed\?/);
    expect(openTrip()!.setup_state).toBe("destination");

    await send(MIKE, MIKE_DM, "tokyo");
    await send(MIKE, MIKE_DM, "oct 17-20");
    await send(MIKE, MIKE_DM, "skip");
    await send(MIKE, MIKE_DM, "skip");
    expect(openTrip()!.state).toBe("active");
    // Trip runs oct 17-20; boards start on its first morning, not before.
    expect(lastTo(GROUP)).toBe(
      "we're live 🔥 every morning your tasks land in your dms, and a code like A1 claims one. first board drops oct 17 at 8am.",
    );
    // Both were ready and waiting on setup: each gets day 1 now, marked as
    // provisional, with the sidequest question, in ONE message each. Mike's
    // rides in his setup reply.
    for (const dm of [SAM_DM, MIKE_DM]) {
      expect(lastTo(dm)).toMatch(/Day 1, might still change/);
      expect(lastTo(dm)).toMatch(/btw i'm turning on sidequests/);
    }
    expect(allTo(MIKE_DM).filter((t) => /Day 1/.test(t))).toHaveLength(1);
    expect(allTo(SAM_DM).filter((t) => /Day 1/.test(t))).toHaveLength(1);
  });

  it("asks again on the organizer's next message, not on a timer", async () => {
    await bootstrapGroup();
    for (const answer of ["skip", "skip", "skip", "skip"]) await send(MIKE, MIKE_DM, answer);
    person(MIKE)!.survey_state = "done";
    const before = h.sent.length;
    vi.setSystemTime(new Date("2026-09-20T03:00:00Z")); // a day passes: nothing sent
    expect(h.sent.length).toBe(before);
    await send(MIKE, MIKE_DM, "hey");
    expect(lastTo(MIKE_DM)).toBe("ok where we headed? a city is plenty. (skip and i'll ask again later)");
  });

  it("stores the raw string when the places layer cannot resolve it", async () => {
    h.near.mockResolvedValue(null);
    h.tz.mockResolvedValue({ display: "somewhere", timezone: "JST" });
    await bootstrapGroup();
    await send(MIKE, MIKE_DM, "that island my cousin went to");
    expect(openTrip()!.destination).toBe("that island my cousin went to");
    expect(openTrip()!.timezone ?? null).toBeNull(); // "JST" is not an IANA zone
    expect(lastTo(MIKE_DM)).toMatch(/couldn't pin it on a map though, so times run on utc/);
  });

  it("sets the live DM's dates and Tokyo timezone with Gemini down", async () => {
    // Reproduces the live failure: Foursquare out of credits, every Gemini
    // call erroring. Neither answer should need a model.
    h.near.mockResolvedValue(null);
    h.tz.mockRejectedValue(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'));
    h.dates.mockRejectedValue(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'));
    await bootstrapGroup();

    await send(MIKE, MIKE_DM, "Tokyo");
    expect(openTrip()!.destination).toBe("Tokyo");
    expect(openTrip()!.timezone).toBe("Asia/Tokyo");
    expect(lastTo(MIKE_DM)).toMatch(/^got it: Tokyo\. when's this happening\?/);
    expect(lastTo(MIKE_DM)).not.toMatch(/utc/);
    expect(h.tz).not.toHaveBeenCalled();

    await send(MIKE, MIKE_DM, "Oct 20-26");
    expect(openTrip()!.start_date).toBe("2026-10-20");
    expect(openTrip()!.end_date).toBe("2026-10-26");
    expect(lastTo(MIKE_DM)).toMatch(/^locked in: oct 20 to oct 26\./);
    expect(h.dates).not.toHaveBeenCalled();
  });

  it("uses Gemini only for places the lookup does not know", async () => {
    h.near.mockResolvedValue(null);
    h.tz.mockResolvedValue({ display: "koh phangan", timezone: "Asia/Bangkok" });
    await bootstrapGroup();
    await send(MIKE, MIKE_DM, "koh phangan");
    expect(h.tz).toHaveBeenCalledOnce();
    expect(openTrip()!.timezone).toBe("Asia/Bangkok");
    expect(openTrip()!.destination).toBe("koh phangan"); // unresolved: raw text
  });

  it("re-asks unreadable dates and difficulty instead of storing them", async () => {
    await bootstrapGroup();
    await send(MIKE, MIKE_DM, "tokyo");
    h.dates.mockResolvedValue(null);
    await send(MIKE, MIKE_DM, "sometime soon");
    expect(lastTo(MIKE_DM)).toBe(`couldn't read those dates. try something like "oct 17-20".`);
    await send(MIKE, MIKE_DM, "2026-10-20 to 2026-10-17");
    expect(lastTo(MIKE_DM)).toMatch(/ends before it starts/);
    expect(openTrip()!.setup_state).toBe("dates");
    await send(MIKE, MIKE_DM, "2026-10-17 to 2026-10-20");
    await send(MIKE, MIKE_DM, "medium-ish");
    expect(lastTo(MIKE_DM)).toBe("didn't catch that lol. reply chill / normal / unhinged, or skip.");
    expect(openTrip()!.setup_state).toBe("difficulty");
  });
});

describe("japlan setup mid-trip", () => {
  async function activeTrip() {
    await bootstrapGroup();
    for (const answer of ["tokyo", "oct 17-20", "normal", "buys ramen"]) {
      await send(MIKE, MIKE_DM, answer);
    }
    await finishSurvey(MIKE, MIKE_DM);
    await finishSurvey(SAM, SAM_DM);
    expect(openTrip()!.state).toBe("active");
    openTrip()!.destination_profile_json = { destination: "tokyo, japan", neighborhoods: [{ name: "Asakusa" }] };
  }

  it("lets the organizer change the destination and refreshes the profile", async () => {
    await activeTrip();
    await send(MIKE, GROUP, "japlan setup");
    expect(lastTo(GROUP)).toBe("setup questions are in your dms 📩");
    expect(lastTo(MIKE_DM)).toContain("(rn: tokyo, japan. skip keeps it)");

    h.tz.mockResolvedValue({ display: "osaka, japan", timezone: "Asia/Tokyo" });
    await send(MIKE, MIKE_DM, "osaka");
    const trip = openTrip()!;
    expect(trip.destination).toBe("osaka, japan");
    expect((trip.destination_profile_json as { partial?: boolean }).partial).toBe(true);
    expect((trip.destination_profile_json as { destination: string }).destination).toBe("osaka, japan");

    for (const answer of ["skip", "skip", "skip"]) await send(MIKE, MIKE_DM, answer);
    expect(openTrip()!.setup_state).toBe("done");
    expect(openTrip()!.state).toBe("active");
    expect(openTrip()!.start_date).toBe("2026-10-17"); // skip kept it
    expect(lastTo(MIKE_DM)).toBe("setup's done, we're so back.");
  });

  it("keeps the profile when the destination is unchanged", async () => {
    await activeTrip();
    await send(MIKE, MIKE_DM, "japlan setup");
    await send(MIKE, MIKE_DM, "tokyo");
    expect((openTrip()!.destination_profile_json as { partial?: boolean }).partial).toBeUndefined();
  });

  it("refuses anyone but the organizer", async () => {
    await activeTrip();
    await send(SAM, GROUP, "japlan setup");
    expect(lastTo(GROUP)).toBe("only Mike can change the setup, that's the rule lol.");
  });
});

describe("end trip and new trip", () => {
  async function activeTripWithScores() {
    await bootstrapGroup();
    for (const answer of ["tokyo", "oct 17-20", "normal", "karaoke solo"]) {
      await send(MIKE, MIKE_DM, answer);
    }
    await finishSurvey(MIKE, MIKE_DM);
    await finishSurvey(SAM, SAM_DM);
    person(MIKE)!.score = 120;
    person(SAM)!.score = 40;
  }

  it("ends only after confirmation and posts final standings with the stake", async () => {
    await activeTripWithScores();
    await send(SAM, GROUP, "japlan end trip");
    expect(lastTo(GROUP)).toBe("only Mike can end the trip, that's the rule lol.");
    await send(MIKE, GROUP, "japlan end trip");
    expect(lastTo(GROUP)).toBe(
      "this ends the trip and the scores are final. send 'japlan end trip confirm' if you mean it.",
    );
    expect(openTrip()?.state).toBe("active");

    await send(MIKE, GROUP, "japlan end trip confirm");
    expect(trips()[0].state).toBe("complete");
    expect(trips()[0].completed_at).toBeTruthy();
    expect(lastTo(GROUP)).toBe("it's over 😭 final: Mike 120 · Sam 40\nSam is on the hook, no takebacks: karaoke solo");
  });

  it("keeps the chat quiet after the end until someone asks for a new trip", async () => {
    await activeTripWithScores();
    await send(MIKE, GROUP, "japlan end trip confirm");
    const sentBefore = h.sent.length;

    await send(SAM, GROUP, "lol good trip");
    expect(trips()).toHaveLength(1); // no silent trip two
    expect(h.sent.length).toBe(sentBefore);

    await send(SAM, GROUP, "A1");
    expect(lastTo(GROUP)).toBe(`this trip's over. "japlan new trip" starts another one.`);

    await send(SAM, GROUP, "japlan new trip");
    expect(trips()).toHaveLength(2);
    const second = openTrip()!;
    expect(second.state).toBe("surveying");
    expect(second.organizer_participant_id).toBe(person(SAM)!.id); // whoever asked
    expect(lastTo(SAM_DM)).toMatch(/^trip setup, 4 quick ones\./);
    expect(allTo(GROUP).filter((t) => /^heyyyy i'm japlan/.test(t))).toHaveLength(2);

    await send(MIKE, GROUP, "japlan new trip");
    expect(lastTo(GROUP)).toBe(`there's already a trip running lol. "japlan end trip" first.`);
    expect(trips()).toHaveLength(2);
  });

  it("answers end trip with nothing running", async () => {
    await activeTripWithScores();
    await send(MIKE, GROUP, "japlan end trip confirm");
    await send(MIKE, GROUP, "japlan end trip");
    expect(lastTo(GROUP)).toBe(`this trip's over. "japlan new trip" starts another one.`);
  });
});
