import type { LLMProvider, Msg } from "./index";

function modelForTier(tier: "fast" | "smart"): string {
  const name =
    tier === "fast"
      ? process.env.GEMINI_FAST_MODEL
      : process.env.GEMINI_SMART_MODEL;
  if (!name) {
    throw new Error(
      tier === "fast"
        ? "missing GEMINI_FAST_MODEL"
        : "missing GEMINI_SMART_MODEL",
    );
  }
  return name;
}

export class GeminiProvider implements LLMProvider {
  async complete(opts: {
    system: string;
    messages: Msg[];
    schema?: object;
    images?: { data: string; mime: string }[];
    tier: "fast" | "smart";
    thinkingBudget?: number;
  }): Promise<string> {
    void modelForTier(opts.tier);
    throw new Error("not implemented");
  }
}
