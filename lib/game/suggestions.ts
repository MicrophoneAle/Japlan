import { haversineKm, type LatLng } from "./duration";

// Where a place someone asked for goes: the earliest day (from today) whose
// stops are near it, else the earliest day with nothing planned yet, else
// nowhere yet, with the day it would suit best. Pure: the handler loads each
// day's points (its tasks' neighborhoods and anchors) and writes the result.

export const NEAR_KM = 2.5;

export type DayPoints = {
  day: number;
  points: LatLng[];
  // A name for where that day is, for "it's near your day 3 stops (ueno)".
  area: string | null;
};

export type SuggestionFit =
  | { kind: "near"; day: number; km: number; area: string | null }
  | { kind: "open_day"; day: number }
  | { kind: "asked_day"; day: number }
  | { kind: "no_fit"; bestDay: number | null; km: number | null }
  | { kind: "no_location" };

export function fitSuggestion(opts: {
  coords: LatLng | null;
  days: DayPoints[];
  // "put it on day 3", "friday": the person's call wins.
  askedDay?: number | null;
}): SuggestionFit {
  const days = [...opts.days].sort((a, b) => a.day - b.day);
  if (opts.askedDay && days.some((d) => d.day === opts.askedDay)) {
    return { kind: "asked_day", day: opts.askedDay };
  }
  if (!opts.coords) return { kind: "no_location" };
  const here = opts.coords;
  const distance = (d: DayPoints) =>
    d.points.length ? Math.min(...d.points.map((p) => haversineKm(here, p))) : null;
  for (const d of days) {
    const km = distance(d);
    if (km !== null && km <= NEAR_KM) return { kind: "near", day: d.day, km, area: d.area };
  }
  const open = days.find((d) => d.points.length === 0);
  if (open) return { kind: "open_day", day: open.day };
  let best: { day: number; km: number } | null = null;
  for (const d of days) {
    const km = distance(d);
    if (km !== null && (!best || km < best.km)) best = { day: d.day, km };
  }
  return { kind: "no_fit", bestDay: best?.day ?? null, km: best?.km ?? null };
}

// Free text from the survey ("teamLab, a jazz bar in golden gai and the fish
// market") into separate places.
export function splitPlaceList(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/,|;|\band\b|\n|\//i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !/^(none|nothing|no|not really|n\/?a|idk|skip)$/i.test(s));
}

// Sources that represent "somebody on this trip asked for this place": typed
// into the chat, pulled off a link they posted, or named in their survey. One
// venue is one row across all of them, or a pasted reel about a place someone
// already mentioned becomes a second row and a second message.
export const SUGGESTED_SOURCES = ["suggestion", "social"] as const;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[.,!?'"`]/g, "")
    .trim();
}

// The row this place is already stored as, whichever path put it there first.
export function existingSuggestion<T extends { name: string; source?: string | null }>(
  places: T[],
  name: string,
): T | null {
  const want = normalizeName(name);
  if (!want) return null;
  return (
    places.find(
      (p) =>
        SUGGESTED_SOURCES.includes((p.source ?? "") as (typeof SUGGESTED_SOURCES)[number]) &&
        normalizeName(p.name) === want,
    ) ?? null
  );
}
