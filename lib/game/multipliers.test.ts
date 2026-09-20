import { describe, expect, it } from "vitest";
import { dayValueMultiplier, tripLengthDays } from "./scoring";
import { dailyBoardHeader, multiplierDayAnnouncement, multiplierHeaderPart } from "./copy";
import { formatPersonalBoard } from "./board";
import {
  FESTIVAL_MULTIPLIER,
  HOLIDAY_MULTIPLIER,
  MAX_MULTIPLIER,
  MAX_SPECIAL_DAYS,
  WEEKEND_MULTIPLIER,
  applyMultiplier,
  capForMultiplier,
  combinedMultiplier,
  eventMultiplierForDate,
  multiplierLabel,
  taskMultiplierFor,
  taskMultiplierInForce,
  validSpecialDays,
  type MultiplierDay,
} from "./multipliers";

// 2026-10-02 is a friday, 10-03 a saturday, 10-04 a sunday, 10-05 a monday.
const FRIDAY = "2026-10-02";
const SATURDAY = "2026-10-03";
const SUNDAY = "2026-10-04";
const MONDAY = "2026-10-05";

const holiday = (local_date: string, label: string): MultiplierDay => ({
  local_date,
  multiplier: HOLIDAY_MULTIPLIER,
  label,
  source: "holiday",
});

const festival = (local_date: string, label: string): MultiplierDay => ({
  local_date,
  multiplier: FESTIVAL_MULTIPLIER,
  label,
  source: "festival",
});

describe("which days are worth more", () => {
  it("counts friday, saturday and sunday, and nothing else", () => {
    expect(eventMultiplierForDate(SATURDAY)).toMatchObject({ source: "weekend", label: "the weekend" });
    expect(eventMultiplierForDate(SUNDAY)?.source).toBe("weekend");
    expect(eventMultiplierForDate(FRIDAY)).toMatchObject({ source: "weekend", label: "friday" });
    expect(eventMultiplierForDate(MONDAY)).toBeNull();
  });

  it("pays a national holiday over a festival period, and a festival over a weekend", () => {
    const days = [holiday(MONDAY, "sports day"), festival(SATURDAY, "golden week")];
    expect(eventMultiplierForDate(MONDAY, days)).toMatchObject({
      multiplier: HOLIDAY_MULTIPLIER,
      label: "sports day",
    });
    expect(eventMultiplierForDate(SATURDAY, days)).toMatchObject({
      multiplier: FESTIVAL_MULTIPLIER,
      label: "golden week",
    });
    // The same monday with nothing looked up is just a monday.
    expect(eventMultiplierForDate(MONDAY)).toBeNull();
  });

  it("ignores a row that does not parse rather than awarding it", () => {
    const junk: MultiplierDay[] = [
      { local_date: "not a date", multiplier: 3, label: "x", source: "holiday" },
      { local_date: MONDAY, multiplier: 3, label: "   ", source: "holiday" },
      { local_date: MONDAY, multiplier: 3, label: "made up", source: "whatever" },
    ];
    expect(eventMultiplierForDate(MONDAY, junk)).toBeNull();
  });

  it("clamps a row that claims more than its source is worth", () => {
    const greedy: MultiplierDay[] = [
      { local_date: MONDAY, multiplier: 40, label: "free points", source: "holiday" },
    ];
    expect(eventMultiplierForDate(MONDAY, greedy)?.multiplier).toBe(HOLIDAY_MULTIPLIER);
  });
});

describe("multipliers never stack", () => {
  it("gives 3x for a holiday on a weekend, not 3.75x", () => {
    const days = [holiday(SATURDAY, "respect for the aged day")];
    const best = eventMultiplierForDate(SATURDAY, days);
    expect(best?.multiplier).toBe(HOLIDAY_MULTIPLIER);
    expect(best?.multiplier).not.toBe(HOLIDAY_MULTIPLIER * WEEKEND_MULTIPLIER);
    expect(best?.label).toBe("respect for the aged day");
  });

  it("gives 2x for a festival on a friday, not 2.5x", () => {
    const days = [festival(FRIDAY, "golden week")];
    expect(eventMultiplierForDate(FRIDAY, days)?.multiplier).toBe(FESTIVAL_MULTIPLIER);
  });

  it("takes the higher of the day-of-trip value and the event, never the product", () => {
    // The final day already doubles (dayValueMultiplier). A holiday on it is
    // 3x, not 6x.
    expect(combinedMultiplier(2, 3)).toBe(3);
    expect(combinedMultiplier(2, 3)).not.toBe(6);
    // The day-of-trip value wins when it is already the bigger of the two.
    expect(combinedMultiplier(2, 1.25)).toBe(2);
    expect(combinedMultiplier(1, 1.25)).toBe(1.25);
    expect(combinedMultiplier(1, 1)).toBe(1);
  });

  it("never exceeds 3x however the two are combined, on any day of any trip", () => {
    const events = [WEEKEND_MULTIPLIER, FESTIVAL_MULTIPLIER, HOLIDAY_MULTIPLIER];
    for (const tripDays of [1, 3, 7, 14, 30, 90]) {
      for (let day = 1; day <= tripDays; day++) {
        const dayValue = dayValueMultiplier(day, tripDays);
        for (const event of events) {
          expect(combinedMultiplier(dayValue, event)).toBeLessThanOrEqual(MAX_MULTIPLIER);
        }
      }
    }
  });

  // The stored factor multiplies UNSCALED points (persistableTask drops the
  // day-of-trip scaling whenever it writes one), so this is the total a task
  // can ever be worth relative to its raw axes score.
  it("never lets a stored multiplier push a task past 3x its raw worth", () => {
    const tripDays = 6;
    for (let day = 1; day <= tripDays; day++) {
      const date = new Date(Date.parse("2026-10-01T00:00:00Z") + (day - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const days of [[holiday(date, "x")], [festival(date, "x")], []]) {
        const found = taskMultiplierFor({ localDate: date, day, tripDays, days });
        const total = found ? found.value : dayValueMultiplier(day, tripDays);
        expect(total).toBeLessThanOrEqual(MAX_MULTIPLIER);
      }
    }
  });
});

describe("what a task carries", () => {
  const tripDays = tripLengthDays("2026-10-01", "2026-10-06");

  it("discards the event when the day-of-trip scaling already beats it", () => {
    // Day 3 of the trip, an ordinary saturday: dayValue is 1.3, already above
    // the weekend's 1.25, so the weekend is discarded and the board says
    // nothing. Taking the higher of the two means the smaller one is dropped.
    expect(taskMultiplierFor({ localDate: SATURDAY, day: 3, tripDays })).toBeNull();
    // Day 1, the same weekend: dayValue is 1, so the weekend is the higher.
    expect(taskMultiplierFor({ localDate: SATURDAY, day: 1, tripDays })).toMatchObject({
      value: WEEKEND_MULTIPLIER,
      source: "weekend",
    });
    expect(taskMultiplierFor({ localDate: MONDAY, day: 1, tripDays })).toBeNull();
  });

  // The whole reason a special day replaces the day-of-trip scaling instead of
  // compounding with it: otherwise the honest number to print is whatever is
  // left over after dayValue, and real Golden Week data reads "2.61x".
  it("announces a clean number people can check, on every day of the trip", () => {
    for (const [date, day] of [["2026-10-01", 1], ["2026-10-03", 3], ["2026-10-06", 6]] as const) {
      expect(
        taskMultiplierFor({ localDate: date, day, tripDays, days: [holiday(date, "sports day")] }),
      ).toMatchObject({ value: 3, label: "sports day", source: "holiday" });
    }
  });
});

describe("what a stored task pays", () => {
  it("pays the number stored on the task, whatever the clock says the day is", () => {
    // The board promised 2x on a day that has since rolled over. The claim
    // still pays 2x, because the promise is on the task and not on the clock.
    expect(taskMultiplierInForce({ day_multiplier: 2, multiplier_reason: "golden week" })).toEqual({
      value: 2,
      label: "golden week",
    });
    expect(applyMultiplier(20, 2)).toBe(40);
  });

  it("pays nothing on a task with no multiplier, and never more than 3x", () => {
    expect(taskMultiplierInForce({})).toBeNull();
    expect(taskMultiplierInForce({ day_multiplier: 1 })).toBeNull();
    expect(taskMultiplierInForce({ day_multiplier: 40 })?.value).toBe(MAX_MULTIPLIER);
  });
});

describe("what a multiplier pays", () => {
  it("rounds once and never pays less than the task was worth", () => {
    expect(applyMultiplier(17, 2)).toBe(34);
    expect(applyMultiplier(17, 1.25)).toBe(21);
    expect(applyMultiplier(17, 1)).toBe(17);
    expect(applyMultiplier(0, 3)).toBe(0);
    expect(applyMultiplier(17, 0.5)).toBe(17);
    expect(applyMultiplier(17, Number.NaN)).toBe(17);
    expect(applyMultiplier(17, 40)).toBe(51);
  });

  // The cap SCALES rather than being raised by a flat amount. The cap exists
  // to bound how many tasks one person can farm in a day, not what a day is
  // worth: scaling keeps the number of claims it takes to hit the ceiling the
  // same, so a 2x day is actually twice as good instead of filling up twice as
  // fast. A flat raise would mean something different at every multiplier.
  it("scales the daily cap with the day, so 2x is not just the ceiling sooner", () => {
    expect(capForMultiplier(120, 2)).toBe(240);
    expect(capForMultiplier(120, 3)).toBe(360);
    expect(capForMultiplier(120, 1.25)).toBe(150);
    expect(capForMultiplier(120, 1)).toBe(120);
    expect(capForMultiplier(120, 40)).toBe(360);
  });

  it("takes the same number of claims to hit the ceiling on a 3x day as on an ordinary one", () => {
    const base = 20;
    const plain = Math.ceil(120 / base);
    const special = Math.ceil(capForMultiplier(120, 3) / applyMultiplier(base, 3));
    expect(special).toBe(plain);
  });

  it("writes the multiplier the way a person would say it", () => {
    expect(multiplierLabel(2)).toBe("2x");
    expect(multiplierLabel(3)).toBe("3x");
    expect(multiplierLabel(1.25)).toBe("1.25x");
    expect(multiplierLabel(1.5)).toBe("1.5x");
  });
});

describe("days read off a lookup", () => {
  const range = { start: "2026-10-01", end: "2026-10-07" };

  it("keeps what parses and sits inside the trip", () => {
    const kept = validSpecialDays(
      [
        { date: MONDAY, name: "Sports Day", kind: "holiday" },
        { date: "2026-09-30", name: "Before The Trip", kind: "holiday" },
        { date: "2026-11-03", name: "After The Trip", kind: "holiday" },
        { date: "nonsense", name: "Bad Date", kind: "holiday" },
        { date: "2026-10-06", name: "   ", kind: "holiday" },
      ],
      range,
    );
    expect(kept).toEqual([
      { local_date: MONDAY, multiplier: HOLIDAY_MULTIPLIER, label: "sports day", source: "holiday" },
    ]);
  });

  it("reads a festival as a festival and a public holiday as a holiday", () => {
    const kept = validSpecialDays(
      [
        { date: FRIDAY, name: "Golden Week", kind: "festival period" },
        { date: SATURDAY, name: "Golden Week", kind: "festival period" },
      ],
      range,
    );
    expect(kept.map((d) => d.source)).toEqual(["festival", "festival"]);
    expect(kept.every((d) => d.multiplier === FESTIVAL_MULTIPLIER)).toBe(true);
  });

  it("keeps the better of two entries for one date", () => {
    const kept = validSpecialDays(
      [
        { date: MONDAY, name: "Golden Week", kind: "festival" },
        { date: MONDAY, name: "Sports Day", kind: "holiday" },
      ],
      range,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ label: "sports day", multiplier: HOLIDAY_MULTIPLIER });
  });

  it("never lets a lookup decide its own number, and never returns a whole year", () => {
    const flood = Array.from({ length: 80 }, (_, i) => ({
      date: `2026-10-0${(i % 7) + 1}`,
      name: `day ${i}`,
      kind: "holiday",
    }));
    const kept = validSpecialDays(flood, range);
    expect(kept.length).toBeLessThanOrEqual(MAX_SPECIAL_DAYS);
    expect(kept.every((d) => d.multiplier <= HOLIDAY_MULTIPLIER)).toBe(true);
  });

  it("drops everything when the trip's own dates are unusable", () => {
    expect(
      validSpecialDays([{ date: MONDAY, name: "Sports Day", kind: "holiday" }], { start: "", end: "" }),
    ).toEqual([]);
  });
});

describe("how a special day reaches people", () => {
  const part = (label: string, value: number) =>
    multiplierHeaderPart({ label, multiplier: multiplierLabel(value) });

  it("rides in the board header, after the route and the weather", () => {
    expect(dailyBoardHeader(3, "18°C", "Asakusa → Ueno", part("golden week", 2))).toBe(
      "Day 3 · Asakusa → Ueno · 18°C · ⚡ golden week, everything's 2x",
    );
    // Nothing special: the header is exactly what it always was.
    expect(dailyBoardHeader(3, "18°C", "Asakusa → Ueno", null)).toBe("Day 3 · Asakusa → Ueno · 18°C");
  });

  it("puts it on the personal board people actually read", () => {
    const board = formatPersonalBoard({
      day: 3,
      tasks: [{ code: "A1", title: "find the loudest street in koenji", base_points: 18 }],
      multiplierPart: part("golden week", 2),
    });
    expect(board.split("\n")[0]).toContain("⚡ golden week, everything's 2x");
  });

  // One message, in the group, in the morning. Never one per claim: the
  // multiplier is collective, so it is news rather than a receipt.
  it("warns about closures on a national holiday, and only invites on a festival", () => {
    const holidayLine = multiplierDayAnnouncement({
      label: "respect for the aged day",
      multiplier: "3x",
      source: "holiday",
    });
    expect(holidayLine).toContain("respect for the aged day");
    expect(holidayLine).toContain("3x");
    expect(holidayLine).toMatch(/shut/);
    expect(holidayLine.split("\n")).toHaveLength(1);

    const festivalLine = multiplierDayAnnouncement({
      label: "golden week",
      multiplier: "2x",
      source: "festival",
    });
    expect(festivalLine).toContain("golden week");
    expect(festivalLine).not.toMatch(/shut/);
    expect(festivalLine.split("\n")).toHaveLength(1);
  });

  it("keeps the house style: lowercase, one line, no em dashes", () => {
    const lines = [
      part("golden week", 2),
      part("friday", 1.25),
      multiplierDayAnnouncement({ label: "sports day", multiplier: "3x", source: "holiday" }),
      multiplierDayAnnouncement({ label: "the weekend", multiplier: "1.25x", source: "weekend" }),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/—/);
      expect(line.split("\n")).toHaveLength(1);
      // No capital letters anywhere: emoji and elongation carry emphasis.
      expect(line.replace(/[^A-Za-z]/g, "")).toBe(line.replace(/[^A-Za-z]/g, "").toLowerCase());
    }
  });
});
