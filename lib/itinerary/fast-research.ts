import { browserbase } from "@browserbasehq/stagehand";
import { z } from "zod";
import { GeminiProvider } from "@/lib/llm/gemini";
import { searchPlaces, type FoursquarePlace } from "@/lib/places/foursquare";
import { inclusiveTripDates, type TripConfig } from "./config";
import { CandidateActivitySchema, type CandidateActivity, type ResearchAction, type ResearchSnapshot } from "./schemas";
import { balanceCandidates, isEnglishFacing, isExplicitlyIncompatible } from "./quality";

const FETCH_TIMEOUT_MS = 12_000;
const candidateExtraction = z.object({ activities: z.array(CandidateActivitySchema.omit({ id: true, destination: true, sourceUrls: true })).max(3) });
const extractionSchema = z.toJSONSchema(candidateExtraction);
const discoveryTranslation = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), category: z.string(), description: z.string() })).max(30),
});
const discoveryTranslationSchema = z.toJSONSchema(discoveryTranslation);
const DISCOVERY_QUERIES = ["attractions", "markets and neighborhoods", "parks and viewpoints", "workshops and live music", "vegetarian restaurants"];

function now() { return new Date().toISOString(); }
function candidateKey(candidate: CandidateActivity) { return candidate.name.trim().toLocaleLowerCase(); }
function sourceForPlace(place: FoursquarePlace) { return `https://foursquare.com/v/${place.fsq_place_id}`; }

function foursquareCandidate(place: FoursquarePlace, config: TripConfig, index: number): CandidateActivity {
  const categories = place.categories.join(", ") || "place";
  const location = [place.neighborhood, place.locality].filter(Boolean).join(", ");
  return {
    id: `foursquare-${index}-${place.fsq_place_id}`,
    name: place.name,
    category: categories,
    description: location ? `Foursquare-listed ${categories} in ${location}.` : `Foursquare-listed ${categories}.`,
    destination: config.destination,
    address: null,
    estimatedDurationMinutes: null,
    estimatedCost: place.price === null ? null : `Foursquare price level ${place.price}`,
    priceLevel: place.price === 1 ? "low" : place.price === 2 ? "medium" : place.price !== null ? "high" : "unknown",
    openingHours: null,
    accessibilityNotes: null,
    dietaryNotes: /restaurant|food|cafe|café/i.test(categories) ? "Vegetarian and peanut cross-contact details require direct confirmation." : null,
    reservationRequired: null,
    sourceUrls: [sourceForPlace(place)],
    unverifiedFields: ["address", "duration", "opening hours", "accessibility", ...(/restaurant|food|cafe|café/i.test(categories) ? ["allergy safety"] : [])],
    translatedFromSource: false,
  };
}

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), FETCH_TIMEOUT_MS); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function enrichWithBrowserbase(url: string, config: TripConfig, apiKey: string): Promise<CandidateActivity[]> {
  const fetched = await withTimeout(browserbase.fetch({ apiKey, url, format: "markdown" }), "Browserbase Fetch");
  const markdown = typeof fetched.content === "string" ? fetched.content.slice(0, 14_000) : JSON.stringify(fetched.content);
  const provider = new GeminiProvider();
  const raw = await withTimeout(provider.complete({
    tier: "fast",
    schema: extractionSchema,
    system: "Extract up to three factual travel candidates from Browserbase-fetched source markdown. Return every display field in clear English; faithfully translate non-English source wording and set translatedFromSource true when translating. Do not invent facts. Preserve unknown fields as null and list them in unverifiedFields. Respect vegetarian dining, peanut allergy uncertainty, reduced walking, and step-free preference.",
    messages: [{ role: "user", content: `Destination: ${config.destination}\nDates: ${config.startDate} through ${config.endDate}\n\nSource URL: ${url}\n\nMarkdown:\n${markdown}` }],
  }), "Gemini source extraction");
  const parsed = candidateExtraction.parse(JSON.parse(raw));
  return parsed.activities.map((activity, index) => ({ ...activity, id: `browserbase-${index}-${Math.abs(url.length)}`, destination: config.destination, sourceUrls: [url] }));
}

/** Foursquare may return local-script place names. Translate only display labels;
 * every factual field and the source URL remains the discovery result. */
async function translateDiscoveryLabels(candidates: CandidateActivity[]): Promise<CandidateActivity[]> {
  const needingTranslation = candidates.filter(candidate => !isEnglishFacing(`${candidate.name} ${candidate.category} ${candidate.description}`)).slice(0, 30);
  if (!needingTranslation.length) return candidates;
  const provider = new GeminiProvider();
  const raw = await withTimeout(provider.complete({
    tier: "fast",
    schema: discoveryTranslationSchema,
    system: "Translate the supplied place labels and short factual descriptions into natural English. Preserve each ID. Do not add facts, recommendations, safety claims, prices, hours, or addresses. Return only the supplied items that need translation.",
    messages: [{ role: "user", content: JSON.stringify(needingTranslation.map(({ id, name, category, description }) => ({ id, name, category, description }))) }],
  }), "Gemini discovery translation");
  const translated = discoveryTranslation.parse(JSON.parse(raw));
  const byId = new Map(translated.items.map(item => [item.id, item]));
  return candidates.map(candidate => {
    const item = byId.get(candidate.id);
    if (!item || !isEnglishFacing(`${item.name} ${item.category} ${item.description}`)) return candidate;
    return { ...candidate, ...item, translatedFromSource: true };
  });
}

export async function researchActivitiesFast(config: TripConfig): Promise<ResearchSnapshot> {
  const browserbaseKey = process.env.BROWSERBASE_API_KEY;
  if (!browserbaseKey || !process.env.FOURSQUARE_API_KEY || !process.env.GEMINI_API_KEY) throw new Error("fast research requires Browserbase, Foursquare, and Gemini credentials");
  const actions: ResearchAction[] = [];
  const visitedUrls: string[] = [];
  const candidates: CandidateActivity[] = [];
  const discoveries = await Promise.allSettled(DISCOVERY_QUERIES.map(query => searchPlaces({ near: config.destination, query, limit: 10 })));
  const discovered: FoursquarePlace[] = [];
  discoveries.forEach((result, index) => {
    const query = DISCOVERY_QUERIES[index]!;
    if (result.status === "fulfilled") {
      discovered.push(...result.value);
      actions.push({ at: now(), type: "search", detail: `Foursquare: ${query} (${result.value.length} results)`, url: null });
    } else actions.push({ at: now(), type: "error", detail: `Foursquare ${query}: ${result.reason instanceof Error ? result.reason.message : "failed"}`, url: null });
  });
  const discoveryCandidates = await translateDiscoveryLabels(discovered.map((place, index) => foursquareCandidate(place, config, index)));
  discoveryCandidates.forEach(candidate => {
    if (isEnglishFacing(`${candidate.name} ${candidate.description}`) && !isExplicitlyIncompatible(candidate, config)) candidates.push(candidate);
  });
  const enrichmentQueries = [`${config.destination} official accessibility opening hours attractions`, `${config.destination} vegetarian restaurant official menu peanut allergy`];
  const sourceSearches = await Promise.allSettled(enrichmentQueries.map(query => browserbase.search({ apiKey: browserbaseKey, query, numResults: 1 })));
  const urls = sourceSearches.flatMap((result, index) => {
    if (result.status !== "fulfilled") { actions.push({ at: now(), type: "error", detail: `Browserbase Search failed: ${enrichmentQueries[index]}`, url: null }); return []; }
    const url = result.value.results[0]?.url;
    if (!url?.startsWith("https://")) return [];
    actions.push({ at: now(), type: "search", detail: `Browserbase: ${enrichmentQueries[index]}`, url });
    return [url];
  });
  const enrichments = await Promise.allSettled(urls.map(url => enrichWithBrowserbase(url, config, browserbaseKey)));
  enrichments.forEach((result, index) => {
    const url = urls[index]!;
    visitedUrls.push(url);
    if (result.status === "fulfilled") {
      for (const candidate of result.value) if (isEnglishFacing(`${candidate.name} ${candidate.description} ${candidate.accessibilityNotes ?? ""} ${candidate.dietaryNotes ?? ""}`) && !isExplicitlyIncompatible(candidate, config)) candidates.push(candidate);
      actions.push({ at: now(), type: "extract", detail: `Browserbase Fetch + Gemini Flash-Lite extracted ${result.value.length} candidates`, url });
    } else actions.push({ at: now(), type: "error", detail: `Browserbase enrichment: ${result.reason instanceof Error ? result.reason.message : "failed"}`, url });
  });
  const minimum = Math.max(8, inclusiveTripDates(config).length * 2);
  const unique = balanceCandidates([...new Map(candidates.map(candidate => [candidateKey(candidate), candidate])).values()], minimum);
  if (unique.length < minimum) throw new Error(`fast research returned ${unique.length} candidates; at least ${minimum} are required for a varied draft`);
  return { mode: "real", status: "researched", sessionId: null, dashboardUrl: null, visitedUrls, actions, candidates: unique, error: null };
}

export { foursquareCandidate };
