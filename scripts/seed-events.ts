// Real Tokyo events into trip_events, so the show suggestion runs for real on
// a trip where Ticketmaster has nothing.
//
//   TRIP_ID=<uuid> npx tsx scripts/seed-events.ts
//   TRIP_ID=<uuid> npx tsx scripts/seed-events.ts --clear   (remove seeds first)
//
// These rows go through exactly the same matcher, attribution and copy a
// Discovery row would. Only the inventory is hand-assembled, and `source` says
// so. Discovery stays wired for non-Japan trips where it genuinely works.
//
// EDIT THE EVENTS BELOW. Every field marked REQUIRED must be real:
//
//   name        REQUIRED  what it is called, as a person would say it
//   url         REQUIRED  the actual ticket page. This is the whole feature.
//   startsAt    REQUIRED  ISO 8601 WITH the local offset, e.g.
//                         "2026-10-04T19:00:00+09:00". A real clock time:
//                         never invent an hour from a date, because the
//                         message says "saturday 7pm" out loud.
//   venue       real venue name, shown in the message
//   lat / lng   venue coordinates, so it can land near a day's cluster
//   category    one of our interest keys where it fits: culture, nightlife,
//               food, outdoors, landmarks, neighbourhoods, shopping
//   priceNote   what tickets cost, in words, e.g. "around 4000 yen".
//               Leave null and the message says the price is unknown, which
//               is the honest default: Discovery's priceRanges was 0% filled
//               in every market probed, so there is nothing to check.
//
// Dates must fall inside the trip's start_date..end_date or the matcher will
// skip them; this script warns when one does not.

import { loadEnvConfig } from "@next/env";
import { getServiceClient } from "@/lib/db/client";

loadEnvConfig(process.cwd());

type SeedEvent = {
  name: string;
  url: string;
  startsAt: string;
  venue?: string | null;
  lat?: number | null;
  lng?: number | null;
  category?: string | null;
  priceNote?: string | null;
};

// ---------------------------------------------------------------------------
// REPLACE THESE. Placeholders on purpose: every one needs a real ticket URL,
// and a fabricated link is worse than no feature. The script refuses to write
// any row whose url still says example.com.
// ---------------------------------------------------------------------------
const EVENTS: SeedEvent[] = [
  {
    name: "Kabuki at Kabukiza Theatre",
    venue: "Kabukiza Theatre, Ginza",
    lat: 35.6695,
    lng: 139.7674,
    startsAt: "2026-10-04T16:30:00+09:00",
    category: "culture",
    url: "https://example.com/REPLACE-kabukiza",
    priceNote: "single-act tickets from around 2000 yen",
  },
  {
    name: "Grand Sumo Tournament",
    venue: "Ryogoku Kokugikan",
    lat: 35.6968,
    lng: 139.7933,
    startsAt: "2026-10-05T14:00:00+09:00",
    category: "culture",
    url: "https://example.com/REPLACE-sumo",
    priceNote: null,
  },
  {
    name: "Live jazz at Blue Note Tokyo",
    venue: "Blue Note Tokyo, Aoyama",
    lat: 35.6626,
    lng: 139.7155,
    startsAt: "2026-10-03T19:00:00+09:00",
    category: "nightlife",
    url: "https://example.com/REPLACE-bluenote",
    priceNote: "around 8000 yen plus a drink minimum",
  },
];

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const tripId = process.env.TRIP_ID;
  if (!tripId) fail("set TRIP_ID=<uuid>. Find one with: select id, destination, start_date, end_date from trips;");

  const db = getServiceClient();
  const trip = await db
    .from("trips")
    .select("id, destination, start_date, end_date, timezone")
    .eq("id", tripId)
    .maybeSingle();
  if (trip.error) fail(`could not read the trip: ${trip.error.message}`);
  if (!trip.data) fail(`no trip with id ${tripId}`);
  const { destination, start_date, end_date } = trip.data as {
    destination: string | null;
    start_date: string | null;
    end_date: string | null;
  };
  console.log(`trip ${tripId}: ${destination ?? "(no destination)"} ${start_date} to ${end_date}`);

  if (process.argv.includes("--clear")) {
    const cleared = await db.from("trip_events").delete().eq("trip_id", tripId).eq("source", "seed");
    if (cleared.error) fail(`could not clear seeds: ${cleared.error.message}`);
    console.log("cleared existing seeded events");
  }

  const placeholders = EVENTS.filter((e) => e.url.includes("example.com"));
  if (placeholders.length > 0) {
    fail(
      `${placeholders.length} event(s) still have a placeholder url:\n` +
        placeholders.map((e) => `  - ${e.name}`).join("\n") +
        "\n\nPut the real ticket pages in EVENTS at the top of this file first." +
        "\nA fabricated link is worse than no suggestion at all.",
    );
  }

  let outside = 0;
  const rows = EVENTS.map((e) => {
    const day = new Date(e.startsAt).toISOString().slice(0, 10);
    if (start_date && end_date && (day < start_date || day > end_date)) {
      console.warn(`  WARNING  "${e.name}" is on ${day}, outside ${start_date}..${end_date}. The matcher will skip it.`);
      outside += 1;
    }
    return {
      trip_id: tripId,
      name: e.name,
      venue: e.venue ?? null,
      lat: e.lat ?? null,
      lng: e.lng ?? null,
      starts_at: new Date(e.startsAt).toISOString(),
      category: e.category ?? null,
      url: e.url,
      price_note: e.priceNote ?? null,
      source: "seed",
    };
  });

  const written = await db
    .from("trip_events")
    .upsert(rows, { onConflict: "trip_id,url" })
    .select("id, name, starts_at");
  if (written.error) fail(`could not write events: ${written.error.message}\n(migration 2026-10-06 applied?)`);

  const saved = (written.data ?? []) as { name: string; starts_at: string }[];
  console.log(`\nwrote ${saved.length} event(s), source='seed':`);
  for (const row of saved) console.log(`  ${row.starts_at}  ${row.name}`);
  if (outside > 0) console.log(`\n${outside} of them fall outside the trip and will not be suggested.`);

  console.log(
    "\nnext: the daily cron picks one on its next tick, once, for whoever's" +
      "\nmust_have mentions something ticketed. Force it with:" +
      `\n  curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/daily-board?force=1&trip_id=${tripId}"` +
      "\nto re-arm after a send: update trips set show_suggested_at = null where id = '" + tripId + "';",
  );
}

main().catch((err) => {
  console.error("\nseed-events threw:", err instanceof Error ? err.message : err);
  process.exit(1);
});
