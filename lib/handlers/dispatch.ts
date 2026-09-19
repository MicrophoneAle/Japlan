import { getServiceClient } from "@/lib/db/client";
import { evaluateAddress } from "@/lib/game/addressing";
import {
  onChatCreated,
  onParticipantAdded,
} from "@/lib/handlers/bootstrap";
import { handleSurveyDm } from "@/lib/handlers/survey";
import {
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

function senderPhone(data: Record<string, unknown>): string | null {
  const sender = data.sender_handle;
  if (!isRecord(sender) || typeof sender.handle !== "string") return null;
  return sender.handle;
}

function chatMeta(data: Record<string, unknown>): {
  chatId: string | null;
  isGroup: boolean | null;
} {
  const chat = data.chat;
  if (!isRecord(chat) || typeof chat.id !== "string") {
    return { chatId: null, isGroup: null };
  }
  const isGroup =
    chat.is_group === true ? true : chat.is_group === false ? false : null;
  return { chatId: chat.id, isGroup };
}

async function onMessageReceived(data: unknown): Promise<void> {
  if (!isRecord(data)) return;
  if (data.direction === "outbound") return;

  const { chatId, isGroup } = chatMeta(data);
  if (!chatId) return;

  const text = textFromParts(data.parts);
  const isDm = isGroup === false;
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

  const phone = senderPhone(data);
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
    const type = envelope.event_type;
    if (type === "message.received") {
      await onMessageReceived(envelope.data);
    } else if (type === "chat.created") {
      await onChatCreated(envelope.data);
    } else if (type === "participant.added") {
      await onParticipantAdded(envelope.data);
    }
    await markProcessed(envelope.event_id);
  } catch (err) {
    console.error("[japlan.dispatch]", err);
  }
}
