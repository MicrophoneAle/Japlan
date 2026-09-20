import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  pollVote: vi.fn(),
  locationWebhook: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/handlers/group-decisions", () => ({
  handleGroupDecisionMessage: vi.fn(async () => false),
  handleGroupDecisionReaction: vi.fn(async () => false),
  handleGroupDecisionPollVote: h.pollVote,
}));
vi.mock("@/lib/handlers/live-location", () => ({
  activateParticipantLocationSharing: vi.fn(),
  getOnDemandLocationContext: vi.fn(),
  handleLocationSharingWebhook: h.locationWebhook,
  requestTripLocationSharing: vi.fn(),
  stopParticipantLocationSharing: vi.fn(),
}));

import { dispatchLinqEvent } from "./dispatch";

function seedEvent(type: string) {
  const eventId = `linq-${type}`;
  h.db.seed("events", [{
    linq_event_id: eventId,
    type,
    payload: { event_id: eventId, event_type: type, data: {} },
    processed_at: null,
  }]);
  return eventId;
}

describe("dispatch live webhook events", () => {
  beforeEach(() => {
    h.db = new FakeSupabase();
    h.pollVote.mockReset().mockResolvedValue(true);
    h.locationWebhook.mockReset().mockResolvedValue({ handled: true, updated: 1 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("routes poll vote events to the native poll handler", async () => {
    const eventId = seedEvent("poll.vote.added");
    const data = {
      chat: { id: "trip-chat", is_group: true },
      message_id: "poll-message",
      option_id: "option-1",
      sender_handle: { handle: "+15550000001" },
    };

    await dispatchLinqEvent({ event_id: eventId, event_type: "poll.vote.added", data });

    expect(h.pollVote).toHaveBeenCalledWith("poll.vote.added", data);
    expect(h.db.table("events")[0].processed_at).toEqual(expect.any(String));
  });

  it("leaves a failed poll webhook unprocessed so the retry sweep can recover it", async () => {
    const eventId = seedEvent("poll.vote.removed");
    h.pollVote.mockRejectedValueOnce(new Error("temporary database failure"));

    await dispatchLinqEvent({
      event_id: eventId,
      event_type: "poll.vote.removed",
      data: { message_id: "poll-message", option_id: "option-1" },
    });

    expect(h.db.table("events")[0].processed_at).toBeNull();
  });

  it("routes location start events and marks successful processing", async () => {
    const eventId = seedEvent("location.sharing.started");
    const data = { chat_id: "person-dm", shared_by: "+15550000001" };

    await dispatchLinqEvent({ event_id: eventId, event_type: "location.sharing.started", data });

    expect(h.locationWebhook).toHaveBeenCalledWith("location.sharing.started", data);
    expect(h.db.table("events")[0].processed_at).toEqual(expect.any(String));
  });
});
