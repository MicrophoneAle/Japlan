import {
  addDaysIso,
  daysBetweenIso,
  localDateString,
  localTimeHHMM,
  zonedTimeToUtc,
} from "./time";

// When boards post, and which day a request means. Pure.
//
// A trip's board for a local day posts at trips.board_time (default 08:00):
// any cron tick at or after that time posts it if it does not exist yet, so a
// late or missed tick recovers on the next one instead of skipping the day.
// Days outside start_date..end_date never get a board.

export const DEFAULT_BOARD_TIME = "08:00";

// "7am", "7 am", "07:00", "10:30", "10.30", "7:15pm", "19:00", "noon".
export function parseBoardTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "noon" || t === "midday") return "12:00";
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (meridiem === "pm" && hour !== 12) hour += 12;
  } else if (!m[2] && hour <= 12) {
    // A bare "7" is ambiguous; ask for am/pm or a 24h time instead of guessing.
    return null;
  }
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// "08:00" -> "8am", "10:30" -> "10:30am", "19:00" -> "7pm".
export function formatBoardTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, "0")}${suffix}`;
}

export type TripWindow = {
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  board_time?: string | null;
};

function boardTimeOf(trip: TripWindow): string {
  return trip.board_time && /^\d{2}:\d{2}/.test(trip.board_time)
    ? trip.board_time.slice(0, 5)
    : DEFAULT_BOARD_TIME;
}

// Day 1 is start_date. Before the trip this is 0 or negative.
export function tripDayForDate(startDate: string, date: string): number {
  return daysBetweenIso(startDate, date) + 1;
}

export function dateForTripDay(startDate: string, day: number): string {
  return addDaysIso(startDate, day - 1);
}

export type DueCheck =
  | { due: true; date: string; day: number }
  | { due: false; reason: "not_started" | "ended" | "before_board_time" | "no_dates" };

// The cron's question for one trip at one tick: is today's board due?
export function boardDueNow(trip: TripWindow, now: Date): DueCheck {
  if (!trip.start_date || !trip.end_date) return { due: false, reason: "no_dates" };
  const today = localDateString(now, trip.timezone);
  if (today < trip.start_date) return { due: false, reason: "not_started" };
  if (today > trip.end_date) return { due: false, reason: "ended" };
  if (localTimeHHMM(now, trip.timezone) < boardTimeOf(trip)) {
    return { due: false, reason: "before_board_time" };
  }
  return { due: true, date: today, day: tripDayForDate(trip.start_date, today) };
}

// When the next scheduled board posts, for messages like "first board lands
// tomorrow at 8am". Null when the trip has no dates or is over.
export function nextBoardAt(
  trip: TripWindow,
  now: Date,
  opts: { todayBoardExists: boolean },
): { at: Date; date: string } | null {
  if (!trip.start_date || !trip.end_date) return null;
  const today = localDateString(now, trip.timezone);
  let date = today < trip.start_date ? trip.start_date : today;
  if (date === today && opts.todayBoardExists) date = addDaysIso(today, 1);
  if (date > trip.end_date) return null;
  const at = zonedTimeToUtc(date, `${boardTimeOf(trip)}:00`, trip.timezone);
  // Today's time already passed without a board: the next tick posts it.
  return { at: at < now ? now : at, date };
}

// "today at 8am", "tomorrow at 8am", "oct 17 at 8am", in the trip's zone.
export function describeBoardTime(at: Date, now: Date, timezone: string | null): string {
  const day = localDateString(at, timezone);
  const today = localDateString(now, timezone);
  const time = formatBoardTime(localTimeHHMM(at, timezone));
  if (day === today) return at.getTime() <= now.getTime() + 60_000 ? "any minute now" : `today at ${time}`;
  if (day === addDaysIso(today, 1)) return `tomorrow at ${time}`;
  return `${shortDate(day)} at ${time}`;
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .toLowerCase();
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?";

export type BoardDay = { date: string; label: string };

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

// "oct 19" / "19 oct" / "october 19th": the year that lands inside or after
// the trip start (a trip in late december asking for "jan 2" means next year).
function monthDayDate(text: string, anchor: string): string | null {
  const m =
    text.match(new RegExp(`\\b${MONTH_WORD}\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`)) ??
    text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_WORD}`));
  if (!m) return null;
  const monthFirst = isNaN(Number(m[1]));
  const month = MONTH_NUM[(monthFirst ? m[1] : m[2]).slice(0, 3)];
  const day = Number(monthFirst ? m[2] : m[1]);
  if (!month || day < 1 || day > 31) return null;
  const year = Number(anchor.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = `${year}-${pad(month)}-${pad(day)}`;
  // Half a year before the anchor means the following year.
  return daysBetweenIso(sameYear, anchor) > 180 ? `${year + 1}-${pad(month)}-${pad(day)}` : sameYear;
}

// Which day a board request means:
//   "day 3", "friday", "oct 19", "the last day", "first day", "tomorrow"
// No day words: today, or day 1 when the trip has not started yet (asking
// for "the plans" before the trip means its first day, not a refusal).
export function parseBoardDay(
  text: string,
  opts: { today: string; startDate: string | null; endDate?: string | null },
): BoardDay {
  const t = text.toLowerCase();
  if (/\b(last|final)\s+day\b/.test(t) && opts.endDate) {
    return { date: opts.endDate, label: "the last day" };
  }
  if (/\bfirst\s+day\b/.test(t) && opts.startDate) {
    return { date: opts.startDate, label: "day 1" };
  }
  const monthDay = monthDayDate(t, opts.startDate ?? opts.today);
  if (monthDay) return { date: monthDay, label: shortDate(monthDay) };
  if (/\bday after tomorrow\b/.test(t)) {
    return { date: addDaysIso(opts.today, 2), label: "the day after tomorrow" };
  }
  if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(t)) {
    return { date: addDaysIso(opts.today, 1), label: "tomorrow" };
  }
  const day = t.match(/\bday\s*(\d{1,2})\b/);
  if (day && opts.startDate) {
    const n = Number(day[1]);
    return { date: dateForTripDay(opts.startDate, n), label: `day ${n}` };
  }
  const weekday = t.match(new RegExp(`\\b${WEEKDAY_RE}\\b`));
  if (weekday) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(weekday[1].slice(0, 3)));
    const current = new Date(`${opts.today}T00:00:00Z`).getUTCDay();
    const ahead = (target - current + 7) % 7; // today if it is that weekday
    return { date: addDaysIso(opts.today, ahead), label: ahead === 0 ? "today" : WEEKDAYS[target] };
  }
  if (opts.startDate && opts.today < opts.startDate) {
    return { date: opts.startDate, label: "day 1" };
  }
  return { date: opts.today, label: "today" };
}

// A request for a board, not a claim ("did the ramen task") or chatter:
//   japlan plans / tasks / board / what am i doing today
//   japlan give me the plans
//   japlan tomorrow / japlan day 3 / japlan friday
// "japlan redo today", "different tasks", "these are boring, give me new
// ones", "i want something else": a request to REPLACE the board, checked
// before isBoardRequest (which only shows the stored board). Without this,
// "give me seven completely new tasks" matched isBoardRequest and resent the
// same board.
const REDO_RE = new RegExp(
  [
    String.raw`\b(redo|remake|reroll|re-roll|regenerate|refresh|reshuffle|shuffle)\b`,
    String.raw`\b(different|new|other|fresh|another|alternative)\s+(board|tasks?|ones?|plans?|list|itinerary|itenerary|schedule|stuff|set)\b`,
    String.raw`\bcompletely (new|different)\b`,
    String.raw`\bswap (these|them|my|the|out)\b`,
    String.raw`\b(these|this|my|the) (tasks?|board|ones?|plan)? ?(are|is|look|looks) (boring|bad|lame|mid|trash|dull)\b`,
    String.raw`\b(boring|lame|mid) (board|tasks?|plan)\b`,
    String.raw`\b(don'?t|do not) (like|want) (these|this|them|my|the) ?(board|tasks?|ones?|plan)?\b`,
    String.raw`\bhate (these|this|my) ?(board|tasks?|ones?)?\b`,
    String.raw`\bsomething else\b`,
  ].join("|"),
);

export function isRedoRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/\bjaplan\b[,:]?/g, " ").replace(/\s+/g, " ").trim();
  if (!REDO_RE.test(t)) return false;
  // "something else" alone is ambiguous in a long message ("something else
  // to eat"): only as a short request, or next to a board word.
  if (/\bsomething else\b/.test(t) && !/\b(board|tasks?|plans?|itinerary|ones?)\b/.test(t)) {
    if (t.split(" ").length > 6 || /\bsomething else (to|for|at|in|on)\b/.test(t)) return false;
  }
  // Talk about food or a place with "new" in it is not a board request.
  if (/\bnew (york|zealand|year)\b/.test(t)) return false;
  return true;
}

export function isBoardRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/\bjaplan\b[,:]?/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(did|done|finished|completed|claimed|got)\b/.test(t)) return false;
  // Just a day: "tomorrow", "day 3", "friday", "oct 19", "the last day"
  const dayOnly = new RegExp(
    `^(?:(?:what about|and|how about|for|show me)\\s+)?(?:today|tonight|tomorrow|tmrw|the day after tomorrow|day\\s*\\d{1,2}|${WEEKDAY_RE}|(?:the\\s+)?(?:first|last|final)\\s+day|${MONTH_WORD}\\s*\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s*${MONTH_WORD})[?.!]*$`,
  );
  if (dayOnly.test(t)) return true;
  if (/\bwhat am i (?:doing|up to)\b/.test(t)) return true;
  if (!/\b(plans?|board|tasks?|sidequests?|quests?|agenda|itinerary|schedule|to-?dos?)\b/.test(t)) {
    return false;
  }
  if (
    /^(?:the |my |today'?s |tomorrow'?s )?(plans?|board|tasks?|sidequests?|quests?|agenda|schedule)[?.!]*$/.test(
      t,
    )
  ) {
    return true;
  }
  return /\?|\b(give|show|send|what|whats|what's|where|when|any|my|today|tomorrow|first|next|day \d+|list)\b/.test(t);
}
