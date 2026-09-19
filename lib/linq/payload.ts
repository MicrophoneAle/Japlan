// Field names are from @linqapp/sdk webhook types (webhook_version 2026-02-03).
// TODO: no .captures/events.ndjson report exists yet; re-check these paths
// against scripts/inspect-captures.ts once real events are on disk.

export type LinqEnvelope = {
  event_id?: string;
  event_type?: string;
  data?: unknown;
};

export type HandleLike = {
  handle: string;
  is_me?: boolean | null;
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

export function handleFromUnknown(value: unknown): HandleLike | null {
  if (!isRecord(value)) return null;
  if (typeof value.handle !== "string" || value.handle.length === 0) return null;
  return {
    handle: value.handle,
    is_me: value.is_me === true ? true : value.is_me === false ? false : null,
  };
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
  return handles.filter((handle) => handle.is_me !== true && !isBotHandle(handle.handle));
}
