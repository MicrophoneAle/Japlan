// Before you deploy the legs embed: prove it against the live database.
//
//   npx tsx scripts/verify-embed.ts
//
// The embed shapes EVERY trip query in the app, and the fake Supabase used by
// the test suite does not implement PostgREST embed syntax, so nothing in
// `npm test` exercises the real join. `npm run check:schema` will not catch it
// either: every column exists, it is the relationship that might not resolve.
//
// Three checks, all read-only, exit 1 if any fails:
//   1. a real trip comes back with its legs embedded and populated
//   2. a trip with no trip_legs rows synthesises a single leg
//   3. a deliberately broken embed falls back to plain TRIP_COLS rather than
//      throwing, which is what stops an unrun migration taking the bot down
//
// Read-only: it never writes.

import { loadEnvConfig } from "@next/env";
import { getServiceClient } from "@/lib/db/client";
import { tripQuery, asTripWithEmbeddedLegs, TRIP_COLS_WITH_LEGS } from "@/lib/handlers/bootstrap";
import { TRIP_COLS } from "@/lib/db/columns";
import { legsOf, isSyntheticLeg, zoneFor, cityFor } from "@/lib/game/legs";

// Env is read lazily inside getServiceClient, so loading it here is in time.
loadEnvConfig(process.cwd());

let failures = 0;

function check(ok: boolean, label: string, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function heading(text: string): void {
  console.log(`\n${"=".repeat(72)}\n${text}`);
}

// Every trip id, plus whether it has any legs rows, in two plain queries so
// this script itself never depends on the thing it is verifying.
async function survey(): Promise<{ withLegs: string[]; withoutLegs: string[] }> {
  const trips = await getServiceClient().from("trips").select("id").limit(50);
  if (trips.error) throw trips.error;
  const ids = (trips.data ?? []).map((r) => (r as { id: string }).id);
  const legs = await getServiceClient().from("trip_legs").select("trip_id");
  if (legs.error) {
    console.log(`  (trip_legs unreadable: ${legs.error.code} ${legs.error.message})`);
    return { withLegs: [], withoutLegs: ids };
  }
  const has = new Set((legs.data ?? []).map((r) => (r as { trip_id: string }).trip_id));
  return {
    withLegs: ids.filter((id) => has.has(id)),
    withoutLegs: ids.filter((id) => !has.has(id)),
  };
}

const byId = (id: string) => (cols: string) =>
  getServiceClient().from("trips").select(cols).eq("id", id).maybeSingle();

async function main(): Promise<void> {
  console.log("verifying the legs embed against the LIVE database");
  console.log(`  embed columns: ${TRIP_COLS_WITH_LEGS.slice(0, 110)}...`);

  const { withLegs, withoutLegs } = await survey();
  console.log(`\n  trips sampled: ${withLegs.length + withoutLegs.length}`);
  console.log(`    with trip_legs rows: ${withLegs.length}`);
  console.log(`    without:             ${withoutLegs.length}`);

  // ---------------------------------------------------------------- 1
  heading("1. a real trip comes back with its legs embedded");
  if (withLegs.length === 0) {
    console.log("  SKIP  no trip has any trip_legs rows yet.");
    console.log("        run a setup, or seed one, then re-run this.");
  } else {
    const id = withLegs[0];
    const raw = await tripQuery(byId(id));
    const embedded = (raw as { trip_legs?: unknown } | null)?.trip_legs;
    check(raw !== null, "the query returned a row", `trip ${id}`);
    check(Array.isArray(embedded), "trip_legs came back as an array", `got ${typeof embedded}`);
    check(
      Array.isArray(embedded) && embedded.length > 0,
      "and it is populated",
      `${Array.isArray(embedded) ? embedded.length : 0} leg(s)`,
    );

    const trip = asTripWithEmbeddedLegs(raw);
    const legs = legsOf(trip);
    check(legs.length > 0, "legsOf() sees them");
    check(!isSyntheticLeg(legs[0]), "and they are REAL legs, not synthesised", legs[0].id);
    check(
      legs.every((l, i) => i === 0 || l.leg_order >= legs[i - 1].leg_order),
      "legs are in leg_order",
      legs.map((l) => `${l.leg_order}:${l.city}`).join(" "),
    );
    // The two reads that every call site depends on.
    const date = trip.start_date ?? "2026-01-01";
    console.log(`  resolved: city=${cityFor(trip, date)} zone=${zoneFor(trip, date)}`);
  }

  // ---------------------------------------------------------------- 2
  heading("2. a trip with no legs rows synthesises a single leg");
  if (withoutLegs.length === 0) {
    console.log("  SKIP  every sampled trip has legs. Nothing to check here.");
  } else {
    const id = withoutLegs[0];
    const raw = await tripQuery(byId(id));
    check(raw !== null, "the query returned a row", `trip ${id}`);
    const trip = asTripWithEmbeddedLegs(raw);
    const legs = legsOf(trip);
    check(legs.length === 1, "exactly one leg", `got ${legs.length}`);
    check(isSyntheticLeg(legs[0]), "and it is synthesised from the trip's own columns", legs[0].id);
    const date = trip.start_date ?? "2026-01-01";
    check(
      zoneFor(trip, date) === (trip.timezone || "UTC"),
      "zoneFor falls back to trips.timezone",
      `${zoneFor(trip, date)} vs ${trip.timezone}`,
    );
    check(
      cityFor(trip, date) === (trip.destination?.trim() || ""),
      "cityFor falls back to trips.destination",
      `${cityFor(trip, date)} vs ${trip.destination}`,
    );
  }

  // ---------------------------------------------------------------- 3
  heading("3. a broken embed falls back instead of throwing");
  const anyId = [...withLegs, ...withoutLegs][0];
  if (!anyId) {
    console.log("  SKIP  no trips at all in this database.");
  } else {
    const badCols = `${TRIP_COLS}, trip_legs_does_not_exist (id)`;
    let threw: unknown = null;
    let raw: unknown = null;
    try {
      raw = await tripQuery(byId(anyId), badCols);
    } catch (err) {
      threw = err;
    }
    check(threw === null, "it did not throw", threw ? String(threw).slice(0, 90) : "");
    check(raw !== null, "it still returned the trip");
    if (raw) {
      const trip = asTripWithEmbeddedLegs(raw);
      check(trip.id === anyId, "and it is the right trip");
      check(legsOf(trip).length === 1 && isSyntheticLeg(legsOf(trip)[0]), "degraded to a single synthesised leg");
    }
  }

  heading(failures === 0 ? "ALL CHECKS PASSED - safe to deploy the embed" : `${failures} CHECK(S) FAILED - do not deploy`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nverify-embed threw:", err instanceof Error ? err.message : err);
  process.exit(1);
});
