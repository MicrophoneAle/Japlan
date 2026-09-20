import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IGNORED_TABLES,
  SCHEMA_CONTRACT,
  columnsFromSelect,
  migrationFor,
  missingFromSchema,
  parseSelectsFromSource,
  parseSqlObjects,
  type SqlObjects,
} from "./schema-contract";
import { parsePostgrestMissing, resetSchemaCheckCache, verifySchema } from "./schema-check";

// The guard that matters: three outages shipped a query for a column no
// migration created (or whose migration was never run). These two tests fail
// the build for the first half of that, before anyone deploys.

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of ["lib", "app", "scripts"]) walk(dir);
  return out;
}

function exportedConstants(files: string[]): Record<string, string> {
  const constants: Record<string, string> = {};
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/export const ([A-Z_]+)\s*=\s*\n?\s*"([^"]*)"/g)) {
      constants[match[1]] = match[2];
    }
  }
  return constants;
}

function schemaFromFiles(): { schema: SqlObjects; migrations: { file: string; objects: SqlObjects }[] } {
  const schema: SqlObjects = { tables: new Map() };
  parseSqlObjects(fs.readFileSync(path.join("lib", "db", "schema.sql"), "utf8"), schema);
  const dir = path.join("lib", "db", "migrations");
  const migrations = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      parseSqlObjects(sql, schema);
      return { file, objects: parseSqlObjects(sql) };
    });
  return { schema, migrations };
}

describe("every column the app selects exists in the schema", () => {
  it("is created by schema.sql or a migration", () => {
    const { schema, migrations } = schemaFromFiles();
    const missing = missingFromSchema(SCHEMA_CONTRACT, schema);
    const described = missing.map((m) => {
      const where = m.column ? `${m.table}.${m.column}` : `${m.table} (whole table)`;
      const file = migrationFor(migrations, m.table, m.column);
      return `${where}${file ? ` (only in ${file})` : " - no migration creates it"}`;
    });
    // A failure here means a query would throw 42703 in production.
    expect(described).toEqual([]);
  });

  it("is covered by SCHEMA_CONTRACT, so the runtime check probes it", () => {
    const files = sourceFiles();
    const constants = exportedConstants(files);
    const gaps: string[] = [];
    for (const file of files) {
      for (const found of parseSelectsFromSource(fs.readFileSync(file, "utf8"), constants)) {
        if (IGNORED_TABLES.has(found.table)) continue;
        const contract = SCHEMA_CONTRACT[found.table];
        if (!contract) {
          gaps.push(`${file}: selects from "${found.table}", which SCHEMA_CONTRACT does not list`);
          continue;
        }
        for (const column of found.columns) {
          if (!contract.includes(column)) gaps.push(`${file}: selects ${found.table}.${column}, missing from SCHEMA_CONTRACT`);
        }
      }
    }
    expect([...new Set(gaps)]).toEqual([]);
  });

  it("covers the shared column lists every trip query uses", () => {
    // TRIP_COLS is what all three outages went through.
    const columns = columnsFromSelect(
      fs.readFileSync(path.join("lib", "db", "columns.ts"), "utf8").match(/"([^"]+)"/)![1],
    );
    for (const column of columns) expect(SCHEMA_CONTRACT.trips, column).toContain(column);
  });
});

describe("reading SQL files", () => {
  it("finds columns from create table and from later alters", () => {
    const objects = parseSqlObjects(`
      create table if not exists demo (
        id uuid primary key default gen_random_uuid(),
        trip_id uuid not null references trips (id) on delete cascade,
        label text not null,
        unique (trip_id, label)
      );
      alter table demo add column if not exists play_mode text;
      alter table other add column note text;
    `);
    expect([...objects.tables.get("demo")!].sort()).toEqual(["id", "label", "play_mode", "trip_id"]);
    expect([...objects.tables.get("other")!]).toEqual(["note"]);
  });

  it("does not invent an id for a table keyed by two columns", () => {
    const objects = parseSqlObjects(`
      create table if not exists participant_stats (
        trip_id uuid not null,
        participant_id uuid not null,
        primary key (trip_id, participant_id)
      );
    `);
    expect([...objects.tables.get("participant_stats")!].sort()).toEqual(["participant_id", "trip_id"]);
  });

  it("names the migration that adds a column", () => {
    const migrations = [
      { file: "a.sql", objects: parseSqlObjects("create table trips (id uuid primary key);") },
      { file: "b.sql", objects: parseSqlObjects("alter table trips add column play_mode text;") },
    ];
    expect(migrationFor(migrations, "trips", "play_mode")).toBe("b.sql");
    expect(migrationFor(migrations, "trips", "nope")).toBe(null);
  });
});

describe("reading selects out of the code", () => {
  it("resolves a shared constant and skips star selects and embeds", () => {
    const source = `
      const TASK_COLS = "id, title, day";
      await db.from("tasks").select(TASK_COLS).eq("trip_id", id);
      await db.from("events").select("*").limit(1);
      await db.from("itinerary").select("place_id, places(name)").eq("trip_id", id);
    `;
    expect(parseSelectsFromSource(source)).toEqual([
      { table: "tasks", columns: ["id", "title", "day"] },
      { table: "itinerary", columns: ["place_id"] },
    ]);
  });

  it("never attributes one query's columns to the previous table", () => {
    const source = `
      await db.from("tasks").select("id").eq("trip_id", id);
      await db.from("participants").select("id, display_name, score").eq("trip_id", id);
    `;
    expect(parseSelectsFromSource(source)).toEqual([
      { table: "tasks", columns: ["id"] },
      { table: "participants", columns: ["id", "display_name", "score"] },
    ]);
  });
});

describe("the runtime check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetSchemaCheckCache();
  });

  it("reads the missing column out of what PostgREST says", () => {
    expect(parsePostgrestMissing('{"message":"column trips.play_mode does not exist","code":"42703"}')).toEqual({
      table: "trips",
      column: "play_mode",
    });
    expect(parsePostgrestMissing('{"message":"relation \\"public.group_decisions\\" does not exist"}')).toEqual({
      table: "group_decisions",
      column: null,
    });
  });

  it("reports the missing column instead of throwing", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        const wanted = (url.searchParams.get("select") ?? "").split(",");
        const bad = url.pathname.endsWith("/trips") && wanted.includes("play_mode");
        return bad
          ? new Response('{"message":"column trips.play_mode does not exist","code":"42703"}', { status: 400 })
          : new Response("[]", { status: 200 });
      }),
    );
    const report = await verifySchema();
    expect(report.status).toBe("missing");
    expect(report.missing).toEqual([{ table: "trips", column: "play_mode" }]);
  });

  it("says so when the database is unreachable, rather than failing the request", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    await expect(verifySchema()).resolves.toMatchObject({ status: "unavailable" });
  });
});
