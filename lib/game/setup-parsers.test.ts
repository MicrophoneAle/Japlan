import { describe, expect, it } from "vitest";
import { ThinkingLevel } from "@google/genai";
import { thinkingConfigFor } from "@/lib/llm/gemini";
import { lookupCityTimezone } from "./city-timezones";
import { checkDateRange, parseLooseDates } from "./setup";

// 2026-09-19 is a Saturday, in September: the live bug report's context.
const TODAY = "2026-09-19";
const dates = (text: string) => {
  const r = parseLooseDates(text, TODAY);
  return r ? [r.start, r.end] : null;
};

describe("deterministic date parser", () => {
  it("reads the exact inputs from the live DM", () => {
    expect(dates("Oct 20-26")).toEqual(["2026-10-20", "2026-10-26"]);
    expect(dates("Oct 17-20")).toEqual(["2026-10-17", "2026-10-20"]);
  });

  it("reads the common shapes", () => {
    expect(dates("october 17th to 20th")).toEqual(["2026-10-17", "2026-10-20"]);
    expect(dates("Oct. 17 - 20")).toEqual(["2026-10-17", "2026-10-20"]);
    expect(dates("oct 17–20")).toEqual(["2026-10-17", "2026-10-20"]); // en dash
    expect(dates("oct 28 - nov 2")).toEqual(["2026-10-28", "2026-11-02"]);
    expect(dates("17-20 oct")).toEqual(["2026-10-17", "2026-10-20"]);
    expect(dates("17th to 20th of october")).toEqual(["2026-10-17", "2026-10-20"]);
    expect(dates("28 oct - 2 nov")).toEqual(["2026-10-28", "2026-11-02"]);
    expect(dates("oct 17")).toEqual(["2026-10-17", "2026-10-17"]);
    expect(dates("2026-10-17 to 2026-10-20")).toEqual(["2026-10-17", "2026-10-20"]);
  });

  it("picks the year that makes the trip upcoming", () => {
    // This October, not next.
    expect(dates("oct 17-20")?.[0]).toBe("2026-10-17");
    // Already over this year, so next year.
    expect(dates("sep 1-5")).toEqual(["2027-09-01", "2027-09-05"]);
    expect(dates("jan 5-10")).toEqual(["2027-01-05", "2027-01-10"]);
    // Underway right now stays this year.
    expect(dates("sep 15-22")).toEqual(["2026-09-15", "2026-09-22"]);
    // Crosses new year.
    expect(dates("dec 28 - jan 3")).toEqual(["2026-12-28", "2027-01-03"]);
    // An explicit year is respected.
    expect(dates("oct 17-20, 2027")).toEqual(["2027-10-17", "2027-10-20"]);
    // None of these land in the past.
    for (const input of ["oct 17-20", "sep 1-5", "jan 5-10", "sep 15-22", "dec 28 - jan 3"]) {
      const r = parseLooseDates(input, TODAY)!;
      expect(checkDateRange(r.start, r.end, TODAY).ok, input).toBe(true);
    }
  });

  it("reads weekends relative to today", () => {
    expect(dates("this weekend")).toEqual(["2026-09-19", "2026-09-20"]);
    expect(dates("next weekend")).toEqual(["2026-09-26", "2026-09-27"]);
    expect(parseLooseDates("next weekend", "2026-09-16")).toMatchObject({
      start: "2026-09-26",
      end: "2026-09-27",
    });
  });

  it("returns null for what it cannot read, so the model can try", () => {
    expect(dates("sometime soon")).toBeNull();
    expect(dates("feb 30-31")).toBeNull();
    expect(dates("the week after my birthday")).toBeNull();
  });
});

describe("city timezone lookup", () => {
  const tz = (text: string) => lookupCityTimezone(text)?.timezone ?? null;

  it("resolves Tokyo with no API", () => {
    expect(tz("Tokyo")).toBe("Asia/Tokyo");
    expect(tz("tokyo, japan")).toBe("Asia/Tokyo");
    expect(lookupCityTimezone("Tokyo")?.source).toBe("zone_database");
  });

  it("covers cities the zone database does not name, and countries", () => {
    expect(tz("Kyoto Japan")).toBe("Asia/Tokyo");
    expect(tz("osaka!")).toBe("Asia/Tokyo");
    expect(tz("Barcelona")).toBe("Europe/Madrid");
    expect(tz("bali")).toBe("Asia/Makassar");
    expect(tz("nyc")).toBe("America/New_York");
    expect(tz("japan")).toBe("Asia/Tokyo");
  });

  it("reads multi-word and accented zone-database cities", () => {
    expect(tz("New York")).toBe("America/New_York");
    expect(tz("Buenos Aires")).toMatch(/Buenos_Aires$/);
    expect(tz("Zürich")).toBe("Europe/Zurich");
    expect(tz("la paz")).toBe("America/La_Paz"); // not "la" -> LA
  });

  it("leaves ambiguous or unknown text to the model", () => {
    expect(tz("portland")).toBeNull();
    expect(tz("vancouver")).toBeNull();
    expect(tz("that island my cousin went to")).toBeNull();
  });
});

describe("gemini thinking config", () => {
  it("never sends a zero thinking budget", () => {
    // gemini-3.5-flash-lite answers thinkingBudget: 0 with a bare 400.
    expect(thinkingConfigFor(0)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(thinkingConfigFor(512)).toEqual({ thinkingBudget: 512 });
    expect(thinkingConfigFor(undefined)).toBeUndefined();
  });
});
