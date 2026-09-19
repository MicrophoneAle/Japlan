import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_SECONDS = 5 * 60;

export type WebhookHeaders = {
  "webhook-id"?: string | null;
  "webhook-timestamp"?: string | null;
  "webhook-signature"?: string | null;
};

export function verifyLinqSignature(
  rawBody: string,
  headers: Headers | WebhookHeaders,
  secret = process.env.LINQ_WEBHOOK_SECRET,
): boolean {
  if (!secret) return false;

  const msgId = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signature = header(headers, "webhook-signature");
  if (!msgId || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // TODO: plan/Linq docs reject timestamps older than 5 minutes; they do not specify future-dated timestamps.
  if (Math.abs(Date.now() / 1000 - ts) > MAX_AGE_SECONDS) return false;

  const secretStr = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(secretStr, "base64");
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", keyBytes)
    .update(signedContent)
    .digest("base64");

  return signature.split(" ").some((sig) => {
    if (!sig.startsWith("v1,")) return false;
    try {
      return timingSafeEqual(
        Buffer.from(expected, "base64"),
        Buffer.from(sig.slice(3), "base64"),
      );
    } catch {
      return false;
    }
  });
}

function header(
  headers: Headers | WebhookHeaders,
  name: keyof WebhookHeaders,
): string | undefined {
  const value =
    headers instanceof Headers ? headers.get(name) : headers[name];
  return value ?? undefined;
}
