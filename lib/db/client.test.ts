import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The timeout that stops a hung query killing the isolate. Four outages have
// been the same shape: the second Supabase call in an isolate never settles,
// the await is unbounded, and after() dies with no error and no log. Timeouts
// were added per call site and missed on loadTripLegs, so this one lives in
// the client and applies to every query whoever writes it.

const h = vi.hoisted(() => ({
  // How the fake query behaves: settle, or never settle at all.
  mode: "ok" as "ok" | "hang",
  fetchInits: [] as (RequestInit | undefined)[],
  created: [] as Record<string, unknown>[],
}));

// A stand-in PostgREST builder: chainable, and thenable at the end.
function builder(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "insert", "update", "upsert", "delete"]) {
    self[method] = () => self;
  }
  self.then = (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => {
    if (h.mode === "hang") return undefined; // never resolves, never rejects
    return Promise.resolve({ data: [{ id: "row-1" }], error: null }).then(onOk, onErr);
  };
  return self;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts: Record<string, unknown>) => {
    h.created.push(opts);
    return { from: () => builder(), rpc: () => builder() };
  },
}));

import { getServiceClient, resetServiceClientForTests } from "./client";

beforeEach(() => {
  h.mode = "ok";
  h.fetchInits.length = 0;
  h.created.length = 0;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  resetServiceClientForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("every supabase query is bounded", () => {
  it("rejects a query that never settles, instead of awaiting forever", async () => {
    h.mode = "hang";
    const pending = getServiceClient().from("trip_legs").select("*").eq("trip_id", "t");
    const caught = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(9_000);
    await caught;
  });

  it("names the table in the error, so a hang is attributable", async () => {
    h.mode = "hang";
    const pending = getServiceClient().from("trip_legs").select("*");
    const caught = expect(pending).rejects.toThrow(/trip_legs/);
    await vi.advanceTimersByTimeAsync(9_000);
    await caught;
  });

  it("bounds an rpc the same way", async () => {
    h.mode = "hang";
    const pending = getServiceClient().rpc("bump_participant_stats", {});
    const caught = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(9_000);
    await caught;
  });

  it("leaves a query that answers completely alone", async () => {
    h.mode = "ok";
    const res = await getServiceClient().from("trips").select("id").eq("id", "t").limit(1);
    expect(res).toEqual({ data: [{ id: "row-1" }], error: null });
  });

  it("keeps the builder chain working through the wrapper", async () => {
    h.mode = "ok";
    const res = await getServiceClient()
      .from("tasks")
      .select("id, code")
      .eq("trip_id", "t")
      .order("day")
      .limit(5);
    expect((res as { data: unknown[] }).data).toHaveLength(1);
  });

  // Next patches global fetch for its cache layer, and supabase-js uses it.
  // Inside after() the request context is gone, which is where a cache-aware
  // fetch can wait on something that never arrives.
  it("hands supabase a fetch that opts out of next's cache", async () => {
    getServiceClient();
    const opts = h.created[0] as { global?: { fetch?: unknown } };
    expect(typeof opts.global?.fetch).toBe("function");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await (opts.global!.fetch as (u: string, i?: RequestInit) => Promise<Response>)("https://x");
    expect(spy.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    spy.mockRestore();
  });

  it("is still one client per isolate, not one per request", () => {
    expect(getServiceClient()).toBe(getServiceClient());
    expect(h.created).toHaveLength(1);
  });
});
