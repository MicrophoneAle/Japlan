import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types";

export { searchPlacesTool, SearchPlacesArgsSchema } from "./search-places";
export { searchEventsTool, SearchEventsArgsSchema } from "./search-events";
export { researchLivePlaceTool, ResearchLivePlaceArgsSchema } from "./research-live-place";
export { getTripContextTool } from "./get-trip-context";
export { verifyTaskPhotoTool, VerifyTaskPhotoArgsSchema } from "./verify-task-photo";

/** Accept any args object; never reject a game-tool call that used to run. */
const AnyArgsSchema = z.custom<Record<string, unknown>>((value) => {
  return value === undefined || value === null || (typeof value === "object" && !Array.isArray(value));
}).transform((value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {},
);

/** Wrap an existing conversation tool (JSON-schema based) as a webhook AgentTool. */
export function wrapConversationTool(opts: {
  name: string;
  description: string;
  geminiParameters: object;
  execute: (args: Record<string, unknown>) => Promise<AgentToolResult>;
}): AgentTool {
  return {
    name: opts.name,
    description: opts.description,
    // Never Zod-reject game tools: invalid_args would be a chat regression.
    parameters: AnyArgsSchema,
    geminiParameters: opts.geminiParameters,
    capabilities: "webhook",
    async execute(raw) {
      const args =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      return opts.execute(args);
    },
  };
}
