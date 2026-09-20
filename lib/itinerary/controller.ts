import { GeminiProvider } from "@/lib/llm/gemini";
import {
  LAB_AGENT_SYSTEM,
  LAB_MAX_TOOL_ITERS,
  researchToolsFor,
  runJaplanAgent,
  type AgentTraceStep,
} from "@/lib/agent";
import { developmentTripConfig, inclusiveTripDates, researchMode, type TripConfig } from "./config";
import { generateDraftItinerary, generateMockDraftItinerary } from "./generate";
import { researchActivities } from "./research";
import { researchActivitiesFast } from "./fast-research";
import { itineraryResearchStrategy } from "./research-strategy";
import { balanceCandidates } from "./quality";
import type { CandidateActivity, DraftItinerary, ResearchAction, ResearchSnapshot } from "./schemas";

let generating = false;
export type DevelopmentGeneration = {
  itinerary: DraftItinerary;
  research: ResearchSnapshot;
};

function candidateKey(candidate: CandidateActivity) {
  return candidate.name.trim().toLocaleLowerCase();
}

function actionsFromTrace(trace: AgentTraceStep[]): ResearchAction[] {
  return trace.map((step) => ({
    at: step.at,
    type: "tool" as const,
    detail: step.detail,
    url: null,
    iteration: step.iteration,
    tool: step.tool,
    args: step.args,
    durationMs: step.durationMs,
    candidateCount: step.candidateCount,
    cached: step.cached,
    browserbaseInvoked: step.browserbaseInvoked,
  }));
}

function selectedIds(itinerary: DraftItinerary): string[] {
  const ids: string[] = [];
  for (const day of itinerary.days) {
    for (const activity of day.activities) ids.push(activity.id);
    if (day.diningPlan.candidate) ids.push(day.diningPlan.candidate.id);
  }
  return ids;
}

/** Fast path: Gemini tool loop over Foursquare / Browserbase / trip_events. */
export async function researchActivitiesViaAgent(
  config: TripConfig,
): Promise<ResearchSnapshot> {
  const provider = new GeminiProvider();
  const tools = researchToolsFor("lab");
  const minimum = Math.max(8, inclusiveTripDates(config).length * 2);
  const contents = [
    {
      role: "user" as const,
      parts: [
        {
          text: [
            `Research a varied ${inclusiveTripDates(config).length}-day draft for ${config.destination}`,
            `(${config.startDate} → ${config.endDate}, group of ${config.groupSize}).`,
            `Dietary: ${config.foodPreferences.dietaryRestrictions.join(", ") || "none"}; allergies: ${config.foodPreferences.allergies.join(", ") || "none"}.`,
            `Accessibility: ${config.accessibilityPreferences.mobilityRestrictions.join("; ")}; ${config.accessibilityPreferences.physicalLimitations.join("; ")}.`,
            `Call get_trip_context, then search_places for several queries (attractions, markets, parks, workshops/live music, vegetarian restaurants),`,
            `research_live_place for accessibility or allergy pages when useful, and search_events for ticketed inventory.`,
            `Gather at least ${minimum} source-backed candidates with real ids. Never invent a venue. Then summarise what you found.`,
          ].join(" "),
        },
      ],
    },
  ];

  const agent = await runJaplanAgent({
    capability: "lab",
    system: LAB_AGENT_SYSTEM,
    contents,
    tools,
    maxIterations: LAB_MAX_TOOL_ITERS,
    provider,
    tripConfig: config,
    tier: "smart",
  });

  const actions = actionsFromTrace(agent.trace);
  let candidates = [...agent.candidates];
  let browserbaseInvoked = agent.browserbaseInvoked;
  let visitedUrls: string[] = [];

  // Reliability: if the model stopped short, top up with the existing fast
  // pipeline so the lab still produces a grounded draft.
  if (candidates.length < minimum) {
    const topUp = await researchActivitiesFast(config);
    actions.push({
      at: new Date().toISOString(),
      type: "tool",
      detail: `top-up via researchActivitiesFast (${topUp.candidates.length} candidates; agent had ${candidates.length})`,
      url: null,
      tool: "researchActivitiesFast",
      candidateCount: topUp.candidates.length,
      cached: false,
      browserbaseInvoked: true,
    });
    const merged = new Map<string, CandidateActivity>();
    for (const c of [...candidates, ...topUp.candidates]) {
      if (!merged.has(candidateKey(c))) merged.set(candidateKey(c), c);
    }
    candidates = balanceCandidates([...merged.values()], minimum);
    browserbaseInvoked =
      browserbaseInvoked ||
      topUp.actions.some((a) => /Browserbase/i.test(a.detail));
    visitedUrls = topUp.visitedUrls;
    return {
      mode: "real",
      status: "researched",
      sessionId: null,
      dashboardUrl: null,
      visitedUrls,
      actions: [...actions, ...topUp.actions],
      candidates,
      error: null,
      browserbaseInvoked,
      agentSummary: agent.text || null,
    };
  }

  candidates = balanceCandidates(
    [...new Map(candidates.map((c) => [candidateKey(c), c])).values()],
    minimum,
  );

  return {
    mode: "real",
    status: "researched",
    sessionId: null,
    dashboardUrl: null,
    visitedUrls,
    actions,
    candidates,
    error: null,
    browserbaseInvoked,
    agentSummary: agent.text || null,
  };
}

export async function generateDevelopmentItinerary(): Promise<DevelopmentGeneration> {
  if (generating) throw new Error("itinerary generation is already running");
  generating = true;
  try {
    const mode = researchMode();
    const config = developmentTripConfig;
    let research: ResearchSnapshot;
    if (mode === "mock") {
      research = await researchActivities(config);
    } else if (itineraryResearchStrategy() === "deep") {
      research = await researchActivities(config);
    } else {
      research = await researchActivitiesViaAgent(config);
    }
    const itinerary =
      mode === "mock"
        ? generateMockDraftItinerary(config, research.candidates)
        : await generateDraftItinerary(config, research.candidates);
    research = {
      ...research,
      selectedCandidateIds: selectedIds(itinerary),
    };
    return { itinerary, research };
  } finally {
    generating = false;
  }
}
