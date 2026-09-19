import { parseConstraints, type Constraint } from "./constraints";
import { answerValue, type Confidence, type SurveyAnswers } from "./survey";
import type { InterestKey } from "./templates";

// The survey's either-or answers as weights with confidence, not facts.
// Hypothetical answers start at medium confidence; vague or skipped ones at
// low (a gentle lean, known to be a guess). Weights then move with what
// people actually do: tasks they claim, places they suggest, things they ask
// to avoid, settings they change.

export type PrefDim =
  | "food"
  | "outdoors"
  | "adventure"
  | "local_discovery"
  | "iconic"
  | "culture"
  | "chill"
  | "activity"
  | "nightlife";

export const PREF_DIMS: PrefDim[] = [
  "food",
  "outdoors",
  "adventure",
  "local_discovery",
  "iconic",
  "culture",
  "chill",
  "activity",
  "nightlife",
];

export type Weight = { w: number; c: Confidence };

export type Prefs = {
  version: 2;
  weights: Record<PrefDim, Weight>;
  // The weights the profile was last written from. The profile is rewritten
  // when any weight moves meaningfully away from these.
  basis?: Partial<Record<PrefDim, number>>;
};

// Which dims each side of each either-or feeds.
const EITHER_OR: Record<string, { a: PrefDim[]; b: PrefDim[] }> = {
  ab_food_outdoors: { a: ["food"], b: ["outdoors", "adventure"] },
  ab_discover_iconic: { a: ["local_discovery"], b: ["iconic"] },
  ab_culture_nightlife: { a: ["culture", "chill"], b: ["activity", "nightlife"] },
};

const PICKED = 0.8;
const NOT_PICKED = 0.3;
const BOTH = 0.6;
const NEITHER = 0.35;

function neutral(): Record<PrefDim, Weight> {
  return Object.fromEntries(PREF_DIMS.map((d) => [d, { w: 0.5, c: "low" as Confidence }])) as Record<PrefDim, Weight>;
}

// Weights from the survey answers alone.
export function weightsFromAnswers(answers: SurveyAnswers): Record<PrefDim, Weight> {
  const weights = neutral();
  for (const [id, sides] of Object.entries(EITHER_OR)) {
    const entry = answers[id as keyof SurveyAnswers];
    if (!entry) continue;
    const c: Confidence = entry.confidence ?? (entry.skipped ? "low" : "medium");
    const set = (dims: PrefDim[], w: number, conf: Confidence) => {
      for (const d of dims) weights[d] = { w, c: conf };
    };
    switch (entry.skipped ? "skip" : entry.value) {
      case "a":
        set(sides.a, PICKED, c);
        set(sides.b, NOT_PICKED, c);
        break;
      case "b":
        set(sides.b, PICKED, c);
        set(sides.a, NOT_PICKED, c);
        break;
      case "both":
        set([...sides.a, ...sides.b], BOTH, "low");
        break;
      case "none":
        set([...sides.a, ...sides.b], NEITHER, "low");
        break;
      default:
        // Skipped: stays in the middle, low confidence. Still a value.
        set([...sides.a, ...sides.b], 0.5, "low");
    }
  }
  // The first survey (before 2026-09-19's rewrite) never asked the
  // either-ors: its interest picks, food share, nightlife and chaos answers
  // fill whatever the either-ors left unknown. Without this, someone who took
  // it read as "no preferences" everywhere (live, 2026-09-19).
  const unknown = (d: PrefDim) => weights[d].c === "low" && weights[d].w === 0.5;
  const lean = (dims: PrefDim[], w: number) => {
    for (const d of dims) if (unknown(d)) weights[d] = { w, c: "medium" };
  };
  const picks = (answerValue(answers, "interest_picks") ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is InterestKey => k in INTEREST_DIMS);
  lean(dimsForInterests(picks), PICKED);
  const food = answerValue(answers, "interests");
  if (food === "food_heavy") lean(["food"], PICKED);
  if (food === "not_food") lean(["food"], NOT_PICKED);
  const night = answerValue(answers, "nightlife");
  if (night === "yes") lean(["nightlife"], 0.75);
  if (night === "no") lean(["nightlife"], NOT_PICKED);
  const chaos = answerValue(answers, "chaos");
  if (chaos === "high") lean(["adventure", "activity"], 0.7);
  if (chaos === "low") lean(["chill"], 0.65);
  return weights;
}

export function prefsFromAnswers(answers: SurveyAnswers): Prefs {
  return { version: 2, weights: weightsFromAnswers(answers) };
}

// Stored weights win (they carry what was learned since), except where the
// stored value is still a low-confidence guess and the answers say more:
// rows written before the first survey's answers were read stayed neutral.
export function prefsOf(raw: unknown, answers: SurveyAnswers): Prefs {
  const p = raw as Prefs | null;
  const fromAnswers = weightsFromAnswers(answers);
  if (!(p && p.version === 2 && p.weights)) return { version: 2, weights: fromAnswers };
  const weights = { ...neutral(), ...p.weights };
  for (const d of PREF_DIMS) {
    if (weights[d].c === "low" && fromAnswers[d].c !== "low") weights[d] = fromAnswers[d];
  }
  return { ...p, weights };
}

const LEGACY_PACE: Record<string, string> = { early_and_moving: "a", two_things_and_lunch: "b", steady: "both" };
const LEGACY_BUDGET: Record<string, string> = { low: "under_50", medium: "50_100", high: "100_200" };

// Someone who took the first survey, read as the current one: pace, budget,
// and hard constraints (diet and mobility) filled in where the new keys are
// missing. What the profile and group profile describe. Never written back.
export function v2View(answers: SurveyAnswers): SurveyAnswers {
  const out: SurveyAnswers = { ...answers };
  const pace = answerValue(answers, "pace");
  if (!out.ab_pace && pace && LEGACY_PACE[pace]) out.ab_pace = { value: LEGACY_PACE[pace], confidence: "medium" };
  const budget = answerValue(answers, "budget");
  if (!out.budget_band && budget && LEGACY_BUDGET[budget]) out.budget_band = { value: LEGACY_BUDGET[budget], confidence: "medium" };
  if (!out.hard_constraints) {
    const dietary = answerValue(answers, "dietary");
    const detail = answerValue(answers, "dietary_detail");
    const mobility = answerValue(answers, "mobility");
    if (dietary !== undefined || mobility !== undefined) {
      const items = [
        dietary === "has_restriction" ? detail ?? "a dietary restriction they didn't spell out" : null,
        mobility === "has_limits" ? "mobility limits" : null,
      ].filter((x): x is string => Boolean(x));
      out.hard_constraints = { value: items.length ? items.join("; ") : "none", confidence: "medium" };
      if (answerValue(answers, "dietary_strictness") === "preference" && !out.fu_diet_strict) {
        out.fu_diet_strict = { value: "preference" };
      }
    }
  }
  return out;
}

// Has this person told us anything about what they like, in either survey?
export function hasPreferenceSignal(prefs: Prefs): boolean {
  return PREF_DIMS.some((d) => prefs.weights[d].c !== "low");
}

// How far a weight is trusted: confidence pulls it toward the middle.
const CONF_FACTOR: Record<Confidence, number> = { low: 0.4, medium: 0.75, high: 1 };

export function effectiveWeight(weight: Weight): number {
  return 0.5 + (weight.w - 0.5) * CONF_FACTOR[weight.c];
}

// A signal from behaviour: move a weight a little, and count it as evidence.
export function nudge(prefs: Prefs, dims: PrefDim[], direction: 1 | -1, step = 0.05): Prefs {
  const weights = { ...prefs.weights };
  for (const d of dims) {
    const current = weights[d];
    const target = direction > 0 ? 1 : 0;
    const w = current.w + (target - current.w) * step;
    // Repeated signals firm a guess up: low becomes medium once it has moved.
    const c: Confidence = current.c === "low" && Math.abs(w - 0.5) > 0.12 ? "medium" : current.c;
    weights[d] = { w: Math.round(w * 100) / 100, c };
  }
  return { ...prefs, weights };
}

// A stated preference ("i'm not that into food", "more nightlife"): set
// outright, high confidence.
export function setWeight(prefs: Prefs, dims: PrefDim[], w: number): Prefs {
  const weights = { ...prefs.weights };
  for (const d of dims) weights[d] = { w, c: "high" };
  return { ...prefs, weights };
}

// Rewrite the profile when a weight has moved this far since it was written.
export const PROFILE_REWRITE_DELTA = 0.1;

export function profileStale(prefs: Prefs): boolean {
  if (!prefs.basis) return true;
  return PREF_DIMS.some((d) => Math.abs(prefs.weights[d].w - (prefs.basis?.[d] ?? 0.5)) >= PROFILE_REWRITE_DELTA);
}

export function withBasis(prefs: Prefs): Prefs {
  return { ...prefs, basis: Object.fromEntries(PREF_DIMS.map((d) => [d, prefs.weights[d].w])) };
}

// Survey interests (the planner's vocabulary) to and from prefs dims.
export const INTEREST_DIMS: Record<InterestKey, PrefDim[]> = {
  food: ["food"],
  nature: ["outdoors", "adventure"],
  museums: ["culture"],
  nightlife: ["nightlife"],
  shopping: [],
  architecture: ["iconic"],
  weird: ["local_discovery"],
};

export function dimsForInterests(interests: InterestKey[]): PrefDim[] {
  return [...new Set(interests.flatMap((k) => INTEREST_DIMS[k]))];
}

// The planner's interest weight (1 is neutral, up to 3) from someone's prefs.
export function interestWeightFromPrefs(prefs: Prefs, key: InterestKey): number | null {
  const dims = INTEREST_DIMS[key];
  if (dims.length === 0) return null;
  const eff = Math.max(...dims.map((d) => effectiveWeight(prefs.weights[d])));
  return Math.min(3, Math.max(0.3, 1 + 4 * (eff - 0.5)));
}

// Words people use for a dim, for "i'm not that into food" and the like.
export function prefDimsFor(phrase: string): PrefDim[] {
  const t = phrase.toLowerCase();
  const out: PrefDim[] = [];
  if (/\b(food|foodie|eat|eating|restaurants?)\b/.test(t)) out.push("food");
  if (/\b(outdoors?|nature|hik\w*|kayak\w*|water|parks?)\b/.test(t)) out.push("outdoors");
  if (/\b(adventur\w*|thrill\w*|extreme)\b/.test(t)) out.push("adventure");
  if (/\b(wander\w*|discover\w*|random|explor\w*|hidden|local stuff|weird)\b/.test(t)) out.push("local_discovery");
  if (/\b(famous|iconic|landmarks?|sights|touristy)\b/.test(t)) out.push("iconic");
  if (/\b(museums?|culture|cultural|art|arts|history|temples?|galler\w*)\b/.test(t)) out.push("culture");
  if (/\b(chill|calm|slow|cafes?|café)\b/.test(t)) out.push("chill");
  if (/\b(activit\w*|doing stuff|active|sports?)\b/.test(t)) out.push("activity");
  if (/\b(night\w*|bars?|clubs?|clubbing|drink\w*|part(?:y|ies|ying))\b/.test(t)) out.push("nightlife");
  return out;
}

// ---- the old survey shape, so every filter keeps working -----------------

const PACE_FROM: Record<string, string> = { a: "early_and_moving", b: "two_things_and_lunch", both: "steady" };
const BUDGET_FROM: Record<string, string> = { under_50: "low", "50_100": "medium", "100_200": "high", no_limit: "high" };

// The survey v2 answers as the keys validation, preferences and the planner
// already read: pace, budget, dietary*, mobility, age_bracket, sociability,
// chaos, interest_picks, social_couples / social_with.
export function compatAnswers(answers: SurveyAnswers, prefs: Prefs, partnerName: string | null = null): SurveyAnswers {
  const out: SurveyAnswers = { ...answers };
  const pace = answers.ab_pace;
  if (pace && !pace.skipped && pace.value && PACE_FROM[pace.value]) out.pace = { value: PACE_FROM[pace.value] };
  const band = answerValue(answers, "budget_band");
  if (band && BUDGET_FROM[band]) out.budget = { value: BUDGET_FROM[band] };

  const hard = answerValue(answers, "hard_constraints");
  if (hard !== undefined || answers.hard_constraints?.skipped) {
    const parse = parseConstraints(hard);
    const food = parse.items.filter((c) => c.kind === "allergy" || c.kind === "diet");
    if (food.length > 0) {
      out.dietary = { value: "has_restriction" };
      out.dietary_detail = { value: food.map((c) => c.text).join(", ") };
      const allergy = food.some((c) => c.kind === "allergy");
      const preference = !allergy && answerValue(answers, "fu_diet_strict") === "preference";
      out.dietary_strictness = { value: allergy ? "allergy" : preference ? "preference" : "allergy" };
    } else if (/^unspecified:/.test(hard ?? "")) {
      // They said there is something and would not say what: fail closed.
      out.dietary = { value: "has_restriction" };
      out.dietary_detail = { skipped: true };
    } else {
      out.dietary = { value: "none" };
    }
    out.mobility = { value: parse.items.some((c) => c.kind === "mobility") ? "has_limits" : "no_limits" };
    if (parse.items.some((c) => c.kind === "age")) out.age_bracket = { value: "under_18" };
  }

  // Sidequest red lines are where sociability and chaos come from now.
  const level = answerValue(answers, "sidequest_level");
  const redLines = (answerValue(answers, "sidequest_red_lines") ?? "").toLowerCase();
  if (level) {
    out.sociability = {
      value: /stranger|people|talking/.test(redLines) ? "rather_not" : level === "2" || level === "3" ? "love_it" : "small_doses",
    };
    if (level === "3") out.chaos = { value: "high" };
    if (level === "1" || level === "4") out.chaos = { value: "low" };
  }

  // Top interests from the weights, for anything still reading picks.
  const ranked = (Object.keys(INTEREST_DIMS) as InterestKey[])
    .map((k) => ({ k, w: interestWeightFromPrefs(prefs, k) ?? 1 }))
    .filter((x) => x.w > 1.2)
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)
    .map((x) => x.k);
  if (ranked.length > 0) out.interest_picks = { value: ranked.join(",") };

  if (answerValue(answers, "splitting") === "no") out.social_couples = { value: "together" };
  if (partnerName) {
    out.social_with = { value: partnerName };
    out.social_couples = { value: "together" };
  }
  return out;
}

export type SplitPreference = { value: "yes" | "conditional" | "no" | null; partner: string | null };

export function splitPreference(answers: SurveyAnswers, partnerName: string | null): SplitPreference {
  const v = answerValue(answers, "splitting");
  return {
    value: v === "yes" ? "yes" : v === "no" ? "no" : v === "depends" ? "conditional" : null,
    partner: partnerName,
  };
}

export function constraintsOf(answers: SurveyAnswers): Constraint[] {
  const parse = parseConstraints(answerValue(answers, "hard_constraints"));
  const cc = answerValue(answers, "fu_allergy_cc");
  const strictDiet = answerValue(answers, "fu_diet_strict");
  return parse.items.map((c) =>
    // A follow-up answer is the last word: it was asked to settle exactly this.
    c.kind === "allergy" && c.strict === undefined && cc
      ? { ...c, strict: cc === "yes" }
      : c.kind === "diet" && strictDiet
        ? { ...c, strict: strictDiet === "hard" }
        : c,
  );
}
