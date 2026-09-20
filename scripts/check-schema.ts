// Before you deploy: which migrations have not been run against the live
// database, and which columns this code selects that the database does not
// have. Three outages have been exactly this, discovered only when the bot
// went quiet.
//
//   npx tsx scripts/check-schema.ts
//
// Exit code 1 if anything is missing, so it can gate a deploy.
// Read-only: it never writes to the database.

import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  IGNORED_TABLES,
  SCHEMA_CONTRACT,
  migrationFor,
  parseSqlObjects,
  type Missing,
  type SqlObjects,
} from "../lib/db/schema-contract";

loadEnvConfig(process.cwd());

const MIGRATIONS_DIR = path.join("lib", "db", "migrations");
const TIMEOUT_MS = 10_000;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// "unknown" matters: a timed out probe is not a missing column. Reporting it
// as missing produces a false "do not deploy", and a check that cries wolf
// gets ignored, which is how the outages happened in the first place.
type Presence = "yes" | "no" | "unknown";
type Live = { has: (table: string, column: string | null) => Promise<Presence> };

async function liveProbe(): Promise<Live> {
  const headers = { apikey: key!, Authorization: `Bearer ${key!}` };
  const cache = new Map<string, Promise<Presence>>();

  async function ask(table: string, column: string | null): Promise<Presence | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=${column ?? "*"}&limit=1`, {
        headers,
        signal: ctl.signal,
      });
      if (res.ok) return "yes";
      // 4xx from PostgREST is an answer: the column or table is not there.
      // 5xx is the server having a bad day, so ask again.
      return res.status >= 400 && res.status < 500 ? "no" : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    has(table, column) {
      const cacheKey = `${table}.${column ?? "*"}`;
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const request = (async () => {
        // One retry, so a single timeout cannot read as a missing column.
        return (await ask(table, column)) ?? (await ask(table, column)) ?? "unknown";
      })();
      cache.set(cacheKey, request);
      return request;
    },
  };
}

function readMigrations(): { file: string; objects: SqlObjects }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, objects: parseSqlObjects(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")) }));
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

async function main() {
  if (!url || !key) {
    console.error(`${RED}SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set: nothing to check against.${OFF}`);
    process.exit(1);
  }
  const live = await liveProbe();
  const migrations = readMigrations();

  console.log(`${DIM}Checking ${migrations.length} migrations and ${Object.keys(SCHEMA_CONTRACT).length} tables against ${url.replace(/https:\/\/([^.]+).*/, "$1")}${OFF}\n`);

  // 1. Migrations: every object a file creates should exist live.
  const unapplied: { file: string; missing: string[] }[] = [];
  const unreachable: string[] = [];
  for (const { file, objects } of migrations) {
    const missing: string[] = [];
    for (const [table, columns] of objects.tables) {
      if (IGNORED_TABLES.has(table)) continue;
      const hasTable = await live.has(table, null);
      if (hasTable === "unknown") {
        unreachable.push(table);
        continue;
      }
      if (hasTable === "no") {
        missing.push(`${table} (whole table)`);
        continue;
      }
      for (const column of columns) {
        const hasColumn = await live.has(table, column);
        if (hasColumn === "unknown") unreachable.push(`${table}.${column}`);
        else if (hasColumn === "no") missing.push(`${table}.${column}`);
      }
    }
    if (missing.length > 0) unapplied.push({ file, missing });
    const mark = missing.length === 0 ? `${GREEN}applied${OFF}` : `${RED}NOT APPLIED${OFF}`;
    console.log(` ${mark}  ${file}`);
    for (const item of missing) console.log(`            ${RED}missing${OFF} ${item}`);
  }

  // 2. The contract: columns this build selects, checked directly. Catches a
  // column someone added to a query with no migration at all.
  const missingForCode: Missing[] = [];
  for (const [table, columns] of Object.entries(SCHEMA_CONTRACT)) {
    if (IGNORED_TABLES.has(table)) continue;
    const hasTable = await live.has(table, null);
    if (hasTable === "unknown") {
      unreachable.push(table);
      continue;
    }
    if (hasTable === "no") {
      missingForCode.push({ table, column: null });
      continue;
    }
    for (const column of columns) {
      const hasColumn = await live.has(table, column);
      if (hasColumn === "unknown") unreachable.push(`${table}.${column}`);
      else if (hasColumn === "no") missingForCode.push({ table, column });
    }
  }

  console.log("");
  if (missingForCode.length === 0) {
    console.log(`${GREEN}Every column this code selects exists live.${OFF}`);
  } else {
    console.log(`${RED}This code selects ${missingForCode.length} thing(s) the live database does not have:${OFF}`);
    for (const gone of missingForCode) {
      const where = gone.column ? `${gone.table}.${gone.column}` : `${gone.table} (whole table)`;
      const file = migrationFor(migrations, gone.table, gone.column);
      console.log(`  ${RED}${where}${OFF} ${file ? `→ run ${YELLOW}${file}${OFF}` : `${YELLOW}→ no migration creates it; the query is wrong or the migration was never written${OFF}`}`);
    }
  }

  if (unreachable.length > 0) {
    const shown = [...new Set(unreachable)];
    console.log(
      `\n${YELLOW}Could not reach the database for ${shown.length} thing(s); they are NOT reported as missing:${OFF} ${shown.slice(0, 8).join(", ")}${shown.length > 8 ? ", ..." : ""}`,
    );
  }

  if (unapplied.length > 0 || missingForCode.length > 0) {
    console.log(
      `\n${RED}Do not deploy.${OFF} Run the migrations above in the Supabase SQL editor (in filename order), then run this again.`,
    );
    process.exit(1);
  }
  console.log(`\n${GREEN}Schema is in sync. Safe to deploy.${OFF}`);
}

main().catch((err) => {
  console.error("check-schema failed", err);
  process.exit(1);
});
