import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cacheKey,
  researchToolsFor,
  runJaplanAgent,
  toolMatchesCapability,
  toGeminiDeclarations,
  type AgentTool,
} from "@/lib/agent";
import type { LLMProvider, ToolTurn } from "@/lib/llm";
import { SearchPlacesArgsSchema } from "@/lib/agent/tools/search-places";
import { developmentTripConfig, inclusiveTripDates } from "@/lib/itinerary/config";
import { validateModelItinerary } from "@/lib/itinerary/generate";
import { mockResearch } from "@/lib/itinerary/mock-research";

describe("agent registry", () => {
  it("filters tools by capability", () => {
    const lab = researchToolsFor("lab").map((t) => t.name);
    const webhook = researchToolsFor("webhook").map((t) => t.name);
    expect(lab).toContain("search_places");
    expect(lab).toContain("research_live_place");
    expect(lab).not.toContain("verify_task_photo");
    expect(webhook).toContain("verify_task_photo");
    expect(webhook).toContain("search_places");
    expect(toolMatchesCapability({ capabilities: "both" }, "lab")).toBe(true);
    expect(toolMatchesCapability({ capabilities: "webhook" }, "lab")).toBe(false);
  });

  it("rejects invalid tool args with Zod", () => {
    expect(() => SearchPlacesArgsSchema.parse({})).toThrow();
    expect(SearchPlacesArgsSchema.parse({ query: "parks" }).query).toBe("parks");
  });

  it("caches identical tool calls and traces them", async () => {
    let executions = 0;
    const echo: AgentTool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ q: z.string() }),
      capabilities: "both",
      async execute(args) {
        executions += 1;
        return { result: { ok: true, ...(args as object) } };
      },
    };
    const turns: ToolTurn[] = [
      {
        text: "",
        functionCalls: [
          { name: "echo", args: { q: "a" } },
          { name: "echo", args: { q: "a" } },
        ],
      },
      { text: "done", functionCalls: [] },
    ];
    let i = 0;
    const provider: LLMProvider = {
      complete: async () => "done",
      completeTurn: async () => turns[i++] ?? { text: "done", functionCalls: [] },
    };
    const result = await runJaplanAgent({
      capability: "lab",
      system: "test",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [echo],
      maxIterations: 3,
      provider,
      tripConfig: developmentTripConfig,
    });
    expect(executions).toBe(1);
    expect(result.trace.some((s) => s.cached)).toBe(true);
    expect(result.toolNames).toEqual(["echo", "echo"]);
    expect(cacheKey("echo", { q: "a", b: 1 })).toBe(cacheKey("echo", { b: 1, q: "a" }));
  });

  it("returns invalid_args without throwing when Zod fails", async () => {
    const strict: AgentTool = {
      name: "need_query",
      description: "needs query",
      parameters: z.object({ query: z.string().min(1) }),
      capabilities: "lab",
      async execute() {
        throw new Error("should not run");
      },
    };
    const turns: ToolTurn[] = [
      { text: "", functionCalls: [{ name: "need_query", args: {} }] },
      { text: "sorry", functionCalls: [] },
    ];
    let i = 0;
    const provider: LLMProvider = {
      complete: async () => "sorry",
      completeTurn: async () => turns[i++] ?? { text: "sorry", functionCalls: [] },
    };
    const result = await runJaplanAgent({
      capability: "lab",
      system: "test",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [strict],
      maxIterations: 3,
      provider,
      tripConfig: developmentTripConfig,
    });
    expect(result.trace[0]?.detail).toMatch(/invalid_args/);
    expect(result.text).toBe("sorry");
  });

  it("declares tools for Gemini", () => {
    const decls = toGeminiDeclarations(researchToolsFor("lab"));
    expect(decls.find((d) => d.name === "search_places")?.parameters).toBeTruthy();
  });

  it("force-finishes after max iterations", async () => {
    let turns = 0;
    const provider: LLMProvider = {
      complete: async () => "final",
      completeTurn: async (opts) => {
        turns += 1;
        if (opts.toolMode === "none") return { text: "best grounded answer", functionCalls: [] };
        return {
          text: "",
          functionCalls: [{ name: "echo", args: { q: String(turns) } }],
        };
      },
    };
    const echo: AgentTool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ q: z.string() }),
      capabilities: "both",
      async execute(args) {
        return { result: { ok: true, ...(args as object) } };
      },
    };
    const result = await runJaplanAgent({
      capability: "lab",
      system: "test",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [echo],
      maxIterations: 2,
      provider,
    });
    expect(result.text).toBe("best grounded answer");
    expect(result.toolNames.length).toBe(2);
  });
});

describe("agent grounding", () => {
  it("still rejects invented candidate ids at draft validation", () => {
    const candidates = mockResearch(developmentTripConfig).candidates;
    const dates = inclusiveTripDates(developmentTripConfig);
    const model = {
      days: dates.map((date, index) => ({
        date,
        dayNumber: index + 1,
        summary: "A varied day of discovery.",
        activities: [
          {
            candidateActivityId: index === 0 ? "invented-id" : candidates[index * 2]!.id,
            startTime: "10:00",
            endTime: "12:00",
            notes: "Tentative draft timing.",
          },
          {
            candidateActivityId: candidates[index * 2 + 1]!.id,
            startTime: "13:30",
            endTime: "17:00",
            notes: "Tentative draft timing.",
          },
        ],
        diningPlan: {
          candidateActivityId: null,
          startTime: "12:00",
          endTime: "13:30",
          notes: "Choose a nearby vegetarian option and confirm peanut cross-contact directly with the venue.",
        },
      })),
    };
    expect(() =>
      validateModelItinerary(model as never, developmentTripConfig, candidates),
    ).toThrow(/unknown candidate/);
  });
});

describe("webhook capability gates", () => {
  it("search_places on webhook without a trip does not invent places", async () => {
    const tool = researchToolsFor("webhook").find((t) => t.name === "search_places");
    expect(tool).toBeTruthy();
    const out = await tool!.execute(
      { query: "parks" },
      { capability: "webhook", candidates: new Map() },
    );
    expect(out.result).toMatchObject({ ok: false, reason: "no_trip" });
    expect(out.candidates ?? []).toEqual([]);
  });

  it("research_live_place on webhook without a key never claims browserbase launch", async () => {
    const tool = researchToolsFor("webhook").find((t) => t.name === "research_live_place");
    expect(tool).toBeTruthy();
    const prev = process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_API_KEY;
    try {
      const out = await tool!.execute(
        { query: "teriyaki osaka" },
        { capability: "webhook", candidates: new Map() },
      );
      expect(out.result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(out.browserbaseInvoked).toBe(false);
    } finally {
      if (prev !== undefined) process.env.BROWSERBASE_API_KEY = prev;
    }
  });
});
