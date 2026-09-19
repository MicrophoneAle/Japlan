import { getLinqClient } from "./client";

export type OutboundOp = "sendText" | "sendTyping" | "markRead" | "sendDM" | "react";

// The 6 standard iMessage tapbacks (Shared.ReactionType minus "custom"/"sticker").
export type Tapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export type OutboundLog = {
  at: string;
  op: OutboundOp;
  chatId?: string;
  messageId?: string;
  phone?: string;
  text?: string;
  typingOn?: boolean;
  ok: boolean;
};

export type SentText = {
  chatId: string;
  messageId: string;
};

function textParts(text: string) {
  return {
    parts: [{ type: "text" as const, value: text }],
  };
}

function fromNumber(): string {
  const from = process.env.LINQ_FROM_NUMBER;
  if (!from) throw new Error("missing LINQ_FROM_NUMBER");
  return from;
}

async function outbound<T>(
  entry: Omit<OutboundLog, "at" | "ok">,
  fn: () => Promise<T>,
): Promise<T> {
  const at = new Date().toISOString();
  try {
    const result = await fn();
    console.info("[linq.outbound]", JSON.stringify({ at, ...entry, ok: true }));
    return result;
  } catch (err) {
    console.info("[linq.outbound]", JSON.stringify({ at, ...entry, ok: false }));
    throw err;
  }
}

export async function sendText(
  chatId: string,
  text: string,
): Promise<SentText> {
  return outbound({ op: "sendText", chatId, text }, async () => {
    const res = await getLinqClient().chats.messages.send(chatId, {
      message: textParts(text),
    });
    return { chatId: res.chat_id, messageId: res.message.id };
  });
}

export async function sendTyping(chatId: string, on: boolean): Promise<void> {
  await outbound({ op: "sendTyping", chatId, typingOn: on }, async () => {
    const typing = getLinqClient().chats.typing;
    if (on) await typing.start(chatId);
    else await typing.stop(chatId);
  });
}

export async function markRead(messageId: string): Promise<void> {
  await outbound({ op: "markRead", messageId }, async () => {
    const message = await getLinqClient().messages.retrieve(messageId);
    // Linq only exposes chat-level read receipts (POST /v3/chats/{chatId}/read).
    await getLinqClient().chats.markAsRead(message.chat_id);
  });
}

export async function sendDM(phone: string, text: string): Promise<SentText> {
  return outbound({ op: "sendDM", phone, text }, async () => {
    const res = await getLinqClient().chats.create({
      from: fromNumber(),
      to: [phone],
      message: textParts(text),
    });
    return { chatId: res.chat.id, messageId: res.chat.message.id };
  });
}

// Tapback a message with a standard iMessage reaction (love/like/dislike/
// laugh/emphasize/question) or any custom emoji. Fire-and-forget by design:
// callers wrap this so a reaction never blocks or fails a text reply.
export async function react(
  messageId: string,
  reaction: Tapback | { emoji: string },
): Promise<void> {
  await outbound({ op: "react", messageId }, async () => {
    await getLinqClient().messages.addReaction(
      messageId,
      typeof reaction === "string"
        ? { operation: "add", type: reaction }
        : { operation: "add", type: "custom", custom_emoji: reaction.emoji },
    );
  });
}
