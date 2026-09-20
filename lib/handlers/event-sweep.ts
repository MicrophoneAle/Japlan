import { getServiceClient } from "@/lib/db/client";
import { dispatchLinqEvent } from "./dispatch";

// Retryable webhook events whose dispatch never finished (the isolate was
// killed: a deploy, a timeout, or a provider/database outage) sit in events
// with no processed_at. Now:
//  - 2 to 30 minutes old: dispatched again, once.
//  - older: logged as dropped, once. A reply hours late is worse than none,
//    but the drop is visible in the logs.
// retried_at marks either outcome and is claimed atomically, so two sweeps
// never handle the same event. Needs migration 2026-09-28 (retried_at);
// before it runs the sweep logs and does nothing.

export const RETRY_AFTER_MS = 2 * 60 * 1000;
export const RETRY_WITHIN_MS = 30 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweepAt = 0;
const RETRYABLE_EVENT_TYPES = [
  "message.received",
  "poll.vote.added",
  "poll.vote.removed",
  "location.sharing.started",
  "location.sharing.stopped",
];

type Stalled = { id: string; linq_event_id: string; created_at: string; payload: Record<string, unknown> };

export async function sweepStalledEvents(opts: { now?: number; force?: boolean } = {}): Promise<{ retried: number; dropped: number }> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastSweepAt < SWEEP_EVERY_MS) return { retried: 0, dropped: 0 };
  lastSweepAt = now;
  const { data, error } = await getServiceClient()
    .from("events")
    .select("id, linq_event_id, created_at, payload")
    .in("type", RETRYABLE_EVENT_TYPES)
    .is("processed_at", null)
    .is("retried_at", null)
    .lt("created_at", new Date(now - RETRY_AFTER_MS).toISOString())
    .order("created_at")
    .limit(10);
  if (error) {
    console.error("[japlan.webhook] sweep skipped (migration 2026-09-28 applied?)", { code: error.code });
    return { retried: 0, dropped: 0 };
  }
  let retried = 0;
  let dropped = 0;
  for (const row of (data ?? []) as Stalled[]) {
    const claimed = await getServiceClient()
      .from("events")
      .update({ retried_at: new Date(now).toISOString() })
      .eq("id", row.id)
      .is("retried_at", null)
      .select("id");
    if (claimed.error || !claimed.data?.length) continue;
    const ageMs = now - Date.parse(row.created_at);
    const data = (row.payload?.data ?? {}) as { chat_id?: string };
    if (ageMs <= RETRY_WITHIN_MS) {
      console.warn("[japlan.webhook] retry", { eventId: row.linq_event_id, ageSeconds: Math.round(ageMs / 1000) });
      retried += 1;
      try {
        await dispatchLinqEvent(row.payload as Parameters<typeof dispatchLinqEvent>[0]);
      } catch (err) {
        console.error("[japlan.webhook] retry failed", { eventId: row.linq_event_id, err });
      }
    } else {
      console.warn("[japlan.webhook] dropped", {
        eventId: row.linq_event_id,
        ageMinutes: Math.round(ageMs / 60000),
        chatId: data.chat_id ?? null,
      });
      dropped += 1;
    }
  }
  return { retried, dropped };
}
