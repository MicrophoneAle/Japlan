// Organizer setup: the trip-level questions (where, when, how hard, the stake).
// Separate from the personal preference survey. Pure: resolving a place and
// reading loose dates happen in handlers; this module decides what to ask
// and whether answers are usable.

export type SetupQuestionId = "destination" | "dates" | "difficulty" | "stake";

export const SETUP_ORDER: SetupQuestionId[] = ["destination", "dates", "difficulty", "stake"];

// setup_state values beyond a question id.
export const SETUP_DONE = "done";
export const SETUP_DEFERRED = "deferred";

export type Difficulty = "chill" | "normal" | "unhinged";
export const DIFFICULTIES: Difficulty[] = ["chill", "normal", "unhinged"];

export type SetupFields = {
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
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

export function nextSetupQuestion(after: SetupQuestionId): SetupQuestionId | null {
  const index = SETUP_ORDER.indexOf(after);
  return SETUP_ORDER[index + 1] ?? null;
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

// What the generator is told for each difficulty. Points still come from the
// six axes in scoring.ts; this only steers which tasks get proposed.
export function difficultyGuidance(difficulty: string | null | undefined): string | null {
  switch (difficulty) {
    case "chill":
      return "Difficulty: chill. Favour low boldness and low physical effort; nothing embarrassing.";
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

export const MAX_TRIP_DAYS = 26; // day letters run A-Z

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
