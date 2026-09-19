import { hardNoWords, parseConstraints } from "./constraints";
import { dietClashes, isBlindFood, parseDiet } from "./diet";
import { minutesForTimeAxis } from "./duration";
import { cautiousEater, isUnderAge, sociabilityOf } from "./preferences";
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
  | "expired_window"
  | "sociability"
  | "alcohol"
  | "blind_food"
  | "hard_no"
  | "red_line";

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
  source?: "generated" | "freeform" | "curveball";
  // Generation-time only (not stored): what sort of task it is, and the
  // specific spot it happens at. Used to keep one board varied.
  kind?: TaskKind;
  place?: string;
  // The template it was built from, or "curveball" for the one-in-four task
  // that fits no template.
  template?: string;
  // Named places in order (a route task has two); place is the first.
  places?: string[];
  // Needs speaking to someone you do not know.
  stranger?: boolean;
  when?: "morning" | "evening";
};

export const CURVEBALL = "curveball";

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
  /\b(eat|food|dish|taste|drink|bar|restaurant|ramen|sushi|street food|meal|snack|menu)\b/i;
const MOBILITY_HARD_RE =
  /\b(climb|hike|stairs|steps|run\b|sprint|steep|uphill|trek|walk \d+|long walk|on foot|highest|to the end of the line|without (?:a |the )?(?:train|taxi|bus|subway))\b/i;
// Backup for tasks with no template flag (curveballs, freeform): anything
// that plainly involves approaching someone. Fails closed for "rather not".
const STRANGER_RE =
  /\b(strangers?|a local|locals|someone|somebody|bartender|staff|shopkeeper|vendor|waiter|chef|passer.?by|person next to|ask (?:a|an|the|someone|people)|compliment|chat with|talk to|high.?five|interview|join (?:a|an|the) (?:group|game|dance))\b/i;
const ALCOHOL_RE =
  /\b(sake|beer|wine|cocktail|highball|shochu|whisk(?:e)?y|izakaya|\bbar\b|pub|alcohol|drunk|chuhai|umeshu|bartender)\b/i;

// The template's flag decides; the title is a fail-closed backup for tasks
// whose wording adds a person the template did not ("...and ask a local").
export function involvesStranger(
  task: Pick<ProposedTask, "title" | "stranger">,
  template: Pick<TemplateFacts, "needs_stranger"> | null,
): boolean {
  const flagged = template ? template.needs_stranger : Boolean(task.stranger);
  return flagged || STRANGER_RE.test(task.title);
}

const EMBARRASS_RE = /\b(sing|singing|dance|dancing|in public|embarrass\w*|use it wrong|perform|karaoke|costume)\b/i;

// A hard no against a title: the word, its plural or stem, and the obvious
// relatives ("heights" also rules out towers and rooftops).
const HARD_NO_RELATIVES: Record<string, RegExp> = {
  heights: /height|highest|tower|rooftop|observation|climb/i,
  boats: /boat|ferry|kayak|cruise/i,
  water: /kayak|swim|boat|beach/i,
  crowds: /crowd|crossing|rush hour|busy/i,
  temples: /temple|shrine|jinja|-ji\b/i,
  seafood: /seafood|sushi|sashimi|fish|shrimp|crab/i,
  spicy: /spicy|chili|hot pot|mala/i,
};

export function hardNoMatches(title: string, word: string): boolean {
  const stem = word.replace(/(ies|es|s)$/, "");
  return new RegExp(`\\b${stem}`, "i").test(title) || Boolean(HARD_NO_RELATIVES[word]?.test(title));
}

// What validation needs to know about the template a task came from. Flags,
// not title-reading, decide the sociability, blind-food and alcohol filters.
export type TemplateFacts = {
  needs_stranger: boolean;
  blind_food?: boolean;
  alcohol?: boolean;
  kind?: TaskKind;
  typical_cost?: string;
  physicalMin?: number;
};

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
  // "vegetarian, but not strict on vacation": a preference is a soft weight
  // (taskPriority lowers clashing food), never a filter.
  if (strictness === "preference") return null;
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

export function validateGeneratedTask(
  task: ProposedTask,
  opts: {
    assignees: AssigneeConstraints[];
    completedTitles: string[];
    now?: Date;
    expiresAt?: Date | null;
    typicalCost?: string;
    template?: TemplateFacts | null;
  },
): RejectionReason | null {
  const title = task.title;
  if (BOOKING_RE.test(title)) return "booking";
  if (PERMANENT_RE.test(title)) return "permanent";
  if (ILLEGAL_RE.test(title)) return "illegal";
  if (UNSAFE_RE.test(title)) return "unsafe";

  const completed = new Set(opts.completedTitles.map(normalizeTitle));
  if (completed.has(normalizeTitle(title))) return "duplicate";

  const template = opts.template ?? null;
  const ceiling = lowestBudgetCeiling(opts.assignees);
  if (estimateTaskCost(title, opts.typicalCost ?? template?.typical_cost) > ceiling) {
    return "over_budget";
  }

  const blind = isBlindFood(title, template?.blind_food);
  // Food the player cannot choose is food, whatever kind the task is filed as.
  const isFood = FOOD_RE.test(title) || template?.kind === "food" || blind;
  const needsStranger = involvesStranger(task, template);
  const alcohol = Boolean(template?.alcohol) || ALCOHOL_RE.test(title);
  for (const person of opts.assignees) {
    const dietary = dietaryConflictKind(person.answers);
    if (dietary) {
      const detail = parseDiet(answerValue(person.answers, "dietary_detail"));
      // Unknown restriction: no food at all (fail closed). Known: only food
      // that involves it, and no food the player cannot choose.
      if (!detail.understood && isFood) return dietary;
      if (detail.understood && isFood && blind) return dietary;
      if (detail.understood && dietClashes(title, detail.keys).length > 0) return dietary;
    }
    if (isFood && blind && cautiousEater(person.answers)) return "blind_food";
    if (
      hasMobilityLimit(person.answers) &&
      (MOBILITY_HARD_RE.test(title) ||
        (template?.physicalMin ?? 0) >= 3 ||
        task.axes.physical >= 4)
    ) {
      return "mobility";
    }
    if (sociabilityOf(person.answers) === "rather_not" && needsStranger) return "sociability";
    // "no heights", "not doing boats": their own words rule tasks out.
    const hardNos = hardNoWords(parseConstraints(answerValue(person.answers, "hard_constraints")).items);
    if (hardNos.some((w) => hardNoMatches(title, w))) return "hard_no";
    // Sidequest red lines hold on the board too.
    const redLines = (answerValue(person.answers, "sidequest_red_lines") ?? "").toLowerCase();
    if (/embarrass/.test(redLines) && EMBARRASS_RE.test(title)) return "red_line";
    if (/physical/.test(redLines) && ((template?.physicalMin ?? 0) >= 3 || task.axes.physical >= 4)) return "red_line";
    if (/money|spend/.test(redLines) && (template?.typical_cost ?? "low") !== "low") return "red_line";
    if (alcohol && (answerValue(person.answers, "drinking") === "no" || isUnderAge(person.answers))) {
      return "alcohol";
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

export type MixRejection = "same_place" | "same_template" | "extra_curveball" | "one_kind";

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
// board at the same place or from the same template, at most one curveball,
// and a board of two or more is never all one kind. An all-one-kind board
// keeps only its first task; the fill step then tops it up from templates.
// oneKind: false applies only the dedupe, for a pool of candidates that the
// day planner picks from (it keeps kinds varied as it picks).
export function enforceBoardMix<T extends ProposedTask>(
  tasks: T[],
  opts: { oneKind?: boolean; existing?: T[] } = {},
): { kept: T[]; rejected: { task: T; reason: MixRejection }[] } {
  const kept: T[] = [];
  const rejected: { task: T; reason: MixRejection }[] = [];
  const places = new Set<string>();
  const templates = new Set<string>();
  let curveballs = 0;
  const note = (task: T) => {
    const key = placeKey(task.place);
    if (key) places.add(key);
    if (task.template === CURVEBALL) curveballs += 1;
    else if (task.template) templates.add(task.template);
  };
  for (const task of opts.existing ?? []) note(task);
  for (const task of tasks) {
    const key = placeKey(task.place);
    if (key && places.has(key)) {
      rejected.push({ task, reason: "same_place" });
      continue;
    }
    if (task.template === CURVEBALL && curveballs > 0) {
      rejected.push({ task, reason: "extra_curveball" });
      continue;
    }
    if (task.template && task.template !== CURVEBALL && templates.has(task.template)) {
      rejected.push({ task, reason: "same_template" });
      continue;
    }
    note(task);
    kept.push(task);
  }
  if (opts.oneKind === false) return { kept, rejected };
  const kinds = kept.map((task) => task.kind);
  const oneKind =
    kept.length >= 2 && kinds.every((kind) => kind !== undefined && kind === kinds[0]);
  if (oneKind) {
    for (const task of kept.splice(1)) rejected.push({ task, reason: "one_kind" });
  }
  return { kept, rejected };
}
