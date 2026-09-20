import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import type { FoursquarePlace, FoursquareSearchParams } from "@/lib/places/foursquare";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import {
  activateParticipantLocationSharing,
  getOnDemandLocationContext,
  handleLocationSharingWebhook,
  LOCATION_FRESHNESS_MS,
  LOCATION_SHARE_TTL_MS,
  requestTripLocationSharing,
  stopParticipantLocationSharing,
  type LiveLocationDeps,
} from "./live-location";

const NOW = new Date("2026-09-19T16:00:00.000Z");
const CHAT_ID = "group-chat";
const DESTINATION = "Shibuya, Tokyo";

function makeTrip(overrides: Partial<TripRow> = {}): TripRow {
  return {
    id: "trip-1",
    linq_chat_id: CHAT_ID,
    name: "Tokyo trip",
    destination: DESTINATION,
    start_date: "2026-09-18",
    end_date: "2026-09-25",
    play_mode: "teams",
    state: "active",
    difficulty: "medium",
    stake_text: null,
    timezone: "Asia/Tokyo",
    organizer_participant_id: "person-elrich",
    completed_at: null,
    setup_state: "done",
    ...overrides,
  };
}

function person(id: string, phone: string, display_name: string, tripId = "trip-1"): ParticipantRow {
  return {
    id,
    trip_id: tripId,
    phone,
    display_name,
    score: 0,
    survey_json: null,
    survey_state: "done",
    sidequests_muted: false,
    consented_at: null,
  };
}

function makePlace(overrides: Partial<FoursquarePlace> = {}): FoursquarePlace {
  return {
    fsq_place_id: "fsq-1",
    name: "Tiny Coffee",
    latitude: 35.6595,
    longitude: 139.7005,
    neighborhood: "Shibuya",
    locality: "Tokyo",
    categories: ["Coffee Shop", "Cafe"],
    price: null,
    tastes: [],
    hours_json: null,
    raw: { internal: "must not escape", latitude: 35.6595, longitude: 139.7005 },
    ...overrides,
  };
}

function feature(phone: string, lat: number, lng: number, updatedAt: Date, locality = "Tokyo") {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { handle: phone, updated_at: updatedAt.toISOString(), locality },
  };
}

function testDeps(db: FakeSupabase, overrides: Partial<LiveLocationDeps> = {}) {
  const api = {
    request: vi.fn(async (chatId: string): Promise<unknown> => {
      void chatId;
      return { success: true };
    }),
    retrieve: vi.fn(async (chatId: string): Promise<unknown> => {
      void chatId;
      return { success: true, data: { features: [] as unknown[] } };
    }),
    stop: vi.fn(async (chatId: string, body: { handle: string }): Promise<unknown> => {
      void chatId;
      void body;
      return { success: true };
    }),
  };
  const dm = vi.fn(async (phone: string, text: string) => {
    void text;
    return { chatId: `dm-${phone}`, messageId: `message-${phone}` };
  });
  const text = vi.fn(async (chatId: string, message: string) => {
    void chatId;
    void message;
  });
  const places = vi.fn(async (params: FoursquareSearchParams): Promise<FoursquarePlace[]> => {
    void params;
    return [makePlace()];
  });
  return {
    deps: {
      db: db as unknown as SupabaseClient,
      locationApi: api,
      sendDM: dm,
      sendText: text,
      searchPlaces: places as unknown as LiveLocationDeps["searchPlaces"],
      ...overrides,
    } satisfies LiveLocationDeps,
    api,
    dm,
    text,
    places,
  };
}

describe("live location sharing", () => {
  let db: FakeSupabase;
  let elrich: ParticipantRow;
  let maya: ParticipantRow;

  beforeEach(() => {
    db = new FakeSupabase();
    elrich = person("person-elrich", "+14165550101", "Elrich");
    maya = person("person-maya", "+14165550102", "Maya");
    db.seed("trips", [makeTrip() as unknown as Record<string, unknown>]);
    db.seed("participants", [elrich, maya] as unknown as Record<string, unknown>[]);
  });

  it("requires the organizer and an active, in-date trip; sends private opt-in requests and stores only metadata", async () => {
    const harness = testDeps(db);
    const unauthorized = await requestTripLocationSharing({
      trip: makeTrip(),
      organizer: maya,
      participants: [elrich, maya],
      now: NOW,
    }, harness.deps);
    expect(unauthorized.status).toBe("organizer_only");
    expect(harness.dm).not.toHaveBeenCalled();

    const inactive = await requestTripLocationSharing({
      trip: makeTrip({ state: "complete" }),
      organizer: elrich,
      participants: [elrich, maya],
      now: NOW,
    }, harness.deps);
    expect(inactive.status).toBe("not_active");
    expect(harness.dm).not.toHaveBeenCalled();

    const result = await requestTripLocationSharing({
      trip: makeTrip(),
      organizer: elrich,
      participants: [elrich, maya],
      now: NOW,
    }, harness.deps);
    expect(result).toEqual({
      status: "requested",
      people: [
        { status: "requested", participantId: "person-elrich" },
        { status: "requested", participantId: "person-maya" },
      ],
    });
    expect(harness.dm).toHaveBeenCalledTimes(2);
    expect(harness.api.request.mock.calls).toEqual([["dm-+14165550101"], ["dm-+14165550102"]]);
    expect(db.table("trip_location_shares")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trip_id: "trip-1",
        participant_id: "person-elrich",
        direct_chat_id: "dm-+14165550101",
        share_status: "requested",
        expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
      }),
      expect.objectContaining({ participant_id: "person-maya", share_status: "requested" }),
    ]));
    for (const row of db.table("trip_location_shares")) {
      expect(Object.keys(row)).not.toContain("lat");
      expect(Object.keys(row)).not.toContain("lng");
      expect(JSON.stringify(row)).not.toMatch(/coordinates|latitude|longitude/);
    }
    const firstMessage = String(harness.dm.mock.calls[0]?.[1]);
    expect(firstMessage).toContain("The group may see your name and approximate neighborhood");
    expect(firstMessage).toContain("does not save them");
    expect(firstMessage).toContain("12 hours");
  });

  it("is idempotent for repeated organizer requests while consent is pending", async () => {
    const harness = testDeps(db);
    const args = { trip: makeTrip(), organizer: elrich, participants: [elrich, maya], now: NOW };
    await requestTripLocationSharing(args, harness.deps);
    const second = await requestTripLocationSharing(args, harness.deps);
    expect(second.people.every((entry) => entry.status === "already_pending")).toBe(true);
    expect(harness.dm).toHaveBeenCalledTimes(2);
    expect(harness.api.request).toHaveBeenCalledTimes(2);
    expect(db.table("trip_location_shares")).toHaveLength(2);
  });

  it("does not prompt participants who are already sharing", async () => {
    const harness = testDeps(db);
    db.seed("trip_location_shares", [{
      trip_id: "trip-1",
      participant_id: maya.id,
      direct_chat_id: "dm-maya",
      share_status: "active",
      expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
    }]);

    const result = await requestTripLocationSharing({
      trip: makeTrip(),
      organizer: elrich,
      participants: [maya],
      now: NOW,
    }, harness.deps);

    expect(result.people).toEqual([{ status: "already_active", participantId: maya.id }]);
    expect(harness.dm).not.toHaveBeenCalled();
    expect(harness.api.request).not.toHaveBeenCalled();
  });

  it("lets a participant request native consent from their own direct chat without creating a second chat", async () => {
    const harness = testDeps(db);
    const status = await activateParticipantLocationSharing({
      trip: makeTrip(),
      participant: maya,
      directChatId: "incoming-maya-dm",
      now: NOW,
    }, harness.deps);
    expect(status).toBe("requested");
    expect(harness.api.request).toHaveBeenCalledWith("incoming-maya-dm");
    expect(harness.dm).not.toHaveBeenCalled();
    expect(db.table("trip_location_shares")[0]).toMatchObject({
      participant_id: maya.id,
      direct_chat_id: "incoming-maya-dm",
      share_status: "requested",
    });
    expect(await activateParticipantLocationSharing({
      trip: makeTrip(),
      participant: maya,
      directChatId: "incoming-maya-dm",
      now: NOW,
    }, harness.deps)).toBe("already_pending");
    expect(await activateParticipantLocationSharing({
      trip: makeTrip(),
      participant: maya,
      directChatId: "someone-elses-chat",
      now: NOW,
    }, harness.deps)).toBe("not_participant");
    expect(harness.api.request).toHaveBeenCalledTimes(1);
  });

  it("only accepts starts from a pending participant's direct chat and handles duplicate webhooks safely", async () => {
    const harness = testDeps(db);
    await requestTripLocationSharing({ trip: makeTrip(), organizer: elrich, participants: [elrich, maya], now: NOW }, harness.deps);

    const unrelated = await handleLocationSharingWebhook("location.sharing.started", {
      chat_id: "some-other-chat",
      shared_by: elrich.phone,
    }, harness.deps, NOW);
    expect(unrelated).toMatchObject({ handled: false, updated: 0 });

    const event = { chat_id: "dm-+14165550101", shared_by: elrich.phone };
    expect(await handleLocationSharingWebhook("location.sharing.started", event, harness.deps, NOW)).toEqual({ handled: true, updated: 1 });
    expect(await handleLocationSharingWebhook("location.sharing.started", event, harness.deps, NOW)).toEqual({ handled: false, updated: 0, reason: "no_matching_consent" });
    expect(db.table("trip_location_shares").find((row) => row.participant_id === elrich.id)?.share_status).toBe("active");
  });

  it("stops reads immediately when the participant asks, and duplicate stop events remain harmless", async () => {
    const harness = testDeps(db);
    await requestTripLocationSharing({ trip: makeTrip(), organizer: elrich, participants: [elrich], now: NOW }, harness.deps);
    await handleLocationSharingWebhook("location.sharing.started", {
      chat_id: "dm-+14165550101",
      shared_by: elrich.phone,
    }, harness.deps, NOW);
    db.seed("trip_location_shares", [{
      trip_id: "trip-2",
      participant_id: elrich.id,
      direct_chat_id: "dm-another-trip",
      share_status: "active",
      expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
    }]);

    expect(await stopParticipantLocationSharing({ tripId: "trip-1", participantId: elrich.id, phone: elrich.phone }, harness.deps)).toBe("stopped");
    expect(harness.api.stop).toHaveBeenCalledWith("dm-+14165550101", { handle: elrich.phone });
    expect(await stopParticipantLocationSharing({ tripId: "trip-1", participantId: elrich.id, phone: elrich.phone }, harness.deps)).toBe("already_stopped");
    const stopped = await handleLocationSharingWebhook("location.sharing.stopped", {
      chat_id: "dm-+14165550101",
      shared_by: elrich.phone,
    }, harness.deps, NOW);
    expect(stopped.updated).toBe(0);
    expect(db.table("trip_location_shares").filter((row) => row.participant_id === elrich.id).every((row) => row.share_status === "stopped")).toBe(true);
  });

  it("revokes local reads even if Linq cannot confirm the stop", async () => {
    const harness = testDeps(db);
    db.seed("trip_location_shares", [{
      trip_id: "trip-1",
      participant_id: elrich.id,
      direct_chat_id: "dm-+14165550101",
      share_status: "active",
      expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
    }]);
    harness.api.stop.mockRejectedValue(new Error("network unavailable"));
    expect(await stopParticipantLocationSharing({ tripId: "trip-1", participantId: elrich.id, phone: elrich.phone }, harness.deps)).toBe("unavailable");
    expect(db.table("trip_location_shares")[0].share_status).toBe("stopped");
  });

  it("marks expired consent stale and uses destination search when nobody has a current share", async () => {
    const harness = testDeps(db);
    db.seed("trip_location_shares", [{
      trip_id: "trip-1",
      participant_id: elrich.id,
      direct_chat_id: "dm-old",
      share_status: "active",
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    }]);
    const context = await getOnDemandLocationContext({ trip: makeTrip(), now: NOW }, harness.deps);
    expect(context.status).toBe("destination_fallback");
    expect(context.clusters).toEqual([]);
    expect(context.note).toContain("not anyone's live position");
    expect(context.candidates).toEqual([expect.objectContaining({ name: "Tiny Coffee", area: "Shibuya" })]);
    expect(harness.api.retrieve).not.toHaveBeenCalled();
    expect(harness.places).toHaveBeenCalledWith({ near: DESTINATION, limit: 8 });
    expect(db.table("trip_location_shares")[0].share_status).toBe("expired");
  });

  it("rejects stale locations and never returns exact coordinates or provider payloads", async () => {
    const harness = testDeps(db);
    db.seed("trip_location_shares", [{
      trip_id: "trip-1",
      participant_id: elrich.id,
      direct_chat_id: "dm-+14165550101",
      share_status: "active",
      expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
    }]);
    harness.api.retrieve.mockResolvedValue({
      success: true,
      data: { features: [feature(elrich.phone, 35.6595, 139.7005, new Date(NOW.getTime() - LOCATION_FRESHNESS_MS - 1))] },
    });
    const context = await getOnDemandLocationContext({ trip: makeTrip(), now: NOW }, harness.deps);
    expect(context.status).toBe("destination_fallback");
    expect(harness.places).toHaveBeenCalledWith({ near: DESTINATION, limit: 8 });
    expect(JSON.stringify(context)).not.toMatch(/35\.6595|139\.7005|latitude|longitude|internal/);
  });

  it("returns only names, coarse neighborhoods, and sanitized nearby candidates for fresh opt-in locations", async () => {
    const harness = testDeps(db);
    db.seed("trip_location_shares", [
      {
        trip_id: "trip-1",
        participant_id: elrich.id,
        direct_chat_id: "dm-+14165550101",
        share_status: "active",
        expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
      },
      {
        trip_id: "trip-1",
        participant_id: maya.id,
        direct_chat_id: "dm-+14165550102",
        share_status: "active",
        expires_at: new Date(NOW.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
      },
    ]);
    harness.api.retrieve.mockImplementation(async (chatId) => ({
      success: true,
      data: {
        features: [feature(
          chatId === "dm-+14165550101" ? elrich.phone : maya.phone,
          35.6595,
          chatId === "dm-+14165550101" ? 139.7005 : 139.701,
          NOW,
        )],
      },
    }));
    const context = await getOnDemandLocationContext({ trip: makeTrip(), now: NOW }, harness.deps);
    expect(context.status).toBe("live");
    expect(context.clusters).toEqual([{ people: ["Elrich", "Maya"], area: "Shibuya" }]);
    expect(context.candidates).toEqual([{ name: "Tiny Coffee", area: "Shibuya", categories: ["Coffee Shop", "Cafe"] }]);
    expect(harness.api.retrieve).toHaveBeenCalledTimes(2);
    expect(harness.places).toHaveBeenCalledWith({ ll: "35.6595,139.7005", radius: 1500, limit: 8 });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toMatch(/35\.6595|139\.7005|fsq-1|latitude|longitude|internal/);
    expect(Object.keys(context.clusters[0])).toEqual(["people", "area"]);
  });

  it("falls back safely when Linq refuses a non-iMessage request", async () => {
    const harness = testDeps(db);
    harness.api.request.mockRejectedValue({ status: 409, code: 2017, message: "ChatServiceNotSupported" });
    const result = await requestTripLocationSharing({ trip: makeTrip(), organizer: elrich, participants: [maya], now: NOW }, harness.deps);
    expect(result.people).toEqual([{ status: "unsupported", participantId: maya.id }]);
    expect(db.table("trip_location_shares")[0].share_status).toBe("unsupported");
    expect(harness.text).toHaveBeenCalledWith(
      "dm-+14165550102",
      expect.stringContaining("1:1 iMessage"),
    );
  });
});
