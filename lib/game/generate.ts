import type { LLMProvider } from "@/lib/llm";
import { GeminiProvider } from "@/lib/llm/gemini";
import type { DestinationProfile } from "./destination";
import {
  fillArchetype,
  midpointAxes,
  TEMPLATES,
  type TaskTemplate,
} from "./templates";
import type { ProposedTask } from "./validate";
import type { DayWeather } from "./weather";
import { dayLetter, type Axes } from "./scoring";

export const TASKS_PER_CALL = 3;

export const GENERATED_TASK_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      code: { type: "string" },
      title: { type: "string" },
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
      verification: { type: "string", enum: ["photo", "honor", "peer"] },
      photo_bonus_max: { type: "integer" },
      neighborhood: { type: "string" },
    },
    required: [
      "code",
      "title",
      "axes",
      "verification",
      "photo_bonus_max",
      "neighborhood",
    ],
  },
};

const AXIS_KEYS: (keyof Axes)[] = [
  "boldness",
  "physical",
  "time",
  "scarcity",
  "cultural",
  "aesthetics",
];

function clampAxis(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseGeneratedTasks(raw: string): ProposedTask[] {
  const parsed = JSON.parse(raw) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [];
  const tasks: ProposedTask[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (!isRecord(row.axes)) continue;
    const verification = row.verification;
    if (
      verification !== "photo" &&
      verification !== "honor" &&
      verification !== "peer"
    ) {
      continue;
    }
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) continue;
    const axes = {} as Axes;
    for (const key of AXIS_KEYS) {
      axes[key] = clampAxis(row.axes[key]);
    }
    tasks.push({
      code: typeof row.code === "string" ? row.code : "",
      title,
      axes,
      verification,
      photo_bonus_max: Math.max(0, Math.round(Number(row.photo_bonus_max) || 0)),
      neighborhood:
        typeof row.neighborhood === "string" ? row.neighborhood : "",
    });
  }
  return tasks;
}

export function assignDayCodes(
  tasks: ProposedTask[],
  day: number,
): ProposedTask[] {
  const letter = dayLetter(day);
  return tasks.map((task, index) => ({
    ...task,
    code: `${letter}${index + 1}`,
  }));
}

export type GenerationInput = {
  profile: DestinationProfile;
  weather: DayWeather;
  preferenceText: string;
  completedTitles: string[];
  yesterdayRatings: string;
  scoreGap: string;
  day: number;
  count?: number;
};

export function buildGenerationPrompt(input: GenerationInput): string {
  const count = input.count ?? TASKS_PER_CALL;
  const indoor = input.weather.indoorPreferred
    ? "Weather is wet. Prefer indoor tasks. Do not generate an outdoor board with a rain warning attached."
    : "Weather is fair. Outdoor tasks are fine.";
  const templates = TEMPLATES.map(
    (t) =>
      `- ${t.id}: ${t.archetype} [${t.verification}, indoor=${t.indoor}]`,
  ).join("\n");
  return [
    `Destination: ${input.profile.destination}`,
    `Neighborhoods: ${input.profile.neighborhoods.map((n) => n.name).join(", ") || "(none yet)"}`,
    `Landmarks: ${input.profile.landmarks.map((l) => l.name).join(", ") || "(none yet)"}`,
    `Dishes: ${input.profile.dishes.join(", ") || "(none yet)"}`,
    `Transit: ${input.profile.transit_lines.join(", ") || "(unknown)"}`,
    `Price bands seen: ${input.profile.price_bands.join(", ") || "(unknown)"}`,
    `Weather: ${input.weather.summary}; ${indoor}`,
    `Preferences: ${input.preferenceText}`,
    `Already completed (do not repeat): ${input.completedTitles.join("; ") || "(none)"}`,
    `Yesterday's ratings: ${input.yesterdayRatings || "(none)"}`,
    `Score gap: ${input.scoreGap}`,
    `Template bank:\n${templates}`,
    `Return exactly ${count} tasks as JSON matching the schema. Fill slots from the destination profile. Axes are integers 1-5. Never include a point value.`,
  ].join("\n");
}

export async function generateTasksForAssignee(
  input: GenerationInput,
  provider: LLMProvider = new GeminiProvider(),
): Promise<ProposedTask[]> {
  const raw = await provider.complete({
    system:
      "You generate daily scavenger-hunt tasks. Propose axes only, never points. Classification of difficulty is the six axes. JSON only.",
    messages: [{ role: "user", content: buildGenerationPrompt(input) }],
    schema: GENERATED_TASK_SCHEMA,
    tier: "smart",
  });
  if (!raw) return [];
  try {
    return parseGeneratedTasks(raw);
  } catch {
    return [];
  }
}

const LETTER_RANGES = ["a-d", "e-h", "i-l", "m-p", "q-t", "u-z"];

export function slotValuesFor(
  template: TaskTemplate,
  profile: DestinationProfile,
  seed: number,
): Record<string, string> {
  const hood =
    profile.neighborhoods[seed % Math.max(1, profile.neighborhoods.length)]
      ?.name ?? profile.destination;
  const landmark =
    profile.landmarks[seed % Math.max(1, profile.landmarks.length)]?.name ??
    "a local landmark";
  const dish =
    profile.dishes[seed % Math.max(1, profile.dishes.length)] ??
    "something local";
  const values: Record<string, string> = {};
  for (const slot of template.slots) {
    switch (slot.kind) {
      case "letter_range":
        values[slot.key] = LETTER_RANGES[seed % LETTER_RANGES.length];
        break;
      case "time":
        values[slot.key] = "4pm";
        break;
      case "transport_mode":
        values[slot.key] = profile.transit_lines[0] ? "the train" : "a taxi";
        break;
      case "subject":
        values[slot.key] = landmark;
        break;
      case "neighborhood":
        values[slot.key] = hood;
        break;
      case "dish":
        values[slot.key] = dish;
        break;
      case "phrase":
        values[slot.key] = "thank you";
        break;
    }
  }
  return values;
}

export function fillTemplatesDeterministically(opts: {
  profile: DestinationProfile;
  weather: DayWeather;
  count: number;
  seed?: number;
}): ProposedTask[] {
  const pool = opts.weather.indoorPreferred
    ? TEMPLATES.filter((t) => t.indoor)
    : TEMPLATES;
  const source = pool.length > 0 ? pool : TEMPLATES;
  const out: ProposedTask[] = [];
  const start = opts.seed ?? 0;
  for (let i = 0; i < opts.count; i++) {
    const template = source[(start + i) % source.length];
    const values = slotValuesFor(template, opts.profile, start + i);
    out.push({
      code: "",
      title: fillArchetype(template.archetype, values),
      axes: midpointAxes(template),
      verification: template.verification,
      photo_bonus_max: template.photo_bonus_max,
      neighborhood: values.neighborhood ?? opts.profile.destination,
    });
  }
  return out;
}
