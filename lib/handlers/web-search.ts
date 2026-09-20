// Real, linkable web results for a conversational question ("good teriyaki in
// osaka", "tickets for universal studios japan", "[place] google maps").
// Search only, never a full browser session: Browserbase Search is a
// stateless API call, unlike browserbase.launch()/Stagehand, which spins up a
// real session that can take seconds to minutes. That's fine for the
// itinerary lab's batch research (lib/itinerary/research.ts) but not for a
// chat reply that has to feel immediate, so this never launches one.
//
// Same primitive lib/itinerary/fast-research.ts already uses for enrichment,
// just without the itinerary-specific candidate schema: this is for a single
// ad hoc question, not a multi-day draft.

import { browserbase } from "@browserbasehq/stagehand";

export type WebSearchResult = { title: string; url: string };

export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; reason: "unavailable" | "no_results" | "failed" | "is_a_url" };

// Searching the web for a URL can never return anything useful: a query like
// "instagram reel DRjSL_pEW3X tokyo place" is a shortcode, not a name, and no
// search engine knows what is inside that post. A link someone pasted is
// already read and resolved before the conversation turn (lib/handlers/
// social-links.ts), and the venue it named is handed to the model as context,
// so this refuses the query and points at that instead of burning a call.
function looksLikeUrl(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (/https?:\/\//.test(q)) return true;
  if (/\b(?:instagram|tiktok|youtube|youtu\.be|fb\.watch|maps\.app\.goo\.gl)\b/.test(q)) return true;
  // A bare shortcode someone pulled out of a URL: a long token with mixed
  // case and no vowels to speak of.
  return /\b[A-Za-z0-9_-]{9,}\b/.test(query) && !/\s/.test(query.trim());
}

const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 5;

function webSearchStep(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.conversation] step", { step, ...fields });
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

// A search failure only costs the tool call: the conversation loop falls
// back to the model's own declared best guess (see CONVERSATION_SYSTEM_PROMPT),
// so this never throws.
export async function searchTheWeb(query: string): Promise<WebSearchOutcome> {
  if (looksLikeUrl(query)) {
    webSearchStep("web_search.rejected", { reason: "is_a_url", query: query.slice(0, 80) });
    return { ok: false, reason: "is_a_url" };
  }
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    webSearchStep("web_search.skip", { reason: "no_api_key" });
    return { ok: false, reason: "unavailable" };
  }
  try {
    const response = await withTimeout(
      browserbase.search({ apiKey, query, numResults: MAX_RESULTS }),
      SEARCH_TIMEOUT_MS,
      "browserbase.search",
    );
    const results = response.results
      .filter((result) => result.url.startsWith("https://"))
      .map((result) => ({ title: result.title, url: result.url }));
    webSearchStep("web_search.result", { query, count: results.length });
    if (results.length === 0) return { ok: false, reason: "no_results" };
    return { ok: true, results };
  } catch (err) {
    webSearchStep("web_search.failed", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "failed" };
  }
}
