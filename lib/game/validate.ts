import { answerValue, type SurveyAnswers } from "./survey";

export type RejectionReason =
  | "booking"
  | "over_budget"
  | "allergy"
  | "dietary"
  | "mobility"
  | "unsafe"
  | "illegal"
  | "permanent"
  | "duplicate"
  | "expired_window";

export type ProposedTask = {
  code: string;
  title: string;
  axes: {
    boldness: number;
    physical: number;
    time: number;
    scarcity: number;
    cultural: number;
    aesthetics: number;
  };
  verification: "photo" | "honor" | "peer";
  photo_bonus_max: number;
  neighborhood: string;
  participantId?: string | null;
  teamId?: string | null;
  source?: "generated" | "freeform";
  // Generation-time only (not stored): what sort of task it is, and the
  // specific spot it happens at. Used to keep one board varied.
  kind?: TaskKind;
  place?: string;
};

export const TASK_KINDS = ["social", "food", "explore", "challenge", "culture", "creative"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

export type AssigneeConstraints = {
  answers: SurveyAnswers;
};

const BOOKING_RE =
  /\b(reserv(?:e|ation)|book(?:ing)? a?|appointment|advance ticket|buy tickets?)\b/i;
const UNSAFE_RE =
  /\b(trespass|steal|drugs?|fight|jump off|cliff|hitchhike|weapon)\b/i;
const ILLEGAL_RE =
  /\b(steal|drugs?|trespass|vandal|bribe|counterfeit)\b/i;
const PERMANENT_RE =
  /\b(tattoo|piercing|brand(?:ing)?|implant|surgery)\b/i;
const FOOD_RE =
  /\b(eat|food|dish|taste|drink|bar|restaurant|ramen|sushi|street food)\b/i;
const MOBILITY_HARD_RE =
  /\b(climb|hike|stairs|run\b|sprint|steep|trek|walk \d+)\b/i;

export const BUDGET_CEILING: Record<string, number> = {
  low: 20,
  medium: 75,
  high: 200,
};

// Survey rows written before choice answers were enforced can hold raw text.
// Anything unrecognised fails closed: the stricter reading wins.
const NO_CONSTRAINT_RE = /^(none|no|nope|nothing|n\/?a|no[ _]limits?)$/i;

export function lowestBudgetCeiling(
  assignees: AssigneeConstraints[],
): number {
  const ceilings = assignees
    .map((person) => answerValue(person.answers, "budget"))
    .map((band) =>
      band ? (BUDGET_CEILING[band] ?? BUDGET_CEILING.low) : undefined,
    )
    .filter((value): value is number => value !== undefined);
  if (ceilings.length === 0) return BUDGET_CEILING.high;
  return Math.min(...ceilings);
}

export function dietaryConflictKind(
  answers: SurveyAnswers,
): "allergy" | "dietary" | null {
  const dietary = answerValue(answers, "dietary");
  if (!dietary || NO_CONSTRAINT_RE.test(dietary.trim())) return null;
  const strictness = answerValue(answers, "dietary_strictness");
  if (strictness === "cheat_on_vacation") return null;
  if (strictness === "preference") return "dietary";
  // allergy, skipped, or unknown: treat as an allergy.
  return "allergy";
}

export function hasMobilityLimit(answers: SurveyAnswers): boolean {
  const mobility = answerValue(answers, "mobility");
  if (!mobility) return false;
  return !NO_CONSTRAINT_RE.test(mobility.trim());
}

export function estimateTaskCost(title: string, typicalCost?: string): number {
  const text = title.toLowerCase();
  if (/\b(omakase|tasting menu|fine dining|helicopter|private tour)\b/.test(text)) {
    return 120;
  }
  if (/\b(ticket|museum|admission|show)\b/.test(text)) return 40;
  if (typicalCost === "high") return 80;
  if (typicalCost === "medium") return 30;
  return 12;
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function minutesForTimeAxis(time: number): number {
  const table = [15, 45, 90, 180, 360];
  const idx = Math.min(5, Math.max(1, Math.round(time))) - 1;
  return table[idx];
}

export function validateGeneratedTask(
  task: ProposedTask,
  opts: {
    assignees: AssigneeConstraints[];
    completedTitles: string[];
    now?: Date;
    expiresAt?: Date | null;
    typicalCost?: string;
  },
): RejectionReason | null {
  const title = task.title;
  if (BOOKING_RE.test(title)) return "booking";
  if (PERMANENT_RE.test(title)) return "permanent";
  if (ILLEGAL_RE.test(title)) return "illegal";
  if (UNSAFE_RE.test(title)) return "unsafe";

  const completed = new Set(opts.completedTitles.map(normalizeTitle));
  if (completed.has(normalizeTitle(title))) return "duplicate";

  const ceiling = lowestBudgetCeiling(opts.assignees);
  if (estimateTaskCost(title, opts.typicalCost) > ceiling) return "over_budget";

  for (const person of opts.assignees) {
    const dietary = dietaryConflictKind(person.answers);
    if (dietary && FOOD_RE.test(title)) return dietary;
    if (hasMobilityLimit(person.answers) && MOBILITY_HARD_RE.test(title)) {
      return "mobility";
    }
  }

  if (opts.expiresAt) {
    const now = opts.now ?? new Date();
    const needed = minutesForTimeAxis(task.axes.time);
    if (now.getTime() + needed * 60_000 > opts.expiresAt.getTime()) {
      return "expired_window";
    }
  }

  return null;
}

export type MixRejection = "same_place" | "one_kind";

// "Yoyogi Park", "yoyogi park.", "the Yoyogi park" are one place. No place
// (eat something starting with a-d) is anywhere, and never collides.
export function placeKey(place: string | undefined): string | null {
  const key = (place ?? "")
    .toLowerCase()
    .replace(/^\s*the\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return key || null;
}

// Board-level rules, in code, after per-task validation: no two tasks on one
// board at the same place, and a board of two or more is never all one kind.
// An all-one-kind board keeps only its first task; the caller's usual "more
// than half rejected" path then regenerates or falls back to templates.
export function enforceBoardMix<T extends ProposedTask>(
  tasks: T[],
): { kept: T[]; rejected: { task: T; reason: MixRejection }[] } {
  const kept: T[] = [];
  const rejected: { task: T; reason: MixRejection }[] = [];
  const places = new Set<string>();
  for (const task of tasks) {
    const key = placeKey(task.place);
    if (key && places.has(key)) {
      rejected.push({ task, reason: "same_place" });
      continue;
    }
    if (key) places.add(key);
    kept.push(task);
  }
  const kinds = kept.map((task) => task.kind);
  const oneKind =
    kept.length >= 2 && kinds.every((kind) => kind !== undefined && kind === kinds[0]);
  if (oneKind) {
    for (const task of kept.splice(1)) rejected.push({ task, reason: "one_kind" });
  }
  return { kept, rejected };
}
