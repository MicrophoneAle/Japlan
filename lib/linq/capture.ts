import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const CAPTURE_PATH = join(process.cwd(), ".captures", "events.ndjson");

export function isCaptureEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

export function capturePath(): string {
  return CAPTURE_PATH;
}

export async function captureInboundWebhook(
  rawBody: string,
  headers: Headers,
): Promise<void> {
  if (!isCaptureEnabled()) return;

  const record = {
    received_at: new Date().toISOString(),
    headers: Object.fromEntries(headers.entries()),
    body: rawBody,
  };

  await mkdir(dirname(CAPTURE_PATH), { recursive: true });
  await appendFile(CAPTURE_PATH, `${JSON.stringify(record)}\n`, "utf8");
}
