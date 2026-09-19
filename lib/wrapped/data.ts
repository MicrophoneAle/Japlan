import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import type { WrappedData } from "@/app/wrapped/data";

export type WrappedPhoto = { src: string; alt: string; claimId: string };

export type WrappedPerson = {
  id: string;
  name: string;
  score: number;
  rank: number;
  quests: number;
  favorite: string;
  moment: string;
  recap?: string;
  photo: WrappedPhoto | null;
};

export type WrappedQuest = { title: string; points: number; winner: string; photo: WrappedPhoto | null };

export type LiveWrappedData = WrappedData;

type ItineraryPlace = { place_id: string; name: string | null };

function dateRange(trip: TripRow): string {
  if (!trip.start_date && !trip.end_date) return "one for the group chat";
  const format = (date: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  if (!trip.start_date) return format(trip.end_date!);
  if (!trip.end_date || trip.end_date === trip.start_date) return format(trip.start_date);
  return `${format(trip.start_date)} — ${format(trip.end_date)}`;
}

function scorePhoto(claim: ClaimRow, task: TaskRow): number {
  const bonus = claim.photo_claimed_at ? Math.max(0, (claim.awarded_points ?? 0) - task.base_points) : 0;
  return bonus * 100_000 + (claim.awarded_points ?? 0) * 100 + task.title.length;
}

export function buildLiveWrapped(opts: {
  trip: TripRow;
  people: ParticipantRow[];
  tasks: TaskRow[];
  claims: ClaimRow[];
  itinerary: ItineraryPlace[];
  savedPlaces: ItineraryPlace[];
}): LiveWrappedData {
  const taskById = new Map(opts.tasks.map((task) => [task.id, task]));
  const personById = new Map(opts.people.map((person) => [person.id, person]));
  const claimedTaskIds = new Set(opts.claims.filter((claim) => claim.status === "awarded").map((claim) => claim.task_id));
  const photos = opts.claims
    .filter((claim) => claim.status === "awarded" && claim.photo_claimed_at && (claim.storage_path || claim.evidence_url))
    .map((claim) => ({ claim, task: taskById.get(claim.task_id), person: personById.get(claim.participant_id) }))
    .filter((row): row is { claim: ClaimRow; task: TaskRow; person: ParticipantRow } => Boolean(row.task && row.person))
    .sort((a, b) => scorePhoto(b.claim, b.task) - scorePhoto(a.claim, a.task) || a.task.title.localeCompare(b.task.title));

  const photoFor = (row: (typeof photos)[number]): WrappedPhoto => ({
    src: `/wrapped/photo/${row.claim.id}`,
    claimId: row.claim.id,
    alt: `${row.person.display_name}'s photo for ${row.task.title}`,
  });
  const pickForPerson = (personId: string) => {
    const found = photos.find((row) => row.person.id === personId);
    if (!found) return null;
    return photoFor(found);
  };

  const ranked = [...opts.people].sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));
  const people = ranked.map((person, index) => {
    const personalTasks = opts.claims.filter((claim) => claim.participant_id === person.id && claim.status === "awarded");
    const bestTask = personalTasks.map((claim) => taskById.get(claim.task_id)).filter((task): task is TaskRow => Boolean(task)).sort((a, b) => b.base_points - a.base_points || a.title.localeCompare(b.title))[0];
    return {
      id: person.id,
      name: person.display_name,
      score: person.score,
      rank: index + 1,
      quests: new Set(personalTasks.map((claim) => claim.task_id)).size,
      favorite: bestTask?.neighborhood ?? "the unexpected detours",
      moment: bestTask?.title ?? "showing up for the group",
      photo: pickForPerson(person.id),
    };
  });

  const questRows: (typeof photos) = [];
  const questPeople = new Set<string>();
  const questDays = new Set<number>();
  for (const row of photos) {
    if (questPeople.has(row.person.id) || questDays.has(row.task.day)) continue;
    questRows.push(row); questPeople.add(row.person.id); questDays.add(row.task.day);
    if (questRows.length === 3) break;
  }
  for (const row of photos) {
    if (questRows.length === 3) break;
    if (!questRows.some((picked) => picked.claim.id === row.claim.id)) questRows.push(row);
  }
  const quests = questRows.map((row) => ({ title: row.task.title, points: row.claim.awarded_points ?? 0, winner: row.person.display_name, photo: photoFor(row) }));
  const gallery = photos.slice(0, 18).map(photoFor);
  const placesForRecap = opts.itinerary.length ? opts.itinerary : opts.savedPlaces;
  const placeLabel = opts.itinerary.length ? "places on the itinerary" : "places saved";
  const placeNames = [...new Set(placesForRecap.map((row) => row.name).filter((name): name is string => Boolean(name)))].slice(0, 6);
  const days = tripDays(opts.trip);

  const names = ranked.map((person) => person.display_name).filter(Boolean);
  const groupName = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} + ${names.length - 3} more`;
  return {
    trip: { name: groupName ? `${groupName} got competitive` : (opts.trip.name || "the trip that got competitive"), destination: opts.trip.destination || "somewhere iconic", dates: dateRange(opts.trip), days },
    stats: [
      { value: String(opts.people.length), label: "friends unleashed" },
      { value: String(placesForRecap.length), label: placeLabel },
      { value: String(claimedTaskIds.size), label: "quests completed" },
      { value: String(photos.length), label: "camera-roll receipts" },
    ],
    places: placeNames,
    quests,
    people,
    photos: gallery,
  };
}

function tripDays(trip: TripRow): number {
  if (!trip.start_date || !trip.end_date) return 0;
  return Math.max(1, Math.round((Date.parse(`${trip.end_date}T00:00:00Z`) - Date.parse(`${trip.start_date}T00:00:00Z`)) / 86_400_000) + 1);
}
