import { GoogleGenAI, type Part } from "@google/genai";
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

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("missing GEMINI_API_KEY");
  return key;
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
    const response = await ai.models.generateContent({
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
        ...(opts.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } }
          : {}),
      },
    });
    return response.text?.trim() ?? "";
  }
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

export async function scorePhotoFidelity(opts: {
  provider?: LLMProvider;
  title: string;
  photoBonusMax: number;
  image: { data: string; mime: string };
}): Promise<PhotoFidelityJson | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const shownRaw = await provider.complete({
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
  });
  if (!shownRaw) return null;
  let showsTask = false;
  try {
    const parsed = JSON.parse(shownRaw) as { shows_task?: boolean };
    showsTask = parsed.shows_task === true;
  } catch {
    return null;
  }
  if (!showsTask) return { shows_task: false, fidelity: 0 };

  const scoreRaw = await provider.complete({
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
  });
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
