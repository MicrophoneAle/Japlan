import type { LLMProvider } from "@/lib/llm";
import { GeminiProvider } from "@/lib/llm/gemini";
import type { DestinationProfile } from "./destination";
import {
  fillArchetype,
  midpointAxes,
  TEMPLATES,
  type TaskTemplate,
} from "./templates";
import type { SurveyAnswers } from "./survey";
import { difficultyGuidance } from "./setup";
import {
  isTaskKind,
  TASK_KINDS,
  validateGeneratedTask,
  type ProposedTask,
  type RejectionReason,
} from "./validate";
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
      kind: { type: "string", enum: [...TASK_KINDS] },
      place: { type: "string" },
    },
    required: [
      "code",
      "title",
      "axes",
      "verification",
      "photo_bonus_max",
      "neighborhood",
      "kind",
      "place",
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
      ...(isTaskKind(row.kind) ? { kind: row.kind } : {}),
      ...(typeof row.place === "string" && row.place.trim() ? { place: row.place.trim() } : {}),
    });
  }
  return tasks;
}

export type ExistingDayCode = {
  code: string;
  participantId: string | null;
  teamId: string | null;
};

// Codes are per owner, not per trip: everyone's personal board starts at A1.
// A number is only taken if nobody who can see the task already sees that
// number, so a person's personal, team, and shared codes never collide.
export function assignOwnedDayCodes<T extends ProposedTask>(
  tasks: T[],
  day: number,
  ctx: {
    participantIds: string[];
    teamMembers: Record<string, string[]>;
    existing?: ExistingDayCode[];
  },
): T[] {
  const letter = dayLetter(day);
  const re = new RegExp(`^${letter}(\\d+)$`, "i");
  const used = new Map<string, Set<number>>();

  const keysFor = (owner: {
    participantId?: string | null;
    teamId?: string | null;
  }): string[] => {
    if (owner.participantId) return [`p:${owner.participantId}`];
    if (owner.teamId) {
      return [
        `t:${owner.teamId}`,
        ...(ctx.teamMembers[owner.teamId] ?? []).map((id) => `p:${id}`),
      ];
    }
    return ["shared", ...ctx.participantIds.map((id) => `p:${id}`)];
  };
  const mark = (keys: string[], n: number): void => {
    for (const key of keys) {
      const set = used.get(key) ?? new Set<number>();
      set.add(n);
      used.set(key, set);
    }
  };

  for (const row of ctx.existing ?? []) {
    const match = row.code.match(re);
    if (match) mark(keysFor(row), Number(match[1]));
  }

  // Team and personal tasks claim low numbers before the shared board does.
  const rank = (task: T): number =>
    task.teamId ? 0 : task.participantId ? 1 : 2;
  const order = tasks
    .map((_, index) => index)
    .sort((a, b) => rank(tasks[a]) - rank(tasks[b]) || a - b);
  const out = [...tasks];
  for (const index of order) {
    const keys = keysFor(tasks[index]);
    let n = 1;
    while (keys.some((key) => used.get(key)?.has(n))) n += 1;
    mark(keys, n);
    out[index] = { ...tasks[index], code: `${letter}${n}` };
  }
  return out;
}

export function nextFreeformCode(codes: string[]): string {
  const re = /^X(\d+)$/i;
  let max = 0;
  for (const code of codes) {
    const match = code.match(re);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `X${max + 1}`;
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
  // Organizer setup answer: chill / normal / unhinged.
  difficulty?: string | null;
  // Titles already on this trip's boards (any day), so day 2 is not day 1
  // again with different adjectives.
  boardTitles?: string[];
};

// Boldness is the highest-weighted axis and the one that makes a story, so
// the prompt asks for it by count. Chill still gets one: chill means low
// effort and nothing embarrassing, not no people.
export function boldTasksWanted(difficulty: string | null | undefined, count: number): number {
  if (difficulty === "unhinged") return count;
  if (difficulty === "chill") return Math.min(1, count);
  return Math.min(2, count);
}

export const BOLDNESS_GUIDANCE = [
  "What makes this game: social friction and a story afterwards. Boldness is the highest-weighted axis.",
  "Bold means involving people or stepping out of your comfort zone: ask a local for their favourite thing and go, get a stranger to teach you something, order the thing you cannot read, trade or haggle, join in with something already happening, make a small public ask. Safe, legal, nothing permanent, no bookings.",
  "\"Go somewhere and look at something\" is boldness 1. At most one task on a board may be that.",
  "Rate axes honestly; make the tasks bolder, do not inflate the numbers.",
].join(" ");

export function buildGenerationPrompt(input: GenerationInput): string {
  const count = input.count ?? TASKS_PER_CALL;
  const indoor = input.weather.indoorPreferred
    ? "Weather is wet. Prefer indoor tasks. Do not generate an outdoor board with a rain warning attached."
    : "Weather is fair. Outdoor tasks are fine.";
  const templates = TEMPLATES.map(
    (t) =>
      `- ${t.id} (${t.kind}): ${t.archetype} [${t.verification}, indoor=${t.indoor}]`,
  ).join("\n");
  const bold = boldTasksWanted(input.difficulty, count);
  return [
    `Destination: ${input.profile.destination}`,
    `Neighborhoods: ${input.profile.neighborhoods.map((n) => n.name).join(", ") || "(none yet)"}`,
    `Landmarks: ${input.profile.landmarks.map((l) => l.name).join(", ") || "(none yet)"}`,
    `Dishes: ${input.profile.dishes.join(", ") || "(none yet)"}`,
    `Transit: ${input.profile.transit_lines.join(", ") || "(unknown)"}`,
    `Price bands seen: ${input.profile.price_bands.join(", ") || "(unknown)"}`,
    `Weather: ${input.weather.summary}; ${indoor}`,
    `Preferences: ${input.preferenceText}`,
    ...(difficultyGuidance(input.difficulty) ? [difficultyGuidance(input.difficulty) as string] : []),
    `Already completed (do not repeat): ${input.completedTitles.join("; ") || "(none)"}`,
    `Already on this trip's boards (do not repeat or rephrase): ${input.boardTitles?.slice(-40).join("; ") || "(none)"}`,
    `Yesterday's ratings: ${input.yesterdayRatings || "(none)"}`,
    `Score gap: ${input.scoreGap}`,
    `Template bank:\n${templates}`,
    BOLDNESS_GUIDANCE,
    `At least ${bold} of the ${count} tasks must honestly rate boldness 3 or more.`,
    `Variety: each task has a kind (${TASK_KINDS.join(", ")}); a board is never all one kind, and different kinds are better. place is the specific spot (a park, shrine, market, street, shop); no two tasks share a place, and a task that can happen anywhere has an empty place.`,
    `Return exactly ${count} tasks as JSON matching the schema. Fill slots from the destination profile. Axes are integers 1-5. Never include a point value.`,
    "Verification is not a photo gate. honor and photo are both claimable by code immediately; photo_bonus_max is the optional bonus ceiling for a matching photo. Only peer requires someone else's tapback.",
  ].join("\n");
}

export async function generateTasksForAssignee(
  input: GenerationInput,
  provider: LLMProvider = new GeminiProvider(),
): Promise<ProposedTask[]> {
  const raw = await provider.complete({
    system:
      "You generate daily scavenger-hunt tasks. Propose axes only, never points. Classification of difficulty is the six axes. JSON only. A photo is a bonus, never a requirement; only peer verification needs another person.",
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

// A filled template's place: its landmark, else its neighborhood, else none.
function templatePlace(values: Record<string, string>): { place?: string } {
  const place = values.subject ?? values.neighborhood;
  return place ? { place } : {};
}

const BOUNTY_ATTEMPTS = 12;

// Catch-up bounty for the trailing player. Peer templates first; the seed
// moves with the day and the attempt, so it is not the same task every day,
// and it never repeats anything in avoidTitles (the trailer's completed tasks
// plus today's board).
export function pickBounty(opts: {
  profile: DestinationProfile;
  day: number;
  trailer: { id: string; answers: SurveyAnswers };
  avoidTitles: string[];
  expiresAt: Date;
  now?: Date;
  onReject?: (reason: RejectionReason, title: string, attempt: number) => void;
}): ProposedTask | null {
  const ordered = [
    ...TEMPLATES.filter((t) => t.verification === "peer"),
    ...TEMPLATES.filter((t) => t.verification !== "peer"),
  ];
  if (ordered.length === 0) return null;
  for (let attempt = 0; attempt < BOUNTY_ATTEMPTS; attempt++) {
    const template = ordered[(opts.day + attempt) % ordered.length];
    const values = slotValuesFor(template, opts.profile, opts.day * 7 + attempt);
    const bounty: ProposedTask = {
      code: "",
      title: fillArchetype(template.archetype, values),
      axes: {
        ...midpointAxes(template),
        boldness: 5,
        scarcity: 4,
      },
      verification: template.verification,
      photo_bonus_max: template.photo_bonus_max,
      neighborhood: values.neighborhood ?? opts.profile.destination,
      kind: template.kind,
      ...templatePlace(values),
      participantId: opts.trailer.id,
      teamId: null,
    };
    const reason = validateGeneratedTask(bounty, {
      assignees: [{ answers: opts.trailer.answers }],
      completedTitles: opts.avoidTitles,
      expiresAt: opts.expiresAt,
      now: opts.now,
    });
    if (!reason) return bounty;
    opts.onReject?.(reason, bounty.title, attempt);
  }
  return null;
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
      kind: template.kind,
      ...templatePlace(values),
    });
  }
  return out;
}
