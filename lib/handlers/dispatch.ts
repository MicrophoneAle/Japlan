import { getServiceClient } from "@/lib/db/client";
import { evaluateAddress } from "@/lib/game/addressing";
import { bootstrapGroupIfNeeded } from "@/lib/handlers/bootstrap";
import { handleSurveyDm } from "@/lib/handlers/survey";
import {
  chatIdFromData,
  isDirectChat,
  isFromMe,
  isGroupChat,
  senderFromData,
  textFromParts,
  type LinqEnvelope,
} from "@/lib/linq/payload";
import { markRead } from "@/lib/linq/send";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function markProcessed(eventId: string | undefined, tripId?: string) {
  if (!eventId) return;
  const patch: { processed_at: string; trip_id?: string } = {
    processed_at: new Date().toISOString(),
  };
  if (tripId) patch.trip_id = tripId;
  const { error } = await getServiceClient()
    .from("events")
    .update(patch)
    .eq("linq_event_id", eventId);
  if (error) {
    console.error("[japlan.dispatch] failed to mark processed", error);
  }
}

async function onMessageReceived(data: unknown): Promise<void> {
  if (!isRecord(data)) return;
  if (data.direction === "outbound") return;

  const chatId = chatIdFromData(data);
  if (!chatId) return;

  const isGroup = isGroupChat(data);
  if (isGroup) {
    await bootstrapGroupIfNeeded(chatId);
  }

  const text = textFromParts(data.parts);
  const isDm = isDirectChat(data);
  const decision = evaluateAddress({
    text,
    isDm,
    // TODO: nothing sets openTaskContext yet; open task-context tracking is later.
    openTaskContext: false,
  });

  if (!decision.respond) {
    console.debug("[japlan.address]", {
      respond: false,
      reason: decision.reason,
      chatId,
      textPreview: text.slice(0, 80),
    });
    return;
  }

  const phone = senderFromData(data)?.handle ?? null;
  const messageId = typeof data.id === "string" ? data.id : null;
  if (messageId) {
    try {
      await markRead(messageId);
    } catch (err) {
      console.error("[japlan.dispatch] markRead failed", err);
    }
  }

  if (isDm && phone) {
    await handleSurveyDm({ phone, chatId, text });
  }
  // TODO: group addressed messages have no handler in this milestone
  // (no claims, itinerary, or task generation).
}

export async function dispatchLinqEvent(envelope: LinqEnvelope): Promise<void> {
  try {
    if (isFromMe(envelope.data)) {
      console.debug("[japlan.dispatch] ignore is_me", {
        type: envelope.event_type,
        eventId: envelope.event_id,
      });
      await markProcessed(envelope.event_id);
      return;
    }

    if (envelope.event_type === "message.received") {
      await onMessageReceived(envelope.data);
    }
    await markProcessed(envelope.event_id);
  } catch (err) {
    console.error("[japlan.dispatch]", err);
  }
}
