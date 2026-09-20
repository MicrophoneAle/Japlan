import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Link resolution end to end. The outcomes that matter:
//   - a hit says ONE line
//   - a miss says NOTHING, ever
//   - an unresolved caption is KEPT, not discarded
//   - every attempt is logged with its source, outcome and extracted text,
//     so the real hit rate comes out of live traffic
//   - no session is ever opened

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as string[],
  reads: [] as { kind: string; url: string }[],
  // What each reader returns, per test.
  tiktok: null as null | { ok: boolean; text?: string; reason?: string },
  page: null as null | { ok: boolean; text?: string; reason?: string },
  place: null as null | { place_name: string; city: string | null; address: string | null; category: string | null },
  geo: null as null | { lat: number; lng: number; label: string },
  geocodeCalls: [] as string[],
  launched: 0,
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));

vi.mock("@/lib/social/read-link", () => ({
  readTikTok: vi.fn(async (url: string) => {
    h.reads.push({ kind: "tiktok", url });
    return h.tiktok ?? { ok: false, reason: "empty_page", via: "oembed" };
  }),
  readPage: vi.fn(async (url: string) => {
    h.reads.push({ kind: "page", url });
    return h.page ?? { ok: false, reason: "empty_page", via: "browserbase.fetch" };
  }),
  followShortLink: vi.fn(async (url: string) => url),
  readerFor: (kind: string) =>
    kind === "tiktok"
      ? async (url: string) => {
          h.reads.push({ kind: "tiktok", url });
          return h.tiktok ?? { ok: false, reason: "empty_page", via: "oembed" };
        }
      : async (url: string) => {
          h.reads.push({ kind: "page", url });
          return h.page ?? { ok: false, reason: "empty_page", via: "browserbase.fetch" };
        },
}));

vi.mock("@/lib/geo/geocode", () => ({
  geocodePlace: vi.fn(async (opts: { name: string }) => {
    h.geocodeCalls.push(opts.name);
    return h.geo;
  }),
}));

vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  return { ...actual, extractPlaceFromText: vi.fn(async () => h.place) };
});

// If anything ever reaches for a session, this test fails loudly.
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: {
    launch: vi.fn(async () => {
      h.launched += 1;
      throw new Error("a session must never be opened on this path");
    }),
    fetch: vi.fn(async () => ({ content: "" })),
    search: vi.fn(async () => ({ results: [] })),
  },
  Stagehand: { create: vi.fn() },
}));

import { captureLinks, resolveQueuedLinks, RESOLUTIONS_PER_TRIP_PER_HOUR } from "./social-links";

const TRIP = {
  id: "trip-1",
  linq_chat_id: "chat-1",
  name: "tokyo",
  destination: "Tokyo",
  start_date: "2026-10-01",
  end_date: "2026-10-06",
  state: "active",
  timezone: "Asia/Tokyo",
  setup_state: "done",
};

function seed(): void {
  h.db = new FakeSupabase();
  h.db.seed("trips", [{ ...TRIP }]);
  h.db.seed("participants", [
    { id: "p-dev", trip_id: "trip-1", phone: "+1555", display_name: "Dev", score: 0 },
  ]);
}

const links = () => h.db.table("social_links");
const places = () => h.db.table("places");
const send = async (text: string) => {
  h.sent.push(text);
};

beforeEach(() => {
  seed();
  h.sent.length = 0;
  h.reads.length = 0;
  h.tiktok = null;
  h.page = null;
  h.place = null;
  h.geo = null;
  h.geocodeCalls.length = 0;
  h.launched = 0;
});

afterEach(() => vi.clearAllMocks());

async function capture(text: string) {
  return captureLinks({ tripId: "trip-1", participantId: "p-dev", chatId: "chat-1", text });
}

describe("noticing a link", () => {
  it("queues it with who posted it, and nothing else", async () => {
    await capture("this place looks unreal https://www.tiktok.com/@a/video/123");
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({
      kind: "tiktok",
      status: "queued",
      participant_id: "p-dev",
      attempts: 0,
    });
    // Capture does no reading at all: that is the whole point of the split.
    expect(h.reads).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("queues ten links from one message without opening anything", async () => {
    const text = Array.from({ length: 10 }, (_, i) => `https://example.com/a${i}`).join(" ");
    await capture(text);
    expect(links()).toHaveLength(10);
    expect(h.reads).toEqual([]);
  });

  it("treats the same link posted twice as one job", async () => {
    await capture("https://www.instagram.com/reel/AAA/");
    await capture("did you see https://www.instagram.com/reel/AAA/");
    expect(links()).toHaveLength(1);
  });

  it("ignores a message with no links", async () => {
    expect(await capture("what time are we going")).toBe(0);
    expect(links()).toHaveLength(0);
  });
});

describe("a link that resolves", () => {
  it("says exactly one line and writes the place", async () => {
    h.tiktok = { ok: true, text: "best french toast 表参道 茶珈堂 1200円" };
    h.place = { place_name: "茶珈堂", city: "Tokyo", address: "Omotesando, Tokyo", category: "cafe" };
    await capture("https://www.tiktok.com/@a/video/123");
    await resolveQueuedLinks(TRIP as never, { send });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("茶珈堂");
    expect(h.sent[0]).toContain("Dev");
    expect(h.sent[0].split("\n")).toHaveLength(1);

    expect(places()).toHaveLength(1);
    expect(places()[0]).toMatchObject({
      name: "茶珈堂",
      address: "Omotesando, Tokyo",
      source: "social",
      suggested_by: "p-dev",
      source_url: "https://www.tiktok.com/@a/video/123",
    });
  });

  // Foursquare is out of credits. A name and an address is enough to put a
  // place on a day, and the id gets backfilled later.
  it("stores it with fsq_place_id null and a resolved_at for the backfill", async () => {
    h.page = { ok: true, text: "📍 Ramen Break Beats (Meguro, Tokyo)" };
    h.place = { place_name: "Ramen Break Beats", city: "Tokyo", address: "Meguro, Tokyo", category: "ramen" };
    await capture("https://www.instagram.com/reel/AAA/");
    await resolveQueuedLinks(TRIP as never, { send });

    const place = places()[0];
    expect(place.fsq_place_id ?? null).toBeNull();
    expect(place.resolved_at).toBeTruthy();
    expect(links()[0]).toMatchObject({ status: "resolved", place_id: place.id });
  });

  it("needs no model at all for a google maps link", async () => {
    await capture("https://www.google.com/maps/place/Tokyo+Tower/@35.6586,139.7454,17z");
    await resolveQueuedLinks(TRIP as never, { send });
    expect(places()[0]).toMatchObject({ name: "Tokyo Tower", lat: 35.6586, lng: 139.7454 });
    expect(links()[0]).toMatchObject({ status: "resolved", outcome: "maps_url" });
    // No page read and no session.
    expect(h.reads).toEqual([]);
    expect(h.launched).toBe(0);
  });
});

describe("a link that resolves to nothing says nothing", () => {
  it("is silent when the page cannot be read at all", async () => {
    h.page = { ok: false, reason: "blocked" };
    await capture("https://www.instagram.com/reel/BBB/");
    await resolveQueuedLinks(TRIP as never, { send });
    expect(h.sent).toEqual([]);
    expect(places()).toHaveLength(0);
    expect(links()[0]).toMatchObject({ status: "failed", outcome: "blocked" });
  });

  it("is silent when the caption names no venue, and KEEPS the caption", async () => {
    h.page = { ok: true, text: "the vibes here are insane no cap #tokyo" };
    h.place = null; // the model found no place, which is normal
    await capture("https://www.instagram.com/reel/CCC/");
    await resolveQueuedLinks(TRIP as never, { send });

    expect(h.sent).toEqual([]);
    expect(places()).toHaveLength(0);
    // Unresolved is a first-class outcome: the text survives so the group can
    // clarify later, and so the hit-rate log has the evidence.
    expect(links()[0]).toMatchObject({ status: "unresolved", outcome: "no_venue" });
    expect(links()[0].extracted_text).toContain("vibes here are insane");
  });

  it("never opens a session, even on the failing paths", async () => {
    h.page = { ok: false, reason: "blocked" };
    await capture("https://www.instagram.com/reel/DDD/ https://www.tiktok.com/@a/video/9");
    await resolveQueuedLinks(TRIP as never, { send });
    expect(h.launched).toBe(0);
  });
});

describe("the queue holds under a flood", () => {
  it("caps how many it resolves per trip per hour and leaves the rest queued", async () => {
    h.page = { ok: false, reason: "empty_page" };
    const many = Array.from(
      { length: RESOLUTIONS_PER_TRIP_PER_HOUR + 5 },
      (_, i) => `https://example.com/a${i}`,
    ).join(" ");
    await capture(many);
    expect(links()).toHaveLength(RESOLUTIONS_PER_TRIP_PER_HOUR + 5);

    await resolveQueuedLinks(TRIP as never, { send });
    const attempted = links().filter((l) => l.status !== "queued");
    expect(attempted).toHaveLength(RESOLUTIONS_PER_TRIP_PER_HOUR);
    expect(links().filter((l) => l.status === "queued")).toHaveLength(5);
  });

  it("tries a link once and then gives up on it", async () => {
    h.page = { ok: false, reason: "blocked" };
    await capture("https://www.instagram.com/reel/EEE/");
    await resolveQueuedLinks(TRIP as never, { send });
    const before = h.reads.length;
    await resolveQueuedLinks(TRIP as never, { send });
    // Already attempted and no longer queued: never read a second time.
    expect(h.reads.length).toBe(before);
  });
});

describe("the hit-rate log", () => {
  it("records source, outcome and extracted text for every attempt", async () => {
    h.tiktok = { ok: true, text: "夜ご飯 at 茶珈堂" };
    h.place = { place_name: "茶珈堂", city: "Tokyo", address: null, category: "cafe" };
    await capture("https://www.tiktok.com/@a/video/1");
    await resolveQueuedLinks(TRIP as never, { send });

    h.tiktok = null;
    h.page = { ok: false, reason: "blocked" };
    await capture("https://www.instagram.com/reel/FFF/");
    await resolveQueuedLinks(TRIP as never, { send });

    const byKind = Object.fromEntries(links().map((l) => [l.kind, { status: l.status, outcome: l.outcome }]));
    expect(byKind.tiktok).toEqual({ status: "resolved", outcome: "venue_no_address" });
    expect(byKind.instagram).toEqual({ status: "failed", outcome: "blocked" });
    // Every row carries when it was tried, which is what makes a rate a rate.
    expect(links().every((l) => Boolean(l.attempted_at))).toBe(true);
  });
});

// IG and TikTok give a name and often an address but never coordinates, and
// fitSuggestion needs coordinates to pick a day.
describe("putting a social place on a day", () => {
  beforeEach(() => {
    h.db.seed("tasks", [
      {
        id: "t-1",
        trip_id: "trip-1",
        participant_id: "p-dev",
        team_id: null,
        code: "A1",
        title: "wander meguro",
        tier: "Light",
        axes_json: {},
        base_points: 12,
        photo_bonus_max: 2,
        verification: "honor",
        day: 1,
        neighborhood: "Meguro",
      },
    ]);
  });

  it("geocodes the VENUE NAME, never the street address", async () => {
    h.page = { ok: true, text: "📍 Ramen Break Beats (〒153-0063 Tokyo, Meguro City, 4 Chome−21−19)" };
    h.place = {
      place_name: "Ramen Break Beats",
      city: "Tokyo",
      address: "〒153-0063 Tokyo, Meguro City, 4 Chome−21−19",
      category: "ramen",
    };
    h.geo = { lat: 35.6335, lng: 139.6988, label: "Ramen Break Beats" };
    await capture("https://www.instagram.com/reel/AAA/");
    await resolveQueuedLinks(TRIP as never, { send });

    // The address is the part a geocoder cannot read; the name is the part it
    // can. It must be the lookup key.
    expect(h.geocodeCalls).toEqual(["Ramen Break Beats"]);
    expect(places()[0]).toMatchObject({ lat: 35.6335, lng: 139.6988 });
    // The address is still stored, it is just not what we looked up.
    expect(places()[0].address).toContain("153-0063");
  });

  it("says which day when it knows, in one line", async () => {
    h.page = { ok: true, text: "📍 Ramen Break Beats" };
    h.place = { place_name: "Ramen Break Beats", city: "Tokyo", address: null, category: "ramen" };
    h.geo = { lat: 35.6335, lng: 139.6988, label: "x" };
    await capture("https://www.instagram.com/reel/BBB/");
    await resolveQueuedLinks(TRIP as never, { send });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].split("\n")).toHaveLength(1);
    expect(h.sent[0]).not.toContain("not sure which day");
  });

  // Guessing a day is worse than saying we do not know.
  it("refuses to guess a day when it cannot pin the place", async () => {
    h.page = { ok: true, text: "this tiny bar is unreal" };
    h.place = { place_name: "some tiny bar", city: null, address: null, category: "bar" };
    h.geo = null; // geocoder missed
    await capture("https://www.instagram.com/reel/CCC/");
    await resolveQueuedLinks(TRIP as never, { send });

    expect(places()).toHaveLength(1);
    expect(places()[0].lat ?? null).toBeNull();
    // Still one line, and still a hit: it just admits it has no day.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("not sure which day yet");
    // Nothing was anchored onto a guessed day.
    expect(h.db.table("itinerary")).toHaveLength(0);
  });

  it("never geocodes a maps link, which already carries coordinates", async () => {
    await capture("https://www.google.com/maps/place/Tokyo+Tower/@35.6586,139.7454,17z");
    await resolveQueuedLinks(TRIP as never, { send });
    expect(h.geocodeCalls).toEqual([]);
    expect(places()[0]).toMatchObject({ lat: 35.6586, lng: 139.7454 });
  });
});
