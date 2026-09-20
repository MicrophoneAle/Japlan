// Three outages have been the same bug: code started selecting a column, the
// migration that adds it was never run, and every query threw 42703
// ("column trips.play_mode does not exist"). The webhook had already returned
// 200, so the bot went silently dead.
//
// This file is the shared vocabulary for catching that in three places:
//  - `npm test` (schema-contract.test.ts): every column the code selects is
//    created by schema.sql or a migration, and SCHEMA_CONTRACT covers every
//    select in the codebase. This is the check that would have caught all
//    three outages before deploying.
//  - `npx tsx scripts/check-schema.ts`: which migrations are not applied to
//    the live database, before you deploy.
//  - the running app (schema-check.ts): one probe per cold start, logging the
//    missing column loudly instead of failing silently.
//
// Only SELECTed columns are covered. An insert or update naming a missing
// column still fails at runtime; object literals are not parsed here.

export type TableColumns = Record<string, string[]>;

// Every column the app selects, per table. Kept in sync by the test: it fails
// if code selects something this misses, or if this names something no
// migration creates.
export const SCHEMA_CONTRACT: TableColumns = {
  trips: [
    "id", "linq_chat_id", "name", "destination", "start_date", "end_date", "play_mode", "state",
    "difficulty", "stake_text", "timezone", "destination_profile_json", "is_solo", "daily_points_cap",
    "organizer_participant_id", "setup_state", "completed_at", "board_time", "category_weights",
    "group_profile_md", "engagement_json", "waiting_notice_sent_at", "sidequest_state",
    "multipliers_checked_at", "created_at",
  ],
  participants: [
    "id", "trip_id", "phone", "display_name", "score", "survey_json", "survey_state",
    "sidequests_muted", "consented_at", "prefs_json", "profile_md", "survey_nudged_on", "created_at",
  ],
  tasks: [
    "id", "trip_id", "participant_id", "team_id", "code", "title", "tier", "axes_json", "base_points",
    "photo_bonus_max", "verification", "day", "expires_at", "neighborhood", "source", "slot",
    "duration_minutes", "day_multiplier", "multiplier_reason", "created_at",
  ],
  claims: [
    "id", "task_id", "participant_id", "evidence_url", "image_hash", "status", "awarded_points",
    "resolved_by", "resolution_json", "capped", "photo_claimed_at", "primary_claim", "expires_at",
    "storage_path", "created_at",
  ],
  boards: [
    "id", "trip_id", "day", "local_date", "status", "provisional", "requested_by", "delivered_at",
    "created_at", "updated_at",
  ],
  board_requests: ["id", "trip_id", "participant_id", "requested_on", "day", "kind", "created_at"],
  teams: ["id", "trip_id", "name", "color", "formed_at", "dissolved_at", "day", "starts_at", "rejoin_at", "rejoin_place", "area"],
  team_members: ["id", "team_id", "participant_id", "created_at"],
  places: ["id", "trip_id", "fsq_place_id", "name", "lat", "lng", "category", "source", "suggested_by", "hours_json", "price_band", "score", "note", "leg_id", "source_url", "resolved_at", "address", "created_at"],
  itinerary: ["id", "trip_id", "day", "anchor_order", "place_id", "planned_time", "created_at"],
  ratings: ["id", "participant_id", "place_id", "score", "created_at"],
  events: ["id", "trip_id", "linq_event_id", "type", "payload", "processed_at", "retried_at", "created_at"],
  chat_messages: ["id", "chat_id", "role", "sender_handle", "sender_name", "text", "created_at"],
  participant_stats: [
    "trip_id", "participant_id", "itinerary_items_total", "tasks_completed", "photos_submitted",
    "photo_bonuses_earned", "sidequests_claimed", "freeform_claims", "days_with_activity",
    "distance_km", "places_visited", "activity_days", "place_keys", "updated_at",
  ],
  sidequests: ["id", "trip_id", "day", "local_date", "template_id", "title", "points", "photo_bonus_max", "trigger", "status", "won_by", "won_at", "created_at"],
  sidequest_offers: ["id", "sidequest_id", "trip_id", "participant_id", "status", "queued_at", "fired_at", "expires_at", "resolved_at", "awarded_points", "photo_bonus", "created_at"],
  group_decisions: ["id", "trip_id", "prompt", "status", "created_by", "selected_option", "poll_message_id", "voting_mode", "created_at", "closed_at", "last_reminded_at"],
  group_decision_options: ["id", "decision_id", "option_index", "label", "message_id", "poll_option_id"],
  group_decision_votes: ["id", "decision_id", "participant_id", "option_index", "created_at", "updated_at"],
  trip_location_shares: ["trip_id", "participant_id", "direct_chat_id", "share_status", "expires_at"],
  multiplier_days: ["id", "trip_id", "local_date", "multiplier", "label", "source", "leg_id", "created_at"],
  social_links: [
    "id", "trip_id", "participant_id", "chat_id", "url", "kind", "status", "attempts",
    "extracted_text", "outcome", "place_id", "created_at", "attempted_at", "resolved_at",
  ],
  trip_legs: [
    "id", "trip_id", "leg_order", "city", "start_date", "end_date", "timezone",
    "destination_profile_json", "is_travel_day", "created_at",
  ],
};

// Tables the app never queries through PostgREST.
export const IGNORED_TABLES = new Set(["smoke_scratch", "storage", "cron"]);

export type SqlObjects = {
  // table -> columns it creates (create table body plus later add column).
  tables: Map<string, Set<string>>;
};

function addColumn(objects: SqlObjects, table: string, column: string): void {
  const set = objects.tables.get(table) ?? new Set<string>();
  set.add(column);
  objects.tables.set(table, set);
}

// Which tables and columns a .sql file creates. Understands the two shapes
// this repo uses: `create table [if not exists] x ( ... )` and
// `alter table x add column [if not exists] y type`.
export function parseSqlObjects(sql: string, into?: SqlObjects): SqlObjects {
  const objects: SqlObjects = into ?? { tables: new Map() };
  const stripped = sql.replace(/--[^\n]*/g, "");

  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  for (const match of stripped.matchAll(createRe)) {
    const table = match[1].toLowerCase();
    // Every column comes from the body. Do not assume an id: participant_stats
    // is keyed by (trip_id, participant_id) and has none.
    objects.tables.set(table, objects.tables.get(table) ?? new Set<string>());
    for (const rawLine of match[2].split("\n")) {
      const line = rawLine.trim().replace(/,$/, "");
      if (!line) continue;
      // Skip table-level constraints: they start with a keyword, not a name.
      if (/^(primary|unique|foreign|constraint|check|exclude)\b/i.test(line)) continue;
      const col = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (col) addColumn(objects, table, col[1].toLowerCase());
    }
  }

  const alterRe = /alter\s+table\s+([a-z_][a-z0-9_]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
  for (const match of stripped.matchAll(alterRe)) {
    addColumn(objects, match[1].toLowerCase(), match[2].toLowerCase());
  }
  return objects;
}

export type FoundSelect = { table: string; columns: string[] };

// Every `from("table")....select(...)` in a source file, with the columns it
// asks for. Constants (TRIP_COLS and friends) resolve through `constants`.
// `select("*")`, counts and embedded selects (`places(name)`) are skipped:
// they cannot name a missing column on their own.
export function parseSelectsFromSource(source: string, constants: Record<string, string> = {}): FoundSelect[] {
  const local: Record<string, string> = { ...constants };
  for (const match of source.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*string\s*)?=\s*\n?\s*"([^"]*)"/g)) {
    local[match[1]] = match[2];
  }

  const found: FoundSelect[] = [];
  for (const match of source.matchAll(/\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)/g)) {
    const table = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const rest = source.slice(start, start + 400);
    // One query only: another .from( means we have run into the next call.
    const window = rest.split(/\.from\(\s*"/)[0];
    const select = window.match(/\.select\(\s*(?:"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (!select) continue;
    const raw = select[1] ?? local[select[2] ?? ""] ?? null;
    if (raw === null) continue;
    const columns = columnsFromSelect(raw);
    if (columns.length > 0) found.push({ table, columns });
  }
  return found;
}

export function columnsFromSelect(raw: string): string[] {
  if (raw.includes("*")) return [];
  // Drop embedded resources: "place_id, places(name)" -> "place_id".
  const withoutEmbeds = raw.replace(/[a-z_][a-z0-9_]*\s*\([^)]*\)/gi, "");
  return withoutEmbeds
    .split(",")
    .map((part) => part.trim().split(/[:\s]/)[0].trim())
    .filter((part) => /^[a-z_][a-z0-9_]*$/.test(part));
}

export type Missing = { table: string; column: string | null };

// What the contract asks for that the schema does not create. column null
// means the whole table is missing.
export function missingFromSchema(contract: TableColumns, schema: SqlObjects): Missing[] {
  const missing: Missing[] = [];
  for (const [table, columns] of Object.entries(contract)) {
    if (IGNORED_TABLES.has(table)) continue;
    const have = schema.tables.get(table);
    if (!have) {
      missing.push({ table, column: null });
      continue;
    }
    for (const column of columns) {
      if (!have.has(column)) missing.push({ table, column });
    }
  }
  return missing;
}

// The migration file that creates a given table or column, for the message
// someone reads at 2am. Later files win: a column can be added once and
// altered later.
export function migrationFor(
  files: { file: string; objects: SqlObjects }[],
  table: string,
  column: string | null,
): string | null {
  let answer: string | null = null;
  for (const { file, objects } of files) {
    const have = objects.tables.get(table);
    if (!have) continue;
    if (column === null || have.has(column)) answer = file;
  }
  return answer;
}
