import type { LLMProvider } from "@/lib/llm";
import { GeminiProvider } from "@/lib/llm/gemini";
import type { DestinationProfile } from "./destination";
import {
  boardTemplates,
  fillArchetype,
  midpointAxes,
  type TaskTemplate,
} from "./templates";
import type { SurveyAnswers } from "./survey";
import { difficultyGuidance } from "./setup";
import {
  CURVEBALL,
  isTaskKind,
  TASK_KINDS,
  validateGeneratedTask,
  type ProposedTask,
  type RejectionReason,
} from "./validate";
import type { DayWeather } from "./weather";
import { dayLetter, type Axes } from "./scoring";
import { haversineKm } from "./duration";
import { lookupCityTimezone } from "./city-timezones";

// How many tasks to ask for when the caller has no day plan (tests, tools).
// The board pipeline asks for candidatesToRequest(window) instead.
export const TASKS_PER_CALL = 3;

export const GENERATED_TASK_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      template: { type: "string" },
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
      places: { type: "array", items: { type: "string" } },
      involves_stranger: { type: "boolean" },
      kind: { type: "string", enum: [...TASK_KINDS] },
    },
    required: [
      "template",
      "title",
      "axes",
      "verification",
      "photo_bonus_max",
      "neighborhood",
      "places",
      "involves_stranger",
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
    const places = (Array.isArray(row.places) ? row.places : [])
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((p) => p.trim())
      .slice(0, 2);
    // Older shape: a single place string.
    if (places.length === 0 && typeof row.place === "string" && row.place.trim()) {
      places.push(row.place.trim());
    }
    const template = typeof row.template === "string" ? row.template.trim() : "";
    tasks.push({
      code: typeof row.code === "string" ? row.code : "",
      title,
      axes,
      verification,
      photo_bonus_max: Math.max(0, Math.round(Number(row.photo_bonus_max) || 0)),
      neighborhood:
        typeof row.neighborhood === "string" ? row.neighborhood : "",
      ...(isTaskKind(row.kind) ? { kind: row.kind } : {}),
      ...(places.length > 0 ? { places, place: places[0] } : {}),
      ...(template ? { template } : {}),
      ...(typeof row.involves_stranger === "boolean" ? { stranger: row.involves_stranger } : {}),
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

// What the day planner tells the model about time, so duration shapes what
// gets generated rather than only what gets rejected afterwards.
export type GenerationPlan = {
  // "09:30 to 21:00", or "18:10 to 21:00" asked in the evening.
  windowText: string;
  usableMinutes: number;
  targetMinutes: number;
  maxTaskMinutes: number;
  // Asked late in the day: say so.
  lateStart: boolean;
};

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
  // The bank the model may build from: main-task templates only (sidequests
  // never go on the board), no group templates on a solo trip.
  templates?: TaskTemplate[];
  plan?: GenerationPlan;
  // One board in four also gets one task that fits no template.
  curveball?: boolean;
};

// Boldness is the highest-weighted axis and the one that makes a story, so
// the prompt asks for it by count. Chill still gets one: chill means low
// effort and nothing embarrassing, not no people.
export function boldTasksWanted(difficulty: string | null | undefined, count: number): number {
  if (difficulty === "unhinged") return count;
  if (difficulty === "chill") return Math.min(1, count);
  return Math.min(2, count);
}

export const TASK_QUALITY_GUIDANCE = [
  "What makes this game: social friction and a story afterwards. Boldness, scarcity and being specific to this place earn the points; length, effort and prettiness barely do.",
  "A task that can be completed without speaking to anyone, without going somewhere unusual, and without doing anything slightly embarrassing is a weak task. Avoid weak tasks.",
  "\"Go look at X\" (find a bench, locate a statue, view a waterfall) is the weakest possible archetype. Avoid it.",
  "At least one task on the board must involve a stranger (involves_stranger: true).",
  "No two tasks on the board share a location, and no two use the same template.",
  "Safe, legal, nothing permanent, no bookings. Rate axes honestly; make the tasks bolder, do not inflate the numbers.",
].join(" ");

export const CURVEBALL_GUIDANCE = [
  `Exactly one task uses template "${CURVEBALL}": invent it, fitting no template in the bank.`,
  "Make it specific and strange, something that only makes sense in this city and that a local would find funny. No template could have produced it.",
  "Same six axes, same rules. Give it a kind.",
].join(" ");

function templateLine(t: TaskTemplate): string {
  const tags = [t.kind, t.duration, t.stranger ? "stranger" : null, t.lookOnly ? "weak" : null]
    .filter(Boolean)
    .join(", ");
  return `- ${t.id} (${tags}): ${t.archetype} [${t.verification}, indoor=${t.indoor}]`;
}

function hoursText(minutes: number): string {
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function buildGenerationPrompt(input: GenerationInput): string {
  const count = input.count ?? TASKS_PER_CALL;
  const indoor = input.weather.indoorPreferred
    ? "Weather is wet. Prefer indoor tasks. Do not generate an outdoor board with a rain warning attached."
    : "Weather is fair. Outdoor tasks are fine.";
  const bank = input.templates ?? boardTemplates({ solo: false });
  const bold = boldTasksWanted(input.difficulty, count);
  const plan = input.plan;
  const timing = plan
    ? [
        plan.lateStart
          ? `It is already late in the day: the board covers ${plan.windowText}, about ${hoursText(plan.usableMinutes)} of usable time.`
          : `The board covers ${plan.windowText}, about ${hoursText(plan.usableMinutes)} of usable time.`,
        `Main tasks should add up to about ${hoursText(plan.targetMinutes)}; the rest of the day is deliberate gaps.`,
        `No task may take longer than ${plan.maxTaskMinutes} minutes, travel included. Time axis: 1 under 20 min (a sidequest, not wanted here), 2 is 20-45 min, 3 is 45 min-2 h, 4-5 is 2 h or more.`,
      ]
    : [];
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
    ...timing,
    `Template bank (build each task from one, and say which in template):\n${bank.map(templateLine).join("\n")}`,
    TASK_QUALITY_GUIDANCE,
    `At least ${bold} of the ${count} tasks must honestly rate boldness 3 or more.`,
    ...(input.curveball ? [CURVEBALL_GUIDANCE] : []),
    "title: the full instruction as the player reads it, lowercase, one short sentence (\"ask a stranger in koenji for their single best recommendation, then actually do it\"), not a headline.",
    "places: the specific spots the task happens at, named as in the neighborhoods or landmarks above where possible; a route task names its start then its end; a task that can happen anywhere has none.",
    `Return exactly ${count} tasks as JSON matching the schema, best first. Fill slots from the destination profile. Axes are integers 1-5. Never include a point value.`,
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

// Roughly one board in four gets a curveball. Seeded by trip, day and
// assignee, so a regenerated board makes the same call.
export function isCurveballBoard(seed: string): boolean {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 4 === 0;
}

const LETTER_RANGES = ["a-d", "e-h", "i-l", "m-p", "q-t", "u-z"];

// Something small to spend, in the destination's own money, from the city's
// timezone. Static data; anywhere unknown gets a currency-free amount.
const AMOUNT_BY_ZONE: [RegExp, string][] = [
  [/^Asia\/Tokyo$/, "1,000 yen"],
  [/^Asia\/Seoul$/, "10,000 won"],
  [/^Asia\/(Shanghai|Chongqing)$/, "50 yuan"],
  [/^Asia\/Taipei$/, "300 taiwan dollars"],
  [/^Asia\/(Hong_Kong|Macau)$/, "80 hong kong dollars"],
  [/^Asia\/Bangkok$/, "300 baht"],
  [/^Asia\/Ho_Chi_Minh$/, "200,000 dong"],
  [/^Asia\/Singapore$/, "10 singapore dollars"],
  [/^Asia\/(Kolkata|Calcutta)$/, "500 rupees"],
  [/^Europe\/London$/, "£8"],
  [/^Europe\/Zurich$/, "10 francs"],
  [/^Europe\/Prague$/, "250 koruna"],
  [/^Europe\/Warsaw$/, "40 zloty"],
  [/^Europe\/Budapest$/, "4,000 forint"],
  [/^Europe\/(Stockholm|Oslo|Copenhagen)$/, "100 kronor"],
  [/^Europe\/Istanbul$/, "300 lira"],
  [/^Europe\//, "€10"],
  [/^America\/(Mexico_City|Cancun)$/, "150 pesos"],
  [/^America\//, "$10"],
  [/^Australia\//, "15 australian dollars"],
];

export function localAmount(destination: string): string {
  const zone = lookupCityTimezone(destination)?.timezone;
  if (zone) {
    for (const [match, amount] of AMOUNT_BY_ZONE) if (match.test(zone)) return amount;
  }
  return "the price of a coffee";
}

type NamedPoint = { name: string; lat: number | null; lng: number | null };

// A second place for a route task: ideally 2-5 km from the first (a real
// walk, not a marathon), else whichever other place is closest to 3 km.
function routePartner(from: NamedPoint, places: NamedPoint[]): NamedPoint | null {
  const others = places.filter((p) => p.name !== from.name);
  if (others.length === 0) return null;
  if (from.lat === null || from.lng === null) return others[0];
  const origin = { lat: from.lat, lng: from.lng };
  const scored = others.map((p) => ({
    p,
    km: p.lat !== null && p.lng !== null ? haversineKm(origin, { lat: p.lat, lng: p.lng }) : 99,
  }));
  scored.sort((a, b) => Math.abs(a.km - 3) - Math.abs(b.km - 3));
  return scored[0].p;
}

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
  const points: NamedPoint[] = [...profile.landmarks, ...profile.neighborhoods];
  const values: Record<string, string> = {};
  for (const slot of template.slots) {
    switch (slot.kind) {
      case "letter_range":
        values[slot.key] = LETTER_RANGES[seed % LETTER_RANGES.length];
        break;
      case "time":
        values[slot.key] = "4pm";
        break;
      case "early_time":
        values[slot.key] = "6am";
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
      case "place_a": {
        values[slot.key] = points[seed % Math.max(1, points.length)]?.name ?? hood;
        break;
      }
      case "place_b": {
        const from = points[seed % Math.max(1, points.length)];
        values[slot.key] = (from && routePartner(from, points)?.name) ?? landmark;
        break;
      }
      case "transit_line":
        values[slot.key] =
          profile.transit_lines[seed % Math.max(1, profile.transit_lines.length)] ??
          "the nearest train line";
        break;
      case "amount":
        values[slot.key] = localAmount(profile.destination);
        break;
    }
  }
  return values;
}

// A filled template's places, in order: a route's two ends, else its
// landmark, else its neighborhood, else none (it can happen anywhere).
function templatePlaces(values: Record<string, string>): { places?: string[]; place?: string } {
  const places = values.place_a
    ? [values.place_a, values.place_b].filter(Boolean)
    : [values.subject ?? values.neighborhood].filter(Boolean);
  return places.length > 0 ? { places, place: places[0] } : {};
}

function fromTemplate(
  template: TaskTemplate,
  values: Record<string, string>,
  axes: Axes,
  fallbackNeighborhood: string,
): ProposedTask {
  return {
    code: "",
    title: fillArchetype(template.archetype, values),
    axes,
    verification: template.verification,
    photo_bonus_max: template.photo_bonus_max,
    neighborhood: values.neighborhood ?? fallbackNeighborhood,
    kind: template.kind,
    template: template.id,
    stranger: template.stranger,
    ...(template.when ? { when: template.when } : {}),
    ...templatePlaces(values),
  };
}

const BOUNTY_ATTEMPTS = 12;

// Catch-up bounty for the trailing player. Peer templates first; the seed
// moves with the day and the attempt, so it is not the same task every day,
// and it never repeats anything in avoidTitles (the trailer's completed tasks
// plus today's board). Main tasks only: a sidequest is not a bounty.
export function pickBounty(opts: {
  profile: DestinationProfile;
  day: number;
  trailer: { id: string; answers: SurveyAnswers };
  avoidTitles: string[];
  expiresAt: Date;
  now?: Date;
  onReject?: (reason: RejectionReason, title: string, attempt: number) => void;
}): ProposedTask | null {
  const bank = boardTemplates({ solo: false }).filter((t) => !t.groupOnly);
  const ordered = [
    ...bank.filter((t) => t.verification === "peer"),
    ...bank.filter((t) => t.verification !== "peer"),
  ];
  if (ordered.length === 0) return null;
  for (let attempt = 0; attempt < BOUNTY_ATTEMPTS; attempt++) {
    const template = ordered[(opts.day + attempt) % ordered.length];
    const values = slotValuesFor(template, opts.profile, opts.day * 7 + attempt);
    const bounty: ProposedTask = {
      ...fromTemplate(
        template,
        values,
        { ...midpointAxes(template), boldness: 5, scarcity: 4 },
        opts.profile.destination,
      ),
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

// Template tasks for when the model falls short: every template in the bank
// once (weather permitting), stranger tasks and bolder ones first, "go look
// at X" last. The day planner picks from these to top a board up.
export function fillTemplatesDeterministically(opts: {
  profile: DestinationProfile;
  weather: DayWeather;
  count: number;
  seed?: number;
  templates?: TaskTemplate[];
}): ProposedTask[] {
  const bank = opts.templates ?? boardTemplates({ solo: false });
  const pool = opts.weather.indoorPreferred ? bank.filter((t) => t.indoor) : bank;
  const source = pool.length > 0 ? pool : bank;
  const start = opts.seed ?? 0;
  const rotated = source.map((_, i) => source[(start + i) % source.length]);
  const rank = (t: TaskTemplate) => (t.lookOnly ? 2 : t.stranger ? 0 : 1);
  const ordered = rotated
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
  const out: ProposedTask[] = [];
  for (let i = 0; i < Math.min(opts.count, ordered.length); i++) {
    const template = ordered[i];
    const values = slotValuesFor(template, opts.profile, start + i);
    out.push(fromTemplate(template, values, midpointAxes(template), opts.profile.destination));
  }
  return out;
}
