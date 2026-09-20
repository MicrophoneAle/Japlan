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
    temperature?: number;
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
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
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

// "seen" comes first so the model looks before it answers, and so every
// check logs what the model actually saw: proof the image arrived intact.
export const PHOTO_RELATES_SCHEMA = {
  type: "object",
  properties: {
    seen: { type: "string" },
    relates: { type: "boolean" },
  },
  required: ["seen", "relates"],
  propertyOrdering: ["seen", "relates"],
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
  seen: string;
  // Exactly what the model returned, for the logs.
  raw: { relates: string; fidelity: string | null };
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

// PLAN: score fidelity, not quality, and ask two easy questions rather than
// one hard one. A photo is evidence, not proof: it cannot show a place's
// name, an action in progress, or that something was done. So the first
// question is only "does this plausibly relate", biased to yes, and the
// bounded score is asked only after a yes. A loose photo occasionally earning
// a bonus is fine; a bonus that never fires is the bug this replaced (it asked
// "does this photo show the task", and a bench was not "finding a bench").
export const PHOTO_RELATES_SYSTEM = [
  "You check photos for a travel game. A player sends a photo as evidence for a task they did.",
  "Evidence, not proof. A photo cannot show a place's name, that an action happened, how long it took, or how it felt. Never require that.",
  "relates is true when the photo plausibly goes with the task: its main subject, kind of place, food, object, activity or scene fits, even loosely or only in part. A park bench goes with a bench task whichever park it is. Any garden or greenery goes with a garden stroll.",
  "relates is false only when the photo clearly has nothing to do with the task: a different kind of thing entirely, a screenshot or meme, or a blank or black frame.",
  "When unsure, relates is true. The photo may be rotated; judge the content.",
  "seen: a few plain words on what the photo shows.",
].join(" ");

export const PHOTO_FIDELITY_SYSTEM = [
  "A player's photo already counts as evidence for a travel game task. Score how much of the task it shows, from 1 to the given maximum.",
  "1: loosely related. The maximum: the task's main subject is plainly in frame.",
  "Score content only. Ignore photo quality, lighting, framing, rotation and whether a named place can be confirmed.",
].join(" ");

// Each vision call is bounded: a hung Gemini request throws TimeoutError
// instead of holding the claim until the function is killed. An empty or
// unreadable answer returns null, which callers treat as a failed check
// (ask again), never as "doesn't look like it".
export async function scorePhotoFidelity(opts: {
  provider?: LLMProvider;
  title: string;
  photoBonusMax: number;
  image: { data: string; mime: string };
  timeoutMs?: number;
}): Promise<PhotoFidelityJson | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const timeoutMs = opts.timeoutMs ?? visionTimeoutMs();
  const relatesRaw = await withTimeout(provider.complete({
    system: PHOTO_RELATES_SYSTEM,
    messages: [{ role: "user", content: `Task: "${opts.title}"` }],
    images: [opts.image],
    schema: PHOTO_RELATES_SCHEMA,
    tier: "fast",
    thinkingBudget: 0,
    temperature: 0,
  }), timeoutMs, "gemini.vision.relates");
  const relates = parseJsonObject(relatesRaw);
  if (!relates || typeof relates.relates !== "boolean") return null;
  const seen = typeof relates.seen === "string" ? relates.seen.slice(0, 200) : "";
  if (!relates.relates) {
    return { shows_task: false, fidelity: 0, seen, raw: { relates: relatesRaw, fidelity: null } };
  }

  const ceiling = Math.max(0, opts.photoBonusMax);
  // A yes is worth at least 1: a match that paid nothing read as a rejection.
  const floor = Math.min(1, ceiling);
  let scoreRaw = "";
  try {
    scoreRaw = await withTimeout(provider.complete({
      system: PHOTO_FIDELITY_SYSTEM,
      messages: [{ role: "user", content: `Task: "${opts.title}". Maximum: ${ceiling}.` }],
      images: [opts.image],
      schema: PHOTO_FIDELITY_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
      temperature: 0,
    }), timeoutMs, "gemini.vision.fidelity");
  } catch {
    // The yes stands; a failed score costs only the difference above 1.
    scoreRaw = "";
  }
  const scored = Number(parseJsonObject(scoreRaw)?.fidelity);
  const fidelity = Number.isFinite(scored)
    ? Math.min(ceiling, Math.max(floor, Math.round(scored)))
    : floor;
  return { shows_task: true, fidelity, seen, raw: { relates: relatesRaw, fidelity: scoreRaw || null } };
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

export const PREFERRED_NAME_SCHEMA = {
  type: "object",
  properties: { preferred_name: { type: "string" } },
  required: ["preferred_name"],
};

const PREFERRED_NAME_TIMEOUT_MS = 6_000;

function cleanPreferredName(value: string): string | null {
  const name = value.trim().replace(/^["'“”‘’]+|["'“”‘’.,!?]+$/g, "").replace(/\s+/g, " ");
  if (!name || name.length > 48) return null;
  if (/^(?:no|none|nothing|not|n\/a|idk|maybe|whatever|anything|the|i|me|skip|don't|dont)$/i.test(name.split(/\s+/, 1)[0])) return null;
  return /^(?:[\p{L}\p{M}][\p{L}\p{M}'’.-]*)(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){0,3}$/u.test(name)
    ? name
    : null;
}

// Local fallback for a model timeout or an answer shaped like "call me Elrich".
// Unknown sentences return null so the survey can ask again instead of saving
// a filler word as someone's name.
export function fallbackPreferredName(text: string): string | null {
  let value = text.trim().replace(/[.!?]+$/, "").trim();
  const lead = value.match(/^(?:you can call me|please call me|call me|my name(?: is|'s|’s)|this is|i am|i['’]m|im|i go by|go by|name is|it's|it’s|its)\s+(.+)$/i);
  if (lead) value = lead[1].trim();
  else if (/\s/.test(value)) return null;
  return cleanPreferredName(value);
}

// Called only for the survey's name answer, once. The model returns only the
// name explicitly supplied; callers use the local parser if this fails.
export async function extractPreferredName(opts: {
  provider?: LLMProvider;
  text: string;
}): Promise<string | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const raw = await withTimeout(
    provider.complete({
      system: "Extract the preferred name the person wants to be called from one survey answer. Return only that name in JSON as preferred_name. Understand answers such as 'call me Elrich', 'I'm Elrich', 'Elrich', and 'my name is Elrich Chen'. Do not include leading phrases, explanations, titles, or other words. If no name is clearly stated, return an empty string. Do not invent or correct a name.",
      messages: [{ role: "user", content: opts.text.slice(0, 240) }],
      schema: PREFERRED_NAME_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
      temperature: 0,
    }),
    PREFERRED_NAME_TIMEOUT_MS,
    "gemini.preferred_name",
  );
  const parsed = parseJsonObject(raw);
  return typeof parsed?.preferred_name === "string"
    ? cleanPreferredName(parsed.preferred_name)
    : null;
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

export const FESTIVALS_SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          name: { type: "string" },
        },
        required: ["date", "name"],
      },
    },
  },
  required: ["days"],
};

export type ExtractedFestival = { date: string; name: string };

// Local festivals and city events off a fetched page: a neighbourhood matsuri,
// a street festival, a parade. National holidays do NOT come from here, they
// come from Nager.Date (lib/holidays/nager.ts); this is only the tier no
// holiday API carries. The page comes from Browserbase (lib/handlers/
// holidays.ts); this only reads it. Everything here is a proposal:
// validSpecialDays in lib/game/multipliers.ts drops anything that does not
// parse or falls outside the trip, so a bad page cannot award 40x.
export async function extractLocalFestivals(opts: {
  provider?: LLMProvider;
  pageText: string;
  destination: string;
  start: string;
  end: string;
}): Promise<ExtractedFestival[]> {
  const provider = opts.provider ?? new GeminiProvider();
  const raw = await withTimeout(
    provider.complete({
      system: [
        "Read the page and list local festivals and city events for the given destination that fall inside the date range.",
        "Wanted: neighbourhood festivals, matsuri, street fairs, parades, fireworks nights, big one-off city events.",
        "Not wanted: national public holidays, anything that is only a shop sale, and anything with no date.",
        "For an event running several days, list one entry per date it covers, each with the same name.",
        "date is ISO YYYY-MM-DD. Only dates inside the range. If the page shows none, days is an empty array.",
        "Do not invent events that are not on the page. JSON only.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: `destination: ${opts.destination}
range: ${opts.start} to ${opts.end}
page:
${opts.pageText}`,
        },
      ],
      schema: FESTIVALS_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
    }),
    SETUP_LLM_TIMEOUT_MS,
    "gemini.festivals",
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  const days = parsed?.days;
  if (!Array.isArray(days)) return [];
  return days.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const date = typeof row.date === "string" ? row.date.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    return date && name ? [{ date, name }] : [];
  });
}

export const SOCIAL_PLACE_SCHEMA = {
  type: "object",
  properties: {
    place_name: { type: "string" },
    city: { type: "string" },
    address: { type: "string" },
    category: { type: "string" },
    confident: { type: "boolean" },
  },
  required: ["place_name", "city", "address", "category", "confident"],
};

export type SocialPlace = {
  place_name: string | null;
  city: string | null;
  address: string | null;
  category: string | null;
};

// A caption or article body to a place, if it names one. Reading only: the
// text came off a TikTok caption or an Instagram post (lib/social/read-link.ts)
// and is full of hashtags, emoji and unrelated chatter.
//
// Returning nothing is a NORMAL outcome and the prompt says so, because most
// of the miss cases are posts that genuinely do not name a venue. An invented
// place is far worse than an unresolved one: the unresolved caption is kept
// and the group can clarify, while a made-up name lands on someone's board.
export async function extractPlaceFromText(opts: {
  provider?: LLMProvider;
  text: string;
  destination?: string | null;
}): Promise<SocialPlace | null> {
  const provider = opts.provider ?? new GeminiProvider();
  const raw = await withTimeout(
    provider.complete({
      system: [
        "You read a social media caption or article and say which real, visitable place it is about, if any.",
        "place_name is the venue as a person would search for it: a restaurant, bar, cafe, shop, museum, park or landmark.",
        "city is the city it is in. address is the street address ONLY if the text states one. category is one word.",
        "confident is true only when the text actually names the place.",
        "Return empty strings and confident=false when the text names no specific venue, which is common and completely fine.",
        "Never invent a name, a city or an address. Never guess from a hashtag alone. Never return a person, a dish or a brand as the place.",
        "JSON only.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: opts.destination
            ? `The trip is to ${opts.destination}.

Text:
${opts.text}`
            : `Text:
${opts.text}`,
        },
      ],
      schema: SOCIAL_PLACE_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
    }),
    SETUP_LLM_TIMEOUT_MS,
    "gemini.social_place",
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  if (!parsed) return null;
  const str = (key: string): string | null => {
    const value = parsed[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  if (parsed.confident !== true) return null;
  const place_name = str("place_name");
  if (!place_name) return null;
  return { place_name, city: str("city"), address: str("address"), category: str("category") };
}

export const PLACE_TIMEZONE_SCHEMA = {
  type: "object",
  properties: {
    // Asked first, and separately, for the same reason extractTripDates asks
    // `understood`: a prompt that opens "given a travel destination" has
    // already decided the answer is one, so the model goes looking for the
    // nearest-sounding city in whatever it was handed. "where did you get
    // that city from" came back as kronjo, indonesia, and the trip was
    // written with it.
    is_a_place: { type: "boolean" },
    display_name: { type: "string" },
    timezone: { type: "string" },
  },
  required: ["is_a_place", "display_name", "timezone"],
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
        "First decide whether the message names a real place someone could travel to. A question, a correction, a refusal, an opinion, a greeting or anything else is not a place: is_a_place is false and both strings are empty. Do not search the message for the nearest-sounding place name, and do not guess from a fragment. Only when it is a place, return a short lowercase display name (city, country) and the IANA timezone name, such as Asia/Tokyo. Never an abbreviation or UTC offset. If it is a place but you cannot tell which timezone, is_a_place is true and timezone is an empty string. JSON only.",
      messages: [{ role: "user", content: `destination: ${opts.text}\n${evidence}` }],
      schema: PLACE_TIMEZONE_SCHEMA,
      tier: "fast",
      thinkingBudget: 0,
    }),
    SETUP_LLM_TIMEOUT_MS,
    "gemini.place_timezone",
  );
  const parsed = raw ? parseJsonObject(raw) : null;
  // Fail closed: an absent or false flag is "not a place". A missing field
  // must never read as a yes, because the caller writes trips.destination
  // from this.
  if (!parsed || parsed.is_a_place !== true) return null;
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

// ---- survey, engagement, reply checks --------------------------------------
// Each is one small fast-tier classification, bounded by a timeout. A failure
// returns null and the caller takes its safe default (re-ask, disengage,
// send). None of these states facts: they read what people said.

const JUDGE_TIMEOUT_MS = 6_000;

export const SURVEY_REPLY_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    reply: { type: "string" },
  },
  required: ["answer", "reply"],
};

// One survey reply the code could not read. answer: the reply as the
// question's own words (or its gist), "" when it is not an answer. reply: a
// one-line in-voice answer to an off-topic message, "" when not needed.
export async function interpretSurveyReply(opts: {
  provider?: LLMProvider;
  question: string;
  options?: string[];
  text: string;
}): Promise<{ answer: string | null; reply: string | null } | null> {
  const provider = opts.provider ?? new GeminiProvider();
  try {
    const raw = await withTimeout(
      provider.complete({
        system: [
          "You read one reply in a quick, playful trip survey done over text.",
          "If the reply answers the question, even loosely or as a sentence, set answer to the closest option in the options' own words (or, for an open question, the reply's gist) and reply to \"\".",
          "If it is off topic or a question for you, set answer to \"\" and reply to one short friendly lowercase sentence answering it. Never state facts you were not given (scores, times, places, tasks); say you'll sort that after the survey instead.",
          "No exclamation marks. JSON only.",
        ].join(" "),
        messages: [
          {
            role: "user",
            content: `Question: ${opts.question}\nOptions: ${opts.options?.join(" / ") || "(open question)"}\nReply: ${opts.text}`,
          },
        ],
        schema: SURVEY_REPLY_SCHEMA,
        tier: "fast",
        thinkingBudget: 0,
        temperature: 0,
      }),
      JUDGE_TIMEOUT_MS,
      "gemini.survey.interpret",
    );
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    const answer = typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : null;
    const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : null;
    return { answer, reply };
  } catch {
    return null;
  }
}

export const JUDGEMENT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["decision", "reason"],
};

async function judge(opts: {
  provider?: LLMProvider;
  system: string;
  content: string;
  label: string;
}): Promise<{ decision: boolean; reason: string } | null> {
  const provider = opts.provider ?? new GeminiProvider();
  try {
    const raw = await withTimeout(
      provider.complete({
        system: opts.system,
        messages: [{ role: "user", content: opts.content }],
        schema: JUDGEMENT_SCHEMA,
        tier: "fast",
        thinkingBudget: 0,
        temperature: 0,
      }),
      JUDGE_TIMEOUT_MS,
      opts.label,
    );
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed.decision !== "boolean") return null;
    return { decision: parsed.decision, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "" };
  } catch {
    return null;
  }
}

// Still in a conversation with the bot, or has the group moved on? Biased
// toward moving on: one message too early is cheaper than one too late.
export const STILL_ENGAGED_SYSTEM = [
  "You are deciding whether a group chat is still talking to japlan, a trip-game bot, or has moved on.",
  "decision true only if the newest message continues the exchange with the bot: a follow-up to what it just said, an answer to its question, agreement with something it proposed (\"yeah do that\"), or a question for it.",
  "decision false if the group has moved on: two people talking to each other, a change of subject, logistics that need no bot (\"i'm downstairs\", \"who has the key\"), or plans the bot has no part in.",
  "When unsure, false. Staying quiet one message too early is much better than one too late.",
  "reason: a few words. JSON only.",
].join(" ");

export async function judgeStillEngaged(opts: {
  provider?: LLMProvider;
  transcript: string;
  message: string;
}): Promise<{ decision: boolean; reason: string } | null> {
  return judge({
    provider: opts.provider,
    system: STILL_ENGAGED_SYSTEM,
    content: `Recent chat (oldest first):\n${opts.transcript}\n\nNewest message:\n${opts.message}`,
    label: "gemini.engage.still",
  });
}

// A message nobody addressed to the bot: is it about the trip game enough
// that the bot should join in? Biased toward staying out.
export const SHOULD_JOIN_SYSTEM = [
  "You are deciding whether japlan, a trip-game bot in a group chat, should join in on a message nobody addressed to it.",
  "decision true only if the message is plainly about the game or the trip plan and the bot has something to add: someone saying they did a task, asking about the score or the day's plan, suggesting a place to go, or saying the group is splitting up.",
  "decision false for everything else, including ordinary trip chatter between friends. When unsure, false.",
  "reason: a few words. JSON only.",
].join(" ");

export async function judgeShouldJoin(opts: {
  provider?: LLMProvider;
  transcript: string;
  message: string;
}): Promise<{ decision: boolean; reason: string } | null> {
  return judge({
    provider: opts.provider,
    system: SHOULD_JOIN_SYSTEM,
    content: `Recent chat (oldest first):\n${opts.transcript}\n\nNew message:\n${opts.message}`,
    label: "gemini.engage.join",
  });
}

// Does a reply respond to what was actually said? Catches the fluent, in
// voice, about-nothing reply that passes every other check.
export const RELEVANCE_SYSTEM = [
  "You check a chat bot's reply before it is sent.",
  "decision true if the reply responds to what was said in the last few messages (answers it, acts on it, or reacts to it).",
  "decision false if it is about something nobody said, or ignores the latest message.",
  "Do not judge tone or style. reason: a few words. JSON only.",
].join(" ");

export async function judgeRelevance(opts: {
  provider?: LLMProvider;
  transcript: string;
  reply: string;
}): Promise<{ decision: boolean; reason: string } | null> {
  return judge({
    provider: opts.provider,
    system: RELEVANCE_SYSTEM,
    content: `Last messages (oldest first):\n${opts.transcript}\n\nBot's reply:\n${opts.reply}`,
    label: "gemini.reply.relevance",
  });
}
