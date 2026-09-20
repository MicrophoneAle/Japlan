import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { getServiceClient } from "@/lib/db/client";
import { localDateString } from "@/lib/game/time";
import { searchPlaces, type FoursquarePlace } from "@/lib/places/foursquare";
import { getLinqClient } from "@/lib/linq/client";
import { sendDM, sendText, type SentText } from "@/lib/linq/send";

export const LOCATION_SHARE_TTL_MS = 12 * 60 * 60 * 1000;
export const LOCATION_FRESHNESS_MS = 15 * 60 * 1000;
const LOCATION_FUTURE_SKEW_MS = 2 * 60 * 1000;
const CLUSTER_RADIUS_METERS = 800;
const NEARBY_RADIUS_METERS = 1_500;
const NEARBY_LIMIT = 8;

export type LocationShareStatus = "requested" | "active" | "stopped" | "expired" | "unsupported";
export type TripLocationShareRow = {
  trip_id: string;
  participant_id: string;
  direct_chat_id: string;
  share_status: LocationShareStatus;
  expires_at: string;
};

type LiveTrip = Pick<TripRow, "id" | "state" | "start_date" | "end_date" | "timezone" | "destination" | "organizer_participant_id">;
type LocationApi = {
  request(chatId: string): Promise<unknown>;
  retrieve(chatId: string): Promise<unknown>;
  stop(chatId: string, body: { handle: string }): Promise<unknown>;
};

export type LiveLocationDeps = {
  db?: SupabaseClient;
  locationApi?: LocationApi;
  sendDM?: (phone: string, text: string) => Promise<SentText>;
  sendText?: (chatId: string, text: string) => Promise<unknown>;
  searchPlaces?: typeof searchPlaces;
};

export type LocationRequestResult = {
  status: "requested" | "already_pending" | "already_active" | "unsupported" | "failed";
  participantId: string;
};

export type RequestTripLocationResult = {
  status: "requested" | "not_active" | "organizer_only";
  people: LocationRequestResult[];
};
export type OwnLocationRequestStatus = "requested" | "already_pending" | "already_active" | "not_active" | "not_participant" | "failed" | "unsupported";

export type LocationWebhookResult = {
  handled: boolean;
  updated: number;
  reason?: "unsupported_event" | "missing_identity" | "no_matching_consent";
};

export type SafeLocationCluster = { people: string[]; area: string };
export type SafeNearbyCandidate = { name: string; area: string; categories: string[] };
export type OnDemandLocationContext = {
  status: "live" | "destination_fallback" | "unavailable";
  clusters: SafeLocationCluster[];
  candidates: SafeNearbyCandidate[];
  note: string;
};

type ParsedPoint = {
  participantId: string;
  name: string;
  lat: number;
  lng: number;
  updatedAt: number;
  locality: string | null;
};

type SafePoint = ParsedPoint & { area: string; candidatePlaces: FoursquarePlace[] };

function dependencies(deps: LiveLocationDeps) {
  let api = deps.locationApi;
  if (!api) {
    const client = getLinqClient();
    api = {
      request: (chatId) => client.chats.location.request(chatId),
      retrieve: (chatId) => client.chats.location.retrieve(chatId),
      stop: (chatId, body) => client.chats.location.stop(chatId, body),
    };
  }
  return {
    db: deps.db ?? getServiceClient(),
    api,
    dm: deps.sendDM ?? sendDM,
    text: deps.sendText ?? sendText,
    places: deps.searchPlaces ?? searchPlaces,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function locationApiFailure(error: unknown): "unsupported" | "already_active" | "failed" {
  if (!isRecord(error)) return /unsupported|not supported/i.test(String(error)) ? "unsupported" : "failed";
  const code = error.code;
  const status = error.status;
  const message = typeof error.message === "string" ? error.message : "";
  if (
    code === 2016 || code === 2017 || code === "2016" || code === "2017" ||
    /group.?chat.?not.?supported|chat.?service.?not.?supported|location.{0,30}(unsupported|not supported)/i.test(message)
  ) return "unsupported";
  if (status === 409 && /already sharing|already active/i.test(message)) return "already_active";
  return "failed";
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits ? `+${digits}` : value.trim().toLowerCase();
}

function isTripInDateRange(trip: LiveTrip, now: Date): boolean {
  if (trip.state !== "active") return false;
  const date = localDateString(now, trip.timezone);
  if (trip.start_date && date < trip.start_date) return false;
  if (trip.end_date && date > trip.end_date) return false;
  return true;
}

function consentMessage(name: string): string {
  return [
    `📍 ${name}, want Japlan to use your live location while you're out today?`,
    "",
    "If you accept Apple's location prompt, Japlan will check for a fresh location only when someone asks for a live plan. It sends the coordinates to Foursquare to find nearby options; it does not save them.",
    "",
    "The group may see your name and approximate neighborhood. Your exact location stays private. Japlan stops using it after 12 hours or when you text ‘japlan stop location’. Apple sharing may continue separately until you stop it in Messages.",
  ].join("\n");
}

async function readShare(
  db: SupabaseClient,
  tripId: string,
  participantId: string,
): Promise<TripLocationShareRow | null> {
  const { data, error } = await db
    .from("trip_location_shares")
    .select("trip_id, participant_id, direct_chat_id, share_status, expires_at")
    .eq("trip_id", tripId)
    .eq("participant_id", participantId)
    .maybeSingle();
  if (error) throw error;
  return (data as TripLocationShareRow | null) ?? null;
}

async function saveShare(db: SupabaseClient, row: TripLocationShareRow): Promise<void> {
  const { error } = await db.from("trip_location_shares").upsert(row, {
    onConflict: "trip_id,participant_id",
  });
  if (error) throw error;
}

async function setShareStatus(
  db: SupabaseClient,
  row: Pick<TripLocationShareRow, "trip_id" | "participant_id">,
  status: LocationShareStatus,
): Promise<void> {
  const { error } = await db
    .from("trip_location_shares")
    .update({ share_status: status })
    .eq("trip_id", row.trip_id)
    .eq("participant_id", row.participant_id);
  if (error) throw error;
}

/** Organizer-only entry point: opens one private Linq DM per participant and asks Apple for consent. */
export async function requestTripLocationSharing(
  opts: {
    trip: LiveTrip;
    organizer: ParticipantRow;
    participants: ParticipantRow[];
    now?: Date;
  },
  deps: LiveLocationDeps = {},
): Promise<RequestTripLocationResult> {
  const now = opts.now ?? new Date();
  const blank: RequestTripLocationResult = { status: "organizer_only", people: [] };
  if (opts.organizer.trip_id !== opts.trip.id || !opts.trip.organizer_participant_id || opts.organizer.id !== opts.trip.organizer_participant_id) return blank;
  if (!isTripInDateRange(opts.trip, now)) return { status: "not_active", people: [] };

  const { db, api, dm, text } = dependencies(deps);
  const uniqueParticipants = new Map(
    opts.participants
      .filter((person) => person.trip_id === opts.trip.id)
      .map((person) => [person.id, person]),
  );
  const people: LocationRequestResult[] = [];

  for (const person of uniqueParticipants.values()) {
    const current = await readShare(db, opts.trip.id, person.id);
    if (current && Date.parse(current.expires_at) > now.getTime() && current.share_status === "active") {
      people.push({ status: "already_active", participantId: person.id });
      continue;
    }
    if (current && Date.parse(current.expires_at) > now.getTime() && current.share_status === "requested") {
      people.push({ status: "already_pending", participantId: person.id });
      continue;
    }

    try {
      const sent = await dm(person.phone, consentMessage(person.display_name || "there"));
      const expiresAt = new Date(now.getTime() + LOCATION_SHARE_TTL_MS).toISOString();
      const row: TripLocationShareRow = {
        trip_id: opts.trip.id,
        participant_id: person.id,
        direct_chat_id: sent.chatId,
        share_status: "requested",
        expires_at: expiresAt,
      };
      // Persist the consent request before calling Linq: the started webhook can arrive immediately.
      await saveShare(db, row);
      try {
        await api.request(sent.chatId);
        people.push({ status: "requested", participantId: person.id });
      } catch (error) {
        const failure = locationApiFailure(error);
        if (failure === "already_active") {
          await setShareStatus(db, row, "active");
          people.push({ status: "already_active", participantId: person.id });
        } else if (failure === "unsupported") {
          await setShareStatus(db, row, "unsupported");
          try {
            await text(sent.chatId, "Live location sharing needs a 1:1 iMessage chat. You can still tell Japlan your neighborhood when you ask for nearby ideas.");
          } catch {
            // The safe fallback is the persisted unsupported state; do not leak Linq errors.
          }
          people.push({ status: "unsupported", participantId: person.id });
        } else {
          await setShareStatus(db, row, "expired");
          people.push({ status: "failed", participantId: person.id });
        }
      }
    } catch {
      people.push({ status: "failed", participantId: person.id });
    }
  }

  return { status: "requested", people };
}

/** A participant can ask for the native consent prompt again from their own 1:1 DM. */
export async function activateParticipantLocationSharing(
  opts: {
    trip: LiveTrip;
    participant: ParticipantRow;
    directChatId: string;
    now?: Date;
  },
  deps: LiveLocationDeps = {},
): Promise<OwnLocationRequestStatus> {
  const now = opts.now ?? new Date();
  if (opts.participant.trip_id !== opts.trip.id || !opts.directChatId.trim()) return "not_participant";
  if (!isTripInDateRange(opts.trip, now)) return "not_active";

  const { db, api } = dependencies(deps);
  const current = await readShare(db, opts.trip.id, opts.participant.id);
  if (current && current.direct_chat_id !== opts.directChatId) return "not_participant";
  if (current && current.share_status === "active" && Date.parse(current.expires_at) > now.getTime()) return "already_active";
  if (current && current.share_status === "requested" && Date.parse(current.expires_at) > now.getTime()) return "already_pending";

  const row: TripLocationShareRow = {
    trip_id: opts.trip.id,
    participant_id: opts.participant.id,
    direct_chat_id: opts.directChatId,
    share_status: "requested",
    expires_at: new Date(now.getTime() + LOCATION_SHARE_TTL_MS).toISOString(),
  };
  await saveShare(db, row);
  try {
    await api.request(opts.directChatId);
    return "requested";
  } catch (error) {
    const failure = locationApiFailure(error);
    if (failure === "already_active") {
      await setShareStatus(db, row, "active");
      return "already_active";
    }
    if (failure === "unsupported") {
      await setShareStatus(db, row, "unsupported");
      return "unsupported";
    }
    await setShareStatus(db, row, "expired");
    return "failed";
  }
}

type SharingWebhookData = {
  chat_id?: unknown;
  shared_by?: unknown;
};

/** Applies Linq start/stop events only to existing opted-in trip rows; duplicate events are no-ops. */
export async function handleLocationSharingWebhook(
  eventType: string,
  data: SharingWebhookData,
  deps: LiveLocationDeps = {},
  now = new Date(),
): Promise<LocationWebhookResult> {
  if (eventType !== "location.sharing.started" && eventType !== "location.sharing.stopped") {
    return { handled: false, updated: 0, reason: "unsupported_event" };
  }
  if (typeof data.shared_by !== "string" || !data.shared_by.trim()) {
    return { handled: false, updated: 0, reason: "missing_identity" };
  }

  const { db } = dependencies(deps);
  const phone = normalizePhone(data.shared_by);
  const phoneDigits = phone.replace(/\D/g, "");
  const { data: participantRows, error: peopleError } = await db
    .from("participants")
    .select("id, trip_id, phone, display_name")
    .in("phone", [...new Set([data.shared_by, phone, phoneDigits ? `+${phoneDigits}` : phone])]);
  if (peopleError) throw peopleError;
  const participants = ((participantRows ?? []) as Pick<ParticipantRow, "id" | "trip_id" | "phone" | "display_name">[])
    .filter((person) => normalizePhone(person.phone) === phone);
  if (!participants.length) return { handled: false, updated: 0, reason: "no_matching_consent" };

  const ids = participants.map((person) => person.id);
  const { data: shareRows, error: sharesError } = await db
    .from("trip_location_shares")
    .select("trip_id, participant_id, direct_chat_id, share_status, expires_at")
    .in("participant_id", ids);
  if (sharesError) throw sharesError;
  const shares = (shareRows ?? []) as TripLocationShareRow[];
  const isStop = eventType === "location.sharing.stopped";
  const eventChatId = typeof data.chat_id === "string" ? data.chat_id : null;
  let candidates = shares.filter((row) => row.share_status === "requested" || row.share_status === "active");

  if (!isStop) {
    candidates = eventChatId
      ? candidates.filter((row) => row.direct_chat_id === eventChatId)
      : candidates.length === 1
        ? candidates
        : [];
  }

  let updated = 0;
  for (const share of candidates) {
    if (Date.parse(share.expires_at) <= now.getTime()) {
      if (share.share_status !== "expired") {
        await setShareStatus(db, share, "expired");
        updated += 1;
      }
      continue;
    }
    if (isStop) {
      if (share.share_status !== "stopped") {
        await setShareStatus(db, share, "stopped");
        updated += 1;
      }
      continue;
    }
    if (share.share_status !== "active") {
      const { data: tripData, error: tripError } = await db
        .from("trips")
        .select("id, state, start_date, end_date, timezone")
        .eq("id", share.trip_id)
        .maybeSingle();
      if (tripError) throw tripError;
      if (!tripData || !isTripInDateRange(tripData as LiveTrip, now)) {
        await setShareStatus(db, share, "expired");
        updated += 1;
        continue;
      }
      await setShareStatus(db, share, "active");
      updated += 1;
    }
  }

  return updated
    ? { handled: true, updated }
    : { handled: false, updated: 0, reason: "no_matching_consent" };
}

/** Called from the participant's own DM command; immediately stops Japlan reads and asks Linq to stop sharing. */
export async function stopParticipantLocationSharing(
  opts: { tripId: string; participantId: string; phone: string },
  deps: LiveLocationDeps = {},
): Promise<"stopped" | "already_stopped" | "unavailable"> {
  const { db, api } = dependencies(deps);
  const { data: participantData, error: participantError } = await db
    .from("participants")
    .select("id, trip_id, phone")
    .eq("trip_id", opts.tripId)
    .eq("id", opts.participantId)
    .maybeSingle();
  if (participantError) throw participantError;
  if (!participantData || normalizePhone((participantData as { phone: string }).phone) !== normalizePhone(opts.phone)) {
    return "already_stopped";
  }
  const row = await readShare(db, opts.tripId, opts.participantId);
  if (!row || row.share_status === "stopped") return "already_stopped";

  const { data: otherRowsData, error: otherRowsError } = await db
    .from("trip_location_shares")
    .select("trip_id, participant_id, direct_chat_id, share_status, expires_at")
    .eq("participant_id", opts.participantId);
  if (otherRowsError) throw otherRowsError;
  const activeRows = ((otherRowsData ?? []) as TripLocationShareRow[])
    .filter((share) => share.share_status !== "stopped");

  try {
    await api.stop(row.direct_chat_id, { handle: opts.phone });
  } catch (error) {
    const status = isRecord(error) && typeof error.status === "number" ? error.status : null;
    if (status !== 404) {
      // The person explicitly asked Japlan to stop, so immediately revoke local
      // reads even if Apple/Linq could not confirm the device-side stop.
      for (const active of activeRows) await setShareStatus(db, active, "stopped");
      return "unavailable";
    }
  }
  // Linq stops sharing with this contact across chats. Mirror that globally so
  // another trip cannot read the location while its stop webhook is in flight.
  for (const active of activeRows) await setShareStatus(db, active, "stopped");
  return "stopped";
}

function validPoint(feature: unknown, person: Pick<ParticipantRow, "id" | "phone" | "display_name">, now: Date): ParsedPoint | null {
  if (!isRecord(feature) || !isRecord(feature.properties) || !isRecord(feature.geometry)) return null;
  const properties = feature.properties;
  if (typeof properties.handle !== "string" || normalizePhone(properties.handle) !== normalizePhone(person.phone)) return null;
  if (typeof properties.updated_at !== "string") return null;
  const updatedAt = Date.parse(properties.updated_at);
  const age = now.getTime() - updatedAt;
  if (!Number.isFinite(updatedAt) || age > LOCATION_FRESHNESS_MS || age < -LOCATION_FUTURE_SKEW_MS) return null;
  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lng, lat] = coordinates;
  if (
    typeof lat !== "number" || typeof lng !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) return null;
  return {
    participantId: person.id,
    name: person.display_name?.trim() || "Trip member",
    lat,
    lng,
    updatedAt,
    locality: typeof properties.locality === "string" ? properties.locality : null,
  };
}

function distanceMeters(a: Pick<ParsedPoint, "lat" | "lng">, b: Pick<ParsedPoint, "lat" | "lng">): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function buildClusters(points: SafePoint[]): SafeLocationCluster[] {
  const parents = points.map((_, index) => index);
  const rootOf = (index: number): number => {
    if (parents[index] !== index) parents[index] = rootOf(parents[index]);
    return parents[index];
  };
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (distanceMeters(points[left], points[right]) <= CLUSTER_RADIUS_METERS) {
        parents[rootOf(right)] = rootOf(left);
      }
    }
  }
  const groups = new Map<number, SafePoint[]>();
  points.forEach((point, index) => {
    const root = rootOf(index);
    groups.set(root, [...(groups.get(root) ?? []), point]);
  });
  return [...groups.values()].map((group) => {
    const counts = new Map<string, number>();
    for (const point of group) counts.set(point.area, (counts.get(point.area) ?? 0) + 1);
    const area = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "nearby";
    return { people: group.map((point) => point.name), area };
  });
}

function safeCandidates(points: SafePoint[]): SafeNearbyCandidate[] {
  const seen = new Set<string>();
  const result: SafeNearbyCandidate[] = [];
  for (const point of points) {
    for (const place of point.candidatePlaces) {
      if (seen.has(place.fsq_place_id)) continue;
      seen.add(place.fsq_place_id);
      result.push({
        name: place.name,
        area: place.neighborhood || place.locality || point.area,
        categories: place.categories.slice(0, 2),
      });
      if (result.length >= 12) return result;
    }
  }
  return result;
}

function fallbackContext(destination: string | null, error = false): OnDemandLocationContext {
  const label = destination?.trim();
  return {
    status: label ? "destination_fallback" : "unavailable",
    clusters: [],
    candidates: [],
    note: error
      ? "No fresh, consented locations are available right now. Nearby search also failed; use the trip plan instead."
      : label
        ? `No fresh, consented locations are available right now. These options use the trip destination (${label}), not anyone's live position.`
        : "No fresh, consented locations are available right now. Ask the group where they are, or request location sharing in 1:1 iMessage DMs.",
  };
}

/** Reads each opted-in participant once on demand and returns only coarse, shareable context. */
export async function getOnDemandLocationContext(
  opts: { trip: LiveTrip; now?: Date },
  deps: LiveLocationDeps = {},
): Promise<OnDemandLocationContext> {
  const now = opts.now ?? new Date();
  if (!isTripInDateRange(opts.trip, now)) {
    return { status: "unavailable", clusters: [], candidates: [], note: "Live location is available only during an active trip." };
  }

  const { db, api, places } = dependencies(deps);
  const { data: rows, error } = await db
    .from("trip_location_shares")
    .select("trip_id, participant_id, direct_chat_id, share_status, expires_at")
    .eq("trip_id", opts.trip.id)
    .eq("share_status", "active");
  if (error) throw error;
  const shares = (rows ?? []) as TripLocationShareRow[];
  for (const row of shares) {
    if (Date.parse(row.expires_at) <= now.getTime()) await setShareStatus(db, row, "expired");
  }
  const validShares = shares.filter((row) => Date.parse(row.expires_at) > now.getTime());
  if (validShares.length === 0) {
    const fallback = fallbackContext(opts.trip.destination);
    if (opts.trip.destination) {
      try {
        const nearby = await places({ near: opts.trip.destination, limit: 8 });
        fallback.candidates = nearby.slice(0, 8).map((place) => ({
          name: place.name,
          area: place.neighborhood || place.locality || opts.trip.destination || "nearby",
          categories: place.categories.slice(0, 2),
        }));
      } catch {
        return fallbackContext(opts.trip.destination, true);
      }
    }
    return fallback;
  }

  const participantIds = validShares.map((row) => row.participant_id);
  const { data: participantsData, error: participantsError } = await db
    .from("participants")
    .select("id, trip_id, phone, display_name")
    .in("id", participantIds)
    .eq("trip_id", opts.trip.id);
  if (participantsError) throw participantsError;
  const participantById = new Map(
    ((participantsData ?? []) as Pick<ParticipantRow, "id" | "trip_id" | "phone" | "display_name">[])
      .map((person) => [person.id, person]),
  );

  const points: SafePoint[] = [];
  for (const share of validShares) {
    const participant = participantById.get(share.participant_id);
    if (!participant) continue;
    try {
      const response = await api.retrieve(share.direct_chat_id);
      if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.features)) continue;
      const feature = response.data.features
        .map((candidate) => validPoint(candidate, participant, now))
        .find((candidate): candidate is ParsedPoint => Boolean(candidate));
      if (!feature) continue;
      let candidatePlaces: FoursquarePlace[] = [];
      try {
        candidatePlaces = await places({
          ll: `${feature.lat},${feature.lng}`,
          radius: NEARBY_RADIUS_METERS,
          limit: NEARBY_LIMIT,
        });
      } catch {
        // A location can still yield safe group proximity even if nearby search is temporarily down.
      }
      const area = candidatePlaces.find((place) => place.neighborhood)?.neighborhood
        || candidatePlaces.find((place) => place.locality)?.locality
        || feature.locality
        || "nearby";
      points.push({ ...feature, area, candidatePlaces });
    } catch {
      // Continue with other consented participants; don't log provider payloads or coordinates.
    }
  }

  if (points.length === 0) {
    const fallback = fallbackContext(opts.trip.destination);
    fallback.note = `No fresh location fix was returned for the ${validShares.length} participant${validShares.length === 1 ? "" : "s"} who opted in. ${fallback.note}`;
    if (opts.trip.destination) {
      try {
        const nearby = await places({ near: opts.trip.destination, limit: 8 });
        fallback.candidates = nearby.slice(0, 8).map((place) => ({
          name: place.name,
          area: place.neighborhood || place.locality || opts.trip.destination || "nearby",
          categories: place.categories.slice(0, 2),
        }));
      } catch {
        return fallbackContext(opts.trip.destination, true);
      }
    }
    return fallback;
  }

  return {
    status: "live",
    clusters: buildClusters(points),
    candidates: safeCandidates(points),
    note: "Live locations were checked once for this request. Group context contains names and approximate neighborhoods only; exact coordinates were not saved.",
  };
}
