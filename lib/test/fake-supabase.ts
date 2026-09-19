// Test-only in-memory stand-in for the Supabase service client. Supports the
// query-builder surface the handlers use, and enforces the unique constraints
// from lib/db/schema.sql so conflict paths behave like production.

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { code: string; message: string } | null };

let idCounter = 0;
function newId(table: string): string {
  idCounter += 1;
  return `${table}-${idCounter}`;
}

const DEFAULTS: Record<string, () => Row> = {
  trips: () => ({ is_solo: false, daily_points_cap: 120, intro_sent_at: null }),
  participants: () => ({ score: 0, sidequests_muted: false, survey_json: null, survey_state: null }),
  claims: () => ({ capped: false, primary_claim: true, photo_claimed_at: null, expires_at: null }),
  tasks: () => ({ source: "generated", expires_at: null }),
  sidequests: () => ({ status: "open", won_by: null, won_at: null, photo_bonus_max: 0 }),
  sidequest_offers: () => ({ photo_bonus: 0, awarded_points: null, resolved_at: null }),
  boards: () => ({ status: "generating", provisional: false, requested_by: null, delivered_at: null, updated_at: new Date().toISOString() }),
};

const STAT_COUNTERS = [
  "itinerary_items_total",
  "tasks_completed",
  "photos_submitted",
  "photo_bonuses_earned",
  "sidequests_claimed",
  "freeform_claims",
  "distance_km",
];

function key(row: Row, cols: string[]): string {
  return JSON.stringify(cols.map((c) => row[c] ?? null));
}

// [table, columns, optional partial-index predicate]
const UNIQUE: [string, string[], ((row: Row) => boolean)?][] = [
  ["events", ["linq_event_id"]],
  ["participants", ["trip_id", "phone"]],
  ["claims", ["task_id", "participant_id"]],
  [
    "claims",
    ["task_id"],
    (row) =>
      row.primary_claim === true &&
      (row.status === "awarded" || row.status === "pending_peer"),
  ],
  ["tasks", ["trip_id", "day", "participant_id", "team_id", "code"]],
  ["trips", ["linq_chat_id"], (row) => row.state !== "complete"],
  ["boards", ["trip_id", "day"]],
  ["sidequest_offers", ["participant_id"], (row) => row.status === "live"],
  ["sidequest_offers", ["participant_id"], (row) => row.status === "queued"],
  ["sidequest_offers", ["sidequest_id"], (row) => row.status === "won"],
];

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  rpcCalls: { name: string; args: Row }[] = [];

  table(name: string): Row[] {
    this.tables[name] ??= [];
    return this.tables[name];
  }

  seed(name: string, rows: Row[]): void {
    for (const row of rows) this.table(name).push(this.withDefaults(name, row));
  }

  withDefaults(name: string, row: Row): Row {
    return {
      id: newId(name),
      created_at: new Date().toISOString(),
      ...(DEFAULTS[name]?.() ?? {}),
      ...row,
    };
  }

  violation(name: string, candidate: Row, ignoreId?: unknown): boolean {
    for (const [table, cols, where] of UNIQUE) {
      if (table !== name) continue;
      if (where && !where(candidate)) continue;
      const k = key(candidate, cols);
      const clash = this.table(name).some(
        (row) =>
          row.id !== ignoreId && (!where || where(row)) && key(row, cols) === k,
      );
      if (clash) return true;
    }
    return false;
  }

  from(name: string): Query {
    return new Query(this, name);
  }

  async rpc(name: string, args: Row): Promise<Result> {
    this.rpcCalls.push({ name, args });
    if (name === "increment_participant_score") {
      const row = this.table("participants").find((p) => p.id === args.p_participant_id);
      if (!row) return { data: null, error: null };
      row.score = Number(row.score ?? 0) + Number(args.p_delta);
      return { data: row.score, error: null };
    }
    if (name === "bump_participant_stats") {
      // Mirrors the SQL function: create the row at zero, add the deltas
      // (never below zero), add the day and place to their sets, and derive
      // the two distinct counts from them. Synchronous, so atomic here.
      const rows = this.table("participant_stats");
      let row = rows.find((r) => r.trip_id === args.p_trip_id && r.participant_id === args.p_participant_id);
      if (!row) {
        row = {
          trip_id: args.p_trip_id,
          participant_id: args.p_participant_id,
          ...Object.fromEntries(STAT_COUNTERS.map((k) => [k, 0])),
          activity_days: [],
          place_keys: [],
        };
        rows.push(row);
      }
      const deltas = (args.p_deltas ?? {}) as Record<string, number>;
      for (const k of STAT_COUNTERS) row[k] = Math.max(0, Number(row[k] ?? 0) + Number(deltas[k] ?? 0));
      const days = row.activity_days as number[];
      const places = row.place_keys as string[];
      if (args.p_day !== null && args.p_day !== undefined && !days.includes(args.p_day as number)) days.push(args.p_day as number);
      if (args.p_place && !places.includes(args.p_place as string)) places.push(args.p_place as string);
      row.days_with_activity = days.length;
      row.places_visited = places.length;
      return { data: { ...row }, error: null };
    }
    return { data: null, error: { code: "PGRST202", message: `no function ${name}` } };
  }
}

class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private returning = false;
  private singleMode: "maybe" | "one" | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private conflictCols: string[] = [];
  private ignoreDuplicates = false;

  constructor(
    private db: FakeSupabase,
    private name: string,
  ) {}

  select(): this {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.conflictCols = (opts.onConflict ?? "id").split(",").map((c) => c.trim());
    this.ignoreDuplicates = Boolean(opts.ignoreDuplicates);
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push((row) => row[col] === value);
    return this;
  }
  neq(col: string, value: unknown): this {
    this.filters.push((row) => row[col] !== value);
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[col]));
    return this;
  }
  is(col: string, value: null): this {
    this.filters.push((row) => (row[col] ?? null) === value);
    return this;
  }
  not(col: string, op: string, value: unknown): this {
    if (op !== "is") throw new Error(`fake supabase: not(${op}) unsupported`);
    this.filters.push((row) => (row[col] ?? null) !== value);
    return this;
  }
  lt(col: string, v: unknown): this {
    this.filters.push((row) => (compare(row[col], v) ?? 0) < 0 && row[col] != null);
    return this;
  }
  lte(col: string, v: unknown): this {
    this.filters.push((row) => row[col] != null && (compare(row[col], v) ?? 1) <= 0);
    return this;
  }
  gt(col: string, v: unknown): this {
    this.filters.push((row) => row[col] != null && (compare(row[col], v) ?? -1) > 0);
    return this;
  }
  gte(col: string, v: unknown): this {
    this.filters.push((row) => row[col] != null && (compare(row[col], v) ?? -1) >= 0);
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.orderBy = { col, asc: opts.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  maybeSingle(): this {
    this.singleMode = "maybe";
    return this;
  }
  single(): this {
    this.singleMode = "one";
    return this;
  }

  then<A = Result, B = never>(
    onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private matching(): Row[] {
    let rows = this.db.table(this.name).filter((row) => this.filters.every((f) => f(row)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => (compare(a[col], b[col]) ?? 0) * (asc ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return rows;
  }

  private conflict(): Result {
    return { data: null, error: { code: "23505", message: "duplicate key value" } };
  }

  private shape(rows: Row[]): Result {
    const copies = rows.map((row) => ({ ...row }));
    if (this.singleMode) {
      if (copies.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      }
      return { data: copies[0] ?? null, error: null };
    }
    return { data: copies, error: null };
  }

  private run(): Result {
    const table = this.db.table(this.name);
    if (this.op === "select") return this.shape(this.matching());

    if (this.op === "insert") {
      const created: Row[] = [];
      for (const raw of this.payload) {
        const row = this.db.withDefaults(this.name, raw);
        if (this.db.violation(this.name, row)) return this.conflict();
        table.push(row);
        created.push(row);
      }
      return this.returning ? this.shape(created) : { data: null, error: null };
    }

    if (this.op === "upsert") {
      const touched: Row[] = [];
      for (const raw of this.payload) {
        const k = key(raw, this.conflictCols);
        const existing = table.find((row) => key(row, this.conflictCols) === k);
        if (existing) {
          if (!this.ignoreDuplicates) Object.assign(existing, raw);
          touched.push(existing);
        } else {
          const row = this.db.withDefaults(this.name, raw);
          table.push(row);
          touched.push(row);
        }
      }
      return this.returning ? this.shape(touched) : { data: null, error: null };
    }

    const targets = this.matching();
    if (this.op === "update") {
      for (const row of targets) {
        const next = { ...row, ...this.patch };
        if (this.db.violation(this.name, next, row.id)) return this.conflict();
      }
      for (const row of targets) Object.assign(row, this.patch);
      return this.returning ? this.shape(targets) : { data: null, error: null };
    }

    // delete
    this.db.tables[this.name] = table.filter((row) => !targets.includes(row));
    return this.returning ? this.shape(targets) : { data: null, error: null };
  }
}
