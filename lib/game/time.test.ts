import { describe, expect, it } from "vitest";
import {
  endOfLocalDay,
  endOfLocalDayContaining,
  localDateString,
  localHour,
  zonedTimeToUtc,
} from "./time";

describe("end of local day", () => {
  it("ends a Tokyo day at 23:59:59 JST, not 08:59 the next morning", () => {
    expect(endOfLocalDay("2026-09-19", "Asia/Tokyo").toISOString()).toBe(
      "2026-09-19T14:59:59.000Z",
    );
  });

  it("ends a Los Angeles day at 23:59:59 PDT, not 16:59 local", () => {
    expect(endOfLocalDay("2026-09-19", "America/Los_Angeles").toISOString()).toBe(
      "2026-09-20T06:59:59.000Z",
    );
  });

  it("follows the DST offset for the date in question", () => {
    // New York is UTC-4 in September and UTC-5 in December.
    expect(endOfLocalDay("2026-09-19", "America/New_York").toISOString()).toBe(
      "2026-09-20T03:59:59.000Z",
    );
    expect(endOfLocalDay("2026-12-19", "America/New_York").toISOString()).toBe(
      "2026-12-20T04:59:59.000Z",
    );
  });

  it("handles a half-hour zone", () => {
    expect(endOfLocalDay("2026-09-19", "Asia/Kolkata").toISOString()).toBe(
      "2026-09-19T18:29:59.000Z",
    );
  });

  it("falls back to UTC for a missing or invalid zone", () => {
    expect(endOfLocalDay("2026-09-19", null).toISOString()).toBe(
      "2026-09-19T23:59:59.000Z",
    );
    expect(endOfLocalDay("2026-09-19", "Not/AZone").toISOString()).toBe(
      "2026-09-19T23:59:59.000Z",
    );
  });

  it("finds the local day containing an instant", () => {
    // 2026-09-19 20:00 UTC is already the 20th in Tokyo.
    const instant = new Date("2026-09-19T20:00:00Z");
    expect(localDateString(instant, "Asia/Tokyo")).toBe("2026-09-20");
    expect(endOfLocalDayContaining(instant, "Asia/Tokyo").toISOString()).toBe(
      "2026-09-20T14:59:59.000Z",
    );
  });

  it("converts a wall-clock time and reads the local hour back", () => {
    const eight = zonedTimeToUtc("2026-09-19", "08:00:00", "Asia/Tokyo");
    expect(eight.toISOString()).toBe("2026-09-18T23:00:00.000Z");
    expect(localHour(eight, "Asia/Tokyo")).toBe(8);
  });
});
