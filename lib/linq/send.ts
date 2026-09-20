import { recordMessage } from "@/lib/chat/transcript";
import { getLinqClient } from "./client";

export type OutboundOp = "sendText" | "sendTyping" | "markRead" | "sendDM" | "react" | "shareContactCard";

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

// Simulated typing time before a text goes out, so replies land like someone
// actually typed them instead of arriving the instant the model finishes. A
// short line lands around 2.5s; jitter keeps two replies of the same length
// from always taking the exact same beat. Ceiling capped at 5s (2026-10-02)
// so even a long reply never feels like it's stalling.
const TYPING_BASE_MS = 1250;
const TYPING_MS_PER_CHAR = 24;
const TYPING_MIN_MS = 1000;
const TYPING_MAX_MS = 5000;

function typingDelayMs(text: string): number {
  const raw = TYPING_BASE_MS + text.length * TYPING_MS_PER_CHAR;
  const jittered = raw * (0.85 + Math.random() * 0.3);
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, Math.round(jittered)));
}

function sleep(ms: number): Promise<void> {
  // Vitest sets this; real wall-clock waits have no place slowing down a
  // unit test suite, so the simulated delay is skipped there.
  if (process.env.VITEST) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shows the typing bubble for the simulated duration. Best-effort: a failed
// typing indicator should never hold up the actual reply.
async function typeBeforeSending(chatId: string, text: string): Promise<void> {
  const delay = typingDelayMs(text);
  try {
    await sendTyping(chatId, true);
  } catch (err) {
    console.error("[linq.outbound] typing indicator failed", { chatId, err });
  }
  await sleep(delay);
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
  opts?: { effect?: MessageEffect; mediaUrl?: string },
): Promise<SentText> {
  await typeBeforeSending(chatId, text);
  const attempt = (effect?: MessageEffect, mediaUrl?: string) =>
    outbound({ op: "sendText", chatId, text }, async () => {
      const res = await getLinqClient().chats.messages.send(chatId, {
        message: {
          parts: [
            { type: "text", value: text },
            ...(mediaUrl ? [{ type: "media" as const, url: mediaUrl, sticker: true }] : []),
          ],
          ...(effect ? { effect } : {}),
        },
      });
      return { chatId: res.chat_id, messageId: res.message.id };
    });
  // An effect rides along with the message in one request: there is no
  // separate call to fail independently. If the effect-carrying send throws,
  // retry once, plain, so a decoration never costs the confirmation itself.
  let sent: SentText;
  if (opts?.mediaUrl) {
    try {
      sent = await attempt(opts.effect, opts.mediaUrl);
    } catch (err) {
      console.error("[linq.outbound] media send failed, retrying without media", {
        chatId,
        err: err instanceof Error ? err.message : String(err),
      });
      // If Linq rejected the combination of media and an iMessage effect,
      // preserve the GIF and drop only the optional effect.
      try {
        sent = await attempt(undefined, opts.mediaUrl);
      } catch (mediaErr) {
        console.error("[linq.outbound] media-only send failed, retrying with text", {
          chatId,
          err: mediaErr instanceof Error ? mediaErr.message : String(mediaErr),
        });
        if (!opts.effect) throw mediaErr;
        try {
          sent = await attempt(opts.effect);
        } catch (effectErr) {
          console.error("[linq.outbound] effect failed, retrying without", {
            chatId,
            effect: opts.effect,
            err: effectErr instanceof Error ? effectErr.message : String(effectErr),
          });
          sent = await attempt(undefined);
        }
      }
    }
  } else if (opts?.effect) {
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
  // No chat exists yet to show a typing bubble in, so just hold for the same
  // simulated duration before the DM (and its first message) goes out.
  await sleep(typingDelayMs(text));
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

// Push the Name & Photo registered for LINQ_FROM_NUMBER (one-time setup:
// scripts/setup-contact-card.ts) into a chat, so it shows "Japlan" and the
// logo instead of a bare number. Fire-and-forget by design, same reasoning as
// react(): a share failing must never block or fail the message it rides
// along after, so callers do not need their own try/catch.
export async function shareContactCardSafely(chatId: string): Promise<void> {
  try {
    await outbound({ op: "shareContactCard", chatId }, () =>
      getLinqClient().chats.shareContactCard(chatId),
    );
  } catch (err) {
    console.error("[linq.outbound] shareContactCard failed", {
      chatId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
