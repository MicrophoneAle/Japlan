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
};

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

export function lowestBudgetCeiling(
  assignees: AssigneeConstraints[],
): number {
  const ceilings = assignees
    .map((person) => answerValue(person.answers, "budget"))
    .map((band) => (band ? BUDGET_CEILING[band] : undefined))
    .filter((value): value is number => value !== undefined);
  if (ceilings.length === 0) return BUDGET_CEILING.high;
  return Math.min(...ceilings);
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
    const dietary = answerValue(person.answers, "dietary");
    const strictness = answerValue(person.answers, "dietary_strictness");
    if (dietary === "has_restriction" && FOOD_RE.test(title)) {
      if (strictness === "allergy") return "allergy";
      if (strictness === "preference") return "dietary";
    }
    const mobility = answerValue(person.answers, "mobility");
    if (mobility && MOBILITY_HARD_RE.test(title)) return "mobility";
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
