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
  sent: [] as { chatId: string; text: string; effect?: unknown }[],
  near: vi.fn(),
  tz: vi.fn(),
  dates: vi.fn(),
  shareContactCard: vi.fn(async () => {}),
}));

// No network in tests: board generation asks for the day's weather.
vi.mock("@/lib/game/weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/game/weather")>()),
  fetchDayWeather: vi.fn(async () => ({ temperatureC: 20, precipitationChance: 0, summary: "clear", indoorPreferred: false })),
}));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string, opts?: { effect?: unknown }) => {
    h.sent.push({ chatId, text, effect: opts?.effect });
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
  shareContactCardSafely: h.shareContactCard,
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
const lastMessageTo = (chatId: string) => [...h.sent].reverse().find((m) => m.chatId === chatId);

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
  h.shareContactCard.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function bootstrapGroup() {
  await send(MIKE, GROUP, "we're doing this");
}

// Shared trip settings are decided in the shared chat, with the keyword.
// GROUP_INTRO says so out loud: "first, we set the city, dates, and play
// style in this chat. then i'll DM each person a short private preference
// survey." Only the personal survey is a DM.
const setupAnswer = (text: string) => send(MIKE, GROUP, `japlan ${text}`);

// destination, dates, play mode, difficulty, stake.
const SETUP_ANSWERS = ["tokyo", "oct 17-20", "1", "normal", "buys ramen"];
async function finishSetup(answers: string[] = SETUP_ANSWERS) {
  for (const answer of answers) await setupAnswer(answer);
}

async function finishSurvey(phone: string, dm: string) {
  // Jump to the last question, then answer it for real.
  const p = person(phone)!;
  p.survey_state = "splitting";
  p.survey_json = {};
  await send(phone, dm, "yes");
}

describe("organizer setup", () => {
  it("asks the organizer the setup questions in the group, then dms everyone the survey", async () => {
    await bootstrapGroup();
    const trip = openTrip()!;
    expect(trip.organizer_participant_id).toBe(person(MIKE)!.id);
    expect(trip.setup_state).toBe("destination");
    // The shared settings are asked where everyone can see them being set.
    const opening = lastTo(GROUP)!;
    expect(opening).toContain("Mike is the organizer");
    expect(opening).toContain("ok where we headed?");
    expect(opening).toContain("Reply here with");
    // Nobody's DM opens until there is a trip to survey them about.
    expect(lastTo(MIKE_DM)).toBeUndefined();
    expect(lastTo(SAM_DM)).toBeUndefined();
    expect(h.shareContactCard).toHaveBeenCalledWith(GROUP);

    await setupAnswer("tokyo");
    expect(openTrip()!.destination).toBe("tokyo, japan");
    expect(openTrip()!.timezone).toBe("Asia/Tokyo");
    expect(h.near).toHaveBeenCalledWith("tokyo");
    expect(lastTo(GROUP)).toMatch(/^got it: tokyo, japan\. when's this happening\?/);

    await setupAnswer("oct 17-20");
    expect(openTrip()!.start_date).toBe("2026-10-17");
    expect(openTrip()!.end_date).toBe("2026-10-20");
    expect(lastTo(GROUP)).toMatch(/^locked in: oct 17 to oct 20\. how should we play\?/);

    await setupAnswer("1");
    expect(openTrip()!.play_mode).toBe("individual");
    expect(lastTo(GROUP)).toMatch(/how unhinged should the tasks be\?/);

    await setupAnswer("unhinged");
    expect(openTrip()!.difficulty).toBe("unhinged");

    await setupAnswer("karaoke solo in shinjuku");
    expect(openTrip()!.stake_text).toBe("karaoke solo in shinjuku");
    expect(openTrip()!.setup_state).toBe("done");

    // Now, and only now, the private survey goes out, to everyone at once.
    expect(lastTo(MIKE_DM)).toContain("what should i call you?");
    expect(lastTo(SAM_DM)).toContain("what should i call you?");
    expect(person(MIKE)!.survey_state).toBe("first_name");
    expect(person(SAM)!.survey_state).toBe("first_name");
    // The group hears who was asked, never a word of what they answer.
    expect(lastTo(GROUP)).toContain("sent to: Mike, Sam");
    expect(lastTo(GROUP)).not.toMatch(/what should i call you/);
    // Each chat that just got its first message gets the Name & Photo too.
    expect(h.shareContactCard).toHaveBeenCalledWith(MIKE_DM);
    expect(h.shareContactCard).toHaveBeenCalledWith(SAM_DM);
  });

  it("will not hand out the surveys until there is a destination", async () => {
    await bootstrapGroup();
    // A skip is honoured on every other question. Not this one: a survey
    // shapes tasks around a place, so there is nothing to ask about yet. It
    // re-asks rather than deferring into a trip nobody can play.
    for (let i = 0; i < 3; i += 1) await setupAnswer("skip");
    expect(openTrip()!.setup_state).toBe("destination");
    expect(openTrip()!.state).toBe("setup");
    expect(lastTo(GROUP)).toMatch(/need to set the destination before i can send/);
    expect(lastTo(MIKE_DM)).toBeUndefined();
    expect(lastTo(SAM_DM)).toBeUndefined();

    // Destination, dates and play mode are the three the trip cannot run
    // without. Everything after them is skippable, and setup still lands.
    await finishSetup(["tokyo", "oct 17-20", "1", "skip", "skip"]);
    expect(openTrip()!.setup_state).toBe("done");
    expect(openTrip()!.state).toBe("surveying");
    expect(lastTo(MIKE_DM)).toContain("what should i call you?");
    expect(lastTo(SAM_DM)).toContain("what should i call you?");
  });

  it("goes live on the first finished survey, not on everyone's", async () => {
    await bootstrapGroup();
    await finishSetup();
    await finishSurvey(SAM, SAM_DM);
    expect(openTrip()!.state).toBe("active");
    // Trip runs oct 17-20; boards start on its first morning, not before.
    expect(allTo(GROUP).some((t) => /we're live/.test(t))).toBe(true);
    // Sam is ready, so Sam gets day 1 now, marked provisional, with the
    // sidequest question, in ONE message.
    expect(lastTo(SAM_DM)).toMatch(/btw i'm turning on sidequests/);
    expect(allTo(SAM_DM).filter((t) => /Day 1/.test(t))).toHaveLength(1);
    // Mike has not finished his, and hears nothing about Sam's.
    expect(allTo(MIKE_DM).filter((t) => /Day 1/.test(t))).toHaveLength(0);
  });

  it("re-asks on the organizer's next answer, not on a timer", async () => {
    await bootstrapGroup();
    await setupAnswer("skip");
    const before = h.sent.length;
    vi.setSystemTime(new Date("2026-09-20T03:00:00Z")); // a day passes: nothing sent
    expect(h.sent.length).toBe(before);
    // An unaddressed line is not an answer and does not restart anything.
    await send(MIKE, GROUP, "lol");
    expect(h.sent.length).toBe(before);
    await setupAnswer("tokyo");
    expect(openTrip()!.destination).toBe("tokyo, japan");
  });

  it("stores the raw string when the places layer cannot resolve it", async () => {
    h.near.mockResolvedValue(null);
    h.tz.mockResolvedValue({ display: "somewhere", timezone: "JST" });
    await bootstrapGroup();
    await setupAnswer("that island my cousin went to");
    expect(openTrip()!.destination).toBe("that island my cousin went to");
    expect(openTrip()!.timezone ?? null).toBeNull(); // "JST" is not an IANA zone
    expect(lastTo(GROUP)).toMatch(/couldn't pin it on a map though, so times run on utc/);
  });

  it("sets dates and the Tokyo timezone with Gemini down", async () => {
    // Reproduces the live failure: Foursquare out of credits, every Gemini
    // call erroring. Neither answer should need a model.
    h.near.mockResolvedValue(null);
    h.tz.mockRejectedValue(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'));
    h.dates.mockRejectedValue(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'));
    await bootstrapGroup();

    await setupAnswer("Tokyo");
    expect(openTrip()!.destination).toBe("Tokyo");
    expect(openTrip()!.timezone).toBe("Asia/Tokyo");
    expect(lastTo(GROUP)).toMatch(/^got it: Tokyo\. when's this happening\?/);
    expect(lastTo(GROUP)).not.toMatch(/utc/);
    expect(h.tz).not.toHaveBeenCalled();

    await setupAnswer("Oct 20-26");
    expect(openTrip()!.start_date).toBe("2026-10-20");
    expect(openTrip()!.end_date).toBe("2026-10-26");
    expect(lastTo(GROUP)).toMatch(/^locked in: oct 20 to oct 26\./);
    expect(h.dates).not.toHaveBeenCalled();
  });

  it("uses Gemini only for places the lookup does not know", async () => {
    h.near.mockResolvedValue(null);
    h.tz.mockResolvedValue({ display: "koh phangan", timezone: "Asia/Bangkok" });
    await bootstrapGroup();
    await setupAnswer("koh phangan");
    expect(h.tz).toHaveBeenCalledOnce();
    expect(openTrip()!.timezone).toBe("Asia/Bangkok");
    expect(openTrip()!.destination).toBe("koh phangan"); // unresolved: raw text
  });

  it("re-asks unreadable dates and difficulty instead of storing them", async () => {
    await bootstrapGroup();
    await setupAnswer("tokyo");
    h.dates.mockResolvedValue(null);
    await setupAnswer("sometime soon");
    expect(lastTo(GROUP)).toBe(`couldn't read those dates. try something like "oct 17-20".`);
    await setupAnswer("2026-10-20 to 2026-10-17");
    expect(lastTo(GROUP)).toMatch(/ends before it starts/);
    expect(openTrip()!.setup_state).toBe("dates");

    await setupAnswer("2026-10-17 to 2026-10-20");
    await setupAnswer("1");
    await setupAnswer("medium-ish");
    expect(lastTo(GROUP)).toBe("didn't catch that lol. reply chill / normal / unhinged, or skip.");
    expect(openTrip()!.setup_state).toBe("difficulty");
  });
});

describe("japlan setup mid-trip", () => {
  async function activeTrip() {
    await bootstrapGroup();
    await finishSetup();
    await finishSurvey(MIKE, MIKE_DM);
    await finishSurvey(SAM, SAM_DM);
    expect(openTrip()!.state).toBe("active");
    openTrip()!.destination_profile_json = { destination: "tokyo, japan", neighborhoods: [{ name: "Asakusa" }] };
  }

  it("lets the organizer change the destination and refreshes the profile", async () => {
    await activeTrip();
    await send(MIKE, GROUP, "japlan setup");
    // Re-run, same place as the first run: the shared chat.
    expect(lastTo(GROUP)).toContain("(rn: tokyo, japan. skip keeps it)");

    h.tz.mockResolvedValue({ display: "osaka, japan", timezone: "Asia/Tokyo" });
    await setupAnswer("osaka");
    const trip = openTrip()!;
    expect(trip.destination).toBe("osaka, japan");
    expect((trip.destination_profile_json as { partial?: boolean }).partial).toBe(true);
    expect((trip.destination_profile_json as { destination: string }).destination).toBe("osaka, japan");

    // A re-run keeps the existing value on a skip, so these are answerable.
    for (const answer of ["skip", "skip", "skip", "skip"]) await setupAnswer(answer);
    expect(openTrip()!.setup_state).toBe("done");
    expect(openTrip()!.state).toBe("active");
    expect(openTrip()!.start_date).toBe("2026-10-17"); // skip kept it
  });

  it("keeps the profile when the destination is unchanged", async () => {
    await activeTrip();
    await send(MIKE, GROUP, "japlan setup");
    await setupAnswer("tokyo");
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
    await finishSetup(["tokyo", "oct 17-20", "1", "normal", "karaoke solo"]);
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
    // The decision is that one "end trip" is not enough, not how it is worded.
    expect(lastTo(GROUP)).toMatch(/scores are final/);
    expect(lastTo(GROUP)).toMatch(/japlan end trip confirm/);
    expect(openTrip()?.state).toBe("active");

    await send(MIKE, GROUP, "japlan end trip confirm");
    expect(trips()[0].state).toBe("complete");
    expect(trips()[0].completed_at).toBeTruthy();
    expect(lastTo(GROUP)).toBe("it's over 😭 final: Mike 120 · Sam 40\nSam is on the hook, no takebacks: karaoke solo");
    expect(lastMessageTo(GROUP)?.effect).toEqual({ type: "screen", name: "confetti" });
  });

  it("only confettis once: a second end-trip attempt on the same trip gets no effect", async () => {
    await activeTripWithScores();
    await send(MIKE, GROUP, "japlan end trip confirm");
    const confettiCount = h.sent.filter(
      (m) => JSON.stringify(m.effect) === JSON.stringify({ type: "screen", name: "confetti" }),
    ).length;
    expect(confettiCount).toBe(1);

    await send(MIKE, GROUP, "japlan end trip confirm");
    const confettiCountAfter = h.sent.filter(
      (m) => JSON.stringify(m.effect) === JSON.stringify({ type: "screen", name: "confetti" }),
    ).length;
    expect(confettiCountAfter).toBe(1);
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
    // A fresh trip starts at setup: no survey goes out before there is a city.
    expect(second.state).toBe("setup");
    expect(second.organizer_participant_id).toBe(person(SAM)!.id); // whoever asked
    // The second trip is set up the same way the first was: in the group.
    expect(lastTo(GROUP)).toContain("ok where we headed?");
    expect(allTo(GROUP).filter((t) => /i'm japlan\./.test(t))).toHaveLength(2);

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
