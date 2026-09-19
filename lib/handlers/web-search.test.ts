import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { search: h.search },
}));

import { searchTheWeb } from "./web-search";

describe("searchTheWeb", () => {
  beforeEach(() => {
    h.search.mockReset();
    process.env.BROWSERBASE_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.BROWSERBASE_API_KEY;
    vi.useRealTimers();
  });

  it("returns https results filtered from the response", async () => {
    h.search.mockResolvedValue({
      results: [
        { title: "Teriyaki House Momiji", url: "https://example.com/momiji" },
        { title: "insecure listing", url: "http://insecure.example.com" },
        { title: "Osaka Grill", url: "https://example.com/osaka-grill" },
      ],
    });
    const outcome = await searchTheWeb("teriyaki restaurants osaka");
    expect(outcome).toEqual({
      ok: true,
      results: [
        { title: "Teriyaki House Momiji", url: "https://example.com/momiji" },
        { title: "Osaka Grill", url: "https://example.com/osaka-grill" },
      ],
    });
    expect(h.search).toHaveBeenCalledWith({
      apiKey: "test-key",
      query: "teriyaki restaurants osaka",
      numResults: 5,
    });
  });

  it("returns unavailable when no API key is configured", async () => {
    delete process.env.BROWSERBASE_API_KEY;
    const outcome = await searchTheWeb("teriyaki restaurants osaka");
    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
    expect(h.search).not.toHaveBeenCalled();
  });

  it("returns no_results when nothing comes back", async () => {
    h.search.mockResolvedValue({ results: [] });
    const outcome = await searchTheWeb("something nobody has heard of");
    expect(outcome).toEqual({ ok: false, reason: "no_results" });
  });

  it("returns no_results when only insecure links come back", async () => {
    h.search.mockResolvedValue({
      results: [{ title: "insecure only", url: "http://insecure.example.com" }],
    });
    const outcome = await searchTheWeb("something sketchy");
    expect(outcome).toEqual({ ok: false, reason: "no_results" });
  });

  it("returns failed when the search call throws", async () => {
    h.search.mockRejectedValue(new Error("network down"));
    const outcome = await searchTheWeb("teriyaki restaurants osaka");
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  it("returns failed when the search call hangs past the timeout", async () => {
    vi.useFakeTimers();
    h.search.mockImplementation(() => new Promise(() => {}));
    const promise = searchTheWeb("teriyaki restaurants osaka");
    await vi.advanceTimersByTimeAsync(8_001);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });
});
