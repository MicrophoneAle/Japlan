import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";
import type { Page } from "playwright-core";

let bb: Browserbase | undefined;
let lastSessionId: string | undefined;

function getBrowserbase(): Browserbase {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("missing BROWSERBASE_API_KEY");
  bb ??= new Browserbase({ apiKey });
  return bb;
}

export function getLastSessionId(): string | undefined {
  return lastSessionId;
}

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const client = getBrowserbase();
  const session = await client.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
    browserSettings: { blockAds: true },
  });
  lastSessionId = session.id;
  const browser = await chromium.connectOverCDP(session.connectUrl);
  // default context so the session records properly
  const page = browser.contexts()[0]!.pages()[0]!;
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}
