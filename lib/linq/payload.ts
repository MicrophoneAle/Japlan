// Field names confirmed from .captures/events.ndjson plus @linqapp/sdk
// webhook_version 2026-02-03. participant.added and chat.created do not fire
// when the bot is added to an iMessage group.

export type LinqEnvelope = {
  event_id?: string;
  event_type?: string;
  data?: unknown;
};

export type HandleLike = {
  handle: string;
  is_me?: boolean | null;
};

export type MediaPart = {
  type: "media";
  mime: string;
  url: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function botHandle(): string {
  const from = process.env.LINQ_FROM_NUMBER;
  if (!from) throw new Error("missing LINQ_FROM_NUMBER");
  return from;
}

export function sameHandle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isBotHandle(handle: string): boolean {
  return sameHandle(handle, botHandle());
}

export function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.value === "string") {
      chunks.push(part.value);
    }
  }
  return chunks.join("\n").trim();
}

export function mediaFromParts(parts: unknown): MediaPart[] {
  if (!Array.isArray(parts)) return [];
  const out: MediaPart[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type !== "media") continue;
    const mime =
      (typeof part.mime === "string" && part.mime) ||
      (typeof part.mime_type === "string" && part.mime_type) ||
      "";
    const url = typeof part.url === "string" ? part.url : "";
    if (!url) continue;
    out.push({ type: "media", mime, url });
  }
  return out;
}

export function handleFromUnknown(value: unknown): HandleLike | null {
  if (!isRecord(value)) return null;
  if (typeof value.handle !== "string" || value.handle.length === 0) return null;
  return {
    handle: value.handle,
    is_me: value.is_me === true ? true : value.is_me === false ? false : null,
  };
}

export function senderFromData(data: unknown): HandleLike | null {
  if (!isRecord(data)) return null;
  return handleFromUnknown(data.sender_handle);
}

export function isFromMe(data: unknown): boolean {
  return senderFromData(data)?.is_me === true;
}

export function handlesFromUnknown(value: unknown): HandleLike[] {
  if (!Array.isArray(value)) return [];
  const out: HandleLike[] = [];
  for (const item of value) {
    const handle = handleFromUnknown(item);
    if (handle) out.push(handle);
  }
  return out;
}

export function humansFromHandles(handles: HandleLike[]): HandleLike[] {
  return handles.filter(
    (handle) => handle.is_me !== true && !isBotHandle(handle.handle),
  );
}

// Captures show the chat id as both data.chat_id and data.chat.id.
export function chatIdFromData(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const nested =
    isRecord(data.chat) && typeof data.chat.id === "string" && data.chat.id
      ? data.chat.id
      : null;
  const flat =
    typeof data.chat_id === "string" && data.chat_id ? data.chat_id : null;
  return nested ?? flat;
}

export function isGroupChat(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return isRecord(data.chat) && data.chat.is_group === true;
}

export function isDirectChat(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return isRecord(data.chat) && data.chat.is_group === false;
}
