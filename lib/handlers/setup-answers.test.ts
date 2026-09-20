import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Two live bugs in group setup, same class as the trip-settings corruption.
//
//  1. The flow asked "where we headed?", nobody answered with a city, and the
//     next message said "got it: kronjo, indonesia". A resolver handed text
//     that was not a destination will find the nearest-sounding city in it
//     rather than refusing.
//  2. "japlan where did you get that city from" was consumed as the DATE
//     answer and got "couldn't read those dates". A question is not an answer,
//     and while that was true a wrong value could never be corrected, because
//     the correction became the next answer.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  // What the places layer says. Null is the live state: out of credits.
  area: null as null | Record<string, unknown>,
  // What the model would name, given anything at all.
  named: null as null | { display: string; timezone: string },
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return { chatId, messageId: `m${h.sent.length}` };
  }),
  sendDM: vi.fn(async () => ({ chatId: "dm", messageId: "m" })),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
  react: vi.fn(async () => {}),
}));
vi.mock("@/lib/places/foursquare", () => ({ resolveNearArea: vi.fn(async () => h.area) }));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  return {
    ...actual,
    // The model always names somewhere. That is the point.
    inferPlaceTimezone: vi.fn(async () => h.named),
    extractTripDates: vi.fn(async () => null),
  };
});

import { answerSetup, resolveDestinationAnswer } from "./setup";

const TRIP = {
  id: "trip-1",
  linq_chat_id: "chat-1",
  destination: null,
  start_date: null,
  end_date: null,
  state: "setup",
  is_solo: false,
  setup_state: "destination",
  organizer_participant_id: "p-mike",
  timezone: null,
} as never;

const ORGANIZER = { id: "p-mike", trip_id: "trip-1", phone: "+1555", display_name: "Mike" } as never;

function seed(over: Record<string, unknown> = {}) {
  h.db = new FakeSupabase();
  h.db.seed("trips", [{ ...(TRIP as object), ...over }]);
  h.db.seed("participants", [ORGANIZER as unknown as Record<string, unknown>]);
}

const trip = () => h.db.table("trips")[0];

beforeEach(() => {
  h.sent.length = 0;
  h.area = null;
  h.named = { display: "kronjo, indonesia", timezone: "Asia/Jakarta" };
  seed();
});
afterEach(() => vi.clearAllMocks());

describe("a destination is only written when the person named it", () => {
  it("refuses to turn a question into a city", async () => {
    const found = await resolveDestinationAnswer("where did you get that city from");
    expect(found.confidence).toBe("unusable");
    expect(found.timezone).toBeNull();
  });

  it("refuses a sentence, a correction and an empty-ish answer", async () => {
    for (const text of ["that's wrong", "no", "why kronjo", "?"]) {
      expect((await resolveDestinationAnswer(text)).confidence).toBe("unusable");
    }
  });

  it("never lets a model display name through without a real places hit", async () => {
    h.area = null; // places out of credits, which is the live state
    const found = await resolveDestinationAnswer("Tokyo");
    // Their words, not the model's.
    expect(found.destination).toBe("Tokyo");
    expect(found.destination).not.toContain("kronjo");
    expect(found.confidence).toBe("lookup");
  });

  it("uses the model's tidy name only when a places lookup corroborated it", async () => {
    h.area = { lat: 35.68, lng: 139.76, locality: "Tokyo", region: null, country: "JP" };
    h.named = { display: "tokyo, japan", timezone: "Asia/Tokyo" };
    const found = await resolveDestinationAnswer("tokyo");
    expect(found.destination).toBe("tokyo, japan");
    expect(found.confidence).toBe("lookup");
  });

  it("re-asks instead of confirming a city nobody named", async () => {
    const reply = await answerSetup({ trip: TRIP, organizer: ORGANIZER, text: "where did you get that city from" });
    expect(reply).not.toMatch(/got it/i);
    expect(reply).not.toMatch(/kronjo/i);
    // Nothing was written.
    expect(trip().destination ?? null).toBeNull();
    expect(trip().setup_state).toBe("destination");
  });
});

describe("a question during setup is not an answer to it", () => {
  it("answers it and re-asks, instead of eating it as the date", async () => {
    seed({ setup_state: "dates", destination: "Tokyo" });
    const reply = await answerSetup({
      trip: { ...(TRIP as object), setup_state: "dates", destination: "Tokyo" } as never,
      organizer: ORGANIZER,
      text: "where did you get that city from",
    });
    // The bug: this used to be "couldn't read those dates".
    expect(reply).not.toMatch(/couldn'?t read|didn'?t catch those dates/i);
    // It says where the value came from, then asks the pending question again.
    expect(reply).toMatch(/destination is set to Tokyo/i);
    expect(reply.split("\n\n").length).toBeGreaterThan(1);
    expect(trip().start_date ?? null).toBeNull();
  });

  it("lets a correction undo a wrong answer instead of becoming the next one", async () => {
    seed({ setup_state: "dates", destination: "kronjo, indonesia" });
    const withDates = { ...(TRIP as object), setup_state: "dates", destination: "kronjo, indonesia" } as never;
    const reply = await answerSetup({ trip: withDates, organizer: ORGANIZER, text: "no that's wrong" });
    expect(reply).toMatch(/redo that one/i);
    // The correction did not become the date answer.
    expect(trip().start_date ?? null).toBeNull();
    expect(trip().setup_state).toBe("dates");
  });

  it("still takes a real answer, and still takes a skip", async () => {
    const reply = await answerSetup({ trip: TRIP, organizer: ORGANIZER, text: "Tokyo" });
    expect(reply).toMatch(/tokyo/i);
    expect(trip().destination).toBe("Tokyo");

    seed({ setup_state: "stake", destination: "Tokyo" });
    const skipped = await answerSetup({
      trip: { ...(TRIP as object), setup_state: "stake", destination: "Tokyo" } as never,
      organizer: ORGANIZER,
      text: "skip",
    });
    expect(skipped).toBeTruthy();
  });
});
