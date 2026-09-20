import { z } from "zod";
import type { AgentCapability, AgentTool } from "./types";
import { toolMatchesCapability } from "./types";
import { searchPlacesTool } from "./tools/search-places";
import { searchEventsTool } from "./tools/search-events";
import { researchLivePlaceTool } from "./tools/research-live-place";
import { getTripContextTool } from "./tools/get-trip-context";
import { verifyTaskPhotoTool } from "./tools/verify-task-photo";

/** Research tools shared by the itinerary lab and (webhook-safe subset) iMessage. */
export const RESEARCH_TOOLS: AgentTool[] = [
  searchPlacesTool,
  searchEventsTool,
  researchLivePlaceTool,
  getTripContextTool,
  verifyTaskPhotoTool,
];

export function researchToolsFor(capability: AgentCapability): AgentTool[] {
  return RESEARCH_TOOLS.filter((tool) => toolMatchesCapability(tool, capability));
}

/** Stable JSON for duplicate-call cache keys (sorted object keys). */
export function stableArgsJson(args: Record<string, unknown>): string {
  return JSON.stringify(sortValue(args));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function cacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableArgsJson(args)}`;
}

/** Truncate args for the Research Inspector (never dump huge markdown). */
export function truncateArgs(
  args: Record<string, unknown>,
  max = 400,
): Record<string, unknown> {
  const raw = stableArgsJson(args);
  if (raw.length <= max) return args;
  return { _truncated: raw.slice(0, max) + "…" };
}

export function toGeminiDeclarations(
  tools: AgentTool[],
): { name: string; description: string; parameters: object }[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: (tool.geminiParameters ?? z.toJSONSchema(tool.parameters)) as object,
  }));
}

export function findTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((tool) => tool.name === name);
}
