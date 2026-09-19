import { after } from "next/server";
import { getServiceClient } from "@/lib/db/client";
import { dispatchLinqEvent } from "@/lib/handlers/dispatch";
import { sweepStalledEvents } from "@/lib/handlers/event-sweep";
import { captureInboundWebhook } from "@/lib/linq/capture";
import { inspectLinqSignature } from "@/lib/linq/verify";

export const maxDuration = 60;

type LinqWebhookEnvelope = {
  event_id?: string;
  event_type?: string;
};

export async function POST(request: Request): Promise<Response> {
  console.log("[japlan.webhook] invoked", {
    method: request.method,
    headerNames: [...request.headers.keys()],
    bodyLength: request.headers.get("content-length"),
  });

  const rawBody = await request.text();

  try {
    await captureInboundWebhook(rawBody, request.headers);
  } catch (err) {
    console.error("webhook capture failed", err);
  }

  const signature = inspectLinqSignature(rawBody, request.headers);
  console.log("[japlan.webhook] signature", {
    ok: signature.ok,
    reason: signature.ok ? "pass" : signature.reason,
  });
  if (!signature.ok) {
    const secret = process.env.LINQ_WEBHOOK_SECRET;
    console.error("[japlan.webhook] signature rejected", {
      reason: signature.reason,
      secretSet: Boolean(secret),
      secretLength: secret?.length ?? 0,
      bodyLength: rawBody.length,
      hasWebhookId: Boolean(request.headers.get("webhook-id")),
      hasWebhookTimestamp: Boolean(request.headers.get("webhook-timestamp")),
      hasWebhookSignature: Boolean(request.headers.get("webhook-signature")),
    });
    return new Response(null, { status: 200 });
  }

  let envelope: LinqWebhookEnvelope & Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as LinqWebhookEnvelope &
      Record<string, unknown>;
  } catch {
    console.error("[japlan.webhook] invalid json", { bodyLength: rawBody.length });
    return new Response("invalid json", { status: 400 });
  }

  // Idempotency key is payload.event_id. webhook-id is a per-delivery id and
  // does not match event_id (confirmed 19/19 in .captures/events.ndjson).
  const linqEventId = envelope.event_id;
  const type = envelope.event_type;
  if (!linqEventId || !type) {
    console.error("[japlan.webhook] missing event_id or event_type", {
      hasEventId: Boolean(linqEventId),
      hasType: Boolean(type),
    });
    return new Response("missing event_id or event_type", { status: 400 });
  }

  const supabase = getServiceClient();
  const { error } = await supabase.from("events").insert({
    linq_event_id: linqEventId,
    type,
    payload: envelope,
  });

  if (error) {
    if (error.code === "23505") {
      console.log("[japlan.webhook] events insert", {
        result: "duplicate",
        code: "23505",
        eventId: linqEventId,
        type,
      });
      return new Response(null, { status: 200 });
    }
    console.error("[japlan.webhook] events insert", {
      result: "failed",
      code: error.code,
      message: error.message,
      eventId: linqEventId,
      type,
    });
    return new Response("persist failed", { status: 500 });
  }

  console.log("[japlan.webhook] events insert", {
    result: "inserted",
    eventId: linqEventId,
    type,
  });

  console.log("[japlan.webhook] dispatch queued", {
    eventId: linqEventId,
    type,
  });
  after(() => {
    console.log("[japlan.webhook] dispatch started", {
      eventId: linqEventId,
      type,
    });
    // Promise chain so a rejection cannot escape after() as unhandled
    // (Vercel can kill the isolate without running an async-fn finally).
    return Promise.resolve()
      .then(() => dispatchLinqEvent(envelope))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("[japlan.webhook] dispatch escaped", {
          eventId: linqEventId,
          type,
          name: error.name,
          message: error.message,
          stack: error.stack ?? null,
        });
      })
      .finally(() => {
        console.log("[japlan.webhook] dispatch finished", {
          eventId: linqEventId,
          type,
        });
      })
      // After this event is handled: re-dispatch any recent message whose
      // dispatch never finished, and log older ones as dropped. At most once
      // a minute per instance.
      .then(() => sweepStalledEvents())
      .catch((err: unknown) => console.error("[japlan.webhook] sweep failed", err));
  });

  return new Response(null, { status: 200 });
}
