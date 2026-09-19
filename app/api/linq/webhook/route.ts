import { after } from "next/server";
import { getServiceClient } from "@/lib/db/client";
import { verifyLinqSignature } from "@/lib/linq/verify";

type LinqWebhookEnvelope = {
  event_id?: string;
  event_type?: string;
};

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  if (!verifyLinqSignature(rawBody, request.headers)) {
    return new Response("unauthorized", { status: 401 });
  }

  let envelope: LinqWebhookEnvelope & Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as LinqWebhookEnvelope &
      Record<string, unknown>;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // TODO: confirm whether events.linq_event_id should be payload.event_id or the webhook-id header when they differ.
  const linqEventId = envelope.event_id ?? request.headers.get("webhook-id");
  const type = envelope.event_type;
  if (!linqEventId || !type) {
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
      return new Response(null, { status: 200 });
    }
    return new Response("persist failed", { status: 500 });
  }

  after(() => dispatchLinqEvent(envelope));

  return new Response(null, { status: 200 });
}

async function dispatchLinqEvent(
  envelope: LinqWebhookEnvelope,
): Promise<void> {
  void envelope;
  throw new Error("not implemented");
}
