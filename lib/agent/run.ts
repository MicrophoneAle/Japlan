import { ZodError } from "zod";
import type { ToolTurn } from "@/lib/llm";
import {
  stripPointFields,
  toolResultHasInventedPoints,
  runToolLoop,
} from "@/lib/game/conversation";
import { cacheKey, findTool, toGeminiDeclarations, truncateArgs } from "./registry";
import type {
  AgentContext,
  AgentToolResult,
  AgentTraceStep,
  RunJaplanAgentOpts,
  RunJaplanAgentResult,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Bounded Gemini tool loop shared by the itinerary lab and iMessage conversation.
 * Validates args with Zod, caches identical tool calls, traces every step, and
 * force-finishes text after maxIterations (lab 8 / webhook 3).
 */
export async function runJaplanAgent(
  opts: RunJaplanAgentOpts,
): Promise<RunJaplanAgentResult> {
  const contents = opts.contents;
  const cache = new Map<string, AgentToolResult>();
  const trace: AgentTraceStep[] = [];
  const ctx: AgentContext = {
    capability: opts.capability,
    tripConfig: opts.tripConfig,
    trip: opts.trip,
    miss: opts.miss,
    photo: opts.photo,
    provider: opts.provider,
    candidates: new Map(),
  };
  let browserbaseInvoked = false;
  let currentIteration = 0;
  const declarations = toGeminiDeclarations(opts.tools);
  const tier = opts.tier ?? "fast";

  const generate = async (input: {
    iteration: number;
    forceReply: boolean;
  }): Promise<ToolTurn> => {
    currentIteration = input.iteration;
    if (!opts.provider.completeTurn) {
      const text = await opts.provider.complete({
        system: opts.system,
        messages: [{ role: "user", content: "(agent turn)" }],
        tier,
        thinkingBudget: 0,
      });
      return { text, functionCalls: [] };
    }
    return opts.provider.completeTurn({
      system: opts.system,
      contents,
      tools: declarations,
      toolMode: input.forceReply ? "none" : "auto",
      tier,
      thinkingBudget: 0,
    });
  };

  const loop = await runToolLoop({
    maxIterations: opts.maxIterations,
    generate: async (input) => {
      const turn = await generate(input);
      if (turn.functionCalls.length > 0) {
        contents.push({
          role: "model",
          parts: turn.functionCalls.map((call) => ({
            functionCall: {
              id: call.id,
              name: call.name,
              args: call.args ?? {},
              ...(call.thoughtSignature
                ? { thoughtSignature: call.thoughtSignature }
                : {}),
            },
          })),
        });
      } else if (turn.text) {
        contents.push({ role: "model", parts: [{ text: turn.text }] });
      }
      return {
        text: turn.text,
        calls: turn.functionCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: stripPointFields(call.args ?? {}),
          // thoughtSignature stays on the content history above
        })),
      };
    },
    execute: async (call) => {
      const iteration = currentIteration;
      const tool = findTool(opts.tools, call.name);
      const started = Date.now();
      let executed: AgentToolResult;
      let cached = false;

      if (!tool) {
        executed = { result: { ok: false, reason: "unknown_tool" } };
      } else {
        let parsed: unknown = call.args;
        try {
          parsed = tool.parameters.parse(call.args);
        } catch (err) {
          const message =
            err instanceof ZodError
              ? err.issues.map((i) => i.message).join("; ")
              : "invalid_args";
          executed = { result: { ok: false, reason: "invalid_args", detail: message } };
          trace.push({
            at: nowIso(),
            iteration,
            tool: call.name,
            args: truncateArgs(call.args),
            durationMs: Date.now() - started,
            candidateCount: 0,
            cached: false,
            browserbaseInvoked: false,
            detail: `invalid_args: ${message}`,
          });
          contents.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: call.id,
                  name: call.name,
                  response: executed.result,
                },
              },
            ],
          });
          return { result: executed.result, sent: false };
        }

        const key = cacheKey(call.name, call.args);
        const hit = cache.get(key);
        if (hit) {
          executed = hit;
          cached = true;
        } else {
          executed = await tool.execute(parsed, ctx);
          cache.set(key, executed);
        }
      }

      if (executed.browserbaseInvoked) browserbaseInvoked = true;
      for (const candidate of executed.candidates ?? []) {
        if (!ctx.candidates.has(candidate.id)) {
          ctx.candidates.set(candidate.id, candidate);
        }
      }
      if (toolResultHasInventedPoints(executed.result)) {
        throw new Error("agent tool returned an invented point value");
      }

      const candidateCount = executed.candidates?.length ?? 0;
      trace.push({
        at: nowIso(),
        iteration,
        tool: call.name,
        args: truncateArgs(call.args),
        durationMs: Date.now() - started,
        candidateCount,
        cached,
        browserbaseInvoked: Boolean(executed.browserbaseInvoked),
        detail: cached
          ? `cached ${call.name}`
          : `${call.name} → ${candidateCount} candidates`,
      });

      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: executed.result,
            },
          },
        ],
      });

      return {
        result: executed.result,
        sent: Boolean(executed.sent),
      };
    },
  });

  return {
    text: loop.text,
    toolNames: loop.toolNames,
    sentByTool: loop.sentByTool,
    candidates: [...ctx.candidates.values()],
    trace,
    browserbaseInvoked,
  };
}

export const LAB_AGENT_SYSTEM = [
  "You are Japlan's itinerary research agent.",
  "Use tools to discover real, source-backed candidates. Never invent a venue, hours, price, ticket, or safety claim.",
  "Call get_trip_context first, then search_places for varied queries (attractions, markets, parks, workshops, vegetarian restaurants),",
  "research_live_place for accessibility/allergy pages when needed, and search_events for ticketed inventory.",
  "Every itinerary selection must reference a candidate id returned by a tool. Unknown availability stays unknown.",
  "When you have enough varied candidates, stop calling tools and reply with a short summary of what you found.",
].join(" ");

export const LAB_MAX_TOOL_ITERS = 8;
