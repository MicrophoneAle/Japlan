import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  dispatch: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("./dispatch", () => ({ dispatchLinqEvent: h.dispatch }));

import { sweepStalledEvents } from "./event-sweep";

const NOW = Date.parse("2026-09-19T16:30:00.000Z");

function seedEvent(type: string, id: string) {
  h.db.seed("events", [{
    id,
    linq_event_id: `linq-${id}`,
    type,
    payload: { event_id: `linq-${id}`, event_type: type, data: {} },
    processed_at: null,
    retried_at: null,
    created_at: new Date(NOW - 5 * 60_000).toISOString(),
  }]);
}

describe("live webhook retry sweep", () => {
  beforeEach(() => {
    h.db = new FakeSupabase();
    h.dispatch.mockReset().mockResolvedValue(undefined);
  });

  it("retries poll vote and location sharing events after a stalled dispatch", async () => {
    const types = [
      "poll.vote.added",
      "poll.vote.removed",
      "location.sharing.started",
      "location.sharing.stopped",
    ];
    types.forEach((type, index) => seedEvent(type, `event-${index}`));

    const result = await sweepStalledEvents({ now: NOW, force: true });

    expect(result).toEqual({ retried: 4, dropped: 0 });
    expect(h.dispatch).toHaveBeenCalledTimes(4);
    expect(h.db.table("events").every((row) => typeof row.retried_at === "string")).toBe(true);
  });

  it("does not retry unrelated webhook event types", async () => {
    seedEvent("poll.updated", "unrelated");
    seedEvent("message.failed", "failed-message");

    const result = await sweepStalledEvents({ now: NOW, force: true });

    expect(result).toEqual({ retried: 0, dropped: 0 });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.db.table("events").every((row) => row.retried_at === null)).toBe(true);
  });
});
