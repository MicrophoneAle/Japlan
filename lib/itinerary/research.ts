import { browserbase, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { researchMode, type TripConfig } from "./config";
import { mockResearch } from "./mock-research";
import { CandidateActivitySchema, type CandidateActivity, type ResearchAction, type ResearchSnapshot } from "./schemas";

const ExtractedActivities = z.object({ activities: z.array(CandidateActivitySchema.omit({ id: true, destination: true, sourceUrls: true })).max(4) });
const MAX_SEARCHES = 3;
const MAX_VISITS = 6;

function now() { return new Date().toISOString(); }
function key(candidate: CandidateActivity) { return candidate.name.trim().toLocaleLowerCase(); }
function dashboardUrl(sessionId: string | null) { return sessionId ? `https://www.browserbase.com/sessions/${sessionId}` : null; }

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
  let stagehand: Stagehand | undefined;
  try {
    const browser = await browserbase.launch({ apiKey: browserbaseKey, projectId });
    sessionId = (browser as unknown as { sessionId?: string }).sessionId ?? null;
    stagehand = await Stagehand.create({ browser, model: { modelName: (process.env.STAGEHAND_MODEL ?? "google/gemini-2.5-flash") as never, apiKey: geminiKey }, logging: { level: "info", format: "json" } });
    const [page] = await browser.context.pages();
    if (!page) throw new Error("Browserbase did not provide an active page");
    const queries = [
      `${config.destination} official accessible attractions step free access`,
      `${config.destination} official cultural attractions October ${config.startDate.slice(0, 4)}`,
      `${config.destination} vegetarian restaurants official menu peanut allergy information`,
    ].slice(0, MAX_SEARCHES);
    for (const query of queries) {
      actions.push({ at: now(), type: "search", detail: query, url: null });
      const search = await browserbase.search({ apiKey: browserbaseKey, query, numResults: 3 });
      for (const result of search.results) {
        if (visitedUrls.length >= MAX_VISITS) break;
        if (!result.url.startsWith("https://")) continue;
        actions.push({ at: now(), type: "visit", detail: result.title, url: result.url });
        try {
          await page.goto(result.url, { timeout: 15_000 });
          visitedUrls.push(result.url);
          const extract = await stagehand.extract(`Extract only factual travel candidates on this page for a group of ${config.groupSize} visiting ${config.destination} from ${config.startDate} through ${config.endDate}. Respect vegetarian dining, peanut allergy uncertainty, reduced walking, and step-free preference. Do not guess facts. Leave unverified fields null and list them.`, ExtractedActivities);
          for (const [index, item] of extract.data.activities.entries()) {
            candidates.push({ ...item, id: `research-${visitedUrls.length}-${index}`, destination: config.destination, sourceUrls: [result.url] });
          }
          actions.push({ at: now(), type: "extract", detail: `Extracted ${extract.data.activities.length} candidates`, url: result.url });
        } catch (error) {
          actions.push({ at: now(), type: "error", detail: error instanceof Error ? error.message : "Research extraction failed", url: result.url });
        }
      }
    }
    const unique = [...new Map(candidates.map(candidate => [key(candidate), candidate])).values()];
    if (unique.length < 3) throw new Error("research returned too few suitable, source-backed candidates");
    return { mode: "real", status: "researched", sessionId, dashboardUrl: dashboardUrl(sessionId), visitedUrls, actions, candidates: unique, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Research failed";
    actions.push({ at: now(), type: "error", detail: message, url: null });
    throw new Error(`itinerary research failed: ${message}`);
  } finally {
    await stagehand?.close();
  }
}
