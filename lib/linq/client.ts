import LinqAPIV3 from "@linqapp/sdk";
import { LINQ_MAX_RETRIES, LINQ_REQUEST_TIMEOUT_MS } from "./budget";

// TODO: plan requires a `channel` field for later RCS/WhatsApp, but does not specify where it lives on the client.

let client: LinqAPIV3 | undefined;

export function getLinqClient(): LinqAPIV3 {
  if (client) return client;

  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey) {
    throw new Error("missing LINQ_API_KEY");
  }

  client = new LinqAPIV3({
    apiKey,
    webhookSecret: process.env.LINQ_WEBHOOK_SECRET,
    timeout: LINQ_REQUEST_TIMEOUT_MS,
    maxRetries: LINQ_MAX_RETRIES,
  });
  return client;
}

// Tests that swap the env out need the memoized client gone with it.
export function resetLinqClientForTests(): void {
  client = undefined;
}
