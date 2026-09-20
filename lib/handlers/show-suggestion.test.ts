import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));

import { pickEvent, suggestShowOnce, ticketedMustHave, type TripEvent } from "./show-suggestion";

const TRIP = {
  id: "trip-1",
  linq_chat_id: "chat-1",
  destination: "Tokyo",
  start_date: "2026-10-01",
  end_date: "2026-10-06",
  timezone: "Asia/Tokyo",
  state: "active",
} as never;

function person(id: string, name: string, mustHave?: string) {
  return {
    id,
    trip_id: "trip-1",
    phone: `+1${id}`,
    display_name: name,
    score: 0,
    survey_json: mustHave ? { must_have: { value: mustHave, confidence: "high" } } : {},
  };
}

function event(over: Partial<TripEvent> & { url: string }): Record<string, unknown> {
  return {
    id: `ev-${over.url.slice(-4)}`,
    trip_id: "trip-1",
    name: "Kabuki at Kabukiza Theatre",
    venue: "Kabukiza Theatre",
    lat: 35.6695,
    lng: 139.7674,
    starts_at: "2026-10-03T10:00:00.000Z", // 19:00 JST
    category: "culture",
    price_note: null,
    source: "seed",
    ...over,
  };
}

function seed(people: ReturnType<typeof person>[], events: Record<string, unknown>[] = []) {
  h.db = new FakeSupabase();
  h.db.seed("trips", [{ ...(TRIP as object), show_suggested_at: null }]);
  h.db.seed("participants", people);
  if (events.length) h.db.seed("trip_events", events);
}

const trip = () => h.db.table("trips")[0];
const people = () => h.db.table("participants") as never;

beforeEach(() => {
  seed([person("p-sarah", "Sarah", "see a show")], [event({ url: "https://tix.example/kabuki" })]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("whose must-have is worth a ticket", () => {
  it("picks the one you can actually buy a ticket to", () => {
    const list = [person("p-dev", "Dev", "eat at a 7-eleven"), person("p-sarah", "Sarah", "see a show")];
    expect(ticketedMustHave(list as never)?.person.display_name).toBe("Sarah");
  });

  it("ignores a must-have with nothing to buy, and an absent one", () => {
    expect(ticketedMustHave([person("p-dev", "Dev", "eat at a 7-eleven")] as never)).toBeNull();
    expect(ticketedMustHave([person("p-dev", "Dev")] as never)).toBeNull();
  });
});

describe("choosing between events", () => {
  const events: TripEvent[] = [
    { ...(event({ url: "a" }) as unknown as TripEvent), name: "Morning flea market", category: "shopping", starts_at: "2026-10-03T01:00:00.000Z" },
    { ...(event({ url: "b" }) as unknown as TripEvent), name: "Live jazz show", category: "nightlife", starts_at: "2026-10-03T10:00:00.000Z" },
    { ...(event({ url: "c" }) as unknown as TripEvent), name: "Museum late opening", category: "culture", starts_at: "2026-10-03T11:00:00.000Z" },
  ];

  it("prefers the event whose words match what they actually said", () => {
    expect(pickEvent({ events, mustHave: "see a show", interests: [] })?.name).toBe("Live jazz show");
  });

  it("falls back to an interest lean when nothing matches the words", () => {
    expect(pickEvent({ events, mustHave: "do something", interests: ["culture"] })?.name).toBe(
      "Museum late opening",
    );
  });

  it("still returns the best available rather than nothing on a thin list", () => {
    const thin = [events[0]];
    expect(pickEvent({ events: thin, mustHave: "see a show", interests: [] })?.name).toBe("Morning flea market");
  });
});

describe("one show, once a trip", () => {
  it("attributes it, names venue and time, and puts the link last and alone", async () => {
    const line = await suggestShowOnce({ trip: TRIP, people: people() });
    expect(line).toBeTruthy();
    expect(line).toContain("Sarah");
    expect(line).toContain("see a show");
    expect(line).toContain("Kabukiza Theatre");
    // A real clock time from a real timestamp, never invented from a date.
    expect(line).toMatch(/saturday \d{1,2}(:\d\d)?(am|pm)/);
    const lines = line!.split("\n");
    expect(lines.at(-1)).toBe("https://tix.example/kabuki");
    expect(line!.match(/https?:\/\//g)).toHaveLength(1);
  });

  // priceRanges was 0% filled in every Discovery market probed, so there is
  // nothing to check a budget against.
  it("says the price is unknown when there is no note, and never invents one", async () => {
    const line = await suggestShowOnce({ trip: TRIP, people: people() });
    expect(line).toMatch(/no idea what tickets cost/);
    expect(line).not.toMatch(/\$|¥|£/);
  });

  it("uses a real price note when the seed supplied one", async () => {
    seed(
      [person("p-sarah", "Sarah", "see a show")],
      [event({ url: "https://tix.example/k2", price_note: "around 4000 yen" })],
    );
    const line = await suggestShowOnce({ trip: TRIP, people: people() });
    expect(line).toContain("around 4000 yen");
    expect(line).not.toMatch(/no idea what tickets cost/);
  });

  // A row is a row: the matcher must not care who wrote it.
  it("treats a discovery row exactly like a seeded one", async () => {
    seed(
      [person("p-sarah", "Sarah", "see a show")],
      [event({ url: "https://tix.example/disc", source: "discovery" })],
    );
    const line = await suggestShowOnce({ trip: TRIP, people: people() });
    expect(line).toContain("Kabukiza Theatre");
    expect(line).toContain("https://tix.example/disc");
  });

  it("never sends a second one for the same trip", async () => {
    expect(await suggestShowOnce({ trip: TRIP, people: people() })).toBeTruthy();
    expect(trip().show_suggested_at).toBeTruthy();
    expect(await suggestShowOnce({ trip: TRIP, people: people() })).toBeNull();
  });

  it("skips an event outside the trip dates instead of suggesting it", async () => {
    seed(
      [person("p-sarah", "Sarah", "see a show")],
      [event({ url: "https://tix.example/late", starts_at: "2026-11-20T10:00:00.000Z" })],
    );
    expect(await suggestShowOnce({ trip: TRIP, people: people() })).toBeNull();
    // The one slot stays free for a later tick with real inventory.
    expect(trip().show_suggested_at ?? null).toBeNull();
  });

  it("is silent with no inventory at all", async () => {
    seed([person("p-sarah", "Sarah", "see a show")], []);
    expect(await suggestShowOnce({ trip: TRIP, people: people() })).toBeNull();
    expect(trip().show_suggested_at ?? null).toBeNull();
  });

  it("is silent when nobody's must-have is ticketed", async () => {
    seed([person("p-dev", "Dev", "eat at a 7-eleven")], [event({ url: "https://tix.example/x" })]);
    expect(await suggestShowOnce({ trip: TRIP, people: people() })).toBeNull();
  });
});
