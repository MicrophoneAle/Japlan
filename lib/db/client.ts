import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Every Supabase call is timed, by construction rather than per call site.
//
// The long-running bug: the SECOND call in an isolate hangs while the first
// succeeds, and an unbounded await inside after() kills the invocation with no
// error, no finally and no log. It has cost hours four times. Timeouts were
// added at some call sites and missed at others, which is how loadTripLegs
// shipped without one and took every message down with it.
//
// So the timeout lives here: getServiceClient() hands back a client whose
// query builders cannot await forever, whoever calls them. A hang becomes a
// loud, attributable error; an error is debuggable, a dead isolate is not.
const DB_TIMEOUT_MS = 8_000;

// Two suspects for the hang itself, neither yet confirmed in production:
//
//  1. Next patches global fetch for its cache/dedup layer, and supabase-js
//     uses global fetch. `serverExternalPackages` in next.config.ts exempts
//     sharp and stagehand but NOT @supabase/supabase-js, so every query goes
//     through the patched fetch. Inside after() the request context is
//     already torn down, which is exactly where a cache-aware fetch can wait
//     on something that will never arrive.
//  2. Connection reuse in the undici pool across an isolate that Vercel has
//     frozen and thawed between the first and second call.
//
// This addresses (1): an explicit fetch that opts out of Next's caching, so a
// query is a plain network call with no request-scoped machinery behind it.
// If the hang survives this, (2) is next and the timeout keeps it survivable
// either way. Every timeout logs, so the rate is measurable rather than felt.
function uncachedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, cache: "no-store" });
}

let client: SupabaseClient | undefined;

function dbStep(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.db] step", { step, ...fields });
}

// A PostgREST builder is a thenable: awaiting it runs the query. Racing its
// `then` is what bounds the query, and every other method is passed through
// so the builder chain (.select().eq().order()) keeps working untouched.
function timed<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);

      if (prop === "then" && typeof value === "function") {
        const runner = value as (
          onOk?: (v: unknown) => unknown,
          onErr?: (e: unknown) => unknown,
        ) => unknown;
        return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const started = Date.now();
          const query = new Promise((resolve, reject) => {
            runner.call(obj, resolve, reject);
          });
          const bounded = Promise.race([
            query,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                // The one line that turns an invisible hang into a fact.
                dbStep("timeout", { label, ms: DB_TIMEOUT_MS });
                reject(new Error(`supabase ${label} timed out after ${DB_TIMEOUT_MS}ms`));
              }, DB_TIMEOUT_MS);
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
            const ms = Date.now() - started;
            // Slow enough to be the hang warming up.
            if (ms > 2_000) dbStep("slow", { label, ms });
          });
          return bounded.then(onOk, onErr);
        };
      }

      if (typeof value === "function") {
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const out = fn.apply(obj, args);
          // Builder methods return builders; wrap them so the timeout
          // survives the whole chain. Anything else passes through.
          return out !== null && typeof out === "object" ? timed(out as object, label) : out;
        };
      }
      return value;
    },
  });
}

export function getServiceClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const raw = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: uncachedFetch },
  });

  // from() is where every query starts, so that is where the timeout is
  // attached. rpc() too: bump_participant_stats goes through it.
  client = new Proxy(raw, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if ((prop === "from" || prop === "rpc") && typeof value === "function") {
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const label = `${String(prop)}:${String(args[0] ?? "?")}`;
          const out = fn.apply(obj, args);
          return out !== null && typeof out === "object" ? timed(out as object, label) : out;
        };
      }
      return value;
    },
  }) as SupabaseClient;
  return client;
}

// Tests build their own client; this lets one reset the singleton.
export function resetServiceClientForTests(): void {
  client = undefined;
}
