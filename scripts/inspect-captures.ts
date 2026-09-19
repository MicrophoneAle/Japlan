import { readFileSync } from "node:fs";
import { capturePath } from "../lib/linq/capture";

type CaptureRecord = {
  received_at?: string;
  headers?: Record<string, string>;
  body?: string;
};

type PathStat = {
  path: string;
  count: number;
  samples: string[];
};

function loadRecords(filePath: string): CaptureRecord[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const records: CaptureRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CaptureRecord);
    } catch (err) {
      console.error(`Skipping malformed ndjson line ${index + 1}: ${String(err)}`);
    }
  }
  return records;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) return value;
  }
  return undefined;
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined || body === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function walk(
  value: unknown,
  path: string,
  visit: (path: string, node: unknown) => void,
): void {
  visit(path, value);
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, visit));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, visit);
    }
  }
}

function summarize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return `url ${truncate(value, 80)}`;
    }
    if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 80) {
      return `base64-looking string, length ${value.length}`;
    }
    if (value.startsWith("+") && /^\+[0-9]{6,15}$/.test(value)) {
      return `E.164 ${value}`;
    }
    if (value.includes("@") && !value.includes(" ")) {
      return `email ${value}`;
    }
    return JSON.stringify(truncate(value, 80));
  }
  if (typeof value !== "object") return `${typeof value} ${String(value)}`;
  if (Array.isArray(value)) return `array(len=${value.length})`;
  const keys = Object.keys(value as object);
  return `object{${keys.join(", ")}}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function addSample(stat: PathStat, sample: string): void {
  if (stat.samples.length < 3 && !stat.samples.includes(sample)) {
    stat.samples.push(sample);
  }
}

function collectPathStats(
  payloads: unknown[],
  match: (path: string, node: unknown) => boolean,
): PathStat[] {
  const byPath = new Map<string, PathStat>();
  for (const payload of payloads) {
    const seen = new Set<string>();
    walk(payload, "", (path, node) => {
      if (!path || seen.has(path) || !match(path, node)) return;
      seen.add(path);
      const stat = byPath.get(path) ?? { path, count: 0, samples: [] };
      stat.count += 1;
      addSample(stat, summarize(node));
      byPath.set(path, stat);
    });
  }
  return [...byPath.values()].sort((a, b) => b.count - a.count);
}

function printStats(stats: PathStat[], empty: string): void {
  if (stats.length === 0) {
    console.log(`  ${empty}`);
    return;
  }
  for (const stat of stats) {
    console.log(`  ${stat.path}  (${stat.count} records)`);
    for (const sample of stat.samples) {
      console.log(`    e.g. ${sample}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function main(): void {
  const filePath = capturePath();
  const records = loadRecords(filePath);
  console.log(`Linq capture report`);
  console.log(`File: ${filePath}`);
  console.log(`Records: ${records.length}`);
  console.log("");

  if (records.length === 0) {
    console.log("No captures yet. Point Linq at /api/linq/webhook while `next dev` is running, send traffic, then re-run this script.");
    return;
  }

  const payloads = records.map((record) => parseBody(record.body));
  const parsedCount = payloads.filter((payload) => payload !== undefined).length;
  const unparsed = records.length - parsedCount;
  if (unparsed > 0) {
    console.log(`${unparsed} record(s) had a body that was not JSON.`);
    console.log("");
  }

  console.log("1. Sender handle");
  const senderStats = collectPathStats(payloads, (path) => {
    const leaf = path.split(".").pop() ?? "";
    return (
      /sender_handle$/.test(path) ||
      (leaf === "handle" && /sender/.test(path)) ||
      leaf === "sender" ||
      leaf === "from"
    );
  });
  printStats(senderStats, "No sender/handle field found. Capture more events or inspect a raw line in the ndjson.");
  const topSender = senderStats[0];
  if (topSender) {
    console.log(`  Most common path: ${topSender.path}`);
  }
  console.log("");

  console.log("2. payload.event_id vs webhook-id header");
  let mismatches = 0;
  let compared = 0;
  for (const [index, record] of records.entries()) {
    const payload = payloads[index];
    const eventId = getPath(payload, "event_id");
    const webhookId = headerValue(record.headers, "webhook-id");
    const eventIdText = eventId === undefined ? "(missing)" : String(eventId);
    const webhookIdText = webhookId ?? "(missing)";
    const match = eventIdText === webhookIdText;
    if (eventId !== undefined || webhookId !== undefined) compared += 1;
    if (!match) mismatches += 1;
    const flag = match ? "match" : "MISMATCH";
    console.log(
      `  ${record.received_at ?? `#${index + 1}`}: event_id=${eventIdText}  webhook-id=${webhookIdText}  ${flag}`,
    );
  }
  console.log(
    `  Compared ${compared} records with at least one id present; ${mismatches} mismatch(es).`,
  );
  console.log("");

  console.log("3. Chat identifier and stability");
  const chatIdStats = collectPathStats(payloads, (path, node) => {
    if (typeof node === "object") return false;
    return /(^|\.)chat\.id$/.test(path) || /chat_id$/.test(path);
  });
  printStats(chatIdStats, "No chat id field found.");
  const chatIdPath = chatIdStats[0]?.path;
  if (chatIdPath) {
    const counts = new Map<string, number>();
    for (const payload of payloads) {
      const id = getPath(payload, chatIdPath);
      if (id === undefined || id === null) continue;
      const key = String(id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`  Grouped by ${chatIdPath}:`);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id, count] of ranked) {
      console.log(`    ${id}: ${count}`);
    }
    const reused = ranked.filter(([, count]) => count > 1);
    if (reused.length > 0) {
      console.log(
        `  ${reused.length} chat id(s) appeared more than once, so this field is stable across messages in the sample.`,
      );
    } else if (ranked.length <= 1) {
      console.log(
        "  Not enough distinct messages in one thread to judge stability. Send several messages in the same chat and re-run.",
      );
    } else {
      console.log(
        "  Every record had a different chat id. Either each event is a different thread, or the field is not stable. Capture more messages in one thread.",
      );
    }
  }
  console.log("");

  console.log("4. Photo / media attachments");
  const mediaNodes: string[] = [];
  for (const payload of payloads) {
    walk(payload, "", (path, node) => {
      const obj = asRecord(node);
      if (!obj) return;
      const type = obj.type;
      const mime = typeof obj.mime_type === "string" ? obj.mime_type : "";
      const looksMedia =
        type === "media" ||
        mime.startsWith("image/") ||
        mime.startsWith("video/");
      if (!looksMedia) return;
      const keys = Object.keys(obj);
      const url = typeof obj.url === "string";
      const attachmentId =
        typeof obj.attachment_id === "string" || typeof obj.id === "string";
      const inline =
        typeof obj.data === "string" ||
        typeof obj.base64 === "string" ||
        asRecord(obj.inlineData) !== undefined;
      let shape = "unknown";
      if (url) shape = "URL (fetchable)";
      else if (inline) shape = "inline/base64";
      else if (attachmentId) shape = "reference id (separate fetch)";
      mediaNodes.push(
        `${path || "(root)"} type=${String(type)} mime=${mime || "n/a"} keys=${keys.join(",")} shape=${shape}`,
      );
    });
  }
  if (mediaNodes.length === 0) {
    console.log(
      "  No media parts found. Send a photo in the group chat, then re-run.",
    );
  } else {
    for (const line of mediaNodes) console.log(`  ${line}`);
  }
  console.log("");

  console.log("5. Group chat vs 1:1 DM");
  const groupStats = collectPathStats(payloads, (path) => {
    const leaf = path.split(".").pop() ?? "";
    return (
      leaf === "is_group" ||
      leaf === "isGroup" ||
      path.endsWith("chat.type") ||
      path.endsWith("chat.kind")
    );
  });
  printStats(
    groupStats,
    "No is_group/type field found. Compare participant counts or chat shape across a group event and a DM.",
  );
  const participantCounts = collectPathStats(payloads, (path) =>
    /participants$/.test(path),
  );
  if (participantCounts.length > 0) {
    console.log("  Participant-list paths:");
    printStats(participantCounts, "");
  }
  console.log("");

  console.log("6. Distinct event types");
  const typeCounts = new Map<string, number>();
  for (const payload of payloads) {
    const type = getPath(payload, "event_type") ?? getPath(payload, "type");
    const key = type === undefined ? "(missing event_type)" : String(type);
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
  }
  const rankedTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of rankedTypes) {
    console.log(`  ${type}: ${count}`);
  }
}

main();
