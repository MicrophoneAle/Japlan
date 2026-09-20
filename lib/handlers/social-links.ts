// Links dropped in the chat, turned into places on the itinerary.
//
// Two halves, deliberately split:
//
//   captureLinks()  runs on the webhook path. It is one INSERT per link and
//                   nothing else: no fetch, no model, no Foursquare. A link is
//                   noticed in milliseconds and the 200 is never at risk.
//   resolveQueuedLinks()  runs on the cron, off the request path entirely.
//
// NO SESSIONS ANYWHERE. Every read is a stateless request (lib/social/read-link.ts):
// TikTok through its keyless oEmbed endpoint, Instagram and articles through
// browserbase.fetch, Google Maps parsed straight off the URL. Nothing calls
// browserbase.launch() or Stagehand, so there is no session to leak, no
// concurrency limit to exhaust, and nothing to close in a finally.
//
// A miss is a first-class outcome. Measured before this was built: TikTok
// blocks a headless fetch outright (hence oEmbed), and 1 in 4 Instagram URLs
// returned nothing at all. Every attempt is logged with its source, outcome
// and the text we actually extracted, so the real hit rate comes from live
// traffic rather than from this comment.

import { getServiceClient } from "@/lib/db/client";
import type { TripRow } from "@/lib/db/types";
import { classifyUrl, findUrls, parseGoogleMapsUrl, type LinkKind } from "@/lib/game/urls";
import { extractPlaceFromText } from "@/lib/llm/gemini";
import { followShortLink, readerFor, type ReadOutcome } from "@/lib/social/read-link";
import { cityFor } from "@/lib/game/legs";
import { legIdForWrite } from "./legs";
import { socialPlaceAddedLine } from "@/lib/game/copy";
import { existingSuggestion } from "@/lib/game/suggestions";
import { anchorSuggestion } from "./plan-changes";
import { geocodePlace } from "@/lib/geo/geocode";
import { resolvePlace } from "@/lib/game/plan-board";
import type { DestinationProfile } from "@/lib/game/destination";

export const SOCIAL_SOURCE = "social";
// Generous on purpose: the failure case is ten links at once, not one link
// being slow. A stateless read costs no session, so the cap is really about
// the Gemini call behind it.
export const RESOLUTIONS_PER_TRIP_PER_HOUR = 20;
// One attempt, then give up. Instagram and TikTok do not become readable on a
// retry, and a retry loop is how you get rate limited for real.
export const MAX_ATTEMPTS = 1;
// The whole job, whatever it is doing.
const JOB_TIMEOUT_MS = 25_000;

export type LinkStatus = "queued" | "resolved" | "unresolved" | "failed" | "skipped";

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.social] step", { step, ...fields });
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- capture

// Webhook path. One insert per new link, nothing more. Never throws: a link we
// fail to record is worth less than the message it arrived in.
export async function captureLinks(opts: {
  tripId: string;
  participantId: string | null;
  chatId: string;
  text: string;
}): Promise<number> {
  const urls = findUrls(opts.text);
  if (urls.length === 0) return 0;
  const rows = urls
    .map((url) => ({ url, kind: classifyUrl(url) }))
    .filter((row): row is { url: string; kind: LinkKind } => row.kind !== null)
    .map((row) => ({
      trip_id: opts.tripId,
      participant_id: opts.participantId,
      chat_id: opts.chatId,
      url: row.url,
      kind: row.kind,
      status: "queued" as const,
      // Set rather than left to the column default: the queue query filters
      // on it, so it must never be null.
      attempts: 0,
    }));
  if (rows.length === 0) return 0;
  // The same link posted twice is one job (unique on trip_id, url).
  const { error } = await getServiceClient()
    .from("social_links")
    .upsert(rows, { onConflict: "trip_id,url", ignoreDuplicates: true });
  if (error) {
    step("capture.failed", { code: error.code, note: "migration 2026-10-04 applied?" });
    return 0;
  }
  step("captured", { tripId: opts.tripId, links: rows.length, kinds: rows.map((r) => r.kind).join(",") });
  return rows.length;
}

// ---------------------------------------------------------------- resolve

type LinkRow = {
  id: string;
  trip_id: string;
  participant_id: string | null;
  url: string;
  kind: LinkKind;
  attempts: number;
};

async function markLink(
  id: string,
  patch: {
    status: LinkStatus;
    outcome?: string | null;
    extracted_text?: string | null;
    place_id?: string | null;
  },
): Promise<void> {
  const { error } = await getServiceClient()
    .from("social_links")
    .update({
      ...patch,
      attempted_at: new Date().toISOString(),
      resolved_at: patch.status === "resolved" ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) step("mark.failed", { code: error.code, id });
}

async function resolvedInLastHour(tripId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const { count, error } = await getServiceClient()
    .from("social_links")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .gte("attempted_at", since);
  if (error) {
    step("ratelimit.skipped", { code: error.code });
    return 0;
  }
  return count ?? 0;
}

// Read the link by whatever route works for its kind. Maps never touches a
// browser: the URL says it, or one redirect hop does.
async function readLink(row: LinkRow): Promise<ReadOutcome & { maps?: ReturnType<typeof parseGoogleMapsUrl> }> {
  if (row.kind === "maps") {
    const target = (await followShortLink(row.url)) ?? row.url;
    const maps = parseGoogleMapsUrl(target);
    if (!maps) return { ok: false, reason: "empty_page", via: "url" };
    return { ok: true, text: maps.name ?? `${maps.lat},${maps.lng}`, via: "url", maps };
  }
  return readerFor(row.kind)(row.url);
}

async function insertPlace(opts: {
  trip: TripRow;
  row: LinkRow;
  name: string;
  address: string | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
  date: string;
}): Promise<{ id: string; duplicate: boolean } | null> {
  // One venue, one row. The conversation tool may already have added this
  // place from the same message (the model sees the link text and calls
  // add_suggestion), so whichever path landed first owns the row and this one
  // attaches to it instead of making a rival.
  const existing = await getServiceClient()
    .from("places")
    .select("id, name, source, lat")
    .eq("trip_id", opts.trip.id);
  if (!existing.error) {
    const same = existingSuggestion(
      (existing.data ?? []) as { id: string; name: string; source: string | null; lat: number | null }[],
      opts.name,
    );
    if (same) {
      // Fill in what the first path could not work out, and record where it
      // came from, without touching what it already got right.
      const patch: Record<string, unknown> = { source_url: opts.row.url, resolved_at: new Date().toISOString() };
      if (same.lat === null && opts.lat !== null) {
        patch.lat = opts.lat;
        patch.lng = opts.lng;
      }
      if (opts.address) patch.address = opts.address;
      await getServiceClient().from("places").update(patch).eq("id", same.id);
      step("place.attached", { name: opts.name, placeId: same.id });
      return { id: same.id, duplicate: true };
    }
  }
  // fsq_place_id stays null: Foursquare is out of credits, and a name plus an
  // address is enough to put a place on a day. places_needs_fsq_idx is exactly
  // the backfill query for when credits return.
  const { data, error } = await getServiceClient()
    .from("places")
    .insert({
      trip_id: opts.trip.id,
      leg_id: legIdForWrite(opts.trip, opts.date),
      name: opts.name,
      address: opts.address,
      lat: opts.lat,
      lng: opts.lng,
      category: opts.category,
      source: SOCIAL_SOURCE,
      suggested_by: opts.row.participant_id,
      source_url: opts.row.url,
      resolved_at: new Date().toISOString(),
      note: null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    step("place.insert_failed", { code: error.code, name: opts.name });
    return null;
  }
  const id = (data as { id: string } | null)?.id ?? null;
  return id ? { id, duplicate: false } : null;
}

// One link, start to finish. Returns a line to say in the chat, or null.
// Silence is the default: only a real resolution speaks.
type Resolved = { name: string; day: number | null };

function dayOfFit(fit: { kind: string; day?: number } | null): number | null {
  return fit && (fit.kind === "near" || fit.kind === "open_day" || fit.kind === "asked_day")
    ? fit.day ?? null
    : null;
}

async function resolveOne(opts: {
  trip: TripRow;
  row: LinkRow;
  date: string;
  now: Date;
  nameOf: (participantId: string | null) => string | null;
}): Promise<Resolved | null> {
  const { row } = opts;
  const read = await readLink(row);
  if (!read.ok) {
    step("read.miss", { kind: row.kind, url: row.url, reason: read.reason, via: read.via });
    await markLink(row.id, { status: "failed", outcome: read.reason, extracted_text: null });
    return null;
  }

  // A Maps link already names the place; nothing needs a model.
  if (read.maps?.name) {
    const saved = await insertPlace({
      trip: opts.trip,
      row,
      name: read.maps.name,
      address: null,
      category: null,
      lat: read.maps.lat,
      lng: read.maps.lng,
      date: opts.date,
    });
    await markLink(row.id, {
      status: saved ? "resolved" : "failed",
      outcome: saved ? (saved.duplicate ? "maps_url_duplicate" : "maps_url") : "place_insert_failed",
      extracted_text: read.text,
      place_id: saved?.id ?? null,
    });
    if (!saved) return null;
    // Already announced by whichever path got here first: one venue, one
    // message.
    if (saved.duplicate) return null;
    const placeId = saved.id;
    // A Maps link is the only source that hands over real coordinates, so it
    // is also the one that always lands on the right day.
    const fit = await anchorSuggestion({
      trip: opts.trip,
      now: opts.now,
      placeId,
      coords: read.maps.lat !== null && read.maps.lng !== null
        ? { lat: read.maps.lat, lng: read.maps.lng }
        : null,
    }).catch(() => null);
    return { name: read.maps.name, day: dayOfFit(fit) };
  }

  const found = await extractPlaceFromText({
    text: read.text,
    destination: cityFor(opts.trip, opts.date) || opts.trip.destination,
  }).catch((err) => {
    step("gemini.failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  });

  if (!found?.place_name) {
    // First-class outcome, not an error branch. The caption is KEPT so the
    // group can clarify later, and so the hit-rate log has the evidence.
    step("unresolved", { kind: row.kind, url: row.url, chars: read.text.length });
    await markLink(row.id, {
      status: "unresolved",
      outcome: "no_venue",
      extracted_text: read.text.slice(0, 2000),
    });
    return null;
  }

  // Coordinates, or honestly none. IG and TikTok give a name and often a
  // street address but never a lat/lng, and fitSuggestion needs coordinates to
  // put a place on the right day.
  //
  // Cascade, cheapest first:
  //   1. a place the trip already knows, or the destination profile
  //   2. Nominatim on the VENUE NAME plus its city. NOT the address: measured,
  //      Nominatim reads "Ramen Break Beats, Tokyo" and cannot read
  //      "〒153-0063 Tokyo, Meguro City, 4 Chome−21−19".
  //   3. nothing, and we say so rather than guessing a day.
  const profile = (opts.trip.destination_profile_json ?? null) as DestinationProfile | null;
  let coords = profile ? resolvePlace(found.place_name, profile)?.coords ?? null : null;
  if (!coords) {
    const geo = await geocodePlace({
      name: found.place_name,
      city: found.city ?? cityFor(opts.trip, opts.date) ?? null,
      near: profile?.center ?? null,
    });
    if (geo) coords = { lat: geo.lat, lng: geo.lng };
  }

  const savedPlace = await insertPlace({
    trip: opts.trip,
    row,
    name: found.place_name,
    address: found.address,
    category: found.category,
    lat: read.maps?.lat ?? coords?.lat ?? null,
    lng: read.maps?.lng ?? coords?.lng ?? null,
    date: opts.date,
  });
  await markLink(row.id, {
    status: savedPlace ? "resolved" : "failed",
    outcome: savedPlace
      ? savedPlace.duplicate
        ? "venue_duplicate"
        : found.address
          ? "venue_with_address"
          : "venue_no_address"
      : "place_insert_failed",
    extracted_text: read.text.slice(0, 2000),
    place_id: savedPlace?.id ?? null,
  });
  if (!savedPlace) return null;
  // The conversation tool already said this one out loud when it read the same
  // message. One venue, one row, one message.
  if (savedPlace.duplicate) {
    step("resolved.duplicate", { kind: row.kind, url: row.url, place: found.place_name });
    return null;
  }
  const placeId = savedPlace.id;
  // Same fit and anchor the typed-in suggestions use, so a place from a TikTok
  // lands exactly the way one someone typed does. With no coordinates the fit
  // is "no_location": it goes on the ideas list rather than onto a guessed day.
  const fit = await anchorSuggestion({
    trip: opts.trip,
    now: opts.now,
    placeId,
    coords,
  }).catch((err) => {
    step("anchor.failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  step("resolved", {
    kind: row.kind,
    url: row.url,
    place: found.place_name,
    address: Boolean(found.address),
    located: Boolean(coords),
    fit: fit?.kind ?? "none",
    via: read.via,
  });
  return { name: found.place_name, day: dayOfFit(fit) };
}

// The cron's job for one trip. Rate limited, one attempt per link, never
// throws: a link is a bonus, never a gate.
export async function resolveQueuedLinks(
  trip: TripRow,
  opts: { now?: Date; send?: (text: string) => Promise<unknown> } = {},
): Promise<{ resolved: number; unresolved: number; failed: number; skipped: number }> {
  const now = opts.now ?? new Date();
  const tally = { resolved: 0, unresolved: 0, failed: 0, skipped: 0 };

  const already = await resolvedInLastHour(trip.id, now);
  const budget = Math.max(0, RESOLUTIONS_PER_TRIP_PER_HOUR - already);
  if (budget === 0) {
    step("ratelimited", { tripId: trip.id, already });
    return tally;
  }

  const { data, error } = await getServiceClient()
    .from("social_links")
    .select("id, trip_id, participant_id, url, kind, attempts")
    .eq("trip_id", trip.id)
    .eq("status", "queued")
    .lt("attempts", MAX_ATTEMPTS + 1)
    .order("created_at")
    .limit(budget);
  if (error) {
    step("queue.skipped", { code: error.code, note: "migration 2026-10-04 applied?" });
    return tally;
  }
  const rows = (data ?? []) as LinkRow[];
  if (rows.length === 0) return tally;

  const date = trip.start_date ?? new Date().toISOString().slice(0, 10);
  const names = await participantNames(trip.id);

  for (const row of rows) {
    // Count the attempt BEFORE trying, so a crash mid-job cannot make a link
    // retry forever.
    await getServiceClient()
      .from("social_links")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    let line: Resolved | null = null;
    try {
      line = await withTimeout(
        resolveOne({ trip, row, date, now, nameOf: (id) => (id ? names.get(id) ?? null : null) }),
        JOB_TIMEOUT_MS,
        "social.resolve",
      );
    } catch (err) {
      step("job.failed", { url: row.url, error: err instanceof Error ? err.message : String(err) });
      await markLink(row.id, { status: "failed", outcome: "timeout" });
    }
    const status = await statusOf(row.id);
    if (status === "resolved") tally.resolved += 1;
    else if (status === "unresolved") tally.unresolved += 1;
    else tally.failed += 1;

    // The one line, only on a hit. A link that resolved to nothing said
    // nothing, which is the whole point of the silence rule.
    if (line && opts.send) {
      await opts
        .send(
          socialPlaceAddedLine({
            name: line.name,
            by: row.participant_id ? names.get(row.participant_id) ?? null : null,
            day: line.day,
          }),
        )
        .catch((err) => step("send.failed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }
  step("swept", { tripId: trip.id, ...tally });
  return tally;
}

async function statusOf(id: string): Promise<LinkStatus> {
  const { data } = await getServiceClient().from("social_links").select("status").eq("id", id).maybeSingle();
  return ((data as { status?: LinkStatus } | null)?.status ?? "failed") as LinkStatus;
}

async function participantNames(tripId: string): Promise<Map<string, string>> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select("id, display_name")
    .eq("trip_id", tripId);
  if (error) return new Map();
  return new Map(
    (data ?? []).map((row) => [
      (row as { id: string }).id,
      (row as { display_name: string | null }).display_name ?? "someone",
    ]),
  );
}
