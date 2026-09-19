import { formatShortDate } from "./copy";
import { groupTotals, type Stats } from "./stats";

// The Wrapped contract: what the page renders, and where each field comes
// from. /wrapped renders the fictional `demo` fixture (app/wrapped/data.ts);
// /wrapped/[tripId] renders a completed trip through lib/wrapped (load.ts,
// data.ts). WRAPPED_SOURCES says, per field, what is real.

export type WrappedPhoto = { src: string; alt: string };

export type WrappedPerson = {
  // Present on live data (lib/wrapped/data.ts keys recaps and photos by it).
  id?: string;
  name: string;
  score: number;
  rank: number;
  quests: number;
  favorite: string;
  moment: string;
  // One model-written sentence, live data only; the page prefers it to moment.
  recap?: string;
  // null: no photo for them; the page renders nothing in its place.
  photo: WrappedPhoto | null;
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

// The one Wrapped contract. Two builders fill it: lib/wrapped/data.ts
// (buildLiveWrapped, what /wrapped/[tripId] renders: counts from rows, real
// stored photos) and buildWrappedData below (numbers from participant_stats).
export type WrappedData = {
  trip: { name: string; destination: string; dates: string; days: number };
  stats: { value: string; label: string }[];
  // Live group totals from participant_stats, summed on read. Optional: only
  // builders that read participant_stats have them.
  totals?: Stats;
  places: string[];
  quests: { title: string; points: number; winner: string; photo: WrappedPhoto | null }[];
  people: WrappedPerson[];
  // The camera-roll gallery.
  photos: WrappedPhoto[];
};

// What the page renders: the data plus its slide order.
export type WrappedStory = WrappedData & { slides: WrappedSlide[] };

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
  // Photos: /wrapped/photo/[claimId] serves claims.storage_path (claim-photos
  // bucket) when set, else claims.evidence_url. Nothing writes storage_path
  // yet, so today every photo is the Linq CDN URL, which may expire.
  "quests[].photo": { source: "real", from: "lib/wrapped/data.ts only: claims.evidence_url via /wrapped/photo/[claimId] (Linq URL, may expire until uploads to claim-photos exist); placeholder from this builder" },
  photos: { source: "real", from: "lib/wrapped/data.ts only: awarded claims with a photo (same caveat); empty from this builder" },
  "people[].recap": { source: "derived", from: "lib/wrapped/load.ts only: one model-written sentence from their completed tasks" },
  "people[].name/score": { source: "real", from: "participants.display_name, participants.score" },
  "people[].rank": { source: "derived", from: "competition ranking by score (ties share a rank)" },
  "people[].quests": { source: "real", from: "participant_stats.tasks_completed" },
  "people[].favorite": { source: "derived", from: "strongest non-guess preference weight (prefs_json); empty when unknown" },
  "people[].moment": { source: "derived", from: "their highest-scoring awarded claim's title; empty when none" },
  "people[].photo": { source: "real", from: "lib/wrapped/data.ts only: their best claim photo (same caveat); placeholder from this builder" },
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

export function buildWrappedData(input: WrappedInput): WrappedStory & { totals: Stats } {
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
    // No stored photos in this builder: the live one (lib/wrapped/data.ts)
    // serves them from the claim-photos bucket.
    photos: [],
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
