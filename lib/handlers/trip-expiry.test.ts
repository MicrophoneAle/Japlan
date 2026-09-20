import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return { chatId, messageId: "out-1" };
  }),
}));

import { completeExpiredTrips, tripHasExpired } from "./trip-expiry";

beforeEach(() => {
  h.db = new FakeSupabase();
  h.sent.length = 0;
  process.env.APP_URL = "https://japlan.example";
});

describe("tripHasExpired", () => {
  it("waits until after the trip's final local calendar day", () => {
    const trip = { end_date: "2026-09-19", timezone: "America/Toronto" };
    expect(tripHasExpired(trip, new Date("2026-09-20T03:59:00Z"))).toBe(false);
    expect(tripHasExpired(trip, new Date("2026-09-20T04:00:00Z"))).toBe(true);
  });
});

describe("completeExpiredTrips", () => {
  it("completes an expired trip and announces its Wrapped link in the group chat once", async () => {
    h.db.seed("trips", [{
      id: "trip-1", linq_chat_id: "group-1", name: "Tokyo", state: "active",
      end_date: "2026-09-19", timezone: "America/Toronto", stake_text: null,
    }]);
    h.db.seed("participants", [
      { id: "person-1", trip_id: "trip-1", display_name: "Maya", score: 30 },
      { id: "person-2", trip_id: "trip-1", display_name: "Noah", score: 10 },
    ]);

    expect(await completeExpiredTrips({ now: new Date("2026-09-20T04:00:00Z") }))
      .toEqual({ completed: ["trip-1"], skipped: [] });
    expect(h.db.table("trips")[0].state).toBe("complete");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      chatId: "group-1",
      text: expect.stringContaining("https://japlan.example/wrapped/trip-1"),
    });

    expect(await completeExpiredTrips({ now: new Date("2026-09-21T04:00:00Z") }))
      .toEqual({ completed: [], skipped: [] });
    expect(h.sent).toHaveLength(1);
  });
});
