import type { Constraint } from "./constraints";
import { constraintsOf, effectiveWeight, prefsOf, PREF_DIMS, type PrefDim, type Prefs } from "./prefs";
import { answerValue, type SurveyAnswers } from "./survey";

// A written profile per person: a synthesis, not a transcript. It goes into
// the generation prompt instead of raw JSON, answers "what do you know about
// me", and is rewritten as the weights move. Hard constraints appear in the
// person's own words, never paraphrased: an allergy summarised loosely is
// dangerous. DM-private, exactly like survey_json.

const DIM_WORDS: Record<PrefDim, string> = {
  food: "food",
  outdoors: "the outdoors",
  adventure: "adventure",
  local_discovery: "wandering and finding things",
  iconic: "the famous sights",
  culture: "museums and culture",
  chill: "a slower, chill day",
  activity: "doing things over looking at them",
  nightlife: "late nights out",
};

function strength(eff: number): "hard" | "some" | null {
  if (eff >= 0.7) return "hard";
  if (eff >= 0.6) return "some";
  return null;
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// "shellfish allergy (cross-contamination matters)": verbatim, plus only the
// facts the follow-ups established. Never reworded.
export function constraintLine(c: Constraint): string {
  if (c.kind === "allergy") {
    return c.strict === true
      ? `${c.text} (cross-contamination matters)`
      : c.strict === false
        ? `${c.text} (traces are fine)`
        : c.text;
  }
  if (c.kind === "diet") {
    return c.strict === false ? `${c.text} (a preference, not a hard rule)` : c.strict === true ? `${c.text} (a hard rule)` : c.text;
  }
  return c.text;
}

const PACE_WORDS: Record<string, string> = {
  a: "would rather cram a day full than linger",
  b: "would rather do one good thing and take it slow",
  both: "is fine with a day either packed or slow",
};

const BUDGET_WORDS: Record<string, string> = {
  under_50: "keeps daily spending under $50",
  "50_100": "is comfortable spending $50-100 a day",
  "100_200": "is fine spending $100-200 a day",
  no_limit: "doesn't want to think about money",
};

export function personProfile(opts: {
  name: string;
  answers: SurveyAnswers;
  prefs?: Prefs | null;
  partnerName?: string | null;
}): string {
  const { name, answers } = opts;
  const isYou = name.toLowerCase() === "you";
  const prefs = opts.prefs ?? prefsOf(null, answers);
  const lines: string[] = [];

  const ranked = PREF_DIMS.map((d) => ({ d, eff: effectiveWeight(prefs.weights[d]), c: prefs.weights[d].c }))
    .sort((a, b) => b.eff - a.eff);
  const hard = ranked.filter((r) => strength(r.eff) === "hard").slice(0, 3).map((r) => DIM_WORDS[r.d]);
  const some = ranked.filter((r) => strength(r.eff) === "some").slice(0, 2).map((r) => DIM_WORDS[r.d]);
  const low = ranked.filter((r) => r.eff <= 0.38 && r.c !== "low").slice(-2).map((r) => DIM_WORDS[r.d]);
  const guessy = ranked.slice(0, 3).every((r) => r.c === "low");
  const directions = hard.length ? listWords(hard) : listWords(some);
  const prefix = isYou ? "you" : name;
  const lean = guessy
    ? directions
      ? `${prefix} might enjoy ${directions}, but that's only an early guess`
      : isYou
        ? "i don't know your preferences well yet"
        : `there aren't enough answers yet to tell what ${name} enjoys`
    : hard.length
      ? `${prefix} ${isYou ? "lean" : "leans"} hard toward ${listWords(hard)}${some.length ? `, with some pull toward ${listWords(some)}` : ""}`
      : some.length
        ? `${prefix} ${isYou ? "lean" : "leans"} toward ${listWords(some)}`
        : isYou
          ? "you haven't shown a clear preference yet"
          : `${name} hasn't shown a clear preference yet`;
  const pace = answers.ab_pace?.value
    ? `${isYou ? "you " : ""}${PACE_WORDS[answers.ab_pace.value]}`
    : null;
  lines.push(`${lean}${pace ? `, and ${pace}` : ""}.`);
  if (low.length) lines.push(`Less into ${listWords(low)}.`);

  const constraints = constraintsOf(answers);
  if (constraints.length) {
    lines.push(`Hard constraints, in their words: ${constraints.map(constraintLine).join("; ")}.`);
  } else if (answerValue(answers, "hard_constraints") !== undefined) {
    lines.push("No hard constraints.");
  }

  const mustHave = answerValue(answers, "must_have");
  if (mustHave) lines.push(`Says the trip is a waste if they don't ${mustHave.replace(/[.!]+$/, "")}.`);

  const budget = answerValue(answers, "budget_band");
  if (budget && BUDGET_WORDS[budget]) lines.push(`${capitalize(BUDGET_WORDS[budget])}.`);

  const split = answerValue(answers, "splitting");
  if (split === "yes") lines.push("Fine splitting up.");
  if (split === "no") lines.push("Would rather the group stayed together.");
  if (split === "depends") {
    lines.push(opts.partnerName ? `Fine splitting up if they're with ${opts.partnerName}.` : "Open to splitting up, depending on the plan.");
  }
  return lines.join(" ");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// The group's profile: where it agrees, where it splits, and every hard
// constraint anyone has, without saying whose. What shared boards and
// splits generate from. Never names a person next to a restriction.
export function groupProfile(people: { answers: SurveyAnswers; prefs?: Prefs | null }[]): string {
  if (people.length === 0) return "";
  const n = people.length;
  const effs = people.map((p) => {
    const prefs = p.prefs ?? prefsOf(null, p.answers);
    return Object.fromEntries(PREF_DIMS.map((d) => [d, effectiveWeight(prefs.weights[d])])) as Record<PrefDim, number>;
  });
  const agree: string[] = [];
  const split: string[] = [];
  for (const d of PREF_DIMS) {
    const values = effs.map((e) => e[d]);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const spread = Math.max(...values) - Math.min(...values);
    if (n > 1 && spread >= 0.3) split.push(DIM_WORDS[d]);
    else if (mean >= 0.62) agree.push(DIM_WORDS[d]);
  }
  const lines: string[] = [];
  lines.push(
    `A group of ${n}.${agree.length ? ` Everyone leans toward ${listWords(agree)}.` : ""}${
      split.length ? ` Split on ${listWords(split)}: some are into it, some aren't.` : ""
    }`,
  );
  const paces = people.map((p) => p.answers.ab_pace?.value).filter(Boolean);
  if (paces.length) {
    const packed = paces.filter((v) => v === "a").length;
    const slow = paces.filter((v) => v === "b").length;
    lines.push(packed > slow ? "Mostly want packed days." : slow > packed ? "Mostly want slower days." : "Mixed on pace.");
  }
  // Every hard constraint, deduplicated, no names. A shared task must be
  // safe for everyone.
  const all = [...new Set(people.flatMap((p) => constraintsOf(p.answers).map(constraintLine)))];
  if (all.length) lines.push(`Hard constraints across the group (every task must respect all of them): ${all.join("; ")}.`);
  const musts = people.map((p) => answerValue(p.answers, "must_have")).filter((m): m is string => Boolean(m));
  if (musts.length) lines.push(`Must-haves someone named: ${musts.map((m) => m.replace(/[.!]+$/, "")).join("; ")}.`);
  const splits = people.map((p) => answerValue(p.answers, "splitting")).filter(Boolean);
  if (splits.includes("no")) lines.push("At least one person would rather not split up.");
  else if (splits.length && splits.every((s) => s === "yes")) lines.push("Everyone is fine splitting up.");
  return lines.join(" ");
}
