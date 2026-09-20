import { describe, expect, it } from "vitest";
import { boardDueNow } from "./board-schedule";
import {
  cityFor,
  isMultiCity,
  isTravelDate,
  legCities,
  legForDate,
  legForNow,
  legProblems,
  legsLabel,
  legsOf,
  splitDestinationAnswer,
  splitIntoLegs,
  syntheticLeg,
  todayFor,
  zoneFor,
  zoneNow,
  type TripLeg,
} from "./legs";

// A single-city trip, exactly as it is stored today: no legs row anywhere.
const SINGLE = {
  id: "trip-1",
  destination: "Tokyo",
  timezone: "Asia/Tokyo",
  start_date: "2026-10-01",
  end_date: "2026-10-08",
  destination_profile_json: { destination: "Tokyo" },
};

const leg = (
  order: number,
  city: string,
  start: string,
  end: string,
  timezone: string,
  travel = false,
): TripLeg => ({
  id: `leg-${order}`,
  trip_id: "trip-2",
  leg_order: order,
  city,
  start_date: start,
  end_date: end,
  timezone,
  destination_profile_json: null,
  is_travel_day: travel,
});

// Tokyo for four days, then Bangkok. Two hours apart, so a timezone bug shows.
const MULTI = {
  id: "trip-2",
  destination: "Tokyo → Bangkok",
  timezone: "Asia/Tokyo",
  start_date: "2026-10-01",
  end_date: "2026-10-08",
  legs: [
    leg(1, "Tokyo", "2026-10-01", "2026-10-04", "Asia/Tokyo"),
    leg(2, "Bangkok", "2026-10-05", "2026-10-08", "Asia/Bangkok", true),
  ],
};

describe("a one-city trip is unchanged", () => {
  it("synthesises exactly one leg from the trip's own columns", () => {
    const legs = legsOf(SINGLE);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      leg_order: 1,
      city: "Tokyo",
      timezone: "Asia/Tokyo",
      start_date: "2026-10-01",
      end_date: "2026-10-08",
      is_travel_day: false,
    });
    expect(isMultiCity(SINGLE)).toBe(false);
  });

  // The whole safety argument: if the migration never runs, or a code path
  // forgets to load legs, every resolver still returns what the old
  // single-timezone code read straight off the trip.
  it("resolves to trips.timezone and trips.destination on every date", () => {
    for (const date of ["2026-09-01", "2026-10-01", "2026-10-05", "2026-12-25"]) {
      expect(zoneFor(SINGLE, date)).toBe("Asia/Tokyo");
      expect(cityFor(SINGLE, date)).toBe("Tokyo");
      expect(isTravelDate(SINGLE, date)).toBe(false);
    }
    const now = new Date("2026-10-03T02:00:00Z");
    expect(zoneNow(SINGLE, now)).toBe("Asia/Tokyo");
    expect(todayFor(SINGLE, now)).toBe("2026-10-03");
  });

  it("has no city label to add to a board header", () => {
    expect(legsLabel(SINGLE)).toBe("Tokyo");
    expect(legCities(SINGLE)).toEqual(["Tokyo"]);
  });

  it("falls back cleanly on a trip with no destination at all", () => {
    const bare = { id: "trip-x", destination: null, timezone: null };
    expect(zoneFor(bare, "2026-10-01")).toBe("UTC");
    expect(syntheticLeg(bare).city).toBe("the trip");
  });
});

describe("legs partition the trip", () => {
  it("resolves each date to the city they are actually in", () => {
    expect(cityFor(MULTI, "2026-10-01")).toBe("Tokyo");
    expect(cityFor(MULTI, "2026-10-04")).toBe("Tokyo");
    expect(cityFor(MULTI, "2026-10-05")).toBe("Bangkok");
    expect(cityFor(MULTI, "2026-10-08")).toBe("Bangkok");
    expect(zoneFor(MULTI, "2026-10-04")).toBe("Asia/Tokyo");
    expect(zoneFor(MULTI, "2026-10-05")).toBe("Asia/Bangkok");
  });

  it("clamps a date outside the trip to the nearest end", () => {
    expect(legForDate(MULTI, "2026-01-01").city).toBe("Tokyo");
    expect(legForDate(MULTI, "2027-01-01").city).toBe("Bangkok");
  });

  it("marks only the first date of a following leg as a travel day", () => {
    expect(isTravelDate(MULTI, "2026-10-04")).toBe(false);
    expect(isTravelDate(MULTI, "2026-10-05")).toBe(true);
    expect(isTravelDate(MULTI, "2026-10-06")).toBe(false);
    // Leg 1 is never a travel day: nobody travels to the start of the trip.
    expect(isTravelDate(MULTI, "2026-10-01")).toBe(false);
  });

  it("labels the trip by its cities in order", () => {
    expect(legsLabel(MULTI)).toBe("Tokyo → Bangkok");
    expect(legCities(MULTI)).toEqual(["Tokyo", "Bangkok"]);
    expect(isMultiCity(MULTI)).toBe(true);
  });
});

describe("which leg is happening right now", () => {
  // The circular one: you need a timezone to know the date, and the date to
  // know the timezone. It has to settle on the leg they are actually in.
  it("settles on the right leg across a timezone change", () => {
    // 2026-10-04 23:00 in Tokyo is still 2026-10-04 in Bangkok (21:00), so
    // they are in Tokyo on their last Tokyo night.
    const lastTokyoNight = new Date("2026-10-04T14:00:00Z");
    expect(legForNow(MULTI, lastTokyoNight).city).toBe("Tokyo");
    expect(todayFor(MULTI, lastTokyoNight)).toBe("2026-10-04");

    // 2026-10-05 09:00 Tokyo / 07:00 Bangkok: travel day, Bangkok leg.
    const travelMorning = new Date("2026-10-05T00:00:00Z");
    expect(legForNow(MULTI, travelMorning).city).toBe("Bangkok");
    expect(zoneNow(MULTI, travelMorning)).toBe("Asia/Bangkok");
  });

  // The property that actually matters, and the one a re-reading resolver
  // could not hold: the answer only ever moves forward. Across the straddling
  // window (Tokyo is already the 5th while Bangkok is still the 4th) the two
  // legs' zones each point at the other, so anything that iterates oscillates.
  it("only ever moves forward, and never flips back", () => {
    let seen = 0;
    for (let hour = 0; hour < 24 * 9; hour++) {
      const at = new Date(Date.parse("2026-09-30T00:00:00Z") + hour * 3_600_000);
      const order = legForNow(MULTI, at).leg_order;
      expect(order).toBeGreaterThanOrEqual(seen);
      seen = order;
    }
    expect(seen).toBe(2);
  });

  it("gives the same answer every time for the same instant", () => {
    const straddling = new Date("2026-10-04T16:00:00Z"); // 10-05 Tokyo, 10-04 Bangkok
    const answers = new Set(
      Array.from({ length: 5 }, () => legForNow(MULTI, straddling).id),
    );
    expect(answers.size).toBe(1);
    // They have not left Tokyo yet, so that is where they are.
    expect(legForNow(MULTI, straddling).city).toBe("Tokyo");
  });
});

// The bug this whole change exists for: board_time fired on the old city's
// clock after a leg change.
describe("board timing follows the city they are in", () => {
  const trip = { ...MULTI, board_time: "08:00" };

  it("holds the Bangkok board until 8am in Bangkok, not 8am in Tokyo", () => {
    // 2026-10-05 08:30 Tokyo is 06:30 in Bangkok: too early for the board.
    const tokyoEight = new Date("2026-10-04T23:30:00Z");
    expect(boardDueNow(trip, tokyoEight)).toMatchObject({
      due: false,
      reason: "before_board_time",
    });
    // 08:30 in Bangkok: now it is due, and it is the Bangkok day.
    const bangkokEight = new Date("2026-10-05T01:30:00Z");
    expect(boardDueNow(trip, bangkokEight)).toMatchObject({ due: true, date: "2026-10-05" });
  });

  it("is identical to the old behaviour on a one-city trip", () => {
    const single = { ...SINGLE, board_time: "08:00" };
    expect(boardDueNow(single, new Date("2026-10-02T22:30:00Z"))).toMatchObject({
      due: false,
      reason: "before_board_time",
    });
    expect(boardDueNow(single, new Date("2026-10-02T23:30:00Z"))).toMatchObject({
      due: true,
      date: "2026-10-03",
    });
  });
});

describe("reading a destination answer", () => {
  it("treats one place as one place, which is the whole point", () => {
    expect(splitDestinationAnswer("Tokyo")).toEqual(["Tokyo"]);
    expect(splitDestinationAnswer("  osaka  ")).toEqual(["osaka"]);
  });

  it("does not split a city from its country", () => {
    expect(splitDestinationAnswer("tokyo, japan")).toEqual(["tokyo, japan"]);
    expect(splitDestinationAnswer("Paris, France")).toEqual(["Paris, France"]);
  });

  it("does not split a city whose name contains a separator word", () => {
    // "Auckland" contains "and"; "Thailand" contains "and" too.
    expect(splitDestinationAnswer("Auckland")).toEqual(["Auckland"]);
    expect(splitDestinationAnswer("Thailand")).toEqual(["Thailand"]);
    expect(splitDestinationAnswer("Andorra")).toEqual(["Andorra"]);
  });

  it("splits the ways people actually write more than one place", () => {
    expect(splitDestinationAnswer("Tokyo and Osaka")).toEqual(["Tokyo", "Osaka"]);
    expect(splitDestinationAnswer("Tokyo then Kyoto")).toEqual(["Tokyo", "Kyoto"]);
    expect(splitDestinationAnswer("Tokyo -> Kyoto -> Osaka")).toEqual(["Tokyo", "Kyoto", "Osaka"]);
    expect(splitDestinationAnswer("tokyo, osaka")).toEqual(["tokyo", "osaka"]);
    expect(splitDestinationAnswer("Tokyo then Osaka, japan")).toEqual(["Tokyo", "Osaka, japan"]);
  });

  it("collapses a place named twice in a row", () => {
    expect(splitDestinationAnswer("Tokyo and Tokyo")).toEqual(["Tokyo"]);
  });
});

describe("turning cities into legs", () => {
  const cities = (...names: string[]) => names.map((city) => ({ city, timezone: null }));

  it("gives one city the whole trip, which is the single-leg path", () => {
    const legs = splitIntoLegs({
      tripId: "t",
      cities: cities("Tokyo"),
      startDate: "2026-10-01",
      endDate: "2026-10-08",
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      city: "Tokyo",
      start_date: "2026-10-01",
      end_date: "2026-10-08",
      is_travel_day: false,
    });
  });

  it("partitions the dates with no gap and no overlap", () => {
    const legs = splitIntoLegs({
      tripId: "t",
      cities: cities("Tokyo", "Kyoto", "Osaka"),
      startDate: "2026-10-01",
      endDate: "2026-10-08",
    });
    expect(legs.map((l) => [l.start_date, l.end_date])).toEqual([
      ["2026-10-01", "2026-10-03"],
      ["2026-10-04", "2026-10-06"],
      ["2026-10-07", "2026-10-08"],
    ]);
    expect(legProblems(legs)).toEqual([]);
    // Every leg after the first is arrived at, so its first day is travel.
    expect(legs.map((l) => l.is_travel_day)).toEqual([false, true, true]);
  });

  it("never returns a leg that ends before it starts", () => {
    const legs = splitIntoLegs({
      tripId: "t",
      cities: cities("A", "B", "C", "D", "E"),
      startDate: "2026-10-01",
      endDate: "2026-10-02",
    });
    for (const l of legs) expect(l.end_date >= l.start_date).toBe(true);
    expect(legProblems(legs)).toEqual([]);
  });

  it("reports a stored partition that has gone wrong instead of throwing", () => {
    const overlapping = [
      leg(1, "Tokyo", "2026-10-01", "2026-10-05", "Asia/Tokyo"),
      leg(2, "Osaka", "2026-10-04", "2026-10-08", "Asia/Tokyo"),
    ];
    expect(legProblems(overlapping)).toContain("leg 2 overlaps the one before it");
  });
});
