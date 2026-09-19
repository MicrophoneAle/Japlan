// Organizer setup: the trip-level questions (where, when, how hard, the stake).
// Separate from the personal preference survey. Pure: resolving a place and
// reading loose dates happen in handlers; this module decides what to ask
// and whether answers are usable.

export type PlayMode = "individual" | "teams" | "full_group";

export type SetupQuestionId = "destination" | "dates" | "play_mode" | "difficulty" | "stake";

export const SETUP_ORDER: SetupQuestionId[] = ["destination", "dates", "play_mode", "difficulty", "stake"];

// setup_state values beyond a question id.
export const SETUP_DONE = "done";
export const SETUP_DEFERRED = "deferred";

export type Difficulty = "chill" | "normal" | "unhinged";
export const DIFFICULTIES: Difficulty[] = ["chill", "normal", "unhinged"];

export type SetupFields = {
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  play_mode?: PlayMode | null;
  difficulty: string | null;
  stake_text: string | null;
};

export function isSetupQuestion(value: string | null | undefined): value is SetupQuestionId {
  return SETUP_ORDER.includes(value as SetupQuestionId);
}

// Destination and dates are required before the trip can go active; the
// board cannot be generated or dated without them.
export function missingRequiredSetup(trip: SetupFields): SetupQuestionId[] {
  const missing: SetupQuestionId[] = [];
  if (!trip.destination?.trim()) missing.push("destination");
  if (!trip.start_date || !trip.end_date) missing.push("dates");
  return missing;
}

export function setupReadyToActivate(trip: SetupFields): boolean {
  return missingRequiredSetup(trip).length === 0;
}

// The stake is what the loser does; a solo trip has no loser.
export function setupOrderFor(ctx: { isSolo?: boolean } = {}): SetupQuestionId[] {
  return ctx.isSolo
    ? SETUP_ORDER.filter((id) => id !== "stake" && id !== "play_mode")
    : SETUP_ORDER;
}

export function nextSetupQuestion(
  after: SetupQuestionId,
  ctx: { isSolo?: boolean } = {},
): SetupQuestionId | null {
  const order = setupOrderFor(ctx);
  const index = order.indexOf(after);
  return order[index + 1] ?? null;
}

export function isSetupSkip(text: string): boolean {
  return /^(skip|keep|same|pass|later)$/i.test(text.trim().replace(/[.!]+$/, ""));
}

export function matchDifficulty(text: string): Difficulty | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (DIFFICULTIES.includes(t as Difficulty)) return t as Difficulty;
  if (/^(easy|chilled|relaxed|low)$/.test(t)) return "chill";
  if (/^(medium|regular|mid|standard)$/.test(t)) return "normal";
  if (/^(hard|chaos|chaotic|wild|insane|max)$/.test(t)) return "unhinged";
  return null;
}

export function matchPlayMode(text: string): PlayMode | null {
  const value = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (/^(?:1\b|individual|solo|separately|on my own)(?:[.)·:\-\s]|$)/.test(value)) return "individual";
  if (/^(?:2\b|teams?|pairs?|pair up|with partners?)(?:[.)·:\-\s]|$)/.test(value)) return "teams";
  if (/^(?:3\b|full group|group|together|all together)(?:[.)·:\-\s]|$)/.test(value)) return "full_group";
  return null;
}

export function playModeLabel(value: string | null | undefined): string {
  switch (value) {
    case "teams":
      return "teams (daily pairs when interests overlap; otherwise individual tasks)";
    case "full_group":
      return "full group (one shared board and group decisions in this chat)";
    case "individual":
    default:
      return "individual (separate boards and tasks)";
  }
}

// What the generator is told for each difficulty. Points still come from the
// six axes in scoring.ts; this only steers which tasks get proposed.
export function difficultyGuidance(difficulty: string | null | undefined): string | null {
  switch (difficulty) {
    case "chill":
      return "Difficulty: chill. Low physical effort and short tasks, nothing embarrassing. Chill is not antisocial: small friendly asks of people are welcome.";
    case "normal":
      return "Difficulty: normal. A mix of easy and stretch tasks.";
    case "unhinged":
      return "Difficulty: unhinged. Favour bold, social, slightly ridiculous tasks, still safe, legal and nothing permanent.";
    default:
      return null;
  }
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

// "2026-10-17 to 2026-10-20" needs no model call.
export function parseIsoRange(text: string): { start: string; end: string } | null {
  const dates = text.match(ISO_DATE);
  if (!dates || dates.length < 1 || dates.length > 2) return null;
  return { start: dates[0], end: dates[1] ?? dates[0] };
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:,?\\s*(\\d{4}))?";
// "-", en dash, em dash, "to", "through", "until", "till".
const RANGE_SEP = "\\s*(?:-|\\u2013|\\u2014|to|through|thru|until|till)\\s*";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null; // "feb 30"
  return `${year}-${pad(month)}-${pad(day)}`;
}

// A range with no year means the next time it happens: this year unless it
// has already ended, then next year. "oct 17-20" typed in September is this
// October; "jan 5-10" typed in September is next January.
function withYear(
  parts: { m1: number; d1: number; m2: number; d2: number; year: number | null },
  today: string,
): { start: string; end: string } | null {
  const todayYear = Number(today.slice(0, 4));
  const crossesYear = parts.m2 < parts.m1; // "dec 28 - jan 3"
  const build = (y: number) => {
    const start = isoOf(y, parts.m1, parts.d1);
    const end = isoOf(crossesYear ? y + 1 : y, parts.m2, parts.d2);
    return start && end ? { start, end } : null;
  };
  if (parts.year !== null) return build(parts.year);
  const thisYear = build(todayYear);
  if (!thisYear) return null;
  return thisYear.end < today ? build(todayYear + 1) : thisYear;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type ParsedDates = { start: string; end: string; form: string };

// Deterministic first: the common ways people write trip dates. Returns null
// only for text none of these forms match; the caller then asks the model.
export function parseLooseDates(text: string, today: string): ParsedDates | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");

  const iso = parseIsoRange(t);
  if (iso) return { ...iso, form: "iso" };

  const month = (s: string) => MONTHS[s.replace(/\.$/, "")];
  let m: RegExpMatchArray | null;

  // "oct 17-20", "october 17th to 20th, 2026"
  m = t.match(new RegExp(`^${MONTH}\\s*${DAY}${RANGE_SEP}${DAY}${YEAR}$`));
  if (m) {
    const r = withYear({ m1: month(m[1]), d1: +m[2], m2: month(m[1]), d2: +m[3], year: m[4] ? +m[4] : null }, today);
    if (r) return { ...r, form: "month day-day" };
  }
  // "oct 28 - nov 2", "october 28 to november 2 2026"
  m = t.match(new RegExp(`^${MONTH}\\s*${DAY}${RANGE_SEP}${MONTH}\\s*${DAY}${YEAR}$`));
  if (m) {
    const r = withYear({ m1: month(m[1]), d1: +m[2], m2: month(m[3]), d2: +m[4], year: m[5] ? +m[5] : null }, today);
    if (r) return { ...r, form: "month day-month day" };
  }
  // "17-20 oct", "17th to 20th october"
  m = t.match(new RegExp(`^${DAY}${RANGE_SEP}${DAY}\\s*(?:of\\s+)?${MONTH}${YEAR}$`));
  if (m) {
    const r = withYear({ m1: month(m[3]), d1: +m[1], m2: month(m[3]), d2: +m[2], year: m[4] ? +m[4] : null }, today);
    if (r) return { ...r, form: "day-day month" };
  }
  // "28 oct - 2 nov"
  m = t.match(new RegExp(`^${DAY}\\s*${MONTH}${RANGE_SEP}${DAY}\\s*${MONTH}${YEAR}$`));
  if (m) {
    const r = withYear({ m1: month(m[2]), d1: +m[1], m2: month(m[4]), d2: +m[3], year: m[5] ? +m[5] : null }, today);
    if (r) return { ...r, form: "day month-day month" };
  }
  // A single day: "oct 17", "17 oct"
  m = t.match(new RegExp(`^${MONTH}\\s*${DAY}${YEAR}$`)) ;
  if (m) {
    const r = withYear({ m1: month(m[1]), d1: +m[2], m2: month(m[1]), d2: +m[2], year: m[3] ? +m[3] : null }, today);
    if (r) return { ...r, form: "month day" };
  }
  m = t.match(new RegExp(`^${DAY}\\s*${MONTH}${YEAR}$`));
  if (m) {
    const r = withYear({ m1: month(m[2]), d1: +m[1], m2: month(m[2]), d2: +m[1], year: m[3] ? +m[3] : null }, today);
    if (r) return { ...r, form: "day month" };
  }

  // Weekends. "this weekend" is the coming Saturday and Sunday (the current
  // one if it is already the weekend); "next weekend" is the one after. The
  // confirmation echoes the dates so a different reading can be corrected.
  const weekend = t.match(/^(this|next|the)?\s*weekend$/);
  if (weekend) {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 sun .. 6 sat
    let saturday = addDaysIso(today, (6 - dow + 7) % 7);
    if (dow === 0) saturday = addDaysIso(today, -1); // sunday: this weekend began yesterday
    if (weekend[1] === "next") saturday = addDaysIso(saturday, 7);
    const start = weekend[1] !== "next" && dow === 0 ? today : saturday;
    return { start, end: addDaysIso(saturday, 1), form: `${weekend[1] ?? "this"} weekend` };
  }

  return null;
}

// Not a capability limit (day letters cycle past Z): a range this long is
// almost always a mistyped year, so it is asked about rather than stored.
export const MAX_TRIP_DAYS = 90;

export type DateRangeCheck =
  | { ok: true; start: string; end: string }
  | { ok: false; reason: "invalid" | "backwards" | "too_long" | "in_the_past" };

// Validated in code whatever produced the dates (regex or model).
export function checkDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
  today: string,
): DateRangeCheck {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!start || !end || !iso.test(start) || !iso.test(end)) return { ok: false, reason: "invalid" };
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || Number.isNaN(t)) return { ok: false, reason: "invalid" };
  // Round-trip guards against "2026-02-31" silently rolling into March.
  if (new Date(s).toISOString().slice(0, 10) !== start) return { ok: false, reason: "invalid" };
  if (new Date(e).toISOString().slice(0, 10) !== end) return { ok: false, reason: "invalid" };
  if (e < s) return { ok: false, reason: "backwards" };
  if ((e - s) / 86_400_000 + 1 > MAX_TRIP_DAYS) return { ok: false, reason: "too_long" };
  if (e < t) return { ok: false, reason: "in_the_past" };
  return { ok: true, start, end };
}

// Lowest score carries the stake. Ties at the bottom share it.
export function losersOf(standings: { name: string; score: number }[]): string[] {
  if (standings.length < 2) return [];
  const low = Math.min(...standings.map((s) => s.score));
  return standings.filter((s) => s.score === low).map((s) => s.name);
}
