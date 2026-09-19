import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type Part,
} from "@google/genai";
import type { LLMProvider, Msg, ToolContent, ToolTurn } from "./index";
import { withTimeout } from "@/lib/timeout";

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

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("missing GEMINI_API_KEY");
  return key;
}

export type ThinkingConfig = { thinkingBudget?: number; thinkingLevel?: ThinkingLevel };

// Callers say thinkingBudget: 0 to mean "no reasoning, this is a
// classification". gemini-3.5-flash-lite rejects a zero budget with a bare
// 400 INVALID_ARGUMENT (verified 2026-09-19), which failed every fast-tier
// call: photo vision, claim matching, conversation, setup. Zero maps to the
// minimal thinking level, which every current model accepts.
export function thinkingConfigFor(budget: number | undefined): ThinkingConfig | undefined {
  if (budget === undefined) return undefined;
  if (budget <= 0) return { thinkingLevel: ThinkingLevel.MINIMAL };
  return { thinkingBudget: budget };
}

// Only the bare "Request contains an invalid argument." is the thinking-config
// rejection. A 400 that names its problem (e.g. a missing thought_signature)
// is a different bug and must surface, not be retried and mislabelled.
function isBareInvalidArgument(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /INVALID_ARGUMENT/.test(message) && /Request contains an invalid argument/.test(message);
}

// If a model rejects the thinking config, retry once without it rather than
// failing the call. Logged loudly: it means a model changed under us.
async function generateWithThinkingFallback(
  ai: GoogleGenAI,
  request: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  try {
    return await ai.models.generateContent(request);
  } catch (err) {
    if (!request.config?.thinkingConfig || !isBareInvalidArgument(err)) throw err;
    console.error("[japlan.llm] model rejected thinkingConfig; retrying without it", {
      model: request.model,
      thinkingConfig: request.config.thinkingConfig,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    const { thinkingConfig: _dropped, ...config } = request.config;
    void _dropped;
    return ai.models.generateContent({ ...request, config });
  }
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
    const parts: Part[] = [];
    for (const image of opts.images ?? []) {
      parts.push({
        inlineData: { mimeType: image.mime, data: image.data },
      });
    }
    for (const message of opts.messages) {
      parts.push({ text: message.content });
    }

    const ai = new GoogleGenAI({ apiKey: apiKey() });
    const thinkingConfig = thinkingConfigFor(opts.thinkingBudget);
    const response = await generateWithThinkingFallback(ai, {
      model: modelForTier(opts.tier),
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: opts.system,
        ...(opts.schema
          ? {
              responseMimeType: "application/json",
              responseSchema: opts.schema,
            }
          : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    });
    return response.text?.trim() ?? "";
  }

  async completeTurn(opts: {
    system: string;
    contents: ToolContent[];
    tools: { name: string; description: string; parameters: object }[];
    toolMode: "auto" | "none";
    tier: "fast" | "smart";
    thinkingBudget?: number;
  }): Promise<ToolTurn> {
    const ai = new GoogleGenAI({ apiKey: apiKey() });
    const forceText = opts.toolMode === "none";
    // Forcing a text reply: gemini-3.5-flash-lite ignores functionCallingConfig
    // NONE and answers a tool-laden history with another call and no text
    // (verified 2026-09-19, with and without tools declared). So the history
    // is replayed as plain text and no tools are offered; nothing to call.
    const contents = (forceText ? flattenToolHistory(opts.contents) : opts.contents).map(
      (entry) => contentFromTurn(entry),
    );
    const thinkingConfig = thinkingConfigFor(opts.thinkingBudget);
    const response = await generateWithThinkingFallback(ai, {
      model: modelForTier(opts.tier),
      contents,
      config: {
        systemInstruction: opts.system,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(forceText
          ? {}
          : {
              tools: [
                {
                  functionDeclarations: opts.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.parameters,
                  })),
                },
              ],
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
              },
            }),
      },
    });
    // Read calls from the raw parts, not response.functionCalls: only the part
    // carries the thoughtSignature that must be sent back next turn.
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const calls = parts
      .filter((part) => part.functionCall?.name)
      .map((part) => ({
        id: part.functionCall?.id,
        name: part.functionCall?.name ?? "",
        args: (part.functionCall?.args ?? {}) as Record<string, unknown>,
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      }));
    return {
      text: response.text?.trim() ?? "",
      functionCalls: calls,
    };
  }
}

// Tool calls and results rewritten as text, so a final reply can be produced
// without offering tools. Keeps what was looked up; drops the call mechanics.
export function flattenToolHistory(contents: ToolContent[]): ToolContent[] {
  return contents.map((entry) => ({
    role: entry.role,
    parts: entry.parts.map((part) => {
      if ("functionCall" in part) {
        return { text: `(looked up ${part.functionCall.name})` };
      }
      if ("functionResponse" in part) {
        return {
          text: `${part.functionResponse.name} result: ${JSON.stringify(part.functionResponse.response)}`,
        };
      }
      return part;
    }),
  }));
}

function contentFromTurn(entry: ToolContent): Content {
  const parts: Part[] = [];
  for (const part of entry.parts) {
    if ("text" in part) {
      parts.push({ text: part.text });
    } else if ("functionCall" in part) {
      parts.push({
        functionCall: {
          id: part.functionCall.id,
          name: part.functionCall.name,
          args: part.functionCall.args,
        },
        ...(part.functionCall.thoughtSignature
          ? { thoughtSignature: part.functionCall.thoughtSignature }
          : {}),
      });
    } else {
      parts.push({
        functionResponse: {
          id: part.functionResponse.id,
          name: part.functionResponse.name,
          response: part.functionResponse.response,
        },
      });
    }
  }
  return { role: entry.role, parts };
}

export const CLAIM_MATCH_SCHEMA = {
  type: "object",
  properties: {
    task_code: { type: "string" },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["task_code", "confidence", "reasoning"],
};

export const PHOTO_SHOWS_SCHEMA = {
  type: "object",
  properties: {
    shows_task: { type: "boolean" },
  },
  required: ["shows_task"],
};

export const PHOTO_FIDELITY_SCHEMA = {
  type: "object",
  properties: {
    fidelity: { type: "integer" },
  },
  required: ["fidelity"],
};

export type ClaimMatchJson = {
  task_code: string;
  confidence: number;
  reasoning: string;
};

export type PhotoFidelityJson = {
  shows_task: boolean;
  fidelity: number;
};

export async function matchClaimText(opts: {
  provider?: LLMProvider;
  text: string;
  tasks: { code: string; title: string }[];
}): Promise<ClaimMatchJson | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const catalog = opts.tasks
    .map((task) => `${task.code}: ${task.title}`)
    .join("\n");
  const raw = await provider.complete({
    system:
      "Classify which open task the message is claiming. Return JSON only. If none match, task_code is an empty string. Classification, not reasoning.",
    messages: [
      {
        role: "user",
        content: `Open tasks:\n${catalog}\n\nMessage:\n${opts.text}`,
      },
    ],
    schema: CLAIM_MATCH_SCHEMA,
    tier: "fast",
    thinkingBudget: 0,
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClaimMatchJson;
    const code =
      typeof parsed.task_code === "string" ? parsed.task_code.trim() : "";
    if (!code) return null;
    const listed = opts.tasks.some(
      (task) => task.code.toUpperCase() === code.toUpperCase(),
    );
    if (!listed) return null;
    return {
      task_code: code,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    };
  } catch {
    return null;
  }
}

export const DEFAULT_VISION_TIMEOUT_MS = 20_000;

export function visionTimeoutMs(value = process.env.JAPLAN_VISION_TIMEOUT_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VISION_TIMEOUT_MS;
}

// Each vision call is bounded: a hung Gemini request throws TimeoutError
// instead of holding the claim until the function is killed.
export async function scorePhotoFidelity(opts: {
  provider?: LLMProvider;
  title: string;
  photoBonusMax: number;
  image: { data: string; mime: string };
  timeoutMs?: number;
}): Promise<PhotoFidelityJson | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const timeoutMs = opts.timeoutMs ?? visionTimeoutMs();
  const shownRaw = await withTimeout(provider.complete({
    system:
      "Answer one question: does this photo show the task. Return JSON only. Classification, not reasoning.",
    messages: [
      {
        role: "user",
        content: `Task: "${opts.title}". Does this photo show it?`,
      },
    ],
    images: [opts.image],
    schema: PHOTO_SHOWS_SCHEMA,
    tier: "fast",
    thinkingBudget: 0,
  }), timeoutMs, "gemini.vision.shows_task");
  if (!shownRaw) return null;
  let showsTask = false;
  try {
    const parsed = JSON.parse(shownRaw) as { shows_task?: boolean };
    showsTask = parsed.shows_task === true;
  } catch {
    return null;
  }
  if (!showsTask) return { shows_task: false, fidelity: 0 };

  const scoreRaw = await withTimeout(provider.complete({
    system:
      "Score only how completely the photo shows the tasked thing, 0 through the given ceiling. Do not score photo quality. Return JSON only.",
    messages: [
      {
        role: "user",
        content: `Task: "${opts.title}". Score fidelity 0-${opts.photoBonusMax}.`,
      },
    ],
    images: [opts.image],
    schema: PHOTO_FIDELITY_SCHEMA,
    tier: "fast",
    thinkingBudget: 0,
  }), timeoutMs, "gemini.vision.fidelity");
  if (!scoreRaw) return { shows_task: true, fidelity: 0 };
  try {
    const parsed = JSON.parse(scoreRaw) as { fidelity?: number };
    const ceiling = Math.max(0, opts.photoBonusMax);
    const fidelity = Math.min(
      ceiling,
      Math.max(0, Math.round(Number(parsed.fidelity) || 0)),
    );
    return { shows_task: true, fidelity };
  } catch {
    return { shows_task: true, fidelity: 0 };
  }
}

export const FREEFORM_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    is_completed_activity: { type: "boolean" },
    title: { type: "string" },
    place_name: { type: "string" },
    neighborhood: { type: "string" },
    duration_minutes: { type: "integer" },
    lat: { type: "number" },
    lng: { type: "number" },
    category: { type: "string" },
    axes: {
      type: "object",
      properties: {
        boldness: { type: "integer" },
        physical: { type: "integer" },
        time: { type: "integer" },
        scarcity: { type: "integer" },
        cultural: { type: "integer" },
        aesthetics: { type: "integer" },
      },
      required: [
        "boldness",
        "physical",
        "time",
        "scarcity",
        "cultural",
        "aesthetics",
      ],
    },
  },
  required: ["is_completed_activity", "title", "axes"],
};

export const SETUP_LLM_TIMEOUT_MS = 10_000;

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const TRIP_DATES_SCHEMA = {
  type: "object",
  properties: {
    understood: { type: "boolean" },
    start_date: { type: "string" },
    end_date: { type: "string" },
  },
  required: ["understood", "start_date", "end_date"],
};

// Loose dates ("march 14-19", "next weekend") to ISO. The result is only a
// proposal: checkDateRange in lib/game/setup.ts validates it in code.
export async function extractTripDates(opts: {
  provider?: LLMProvider;
  text: string;
  today: string;
}): Promise<{ start: string; end: string } | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const raw = await withTimeout(
    provider.complete({
      system:
        "Convert a trip's travel dates to ISO YYYY-MM-DD. Today's date is given. Resolve relative phrases against today. A range with no year is the next occurrence on or after today. A weekend is Saturday to Sunday. If the message does not describe dates, understood is false and both dates are empty strings. JSON only.",
      messages: [{ role: "user", content: `today: ${opts.today}\nmessage: ${opts.text}` }],
      schema: TRIP_DATES_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
    }),
    SETUP_LLM_TIMEOUT_MS,
    "gemini.trip_dates",
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  if (!parsed || parsed.understood !== true) return null;
  const start = typeof parsed.start_date === "string" ? parsed.start_date.trim() : "";
  const end = typeof parsed.end_date === "string" ? parsed.end_date.trim() : "";
  return start && end ? { start, end } : null;
}

export const PLACE_TIMEZONE_SCHEMA = {
  type: "object",
  properties: {
    display_name: { type: "string" },
    timezone: { type: "string" },
  },
  required: ["display_name", "timezone"],
};

// Names the destination and its IANA timezone from what Foursquare resolved
// (or, when it could not, the organizer's raw text). The caller rejects any
// zone that is not a real IANA name or does not fit the longitude.
export async function inferPlaceTimezone(opts: {
  provider?: LLMProvider;
  text: string;
  area: {
    lat: number | null;
    lng: number | null;
    locality: string | null;
    region: string | null;
    country: string | null;
  } | null;
}): Promise<{ display: string; timezone: string } | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const evidence = opts.area
    ? `resolved by places search: locality ${opts.area.locality ?? "?"}, region ${opts.area.region ?? "?"}, country ${opts.area.country ?? "?"}, lat ${opts.area.lat ?? "?"}, lng ${opts.area.lng ?? "?"}`
    : "not resolved by places search";
  const raw = await withTimeout(
    provider.complete({
      system:
        "Given a travel destination, return a short lowercase display name (city, country) and the IANA timezone name, such as Asia/Tokyo. Never an abbreviation or UTC offset. If you cannot tell where it is, return empty strings. JSON only.",
      messages: [{ role: "user", content: `destination: ${opts.text}\n${evidence}` }],
      schema: PLACE_TIMEZONE_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
    }),
    SETUP_LLM_TIMEOUT_MS,
    "gemini.place_timezone",
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  if (!parsed) return null;
  const display = typeof parsed.display_name === "string" ? parsed.display_name.trim() : "";
  const timezone = typeof parsed.timezone === "string" ? parsed.timezone.trim() : "";
  if (!timezone) return null;
  return { display: display || opts.text.trim(), timezone };
}

export async function extractFreeformActivity(opts: {
  provider?: LLMProvider;
  text: string;
}): Promise<string> {
  const provider = opts.provider ?? new GeminiProvider();
  return provider.complete({
    system:
      "Extract a completed real-world activity from the message. Axes are integers 1-5. Never include a point value. If the message is not claiming something they already did, is_completed_activity is false. JSON only.",
    messages: [{ role: "user", content: opts.text }],
    schema: FREEFORM_EXTRACT_SCHEMA,
    tier: "fast",
    thinkingBudget: 0,
  });
}
