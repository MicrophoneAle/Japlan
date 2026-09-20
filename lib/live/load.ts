import { getServiceClient } from "@/lib/db/client";
import { TRIP_COLS } from "@/lib/db/columns";
import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { withLegs } from "@/lib/handlers/legs";
import { currentTripDay } from "@/lib/handlers/daily-board";
import { readStats } from "@/lib/handlers/stats";
import { buildLiveTripData, type LiveTripData } from "./data";

type ItineraryJoinRow = {
  anchor_order: number;
  place_id: string;
  planned_time: string | null;
  places: { id: string; name: string } | { id: string; name: string }[] | null;
};

function placeNameOf(row: ItineraryJoinRow): { id: string; name: string } | null {
  const place = row.places;
  return Array.isArray(place) ? place[0] ?? null : place;
}

// Only an in-progress trip has a live board: before "active" there is
// nothing happening yet, and once "complete" the story belongs to Wrapped
// (/wrapped/[tripId]), not here.
export async function loadLiveTrip(tripId: string): Promise<LiveTripData | null> {
  const db = getServiceClient();
  const tripResult = await db.from("trips").select(TRIP_COLS).eq("id", tripId).eq("state", "active").maybeSingle();
  if (tripResult.error) throw tripResult.error;
  if (!tripResult.data) return null;
  const trip = await withLegs(tripResult.data as TripRow);
  const now = new Date();
  const day = currentTripDay(trip, now);

  const [peopleResult, tasksResult, teamsResult, itineraryResult, sidequestsResult] = await Promise.all([
    db.from("participants").select("*").eq("trip_id", tripId),
    db.from("tasks").select("*").eq("trip_id", tripId),
    db.from("teams").select("id, name, color, formed_at").eq("trip_id", tripId).is("day", null).is("dissolved_at", null),
    db
      .from("itinerary")
      .select("anchor_order, place_id, planned_time, places(id, name)")
      .eq("trip_id", tripId)
      .eq("day", day)
      .order("anchor_order"),
    db.from("sidequests").select("id, title, points").eq("trip_id", tripId),
  ]);
  if (peopleResult.error) throw peopleResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (teamsResult.error) throw teamsResult.error;
  if (itineraryResult.error) throw itineraryResult.error;
  if (sidequestsResult.error) throw sidequestsResult.error;

  const people = (peopleResult.data ?? []) as ParticipantRow[];
  const tasks = (tasksResult.data ?? []) as TaskRow[];
  const teamRows = (teamsResult.data ?? []) as { id: string; name: string; color: string; formed_at: string }[];
  const itineraryRows = (itineraryResult.data ?? []) as unknown as ItineraryJoinRow[];

  const [claimsResult, teamMembersResult, sidequestOffersResult] = await Promise.all([
    tasks.length ? db.from("claims").select("*").in("task_id", tasks.map((t) => t.id)) : Promise.resolve({ data: [], error: null }),
    teamRows.length ? db.from("team_members").select("team_id, participant_id").in("team_id", teamRows.map((t) => t.id)) : Promise.resolve({ data: [], error: null }),
    db.from("sidequest_offers").select("sidequest_id, participant_id, status, fired_at, resolved_at, awarded_points").eq("trip_id", tripId),
  ]);
  if (claimsResult.error) throw claimsResult.error;
  if (teamMembersResult.error) throw teamMembersResult.error;
  if (sidequestOffersResult.error) throw sidequestOffersResult.error;

  const claims = (claimsResult.data ?? []) as ClaimRow[];
  const teamMembers = (teamMembersResult.data ?? []) as { team_id: string; participant_id: string }[];
  const teams = teamRows.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    formedAt: t.formed_at,
    memberIds: teamMembers.filter((m) => m.team_id === t.id).map((m) => m.participant_id),
  }));

  const places = itineraryRows.map(placeNameOf).filter((p): p is { id: string; name: string } => Boolean(p));
  const itinerary = itineraryRows.map((row) => ({ order: row.anchor_order, place_id: row.place_id, planned_time: row.planned_time }));

  const stats = Object.fromEntries((await readStats(tripId)).map((row) => [row.participant_id, row]));

  return buildLiveTripData({
    trip,
    people,
    tasks,
    claims,
    teams,
    itinerary,
    places,
    stats,
    sidequests: (sidequestsResult.data ?? []) as { id: string; title: string; points: number }[],
    sidequestOffers: (sidequestOffersResult.data ?? []) as {
      sidequest_id: string;
      participant_id: string;
      status: string;
      fired_at: string | null;
      resolved_at: string | null;
      awarded_points: number | null;
    }[],
    now,
    day,
  });
}

// Mirrors lib/wrapped/load.ts's wrappedPhotoRedirect: never expose the
// storage bucket or a raw signed-URL flow to the client. Gated on the trip
// still being active: a completed trip's photos are Wrapped's to serve.
export async function liveTripPhotoRedirect(claimId: string): Promise<string | null> {
  const db = getServiceClient();
  const claimResult = await db.from("claims").select("*").eq("id", claimId).maybeSingle();
  if (claimResult.error) throw claimResult.error;
  const claim = claimResult.data as Pick<ClaimRow, "task_id" | "storage_path" | "evidence_url" | "photo_claimed_at" | "status"> | null;
  if (!claim || claim.status !== "awarded" || !claim.photo_claimed_at) return null;
  const taskResult = await db.from("tasks").select("trip_id").eq("id", claim.task_id).maybeSingle();
  if (taskResult.error || !taskResult.data) return null;
  const tripResult = await db.from("trips").select("state").eq("id", (taskResult.data as { trip_id: string }).trip_id).maybeSingle();
  if (tripResult.error || (tripResult.data as { state?: string } | null)?.state !== "active") return null;
  if (claim.storage_path) {
    const signed = await db.storage.from("claim-photos").createSignedUrl(claim.storage_path, 60 * 30);
    if (!signed.error && signed.data?.signedUrl) return signed.data.signedUrl;
  }
  return claim.evidence_url;
}
