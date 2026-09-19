import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_SECONDS = 5 * 60;

export type WebhookHeaders = {
  "webhook-id"?: string | null;
  "webhook-timestamp"?: string | null;
  "webhook-signature"?: string | null;
};

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function inspectLinqSignature(
  rawBody: string,
  headers: Headers | WebhookHeaders,
  secret = process.env.LINQ_WEBHOOK_SECRET,
): SignatureCheck {
  if (!secret) return { ok: false, reason: "missing_secret" };

  const msgId = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signature = header(headers, "webhook-signature");
  if (!msgId) return { ok: false, reason: "missing_webhook-id" };
  if (!timestamp) return { ok: false, reason: "missing_webhook-timestamp" };
  if (!signature) return { ok: false, reason: "missing_webhook-signature" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  // TODO: plan/Linq docs reject timestamps older than 5 minutes; they do not specify future-dated timestamps.
  const ageSeconds = Date.now() / 1000 - ts;
  if (Math.abs(ageSeconds) > MAX_AGE_SECONDS) {
    return { ok: false, reason: `timestamp_skew ageSeconds=${ageSeconds.toFixed(1)}` };
  }

  const secretStr = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(secretStr, "base64");
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", keyBytes)
    .update(signedContent)
    .digest("base64");

  const parts = signature.split(" ");
  if (!parts.some((sig) => sig.startsWith("v1,"))) {
    return { ok: false, reason: "no_v1_signature" };
  }

  const matched = parts.some((sig) => {
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

  if (!matched) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

export function verifyLinqSignature(
  rawBody: string,
  headers: Headers | WebhookHeaders,
  secret = process.env.LINQ_WEBHOOK_SECRET,
): boolean {
  return inspectLinqSignature(rawBody, headers, secret).ok;
}

function header(
  headers: Headers | WebhookHeaders,
  name: keyof WebhookHeaders,
): string | undefined {
  const value =
    headers instanceof Headers ? headers.get(name) : headers[name];
  return value ?? undefined;
}
