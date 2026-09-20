import { describe, expect, it } from "vitest";
import { loadEnvConfig } from "@next/env";
import {
  enterpriseRentalReply,
  findEnterpriseRentals,
} from "./enterprise-rentals";

// Load .env so a local `npx vitest run lib/handlers/enterprise-rentals.live.test.ts`
// can hit real Browserbase when the key is present.
loadEnvConfig(process.cwd(), true);

const live = Boolean(process.env.BROWSERBASE_API_KEY);

describe("live enterprise rentals", () => {
  it.skipIf(!live)(
    "returns a real enterprise.com booking link (Browserbase search/fetch)",
    async () => {
      const out = await findEnterpriseRentals({
        city: "Tokyo",
        pickupDate: "2026-10-17",
        returnDate: "2026-10-20",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.bookingUrl.startsWith("https://www.enterprise.com/")).toBe(true);
      expect(out.browserbaseUsed).toBe(true);
      expect(out.links.length).toBeGreaterThanOrEqual(1);
      expect(out.links.every((l) => l.url.startsWith("https://"))).toBe(true);
      const reply = enterpriseRentalReply(out);
      expect(reply).toContain(out.bookingUrl);
      expect(reply).toMatch(/book \/ search:/i);

      // Surface the live payload so `npx vitest run …live.test.ts` is also a smoke.
      console.info("[japlan.enterprise] live.outcome", {
        bookingUrl: out.bookingUrl,
        browserbaseUsed: out.browserbaseUsed,
        linkCount: out.links.length,
        links: out.links,
        notes: out.notes,
      });
      console.info("[japlan.enterprise] live.reply\n" + reply);

      const res = await fetch(out.bookingUrl, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "JaplanEnterpriseLiveTest/1.0" },
      });
      // Enterprise may 403 bots; accept any completed HTTP response with a final URL.
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.url.startsWith("https://")).toBe(true);
      console.info("[japlan.enterprise] live.http", {
        status: res.status,
        finalUrl: res.url,
      });
    },
    45_000,
  );

  it("always builds a usable link even without Browserbase", async () => {
    const prev = process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_API_KEY;
    try {
      const out = await findEnterpriseRentals({ city: "Osaka" });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.bookingUrl).toContain("enterprise.com");
      expect(out.browserbaseUsed).toBe(false);
      expect(enterpriseRentalReply(out)).toContain("https://www.enterprise.com/");
    } finally {
      if (prev !== undefined) process.env.BROWSERBASE_API_KEY = prev;
    }
  });
});
