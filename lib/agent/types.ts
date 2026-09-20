import { z } from "zod";
import type { LLMProvider, ToolContent } from "@/lib/llm";
import type { CandidateActivity } from "@/lib/itinerary/schemas";
import type { TripConfig } from "@/lib/itinerary/config";
import type { ClaimFallthrough } from "@/lib/handlers/claims";
import type { TripRow } from "@/lib/db/types";

export type AgentCapability = "lab" | "webhook" | "both";

export type AgentTraceStep = {
  at: string;
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  candidateCount: number;
  cached: boolean;
  browserbaseInvoked: boolean;
  detail: string;
};

export type AgentToolResult = {
  result: Record<string, unknown>;
  sent?: boolean;
  candidates?: CandidateActivity[];
  browserbaseInvoked?: boolean;
};

export type AgentContext = {
  capability: AgentCapability;
  tripConfig?: TripConfig;
  trip?: TripRow;
  miss?: ClaimFallthrough;
  photo?: { data: string; mime: string } | null;
  provider?: LLMProvider;
  /** Accumulated source-backed candidates for this agent run. */
  candidates: Map<string, CandidateActivity>;
};

export type AgentTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  /** When set, declared to Gemini instead of z.toJSONSchema(parameters). */
  geminiParameters?: object;
  capabilities: AgentCapability;
  execute: (args: unknown, ctx: AgentContext) => Promise<AgentToolResult>;
};

export type RunJaplanAgentOpts = {
  capability: AgentCapability;
  system: string;
  contents: ToolContent[];
  tools: AgentTool[];
  maxIterations: number;
  provider: LLMProvider;
  tripConfig?: TripConfig;
  trip?: TripRow;
  miss?: ClaimFallthrough;
  photo?: { data: string; mime: string } | null;
  tier?: "fast" | "smart";
};

export type RunJaplanAgentResult = {
  text: string;
  toolNames: string[];
  sentByTool: boolean;
  candidates: CandidateActivity[];
  trace: AgentTraceStep[];
  browserbaseInvoked: boolean;
};

export const EmptyArgsSchema = z.object({}).passthrough();

export function toolMatchesCapability(
  tool: Pick<AgentTool, "capabilities">,
  capability: AgentCapability,
): boolean {
  return tool.capabilities === "both" || tool.capabilities === capability;
}
