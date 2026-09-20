import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  search: vi.fn(),
  fetch: vi.fn(),
  launched: 0,
}));

vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: {
    launch: vi.fn(async () => {
      h.launched += 1;
      throw new Error("a session must never be opened on this path");
    }),
    search: h.search,
    fetch: h.fetch,
  },
  Stagehand: { create: vi.fn() },
}));

import {
  enterpriseBookingUrl,
  enterpriseRentalReply,
  findEnterpriseRentals,
} from "./enterprise-rentals";
import { isCarRentalRequest } from "@/lib/game/commands";
import { HELP_TEXT } from "@/lib/game/copy";

describe("isCarRentalRequest", () => {
  it("matches rent-a-car commands and ignores ordinary sentences", () => {
    expect(isCarRentalRequest("japlan rent a car")).toBe(true);
    expect(isCarRentalRequest("japlan car rental")).toBe(true);
    expect(isCarRentalRequest("japlan enterprise")).toBe(true);
    expect(isCarRentalRequest("japlan find me a rental car")).toBe(true);
    expect(isCarRentalRequest("we should rent a car later maybe")).toBe(false);
    expect(isCarRentalRequest("japlan standings")).toBe(false);
  });
});

describe("enterpriseBookingUrl", () => {
  it("always returns an https enterprise locations link", () => {
    const url = enterpriseBookingUrl("Tokyo, Japan");
    expect(url.startsWith("https://www.enterprise.com/")).toBe(true);
    expect(url).toContain("search=Tokyo");
    expect(enterpriseBookingUrl("Osaka", {
      pickup: "2026-10-17",
      returnDate: "2026-10-20",
    })).toContain("pickupDate=2026-10-17");
  });
});

describe("findEnterpriseRentals", () => {
  afterEach(() => {
    h.search.mockReset();
    h.fetch.mockReset();
    h.launched = 0;
    delete process.env.BROWSERBASE_API_KEY;
  });

  it("refuses under-age senders but can still share a link for an adult", async () => {
    const out = await findEnterpriseRentals({ city: "Tokyo", underAge: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("under_age");
    expect(enterpriseRentalReply(out)).toMatch(/21\+/);
    expect(enterpriseRentalReply(out)).toContain("https://www.enterprise.com/");
    expect(h.launched).toBe(0);
  });

  it("asks for a city when none is known", async () => {
    const out = await findEnterpriseRentals({ city: null });
    expect(out).toMatchObject({ ok: false, reason: "need_city" });
    expect(enterpriseRentalReply(out)).toMatch(/city/i);
  });

  it("rejects inverted dates but still offers the booking link", async () => {
    const out = await findEnterpriseRentals({
      city: "Toronto",
      pickupDate: "2026-10-20",
      returnDate: "2026-10-17",
    });
    expect(out).toMatchObject({ ok: false, reason: "bad_dates" });
    expect(out.bookingUrl).toContain("enterprise.com");
    expect(enterpriseRentalReply(out)).toContain("https://");
  });

  it("returns the official link even without Browserbase", async () => {
    const out = await findEnterpriseRentals({
      city: "Tokyo",
      pickupDate: "2026-10-17",
      returnDate: "2026-10-20",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.bookingUrl).toContain("enterprise.com");
      expect(out.links[0]?.url).toBe(out.bookingUrl);
      expect(out.browserbaseUsed).toBe(false);
    }
    expect(enterpriseRentalReply(out)).toContain("book / search:");
    expect(h.launched).toBe(0);
    expect(h.search).not.toHaveBeenCalled();
  });

  it("enriches with enterprise.com search hits and never launches a session", async () => {
    process.env.BROWSERBASE_API_KEY = "test-key";
    h.search.mockResolvedValue({
      results: [
        {
          title: "Enterprise Tokyo Station",
          url: "https://www.enterprise.com/en/car-rental/locations/tokyo-station.html",
        },
        { title: "random blog", url: "https://example.com/cars" },
        {
          title: "Enterprise Shinjuku",
          url: "https://www.enterpriserentacar.com/en/locations/shinjuku",
        },
      ],
    });
    h.fetch.mockResolvedValue({ content: "# Enterprise locations\n\nFind a branch near you.".repeat(5) });

    const out = await findEnterpriseRentals({ city: "Tokyo" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.browserbaseUsed).toBe(true);
      expect(out.links.some((l) => l.url.includes("tokyo-station"))).toBe(true);
      expect(out.links.every((l) => /enterprise/i.test(l.url))).toBe(true);
    }
    expect(enterpriseRentalReply(out)).toContain("https://www.enterprise.com/");
    expect(h.launched).toBe(0);
    expect(h.search).toHaveBeenCalled();
  });

  it("still sends the official link when Browserbase search fails", async () => {
    process.env.BROWSERBASE_API_KEY = "test-key";
    h.search.mockRejectedValue(new Error("timeout"));
    h.fetch.mockRejectedValue(new Error("blocked"));
    const out = await findEnterpriseRentals({ city: "Osaka" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.bookingUrl).toContain("Osaka");
      expect(out.links[0]?.url).toBe(out.bookingUrl);
    }
    expect(enterpriseRentalReply(out)).toMatch(/enterprise/i);
    expect(h.launched).toBe(0);
  });
});

describe("help mentions enterprise rentals", () => {
  it("lists the command in group and dm guides", () => {
    expect(HELP_TEXT.group.toLowerCase()).toContain("rent a car");
    expect(HELP_TEXT.dm.toLowerCase()).toContain("rent a car");
    expect(HELP_TEXT.group.toLowerCase()).toContain("enterprise");
  });
});
