import { z } from "zod";
import { browserbase } from "@browserbasehq/stagehand";
import { searchTheWeb } from "@/lib/handlers/web-search";
import { enrichWithBrowserbase } from "@/lib/itinerary/fast-research";
import type { AgentTool, AgentToolResult } from "../types";

export const ResearchLivePlaceArgsSchema = z.object({
  query: z.string().min(1).max(300),
});

export const researchLivePlaceTool: AgentTool = {
  name: "research_live_place",
  description:
    "Look up a real place or topic on the live web. Lab: Browserbase search + fetch + extract (never invents venues). Chat: Browserbase search only (8s, no session). Returns titles/urls or source-backed candidates.",
  parameters: ResearchLivePlaceArgsSchema,
  capabilities: "both",
  async execute(raw, ctx): Promise<AgentToolResult> {
    const args = ResearchLivePlaceArgsSchema.parse(raw);

    if (ctx.capability === "webhook") {
      const outcome = await searchTheWeb(args.query);
      if (!outcome.ok) {
        return {
          result: { ok: false, reason: outcome.reason },
          browserbaseInvoked: outcome.reason !== "unavailable" && outcome.reason !== "is_a_url",
        };
      }
      return {
        result: { ok: true, results: outcome.results },
        browserbaseInvoked: true,
      };
    }

    // Lab: search then fetch+extract the first https result.
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      return { result: { ok: false, reason: "unavailable" }, browserbaseInvoked: false };
    }
    const config = ctx.tripConfig;
    if (!config) {
      return { result: { ok: false, reason: "need_trip_config" }, browserbaseInvoked: false };
    }
    try {
      const search = await browserbase.search({
        apiKey,
        query: args.query,
        numResults: 1,
      });
      const url = search.results.find((r) => r.url.startsWith("https://"))?.url;
      if (!url) {
        return {
          result: { ok: false, reason: "no_results" },
          browserbaseInvoked: true,
        };
      }
      const candidates = await enrichWithBrowserbase(url, config, apiKey);
      return {
        result: {
          ok: true,
          url,
          count: candidates.length,
          candidates: candidates.map((c) => ({
            id: c.id,
            name: c.name,
            category: c.category,
            unverifiedFields: c.unverifiedFields,
          })),
        },
        candidates,
        browserbaseInvoked: true,
      };
    } catch (err) {
      return {
        result: {
          ok: false,
          reason: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
        browserbaseInvoked: true,
      };
    }
  },
};
