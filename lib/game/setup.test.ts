import { describe, expect, it } from "vitest";
import { detectTripCommand } from "./commands";
import { finalStandingsLine, setupPrompt } from "./copy";
import {
  checkDateRange,
  difficultyGuidance,
  losersOf,
  matchDifficulty,
  missingRequiredSetup,
  parseIsoRange,
  setupOrderFor,
  setupReadyToActivate,
} from "./setup";
import { isValidTimeZone, zonePlausibleForLongitude } from "./time";
import { parseNearArea } from "@/lib/places/foursquare";

const empty = {
  destination: null,
  start_date: null,
  end_date: null,
  difficulty: null,
  stake_text: null,
};

describe("organizer setup requirements", () => {
  it("needs a destination and both dates before the trip can go active", () => {
    expect(missingRequiredSetup(empty)).toEqual(["destination", "dates"]);
    expect(
      missingRequiredSetup({ ...empty, destination: "tokyo", start_date: "2026-10-17" }),
    ).toEqual(["dates"]);
    expect(
      setupReadyToActivate({
        ...empty,
        destination: "tokyo",
        start_date: "2026-10-17",
        end_date: "2026-10-20",
      }),
    ).toBe(true);
  });

  it("does not need difficulty or a stake", () => {
    expect(
      missingRequiredSetup({
        ...empty,
        destination: "tokyo",
        start_date: "2026-10-17",
        end_date: "2026-10-20",
      }),
    ).toEqual([]);
  });
});

describe("difficulty", () => {
  it("accepts the three options and obvious synonyms", () => {
    expect(matchDifficulty("Chill")).toBe("chill");
    expect(matchDifficulty("normal.")).toBe("normal");
    expect(matchDifficulty("unhinged")).toBe("unhinged");
    expect(matchDifficulty("easy")).toBe("chill");
    expect(matchDifficulty("chaos")).toBe("unhinged");
    expect(matchDifficulty("medium-ish I guess")).toBeNull();
  });

  it("steers generation without mentioning points", () => {
    expect(difficultyGuidance("unhinged")).toContain("safe, legal and nothing permanent");
    expect(difficultyGuidance("chill")).not.toMatch(/point/i);
    expect(difficultyGuidance(null)).toBeNull();
  });
});

describe("dates", () => {
  const today = "2026-09-19";

  it("reads plain ISO ranges without a model call", () => {
    expect(parseIsoRange("2026-10-17 to 2026-10-20")).toEqual({
      start: "2026-10-17",
      end: "2026-10-20",
    });
    expect(parseIsoRange("2026-10-17")).toEqual({ start: "2026-10-17", end: "2026-10-17" });
    expect(parseIsoRange("march 14-19")).toBeNull();
  });

  it("validates whatever produced the dates", () => {
    expect(checkDateRange("2026-10-17", "2026-10-20", today)).toEqual({
      ok: true,
      start: "2026-10-17",
      end: "2026-10-20",
    });
    expect(checkDateRange("2026-10-20", "2026-10-17", today)).toEqual({ ok: false, reason: "backwards" });
    // Long trips are fine (day letters cycle past Z); only a likely typo is asked about.
    expect(checkDateRange("2026-10-01", "2026-11-30", today).ok).toBe(true);
    expect(checkDateRange("2026-10-01", "2027-01-15", today)).toEqual({ ok: false, reason: "too_long" });
    expect(checkDateRange("2026-08-01", "2026-08-05", today)).toEqual({ ok: false, reason: "in_the_past" });
    expect(checkDateRange("2026-02-30", "2026-03-02", today)).toEqual({ ok: false, reason: "invalid" });
    expect(checkDateRange("march 14", "march 19", today)).toEqual({ ok: false, reason: "invalid" });
    // A trip already underway is fine.
    expect(checkDateRange("2026-09-15", "2026-09-22", today).ok).toBe(true);
  });
});

describe("timezone checks", () => {
  it("accepts real IANA zones only", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidTimeZone("JST")).toBe(false);
    expect(isValidTimeZone("UTC+9")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it("rejects a zone on the wrong side of the world for the place", () => {
    const at = new Date("2026-09-19T00:00:00Z");
    expect(zonePlausibleForLongitude("Asia/Tokyo", 139.7, at)).toBe(true);
    expect(zonePlausibleForLongitude("Asia/Kolkata", 77.2, at)).toBe(true);
    expect(zonePlausibleForLongitude("Asia/Shanghai", 87.6, at)).toBe(true); // Urumqi
    expect(zonePlausibleForLongitude("Europe/Madrid", -8.5, at)).toBe(true); // Santiago de Compostela
    expect(zonePlausibleForLongitude("America/New_York", 139.7, at)).toBe(false);
    expect(zonePlausibleForLongitude("America/New_York", null, at)).toBe(true);
  });
});

describe("places layer", () => {
  it("reads the resolved area from a Foursquare near search", () => {
    expect(
      parseNearArea({
        results: [{ location: { locality: "Shibuya", region: "Tokyo", country: "JP" } }],
        context: { geo_bounds: { circle: { center: { latitude: 35.68, longitude: 139.76 } } } },
      }),
    ).toEqual({ lat: 35.68, lng: 139.76, locality: "Shibuya", region: "Tokyo", country: "JP" });
    expect(parseNearArea({ results: [] })).toBeNull();
    expect(parseNearArea(null)).toBeNull();
  });
});

describe("trip commands", () => {
  it("needs the keyword and an exact phrase", () => {
    expect(detectTripCommand("japlan end trip", "japlan")).toBe("end_trip");
    expect(detectTripCommand("Japlan, end the trip.", "japlan")).toBe("end_trip");
    expect(detectTripCommand("japlan end trip confirm", "japlan")).toBe("end_trip_confirm");
    expect(detectTripCommand("japlan 'end trip confirm'", "japlan")).toBe("end_trip_confirm");
    expect(detectTripCommand("japlan new trip", "japlan")).toBe("new_trip");
    expect(detectTripCommand("japlan setup", "japlan")).toBe("setup");
    expect(detectTripCommand("end trip", "japlan")).toBeNull();
    expect(detectTripCommand("japlan should we end trip early lol", "japlan")).toBeNull();
    expect(detectTripCommand("japlan help", "japlan")).toBeNull();
  });
});

describe("final standings", () => {
  it("names the loser and the stake in one message", () => {
    const standings = [
      { name: "Mike", score: 120 },
      { name: "Sam", score: 40 },
    ];
    expect(
      finalStandingsLine({ standings, losers: losersOf(standings), stake: "karaoke solo", wrappedUrl: null }),
    ).toBe("it's over 😭 final: Mike 120 · Sam 40\nSam is on the hook, no takebacks: karaoke solo");
  });

  it("shares the stake on a tie at the bottom and skips it when unset", () => {
    const tied = [
      { name: "Mike", score: 90 },
      { name: "Sam", score: 40 },
      { name: "Ana", score: 40 },
    ];
    expect(losersOf(tied)).toEqual(["Sam", "Ana"]);
    expect(
      finalStandingsLine({ standings: tied, losers: losersOf(tied), stake: "buys dinner", wrappedUrl: null }),
    ).toContain("Sam and Ana are on the hook, no takebacks: buys dinner");
    expect(
      finalStandingsLine({ standings: tied, losers: losersOf(tied), stake: null, wrappedUrl: null }),
    ).toBe("it's over 😭 final: Mike 90 · Sam 40 · Ana 40");
    expect(losersOf([{ name: "Solo", score: 10 }])).toEqual([]);
  });

  it("adds the recap link only when one exists", () => {
    expect(
      finalStandingsLine({
        standings: [{ name: "A", score: 1 }, { name: "B", score: 0 }],
        losers: ["B"],
        stake: null,
        wrappedUrl: "https://example.test/wrapped/1",
      }),
    ).toContain("the recap: https://example.test/wrapped/1");
  });
});

describe("setup prompts", () => {
  it("shows the current value on a re-run and never asks for a timezone", () => {
    // The count in the lead has to match the questions actually asked, or the
    // group is told four and gets five.
    expect(setupPrompt("destination", null, { first: true })).toBe(
      `trip setup, ${setupOrderFor().length} quick ones. ok where we headed? a city is plenty. (skip and i'll ask again later)`,
    );
    expect(setupPrompt("destination", "tokyo, japan")).toContain("(rn: tokyo, japan. skip keeps it)");
    expect(setupPrompt("stake", null)).toContain("(skip is fine)");
    for (const id of ["destination", "dates", "difficulty", "stake"] as const) {
      expect(setupPrompt(id, null)).not.toMatch(/timezone|time zone|!/i);
    }
  });
});
