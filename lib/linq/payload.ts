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
  display_name?: string | null;
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

// No capture has shown a real media part yet, so the declared type is not
// trusted to be image/*: iMessage HEIC can arrive as public.heic, an
// octet-stream, or with no type at all. Only clearly non-image types are
// dropped; the bytes are sniffed after the fetch.
const NON_IMAGE_MIME = /^(video|audio|text)\/|^application\/(pdf|zip|json)|vcard|pkpass/i;

export function isLikelyImageMime(mime: string): boolean {
  if (!mime) return true;
  return !NON_IMAGE_MIME.test(mime);
}

export function photoPartsFrom(parts: unknown): MediaPart[] {
  return mediaFromParts(parts).filter((part) => isLikelyImageMime(part.mime));
}

// Keys and types only (no URLs), for confirming the live media shape.
export function describeNonTextParts(parts: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part) => isRecord(part) && part.type !== "text")
    .map((part) => {
      const record = part as Record<string, unknown>;
      return {
        type: record.type ?? null,
        keys: Object.keys(record),
        mime: record.mime ?? record.mime_type ?? null,
        hasUrl: typeof record.url === "string",
      };
    });
}

export function looksLikePhone(value: string): boolean {
  return /^\+?\d[\d\s().-]{6,}$/.test(value.trim());
}

export function displayNameFromHandleObject(
  value: Record<string, unknown>,
): string | null {
  const keys = [
    "display_name",
    "displayName",
    "nickname",
    "first_name",
    "given_name",
    "name",
  ];
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim() && !looksLikePhone(raw)) {
      return raw.trim();
    }
  }
  if (isRecord(value.contact)) {
    return displayNameFromHandleObject(value.contact);
  }
  return null;
}

export function handleFromUnknown(value: unknown): HandleLike | null {
  if (!isRecord(value)) return null;
  if (typeof value.handle !== "string" || value.handle.length === 0) return null;
  return {
    handle: value.handle,
    is_me: value.is_me === true ? true : value.is_me === false ? false : null,
    display_name: displayNameFromHandleObject(value),
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

function coerceMember(value: unknown): HandleLike | null {
  if (typeof value === "string" && value.trim()) {
    return { handle: value.trim(), is_me: null };
  }
  const fromHandle = handleFromUnknown(value);
  if (fromHandle) return fromHandle;
  if (!isRecord(value)) return null;
  if (typeof value.phone === "string" && value.phone.trim()) {
    return {
      handle: value.phone.trim(),
      is_me: value.is_me === true ? true : value.is_me === false ? false : null,
      display_name: displayNameFromHandleObject(value),
    };
  }
  return null;
}

export type ChatMemberParse = {
  parsed: HandleLike[];
  sourcePath: string | null;
  candidatePaths: string[];
};

// Walk the raw GET /v3/chats/{id} JSON. `handles` is an SDK guess; captures
// never showed this resource, so we record every array we find.
export function membersFromChatJson(raw: unknown): ChatMemberParse {
  const candidatePaths: string[] = [];
  const found: { path: string; items: HandleLike[] }[] = [];

  function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      const items: HandleLike[] = [];
      for (const item of value) {
        const member = coerceMember(item);
        if (member) items.push(member);
      }
      candidatePaths.push(
        `${path || "(root)"} len=${value.length} parsed=${items.length}`,
      );
      if (items.length > 0) found.push({ path: path || "(root)", items });
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  }

  walk(raw, "");
  const preferred =
    found.find((entry) => entry.path === "handles" || entry.path.endsWith(".handles")) ??
    found.sort((a, b) => b.items.length - a.items.length)[0];
  return {
    parsed: preferred?.items ?? [],
    sourcePath: preferred?.path ?? null,
    candidatePaths,
  };
}

export function displayNameFromChatJson(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.display_name === "string" && raw.display_name.trim()) {
    return raw.display_name;
  }
  if (isRecord(raw.data) && typeof raw.data.display_name === "string") {
    return raw.data.display_name;
  }
  if (isRecord(raw.chat) && typeof raw.chat.display_name === "string") {
    return raw.chat.display_name;
  }
  return null;
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
