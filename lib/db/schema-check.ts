import { SCHEMA_CONTRACT, type Missing } from "./schema-contract";

// One probe per cold start: does the live database actually have every column
// this deploy selects? Three outages have gone the other way round - the
// column was missing, every trip query threw 42703, the webhook had already
// returned 200, and the bot looked dead with nothing in the logs saying why.
//
// This never changes behaviour and never throws. It logs, loudly, once.

export type SchemaStatus = "ok" | "missing" | "unavailable";
export type SchemaReport = { status: SchemaStatus; missing: Missing[]; tables: number; ms: number };

const PROBE_TIMEOUT_MS = 4_000;

let cached: Promise<SchemaReport> | null = null;

// "column trips.play_mode does not exist" -> { table: trips, column: play_mode }
export function parsePostgrestMissing(raw: string): Missing | null {
  // The body is JSON, so quotes inside the message arrive escaped:
  // {"message":"relation \"public.group_decisions\" does not exist"}
  const body = raw.replace(/\\/g, "");
  const column = body.match(/column\s+"?([a-z_][a-z0-9_]*)"?\.?"?([a-z_][a-z0-9_]*)?"?\s+does not exist/i);
  if (column) {
    return column[2] ? { table: column[1], column: column[2] } : { table: "", column: column[1] };
  }
  // PGRST205: the table itself is not in the schema cache.
  const table = body.match(/relation\s+"?(?:public\.)?([a-z_][a-z0-9_]*)"?\s+does not exist/i);
  if (table) return { table: table[1], column: null };
  return null;
}

async function probe(url: string, headers: HeadersInit, table: string, columns: string[]): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(`${url}/rest/v1/${table}?select=${columns.join(",")}&limit=1`, {
      headers,
      signal: ctl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function missingForTable(
  url: string,
  headers: HeadersInit,
  table: string,
  columns: string[],
): Promise<Missing[]> {
  const res = await probe(url, headers, table, columns);
  if (!res) return [];
  if (res.ok) return [];
  const body = await res.text();
  if (res.status === 404) return [{ table, column: null }];
  const first = parsePostgrestMissing(body);
  if (first?.column === null) return [{ table, column: null }];
  // PostgREST reports one bad column at a time; ask per column so the log
  // names all of them at once. Only on the failure path.
  const missing: Missing[] = [];
  for (const column of columns) {
    const one = await probe(url, headers, table, [column]);
    if (one && !one.ok && one.status !== 404) missing.push({ table, column });
  }
  return missing.length > 0 ? missing : first ? [{ table, column: first.column }] : [];
}

export async function verifySchema(): Promise<SchemaReport> {
  const started = Date.now();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tables = Object.entries(SCHEMA_CONTRACT);
  if (!url || !key) {
    return { status: "unavailable", missing: [], tables: 0, ms: 0 };
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const results = await Promise.all(
    tables.map(([table, columns]) => missingForTable(url, headers, table, columns)),
  );
  const missing = results.flat();
  return {
    status: missing.length > 0 ? "missing" : "ok",
    missing,
    tables: tables.length,
    ms: Date.now() - started,
  };
}

function report(result: SchemaReport): void {
  if (result.status === "ok") {
    console.info("[japlan.schema] ok", { tables: result.tables, ms: result.ms });
    return;
  }
  if (result.status === "unavailable") {
    console.warn("[japlan.schema] skipped: no SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }
  const tablesGone = result.missing.filter((m) => m.column === null).map((m) => m.table);
  const columnsGone = result.missing.filter((m) => m.column !== null).map((m) => `${m.table}.${m.column}`);
  console.error(
    "[japlan.schema] SCHEMA MISMATCH: this deploy queries columns the live database does not have. " +
      "Every query touching them fails with 42703 and the bot goes silent. " +
      "Run the missing migration in the Supabase SQL editor; " +
      "`npx tsx scripts/check-schema.ts` names which one.",
    { missingColumns: columnsGone, missingTables: tablesGone, checkedTables: result.tables },
  );
  for (const gone of columnsGone) console.error(`[japlan.schema] MISSING COLUMN ${gone}`);
  for (const gone of tablesGone) console.error(`[japlan.schema] MISSING TABLE ${gone}`);
}

// Runs once per isolate. Safe to call on every request: later calls await the
// first result. Never throws, so a failed check can never take the app down.
export function verifySchemaOnce(): Promise<SchemaReport> {
  cached ??= verifySchema()
    .then((result) => {
      report(result);
      return result;
    })
    .catch((err) => {
      console.error("[japlan.schema] check failed", err);
      return { status: "unavailable" as const, missing: [], tables: 0, ms: 0 };
    });
  return cached;
}

// Tests only.
export function resetSchemaCheckCache(): void {
  cached = null;
}
