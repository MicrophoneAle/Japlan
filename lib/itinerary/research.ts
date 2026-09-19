import { browserbase, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { z } from "zod";
import { inclusiveTripDates, researchMode, type TripConfig } from "./config";
import { mockResearch } from "./mock-research";
import { CandidateActivitySchema, type CandidateActivity, type ResearchAction, type ResearchSnapshot } from "./schemas";
import { balanceCandidates, isEnglishFacing, isExplicitlyIncompatible } from "./quality";

const ExtractedActivities = z.object({ activities: z.array(CandidateActivitySchema.omit({ id: true, destination: true, sourceUrls: true })).max(3) });
const MAX_SEARCHES = 4;
const MAX_VISITS = 8;

function now() { return new Date().toISOString(); }
function key(candidate: CandidateActivity) { return candidate.name.trim().toLocaleLowerCase(); }
function dashboardUrl(sessionId: string | null) { return sessionId ? `https://www.browserbase.com/sessions/${sessionId}` : null; }
function errorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && !messages.includes(current.message)) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(": ") || "Research failed";
}

export async function researchActivities(config: TripConfig): Promise<ResearchSnapshot> {
  if (researchMode() === "mock") return mockResearch(config);
  const browserbaseKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!browserbaseKey || !projectId || !geminiKey) throw new Error("real research requires Browserbase and Gemini credentials");

  const actions: ResearchAction[] = [];
  const visitedUrls: string[] = [];
  const candidates: CandidateActivity[] = [];
  let sessionId: string | null = null;
  let browser: StagehandBrowser | undefined;
  let stagehand: Stagehand | undefined;
  try {
    browser = await browserbase.launch({ apiKey: browserbaseKey, projectId });
    sessionId = (browser as unknown as { sessionId?: string }).sessionId ?? null;
    stagehand = await Stagehand.create({ browser, model: { modelName: (process.env.STAGEHAND_MODEL ?? "google/gemini-3.6-flash") as never, apiKey: geminiKey }, logging: { level: "info", format: "json" } });
    const [page] = await browser.context.pages();
    if (!page) throw new Error("Browserbase did not provide an active page");
    const queries = [
      `${config.destination} official landmark attraction accessibility`,
      `${config.destination} neighborhoods markets parks viewpoints official visitor guide`,
      `${config.destination} workshops live music local experiences official visitor guide`,
      `${config.destination} vegetarian restaurants official menu peanut allergy information`,
    ].slice(0, MAX_SEARCHES);
    for (const query of queries) {
      actions.push({ at: now(), type: "search", detail: query, url: null });
      const search = await browserbase.search({ apiKey: browserbaseKey, query, numResults: 2 });
      for (const result of search.results) {
        if (visitedUrls.length >= MAX_VISITS) break;
        if (!result.url.startsWith("https://")) continue;
        actions.push({ at: now(), type: "visit", detail: result.title, url: result.url });
        try {
          await page.goto(result.url, { timeout: 15_000 });
          visitedUrls.push(result.url);
          const extract = await stagehand.extract(`Extract up to three factual travel candidates from this page for a group of ${config.groupSize} visiting ${config.destination} from ${config.startDate} through ${config.endDate}. Return user-facing name, category, description, accessibility notes, dietary notes, and unverifiedFields in clear English. Faithfully translate non-English source wording into English and set translatedFromSource true when you translated any display field. Do not return Japanese, Chinese, Korean, or other untranslated source text in display fields. Respect vegetarian dining, peanut allergy uncertainty, reduced walking, and step-free preference, but include suitable non-museum choices such as neighborhoods, markets, parks, viewpoints, food, workshops, music, or local experiences when present. Do not guess facts. Leave unverified fields null and list them.`, ExtractedActivities);
          for (const [index, item] of extract.data.activities.entries()) {
            const display = [item.name, item.description, item.address, item.estimatedCost, item.openingHours, item.accessibilityNotes, item.dietaryNotes].filter((value): value is string => value !== null).join(" ");
            if (!isEnglishFacing(display)) {
              actions.push({ at: now(), type: "error", detail: `Skipped untranslated candidate: ${item.name}`, url: result.url });
              continue;
            }
            const candidate = { ...item, id: `research-${visitedUrls.length}-${index}`, destination: config.destination, sourceUrls: [result.url] };
            if (isExplicitlyIncompatible(candidate, config)) {
              actions.push({ at: now(), type: "error", detail: `Skipped incompatible walking-intensive candidate: ${item.name}`, url: result.url });
              continue;
            }
            candidates.push(candidate);
          }
          actions.push({ at: now(), type: "extract", detail: `Extracted ${extract.data.activities.length} candidates`, url: result.url });
        } catch (error) {
          actions.push({ at: now(), type: "error", detail: errorMessage(error), url: result.url });
        }
      }
    }
    const minimum = Math.max(8, inclusiveTripDates(config).length * 2);
    const unique = balanceCandidates([...new Map(candidates.map(candidate => [key(candidate), candidate])).values()], minimum);
    if (unique.length < minimum) {
      const extractionErrors = actions
        .filter(action => action.type === "error")
        .map(action => action.detail)
        .filter((detail, index, entries) => entries.indexOf(detail) === index)
        .join(" | ");
      throw new Error(`research returned ${unique.length} suitable, source-backed candidates; at least ${minimum} are required for a varied ${inclusiveTripDates(config).length}-day draft${extractionErrors ? `: ${extractionErrors}` : ""}`);
    }
    return { mode: "real", status: "researched", sessionId, dashboardUrl: dashboardUrl(sessionId), visitedUrls, actions, candidates: unique, error: null };
  } catch (error) {
    const message = errorMessage(error);
    actions.push({ at: now(), type: "error", detail: message, url: null });
    throw new Error(`itinerary research failed: ${message}`);
  } finally {
    await stagehand?.close();
    await browser?.close().catch(() => undefined);
  }
}
