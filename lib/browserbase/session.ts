import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";
import type { Page } from "playwright-core";

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
    browserSettings: { blockAds: true },
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  // default context so the session records properly
  const page = browser.contexts()[0]!.pages()[0]!;
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}
