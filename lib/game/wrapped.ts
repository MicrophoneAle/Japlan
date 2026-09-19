import { formatShortDate } from "./copy";
import { groupTotals, type Stats } from "./stats";

// The Wrapped contract: what the page renders, and where each field comes
// from. The page (app/wrapped) still renders the fictional `demo` fixture
// and has no per-trip route; buildWrappedData fills this same shape from a
// real trip, so the page can switch to it without changing shape.
// WRAPPED_SOURCES says, per field, whether it is real yet.

export type WrappedPhoto = { src: string; alt: string };

export type WrappedPerson = {
  name: string;
  score: number;
  rank: number;
  quests: number;
  favorite: string;
  moment: string;
  photo: WrappedPhoto;
};

export type WrappedSlide =
  | { type: "intro" }
  | { type: "stats" }
  | { type: "places" }
  | { type: "quests" }
  | { type: "leaderboard" }
  | { type: "person"; person: WrappedPerson; layout: 0 | 1 | 2 }
  | { type: "photos" }
  | { type: "finale" };

export type WrappedData = {
  trip: { name: string; destination: string; dates: string; days: number };
  stats: { value: string; label: string }[];
  // Group totals for the numbers the page currently hard-codes ("32 quests
  // completed", "18 places planned"): summed across people, on read.
  totals: Stats;
  places: string[];
  quests: { title: string; points: number; winner: string; photo: WrappedPhoto }[];
  people: WrappedPerson[];
  slides: WrappedSlide[];
};

export type WrappedSource = "real" | "derived" | "fictional";

// Safe to build against: "real" (a column), "derived" (computed from real
// rows by a rule you should know), "fictional" (placeholder, no source yet).
export const WRAPPED_SOURCES: Record<string, { source: WrappedSource; from: string }> = {
  "trip.name": { source: "real", from: "trips.name" },
  "trip.destination": { source: "real", from: "trips.destination" },
  "trip.dates": { source: "real", from: "trips.start_date, trips.end_date" },
  "trip.days": { source: "real", from: "end_date - start_date + 1" },
  "stats[friends]": { source: "real", from: "count of participants" },
  "stats[things done]": { source: "real", from: "sum of participant_stats.tasks_completed" },
  "stats[photos]": { source: "real", from: "sum of participant_stats.photos_submitted" },
  "stats[places]": { source: "real", from: "sum of participant_stats.places_visited (a place two people visited counts twice)" },
  totals: { source: "real", from: "participant_stats, summed on read (distance_km stays 0: claims store no location)" },
  places: { source: "derived", from: "distinct tasks.neighborhood across awarded claims" },
  "quests[].title/points/winner": { source: "real", from: "the three highest-scoring awarded claims" },
  "quests[].photo": { source: "fictional", from: "placeholder; claim photos are Linq CDN URLs, not stored, and may expire" },
  "people[].name/score": { source: "real", from: "participants.display_name, participants.score" },
  "people[].rank": { source: "derived", from: "competition ranking by score (ties share a rank)" },
  "people[].quests": { source: "real", from: "participant_stats.tasks_completed" },
  "people[].favorite": { source: "derived", from: "strongest non-guess preference weight (prefs_json); empty when unknown" },
  "people[].moment": { source: "derived", from: "their highest-scoring awarded claim's title; empty when none" },
  "people[].photo": { source: "fictional", from: "placeholder" },
  "photos slide": { source: "fictional", from: "placeholder images" },
};

export type WrappedInput = {
  trip: { name: string; destination: string | null; start_date: string | null; end_date: string | null };
  people: { id: string; name: string; score: number; favorite: string | null }[];
  stats: Record<string, Stats>;
  awarded: { participantId: string; title: string; points: number; neighborhood: string | null }[];
  placeholder: WrappedPhoto;
};

function daysBetween(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

export function buildWrappedData(input: WrappedInput): WrappedData {
  const totals = groupTotals(input.people.map((p) => input.stats[p.id]).filter(Boolean));
  const sorted = [...input.people].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const people: WrappedPerson[] = sorted.map((p) => {
    const best = input.awarded.filter((a) => a.participantId === p.id).sort((a, b) => b.points - a.points)[0];
    return {
      name: p.name,
      score: p.score,
      // Competition ranking: 284, 266, 241, 241, 198 -> 1, 2, 3, 3, 5.
      rank: 1 + sorted.filter((q) => q.score > p.score).length,
      quests: input.stats[p.id]?.tasks_completed ?? 0,
      favorite: p.favorite ?? "",
      moment: best?.title ?? "",
      photo: input.placeholder,
    };
  });
  const nameOf = new Map(input.people.map((p) => [p.id, p.name]));
  const quests = [...input.awarded]
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((a) => ({ title: a.title, points: a.points, winner: nameOf.get(a.participantId) ?? "", photo: input.placeholder }));
  const places = [...new Set(input.awarded.map((a) => a.neighborhood).filter((n): n is string => Boolean(n)))];
  const { start_date: start, end_date: end } = input.trip;
  return {
    trip: {
      name: input.trip.name,
      destination: input.trip.destination ?? "",
      dates: start && end ? `${formatShortDate(start)} to ${formatShortDate(end)}` : "",
      days: daysBetween(start, end),
    },
    stats: [
      { value: String(input.people.length), label: "friends unleashed" },
      { value: String(totals.places_visited), label: "places visited" },
      { value: String(totals.tasks_completed), label: "things done" },
      { value: String(totals.photos_submitted), label: "camera-roll receipts" },
    ],
    totals,
    places,
    quests,
    people,
    slides: [
      { type: "intro" },
      { type: "stats" },
      { type: "places" },
      { type: "quests" },
      { type: "leaderboard" },
      ...people.map((person, index) => ({ type: "person" as const, person, layout: (index % 3) as 0 | 1 | 2 })),
      { type: "photos" },
      { type: "finale" },
    ],
  };
}
