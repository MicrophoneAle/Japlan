// Some days are worth more. A national holiday, a festival week, a weekend:
// the whole point is to get people out of the airbnb on the days the city is
// actually alive, so the day's multiplier is announced on the board and paid
// to everyone on the trip, not to one person.
//
// Network-free by rule (lib/game). Fetched days arrive as rows somebody else
// looked up (lib/handlers/holidays.ts). Weekends are arithmetic, so they work
// with no api, no key and no trip profile.
//
// What multiplies:
//   national holiday        3x
//   major festival period   2x   (golden week, obon, carnival, songkran)
//   weekend (fri/sat/sun)  1.25x
//
// How it combines with dayValueMultiplier: lib/game/scoring.ts already scales
// a task by which day of the trip it lands on (later days are worth more, the
// final day doubles), and that scaling is baked into tasks.base_points, which
// is the number printed on the board.
//
// The two never multiply. The HIGHER of them applies and the other is
// discarded, so the most a task can be worth is
//   min(3, max(dayValue, event))
// times its raw axes score. A holiday on the final day is 3x, not 6x: it
// cannot break the tier bands or empty the daily cap in one claim.
//
// In practice that means a special day REPLACES the day-of-trip scaling: the
// board prints the task's own unscaled worth and the multiplier applies to the
// number printed, so "everything's 2x" is literally true of the points you can
// see. (The alternative, announcing the factor left over after dayValue, is
// just as correct and completely unreadable: real Golden Week data comes out
// as "everything's 2.61x".) When dayValue is already the higher of the two,
// the event is discarded instead and the board says nothing, which is why a
// plain weekend stops mattering from day 3 onward while holidays and festivals
// always still pay.
//
// Whole days only. Friday is in the 1.25x tier with the weekend rather than
// friday evening alone: an evening-only window cannot be baked into a task's
// points, and 1.25x only ever beats dayValue on trip days 1 and 2 anyway.

import { dayValueMultiplier } from "./scoring";

export type MultiplierSource = "holiday" | "festival" | "weekend";

// A stored special day. One row per trip per local date.
export type MultiplierDay = {
  local_date: string;
  multiplier: number;
  label: string;
  source: string;
};

// A national holiday outscores a festival period on purpose: golden week is
// several days of 2x, the individual public holidays inside it are worth more.
export const HOLIDAY_MULTIPLIER = 3;
export const FESTIVAL_MULTIPLIER = 2;
// Friday counts with the weekend: it is the day people go out, and the tier is
// "the weekend starts on friday" rather than three separate rules.
export const WEEKEND_MULTIPLIER = 1.25;

// Nothing is ever worth more than this, whatever a lookup returns.
export const MAX_MULTIPLIER = 3;

export type ActiveMultiplier = {
  multiplier: number;
  label: string;
  source: MultiplierSource;
};

export function multiplierForSource(source: string): number {
  if (source === "holiday") return HOLIDAY_MULTIPLIER;
  if (source === "festival") return FESTIVAL_MULTIPLIER;
  return 1;
}

// Two decimals, so a stored factor and the number on the board are the same
// number and the arithmetic on a claim confirmation adds up.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// A stored row is only trusted if it parses: a bad lookup must never award
// 40x. Anything unusable is dropped, which leaves the day at 1.
function usableRow(row: MultiplierDay): ActiveMultiplier | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.local_date ?? "")) return null;
  const label = (row.label ?? "").trim();
  if (!label) return null;
  const source = row.source === "holiday" || row.source === "festival" ? row.source : null;
  if (!source) return null;
  const stored = Number(row.multiplier);
  // The row's own number is a hint; the source decides, so an edited row
  // cannot invent a value.
  const multiplier = Number.isFinite(stored) && stored > 1
    ? Math.min(stored, multiplierForSource(source))
    : multiplierForSource(source);
  return { multiplier: Math.min(multiplier, MAX_MULTIPLIER), label, source };
}

// Sat or Sun, from the local calendar date. The date string is already
// trip-local, so UTC parsing is correct here.
export function weekdayOf(localDate: string): number {
  const at = Date.parse(`${localDate}T00:00:00Z`);
  return Number.isNaN(at) ? -1 : new Date(at).getUTCDay();
}

// Friday, saturday or sunday: the days worth being out.
export function isWeekend(localDate: string): boolean {
  const day = weekdayOf(localDate);
  return day === 0 || day === 5 || day === 6;
}

export function isFriday(localDate: string): boolean {
  return weekdayOf(localDate) === 5;
}

// Every event multiplier that could apply to a date, best first.
export function multipliersForDate(
  localDate: string,
  days: MultiplierDay[] = [],
): ActiveMultiplier[] {
  const found: ActiveMultiplier[] = [];
  for (const row of days) {
    if (row.local_date !== localDate) continue;
    const usable = usableRow(row);
    if (usable) found.push(usable);
  }
  if (isWeekend(localDate)) {
    found.push({
      multiplier: WEEKEND_MULTIPLIER,
      label: isFriday(localDate) ? "friday" : "the weekend",
      source: "weekend",
    });
  }
  return found.sort((a, b) => b.multiplier - a.multiplier);
}

// The best event multiplier a date carries, before it meets the day-of-trip
// scaling. Never stacked: golden week on a saturday is 2x, not 2.5x, and a
// holiday on a saturday is 3x, not 3.75x.
export function eventMultiplierForDate(
  localDate: string,
  days: MultiplierDay[] = [],
): ActiveMultiplier | null {
  const best = multipliersForDate(localDate, days)[0];
  return best && best.multiplier > 1 ? best : null;
}

// The rule that keeps a holiday on the final day from paying 6x: the higher of
// the two, never the product, never above 3x.
export function combinedMultiplier(dayValue: number, eventValue: number): number {
  const day = Number.isFinite(dayValue) && dayValue > 1 ? dayValue : 1;
  const event = Number.isFinite(eventValue) && eventValue > 1 ? eventValue : 1;
  return Math.min(MAX_MULTIPLIER, Math.max(day, event));
}

// What a task generated for this trip-day carries, and what the board
// announces. Null on an ordinary day, and on a day whose event multiplier the
// day-of-trip scaling has already overtaken: taking the higher of the two
// means the smaller one is simply discarded.
//
// When this is not null the caller must also drop the day-of-trip scaling from
// base_points (persistableTask does), because the event multiplier is standing
// in its place. That is what makes "everything's 2x" true of the number on the
// board rather than true of some number nobody can see.
export type TaskMultiplier = {
  value: number;
  label: string;
  source: MultiplierSource;
};

export function taskMultiplierFor(opts: {
  localDate: string;
  day: number;
  tripDays: number | null;
  days?: MultiplierDay[];
}): TaskMultiplier | null {
  const event = eventMultiplierForDate(opts.localDate, opts.days ?? []);
  if (!event) return null;
  const dayValue = dayValueMultiplier(opts.day, opts.tripDays);
  // The day-of-trip scaling already beats it: keep that and say nothing.
  if (dayValue >= event.multiplier) return null;
  return {
    value: round2(combinedMultiplier(dayValue, event.multiplier)),
    label: event.label,
    source: event.source,
  };
}

// What a stored task pays. The task carries the promise, so a claim awards
// what its board line said even if the local day rolled over between the board
// landing and the claim, and the claim path needs no lookup of its own.
export type StoredTaskMultiplier = {
  day_multiplier?: number | null;
  multiplier_reason?: string | null;
};

export function taskMultiplierInForce(
  task: StoredTaskMultiplier,
): { value: number; label: string } | null {
  const stored = Number(task.day_multiplier);
  if (!Number.isFinite(stored) || stored <= 1) return null;
  return {
    value: Math.min(stored, MAX_MULTIPLIER),
    label: (task.multiplier_reason ?? "").trim() || "today",
  };
}

// Points are integers everywhere else, so a multiplied award rounds once,
// here, and never goes below what the task was worth.
export function applyMultiplier(points: number, multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 1) return points;
  const capped = Math.min(multiplier, MAX_MULTIPLIER);
  return Math.max(points, Math.round(points * capped));
}

// The daily cap rises with the day. Without it a 2x day just means hitting the
// ceiling in half the claims, which is the opposite of the incentive: the cap
// bounds how many tasks one person can farm, not what a day is worth, so it
// scales by the same factor the day does.
export function capForMultiplier(cap: number, multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 1) return cap;
  return Math.round(cap * Math.min(multiplier, MAX_MULTIPLIER));
}

// A looked-up day is a proposal, never a source of truth. Everything from
// Nager.Date or a scraped festival page passes through here before it can
// touch the database: the date has to parse, sit inside the trip, and carry a
// name, and the source decides the multiplier so no page can name its number.
export const MAX_SPECIAL_DAYS = 40;
const MAX_LABEL_LENGTH = 40;

export function validSpecialDays(
  proposed: { date: string; name: string; kind: string }[],
  range: { start: string; end: string },
): MultiplierDay[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end)) return [];
  const best = new Map<string, MultiplierDay>();
  for (const row of proposed) {
    const date = (row.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) continue;
    if (date < range.start || date > range.end) continue;
    // House style is lowercase, and a page title is not a label.
    const label = (row.name ?? "").trim().toLowerCase().slice(0, MAX_LABEL_LENGTH);
    if (!label) continue;
    const kind = (row.kind ?? "").toLowerCase();
    const source = kind.includes("festival") || kind.includes("period") ? "festival" : "holiday";
    const candidate: MultiplierDay = {
      local_date: date,
      multiplier: multiplierForSource(source),
      label,
      source,
    };
    const existing = best.get(date);
    if (!existing || candidate.multiplier > existing.multiplier) best.set(date, candidate);
  }
  return [...best.values()]
    .sort((a, b) => a.local_date.localeCompare(b.local_date))
    .slice(0, MAX_SPECIAL_DAYS);
}

// "2x" / "1.25x": trailing zeros never help.
export function multiplierLabel(multiplier: number): string {
  const rounded = round2(multiplier);
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, "")}x`;
}
