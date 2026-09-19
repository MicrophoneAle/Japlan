import { answerValue, interestPicksOf, type SurveyAnswers } from "./survey";
import type { InterestKey } from "./templates";

// Survey answers, as the rules a board is built under. Two sorts:
//   filters: hard, enforced in code (validate.ts per task, selection per
//     board). Sociability, diet, budget, mobility, drinking, blackouts, age.
//   weights: which of the valid tasks are preferred (interests, difficulty
//     and chaos, what the group asked for or asked to avoid).
// For anyone assigned together, filters take the most restrictive answer and
// weights the group's share.

export type Sociability = "love_it" | "small_doses" | "rather_not";

const SOCIABILITY_ORDER: Sociability[] = ["love_it", "small_doses", "rather_not"];

// Not asked yet, or skipped: small doses. A filter fails closed; a board of
// three stranger tasks for someone who never said is the wrong default.
export function sociabilityOf(answers: SurveyAnswers): Sociability {
  const value = answerValue(answers, "sociability");
  return (SOCIABILITY_ORDER as string[]).includes(value ?? "") ? (value as Sociability) : "small_doses";
}

export function groupSociability(list: SurveyAnswers[]): Sociability {
  return list
    .map(sociabilityOf)
    .reduce<Sociability>(
      (worst, s) => (SOCIABILITY_ORDER.indexOf(s) > SOCIABILITY_ORDER.indexOf(worst) ? s : worst),
      "love_it",
    );
}

// love it: unrestricted, at least one. small doses: exactly one at most.
// rather not: none, ever.
export function strangerLimits(s: Sociability): { min: number; max: number } {
  if (s === "rather_not") return { min: 0, max: 0 };
  if (s === "small_doses") return { min: 1, max: 1 };
  return { min: 1, max: Infinity };
}

export const INTEREST_KEYS: InterestKey[] = [
  "food",
  "nature",
  "museums",
  "nightlife",
  "shopping",
  "architecture",
  "weird",
];

// interest_picks, or the older questions for surveys taken before it.
export function interestPicksFor(answers: SurveyAnswers): InterestKey[] {
  const picks = interestPicksOf(answers).filter((p): p is InterestKey =>
    (INTEREST_KEYS as string[]).includes(p),
  );
  if (picks.length > 0) return picks;
  const legacy: InterestKey[] = [];
  if (answerValue(answers, "interests") === "food_heavy") legacy.push("food");
  if (answerValue(answers, "nightlife") === "yes") legacy.push("nightlife");
  return legacy;
}

// 1 for everything, up to 3 for what everyone assigned picked. Food someone
// explicitly said the trip is not about drops below 1.
export function interestWeights(list: SurveyAnswers[]): Record<InterestKey, number> {
  const weights = Object.fromEntries(INTEREST_KEYS.map((k) => [k, 1])) as Record<InterestKey, number>;
  if (list.length === 0) return weights;
  for (const key of INTEREST_KEYS) {
    const share = list.filter((a) => interestPicksFor(a).includes(key)).length / list.length;
    weights[key] = 1 + 2 * share;
  }
  const notFood = list.filter((a) => answerValue(a, "interests") === "not_food").length / list.length;
  if (notFood > 0) weights.food = Math.max(0.3, weights.food - notFood);
  return weights;
}

// Where on the 1-5 boldness axis a board should sit. Difficulty is the
// organizer's call; chaos nudges it half a step. Chill is 2.5, not 1: chill
// means low effort and nothing embarrassing, not no boldness.
export function boldnessTarget(difficulty: string | null | undefined, list: SurveyAnswers[]): number {
  const base = difficulty === "chill" ? 2.5 : difficulty === "unhinged" ? 4.5 : 3.5;
  const high = list.filter((a) => answerValue(a, "chaos") === "high").length;
  const low = list.filter((a) => answerValue(a, "chaos") === "low").length;
  const nudge = high > low ? 0.5 : low > high ? -0.5 : 0;
  return Math.min(5, Math.max(1.5, base + nudge));
}

export function boldnessFit(boldness: number, target: number): number {
  return 1 / (1 + Math.abs(boldness - target));
}

// Categories people can ask to avoid ("we don't want to do temples"), matched
// against a task's title and its place's category. Also what a thumbs-down
// rating of a place lowers.
export const CATEGORY_RULES: Record<string, RegExp> = {
  temples: /temple|shrine|jinja|\b\w+-ji\b|church|cathedral|mosque|religious/,
  museums: /museum|gallery|exhibit/,
  nightlife: /\bbar\b|club|izakaya|karaoke|pub|nightlife|after 9pm/,
  shopping: /\bshop|mall|market|\bbuy\b|store|boutique/,
  parks: /\bpark\b|garden|nature/,
  food: /\beat\b|food|dish|restaurant|ramen|sushi|meal|snack|order/,
  trains: /train|line\b|station|subway|metro/,
  crowds: /crossing|crowd|rush hour|busy/,
  heights: /highest|tower|observation|view ?point|rooftop/,
};

const CATEGORY_SYNONYMS: [RegExp, string][] = [
  [/temple|shrine|religio|church/, "temples"],
  [/museum|galler|art\b/, "museums"],
  [/bar|club|nightlife|drinking|izakaya|karaoke/, "nightlife"],
  [/shop|mall|market|buying/, "shopping"],
  [/park|garden|nature|hike|outdoor/, "parks"],
  [/food|eating|restaurant/, "food"],
  [/train|subway|metro/, "trains"],
  [/crowd|busy/, "crowds"],
  [/height|tower|view/, "heights"],
];

export function categoryKeyFor(phrase: string): string | null {
  const lower = phrase.toLowerCase();
  return CATEGORY_SYNONYMS.find(([re]) => re.test(lower))?.[1] ?? null;
}

export function categoriesOf(title: string, placeCategory: string | null = null): string[] {
  const text = `${title} ${placeCategory ?? ""}`.toLowerCase();
  return Object.entries(CATEGORY_RULES)
    .filter(([, re]) => re.test(text))
    .map(([key]) => key);
}

// "work calls 9-10am", "mornings", "after 10pm", "prayer at 1pm", "a nap
// 2-4pm": minutes-after-midnight ranges. Unreadable text blocks nothing.
export function parseBlackouts(text: string | undefined | null): [number, number][] {
  const t = (text ?? "").toLowerCase();
  const out: [number, number][] = [];
  if (/\bmornings?\b/.test(t)) out.push([0, 12 * 60]);
  if (/\bafternoons?\b/.test(t)) out.push([12 * 60, 17 * 60]);
  if (/\bevenings?\b|\bnights?\b/.test(t)) out.push([18 * 60, 24 * 60]);
  const clock = (h: string, m: string | undefined, ampm: string | undefined, fallbackAmpm?: string) => {
    let hour = Number(h) % 12;
    const suffix = ampm ?? fallbackAmpm;
    if (suffix === "pm") hour += 12;
    if (!suffix && Number(h) >= 12) hour = Number(h);
    return hour * 60 + Number(m ?? 0);
  };
  const rangeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g;
  for (const m of t.matchAll(rangeRe)) {
    const end = clock(m[4], m[5], m[6]);
    const start = clock(m[1], m[2], m[3], m[6]);
    if (end > start) out.push([start, end]);
  }
  const after = t.match(/after (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (after) out.push([clock(after[1], after[2], after[3], "pm"), 24 * 60]);
  const before = t.match(/before (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (before) out.push([0, clock(before[1], before[2], before[3], "am")]);
  // "prayer at 1pm", "calls at 9": an hour from then.
  for (const m of t.matchAll(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)) {
    const start = clock(m[1], m[2], m[3]);
    out.push([start, start + 60]);
  }
  return out;
}

export function groupBlackouts(list: SurveyAnswers[]): [number, number][] {
  return list.flatMap((a) => parseBlackouts(answerValue(a, "blackout")));
}

// Someone who said the food side should be careful ("not very adventurous",
// "picky", "plain") is not sent to order things they cannot choose.
export function cautiousEater(answers: SurveyAnswers): boolean {
  return /not (?:very |that |really )?adventurous|picky|plain|mild|cautious|nothing weird|no mystery|careful|safe/.test(
    (answerValue(answers, "food_adventure") ?? "").toLowerCase(),
  );
}

export function isUnderAge(answers: SurveyAnswers): boolean {
  return answerValue(answers, "age_bracket") === "under_18";
}

// Soft preferences that only the model can use: free text the code cannot
// act on. Named so the per-board log shows exactly what went in.
export function promptPreferences(answers: SurveyAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = [
    "interest_picks",
    "interests",
    "pace",
    "chaos",
    "chaos_dares",
    "chaos_alternative",
    "food_adventure",
    "drinking",
    "nightlife",
  ] as const;
  for (const id of fields) {
    const value = answerValue(answers, id);
    if (value) out[id] = value;
  }
  return out;
}
