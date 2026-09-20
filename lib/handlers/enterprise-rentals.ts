// Enterprise Rent-A-Car discovery for chat: always return a real link.
//
// No Enterprise API (project rule: no new keyed APIs). We:
//   1. build an official enterprise.com locations/search URL from the city
//   2. optionally enrich with browserbase.search() for live listing links
//   3. optionally fetch() the first official page for a short note
//
// Never browserbase.launch()/Stagehand on this path (webhook-safe).
// Japlan does not book or quote a price: the link is the product.

import { browserbase } from "@browserbasehq/stagehand";
import { z } from "zod";

export const FindCarRentalArgsSchema = z.object({
  city: z.string().min(1).max(120).optional(),
  pickup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type FindCarRentalArgs = z.infer<typeof FindCarRentalArgsSchema>;

export type CarRentalLink = { title: string; url: string };

export type CarRentalOutcome =
  | {
      ok: true;
      city: string;
      bookingUrl: string;
      links: CarRentalLink[];
      notes: string[];
      browserbaseUsed: boolean;
    }
  | {
      ok: false;
      reason:
        | "need_city"
        | "under_age"
        | "bad_dates"
        | "unavailable"
        | "no_results";
      bookingUrl: string | null;
      notes: string[];
    };

const SEARCH_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_LINKS = 4;

const ENTERPRISE_HOST_RE =
  /(?:^|\.)(?:enterprise\.com|enterpriserentacar\.com|enterprise\.ca|enterprise\.co\.uk)$/i;

function step(stepName: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.enterprise] step", { step: stepName, ...fields });
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanCity(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/,?\s*(japan|usa|united states|canada|uk|united kingdom)$/i, "")
    .trim();
}

/** Official Enterprise locations finder; always https so iMessage can preview. */
export function enterpriseBookingUrl(city: string, dates?: {
  pickup?: string | null;
  returnDate?: string | null;
}): string {
  const q = encodeURIComponent(cleanCity(city));
  // Locations search is the most reliable deep link without an API key.
  // Dates stay on the page for the human to confirm; we do not invent rates.
  const base = `https://www.enterprise.com/en/car-rental/locations.html?search=${q}`;
  if (dates?.pickup && dates?.returnDate) {
    return `${base}&pickupDate=${encodeURIComponent(dates.pickup)}&returnDate=${encodeURIComponent(dates.returnDate)}`;
  }
  return base;
}

function isEnterpriseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ENTERPRISE_HOST_RE.test(host);
  } catch {
    return false;
  }
}

function validDateOrder(pickup?: string, ret?: string): boolean {
  if (!pickup && !ret) return true;
  if ((pickup && !ret) || (!pickup && ret)) return false;
  return pickup! <= ret!;
}

/**
 * Find Enterprise rental options for a city. Always prefers a real
 * enterprise.com link; Browserbase only enriches, never replaces that.
 */
export async function findEnterpriseRentals(opts: {
  city: string | null | undefined;
  pickupDate?: string | null;
  returnDate?: string | null;
  underAge?: boolean;
}): Promise<CarRentalOutcome> {
  const notes: string[] = [];
  const city = opts.city?.trim() ? cleanCity(opts.city) : "";

  if (opts.underAge) {
    return {
      ok: false,
      reason: "under_age",
      bookingUrl: city ? enterpriseBookingUrl(city) : null,
      notes: [
        "most rental counters need you to be 21+ (sometimes 25+), and japlan can't book for anyone under 18.",
      ],
    };
  }

  if (!city) {
    return {
      ok: false,
      reason: "need_city",
      bookingUrl: null,
      notes: ["need a city first (finish trip setup, or tell me the city)."],
    };
  }

  const pickup = opts.pickupDate?.trim() || null;
  const ret = opts.returnDate?.trim() || null;
  if (!validDateOrder(pickup ?? undefined, ret ?? undefined)) {
    return {
      ok: false,
      reason: "bad_dates",
      bookingUrl: enterpriseBookingUrl(city),
      notes: [
        "pickup and return dates need to be yyyy-mm-dd with return on or after pickup.",
        `you can still open enterprise here: ${enterpriseBookingUrl(city)}`,
      ],
    };
  }

  const bookingUrl = enterpriseBookingUrl(city, {
    pickup,
    returnDate: ret,
  });
  notes.push("japlan can't reserve or quote a price; book on enterprise's site.");
  if (pickup && ret) {
    notes.push(`suggested window: ${pickup} → ${ret} (confirm on their site).`);
  }

  const links: CarRentalLink[] = [
    { title: `Enterprise locations · ${city}`, url: bookingUrl },
  ];

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    step("search.skip", { reason: "no_api_key", city });
    return {
      ok: true,
      city,
      bookingUrl,
      links,
      notes: [...notes, "live listing search unavailable right now; official link still works."],
      browserbaseUsed: false,
    };
  }

  let browserbaseUsed = false;
  try {
    const query = `Enterprise Rent-A-Car ${city} official locations`;
    const response = await withTimeout(
      browserbase.search({ apiKey, query, numResults: 6 }),
      SEARCH_TIMEOUT_MS,
      "browserbase.search.enterprise",
    );
    browserbaseUsed = true;
    const seen = new Set(links.map((l) => l.url));
    for (const result of response.results) {
      if (!result.url.startsWith("https://")) continue;
      if (!isEnterpriseUrl(result.url)) continue;
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      links.push({
        title: result.title.slice(0, 120) || `Enterprise · ${city}`,
        url: result.url,
      });
      if (links.length >= MAX_LINKS) break;
    }
    step("search.result", { city, count: links.length });
  } catch (err) {
    browserbaseUsed = true;
    step("search.failed", {
      city,
      error: err instanceof Error ? err.message : String(err),
    });
    notes.push("couldn't refresh live listings; official enterprise link still works.");
  }

  // Optional light fetch of the booking URL for a one-line status; never blocks a link.
  try {
    const fetched = await withTimeout(
      browserbase.fetch({ apiKey: apiKey!, url: bookingUrl, format: "markdown" }),
      FETCH_TIMEOUT_MS,
      "browserbase.fetch.enterprise",
    );
    browserbaseUsed = true;
    const markdown =
      typeof fetched.content === "string"
        ? fetched.content
        : JSON.stringify(fetched.content);
    if (markdown.length > 80) {
      notes.push("opened enterprise's locations page successfully; finish the booking there.");
    }
  } catch {
    // Link still valid; a fetch miss is normal for bot-gated pages.
    step("fetch.skip", { city });
  }

  return {
    ok: true,
    city,
    bookingUrl,
    links: links.slice(0, MAX_LINKS),
    notes,
    browserbaseUsed,
  };
}

/** Deterministic chat line: always includes at least one https link when possible. */
export function enterpriseRentalReply(outcome: CarRentalOutcome): string {
  if (!outcome.ok) {
    if (outcome.reason === "under_age") {
      return [
        "🚗 car rentals usually need you to be 21+ (sometimes 25+), so i can't help book that.",
        outcome.bookingUrl ? `if an adult on the trip wants enterprise: ${outcome.bookingUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (outcome.reason === "need_city") {
      return "🚗 tell me which city to rent in (or finish trip setup) and i'll send an enterprise link.";
    }
    if (outcome.reason === "bad_dates") {
      return [
        "🚗 those dates look off (need pickup ≤ return, yyyy-mm-dd).",
        outcome.bookingUrl ? `enterprise anyway: ${outcome.bookingUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    return outcome.bookingUrl
      ? `🚗 couldn't load live listings. try enterprise here: ${outcome.bookingUrl}`
      : "🚗 couldn't find an enterprise listing just now. try again in a bit.";
  }

  const extra = outcome.links
    .slice(1)
    .map((link) => `· ${link.title}\n  ${link.url}`)
    .join("\n");
  return [
    `🚗 enterprise near ${outcome.city}`,
    `book / search: ${outcome.bookingUrl}`,
    extra ? `more listings:\n${extra}` : null,
    ...outcome.notes.map((n) => `(${n})`),
  ]
    .filter(Boolean)
    .join("\n");
}
