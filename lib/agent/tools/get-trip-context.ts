import { surveySliceForConversation } from "@/lib/game/conversation";
import type { SurveyAnswers } from "@/lib/game/survey";
import { EmptyArgsSchema, type AgentTool, type AgentToolResult } from "../types";

export const getTripContextTool: AgentTool = {
  name: "get_trip_context",
  description:
    "Compact trip facts for planning: destination, dates, group size, food/accessibility preferences (lab), or public survey slice + destination (chat). Call before inventing constraints.",
  parameters: EmptyArgsSchema,
  capabilities: "both",
  async execute(_raw, ctx): Promise<AgentToolResult> {
    if (ctx.capability === "lab" && ctx.tripConfig) {
      return {
        result: {
          ok: true,
          config: ctx.tripConfig,
          note: "Use only candidates returned by search_places, search_events, or research_live_place. Unknown fields stay unknown.",
        },
      };
    }
    const trip = ctx.trip ?? ctx.miss?.trip;
    const miss = ctx.miss;
    if (!trip || !miss) {
      return { result: { ok: false, reason: "no_trip" } };
    }
    const survey = surveySliceForConversation(
      (miss.claimant.survey_json ?? {}) as SurveyAnswers,
      miss.isDm,
    );
    return {
      result: {
        ok: true,
        destination: trip.destination,
        start_date: trip.start_date,
        end_date: trip.end_date,
        state: trip.state,
        people: miss.people.map((p) => p.display_name),
        survey,
        note: "Private survey answers of other people are never included.",
      },
    };
  },
};
