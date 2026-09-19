import { recordMessage } from "@/lib/chat/transcript";
import { getLinqClient } from "./client";

export type OutboundOp = "sendText" | "sendTyping" | "markRead" | "sendDM" | "react";

// The 6 standard iMessage tapbacks (Shared.ReactionType minus "custom"/"sticker").
export type Tapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

// iMessage effects Linq's MessageContent.effect exposes. Screen effects
// animate the whole screen; bubble effects animate only the message bubble.
// Two different things in iMessage, and Linq exposes both under one field.
export const SCREEN_EFFECTS = [
  "confetti",
  "fireworks",
  "lasers",
  "sparkles",
  "celebration",
  "hearts",
  "love",
  "balloons",
  "happy_birthday",
  "echo",
  "spotlight",
] as const;
export const BUBBLE_EFFECTS = ["slam", "loud", "gentle", "invisible"] as const;
export type ScreenEffectName = (typeof SCREEN_EFFECTS)[number];
export type BubbleEffectName = (typeof BUBBLE_EFFECTS)[number];
export type MessageEffect =
  | { type: "screen"; name: ScreenEffectName }
  | { type: "bubble"; name: BubbleEffectName };

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
  opts?: { effect?: MessageEffect },
): Promise<SentText> {
  const attempt = (effect?: MessageEffect) =>
    outbound({ op: "sendText", chatId, text }, async () => {
      const res = await getLinqClient().chats.messages.send(chatId, {
        message: { ...textParts(text), ...(effect ? { effect } : {}) },
      });
      return { chatId: res.chat_id, messageId: res.message.id };
    });
  // An effect rides along with the message in one request: there is no
  // separate call to fail independently. If the effect-carrying send throws,
  // retry once, plain, so a decoration never costs the confirmation itself.
  let sent: SentText;
  if (opts?.effect) {
    try {
      sent = await attempt(opts.effect);
    } catch (err) {
      console.error("[linq.outbound] effect failed, retrying without", {
        chatId,
        effect: opts.effect,
        err: err instanceof Error ? err.message : String(err),
      });
      sent = await attempt(undefined);
    }
  } else {
    sent = await attempt(undefined);
  }
  // The transcript is what the next conversational call reads; the bot's own
  // replies belong in it. Not game logic, just the record.
  await recordMessage({ chatId: sent.chatId, role: "bot", text });
  return sent;
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
  const sent = await outbound({ op: "sendDM", phone, text }, async () => {
    const res = await getLinqClient().chats.create({
      from: fromNumber(),
      to: [phone],
      message: textParts(text),
    });
    return { chatId: res.chat.id, messageId: res.chat.message.id };
  });
  await recordMessage({ chatId: sent.chatId, role: "bot", text });
  return sent;
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
