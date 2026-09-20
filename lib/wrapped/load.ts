import { getServiceClient } from "@/lib/db/client";
import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { buildLiveWrapped, type LiveWrappedData } from "./data";
import { GeminiProvider } from "@/lib/llm/gemini";

export async function loadWrapped(tripId: string): Promise<LiveWrappedData | null> {
  const db = getServiceClient();
  const tripResult = await db.from("trips").select("*").eq("id", tripId).eq("state", "complete").maybeSingle();
  if (tripResult.error) throw tripResult.error;
  if (!tripResult.data) return null;
  const trip = tripResult.data as TripRow;
  const [peopleResult, tasksResult, itineraryResult, placesResult] = await Promise.all([
    db.from("participants").select("*").eq("trip_id", tripId),
    db.from("tasks").select("*").eq("trip_id", tripId),
    db.from("itinerary").select("place_id, places(name)").eq("trip_id", tripId).order("day").order("anchor_order"),
    db.from("places").select("id, name").eq("trip_id", tripId).order("created_at"),
  ]);
  if (peopleResult.error) throw peopleResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (itineraryResult.error) throw itineraryResult.error;
  if (placesResult.error) throw placesResult.error;
  const tasks = (tasksResult.data ?? []) as TaskRow[];
  const claims = tasks.length
    ? await db.from("claims").select("*").in("task_id", tasks.map((task) => task.id))
    : { data: [], error: null };
  if (claims.error) throw claims.error;
  const itinerary = (itineraryResult.data ?? []).map((row) => {
    const place = (row as { places: { name: string } | { name: string }[] | null }).places;
    return { place_id: (row as { place_id: string }).place_id, name: Array.isArray(place) ? place[0]?.name ?? null : place?.name ?? null };
  });
  const savedPlaces = (placesResult.data ?? []).map((place) => ({
    place_id: (place as { id: string }).id,
    name: (place as { name: string }).name,
  }));
  const people = (peopleResult.data ?? []) as ParticipantRow[];
  const claimRows = (claims.data ?? []) as ClaimRow[];
  const wrapped = buildLiveWrapped({ trip, people, tasks, claims: claimRows, itinerary, savedPlaces });
  const provider = new GeminiProvider();
  await Promise.all(wrapped.people.map(async (person) => {
    const source = people.find((row) => row.id === person.id);
    const titles = claimRows.filter((claim) => claim.participant_id === person.id && claim.status === "awarded").map((claim) => tasks.find((task) => task.id === claim.task_id)?.title).filter(Boolean);
    try {
      const recap = await provider.complete({
        tier: "fast", thinkingBudget: 0, temperature: 0.7,
        system: "Write one playful, factual sentence (18 words maximum) for a public travel-game recap. Use private survey context only for tone and interests; never reveal or quote it. Never invent events.",
        messages: [{ role: "user", content: JSON.stringify({ name: person.name, score: person.score, rank: person.rank, completedTasks: titles, privateSurveyContext: source?.survey_json ?? source?.prefs_json ?? {} }) }],
      });
      if (recap) person.recap = recap.replace(/\s+/g, " ").slice(0, 180);
    } catch (error) { console.warn("[japlan.wrapped] individual recap unavailable", { participantId: person.id, error: error instanceof Error ? error.message : String(error) }); }
  }));
  return wrapped;
}

export async function wrappedPhotoRedirect(claimId: string): Promise<string | null> {
  const db = getServiceClient();
  // `storage_path` was added after initial Wrapped photos existed. Use `*` so
  // old live databases can still serve their evidence_url fallback before the
  // storage migration is applied.
  const claimResult = await db.from("claims").select("*").eq("id", claimId).maybeSingle();
  if (claimResult.error) throw claimResult.error;
  const claim = claimResult.data as Pick<ClaimRow, "task_id" | "storage_path" | "evidence_url" | "photo_claimed_at" | "status"> | null;
  if (!claim || claim.status !== "awarded" || !claim.photo_claimed_at) return null;
  const taskResult = await db.from("tasks").select("trip_id").eq("id", claim.task_id).maybeSingle();
  if (taskResult.error || !taskResult.data) return null;
  const tripResult = await db.from("trips").select("state").eq("id", (taskResult.data as { trip_id: string }).trip_id).maybeSingle();
  if (tripResult.error || (tripResult.data as { state?: string } | null)?.state !== "complete") return null;
  if (claim.storage_path) {
    const signed = await db.storage.from("claim-photos").createSignedUrl(claim.storage_path, 60 * 30);
    if (!signed.error && signed.data?.signedUrl) return signed.data.signedUrl;
  }
  return claim.evidence_url;
}
