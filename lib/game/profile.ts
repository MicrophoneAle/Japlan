import type { Constraint } from "./constraints";
import { constraintsOf, effectiveWeight, hasPreferenceSignal, prefsOf, PREF_DIMS, v2View, type PrefDim, type Prefs } from "./prefs";
import { answerValue, type SurveyAnswers } from "./survey";
import { matchPerson } from "./split";

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

const YOUR_BUDGET_WORDS: Record<string, string> = {
  under_50: "keep daily spending under $50",
  "50_100": "are comfortable spending $50-100 a day",
  "100_200": "are fine spending $100-200 a day",
  no_limit: "don't want to think about money",
};

export function personProfile(opts: {
  name: string;
  answers: SurveyAnswers;
  prefs?: Prefs | null;
  partnerName?: string | null;
}): string {
  const { name } = opts;
  // Either survey: the first one's answers read as the current one's.
  const answers = v2View(opts.answers);
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
    // Verbatim either way; only the framing changes.
    lines.push(`Hard constraints, in ${isYou ? "your" : "their"} words: ${constraints.map(constraintLine).join("; ")}.`);
  } else if (answerValue(answers, "hard_constraints") !== undefined) {
    lines.push("No hard constraints.");
  }

  const mustHave = answerValue(answers, "must_have");
  if (mustHave) {
    const what = mustHave.replace(/[.!]+$/, "");
    lines.push(isYou ? `You said the trip is a waste if you don't ${what}.` : `Says the trip is a waste if they don't ${what}.`);
  }

  const budget = answerValue(answers, "budget_band");
  if (budget && BUDGET_WORDS[budget]) {
    lines.push(isYou ? `You ${YOUR_BUDGET_WORDS[budget]}.` : `${capitalize(BUDGET_WORDS[budget])}.`);
  }

  const split = answerValue(answers, "splitting");
  if (split === "yes") lines.push(isYou ? "You're fine splitting up." : "Fine splitting up.");
  if (split === "no") lines.push(isYou ? "You'd rather the group stayed together." : "Would rather the group stayed together.");
  if (split === "depends") {
    const who = isYou ? "you're" : "they're";
    lines.push(
      opts.partnerName
        ? `${isYou ? "You're fine" : "Fine"} splitting up if ${who} with ${opts.partnerName}.`
        : `${isYou ? "You're open" : "Open"} to splitting up, depending on the plan.`,
    );
  }
  return lines.join(" ");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// The group's profile: where it agrees, where it splits, and every hard
// constraint anyone has, without saying whose. What shared boards and
// splits generate from. Never names a person next to a restriction.
// Only reports what the answers support: agreement and splits come from the
// people who have told us something, and every count says how many that is.
// ("Everyone is fine splitting up" from one answer out of four was live.)
export function groupProfile(
  rawPeople: { answers: SurveyAnswers; prefs?: Prefs | null }[],
  opts: { groupSize?: number } = {},
): string {
  if (rawPeople.length === 0) return "";
  const size = Math.max(opts.groupSize ?? rawPeople.length, rawPeople.length);
  const people = rawPeople.map((p) => {
    const answers = v2View(p.answers);
    return { answers, prefs: p.prefs ?? prefsOf(null, answers) };
  });
  const informed = people.filter((p) => hasPreferenceSignal(p.prefs));
  const n = informed.length;
  const effs = informed.map((p) =>
    Object.fromEntries(PREF_DIMS.map((d) => [d, effectiveWeight(p.prefs.weights[d])])) as Record<PrefDim, number>,
  );
  const agree: string[] = [];
  const split: string[] = [];
  for (const d of n > 0 ? PREF_DIMS : []) {
    const values = effs.map((e) => e[d]);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const spread = Math.max(...values) - Math.min(...values);
    if (n > 1 && spread >= 0.3) split.push(DIM_WORDS[d]);
    else if (mean >= 0.62) agree.push(DIM_WORDS[d]);
  }
  const lines: string[] = [];
  const of = (k: number) => (k === size ? "" : ` (${k} of ${size} answered)`);
  const everyone = n === size ? "Everyone leans" : n === 1 ? "The one person who answered leans" : `All ${n} who answered lean`;
  lines.push(
    `A group of ${size}.${n === 0 ? " Nobody has said what they're into yet." : ""}${agree.length ? ` ${everyone} toward ${listWords(agree)}.` : ""}${
      split.length ? ` Split on ${listWords(split)}: some are into it, some aren't${of(n)}.` : ""
    }`,
  );
  const paces = people.map((p) => p.answers.ab_pace?.value).filter(Boolean);
  if (paces.length) {
    const packed = paces.filter((v) => v === "a").length;
    const slow = paces.filter((v) => v === "b").length;
    const verdict = packed > slow ? "Mostly want packed days" : slow > packed ? "Mostly want slower days" : "Mixed on pace";
    lines.push(`${verdict}${of(paces.length)}.`);
  }
  // Every hard constraint, deduplicated, no names. A shared task must be
  // safe for everyone.
  const all = [...new Set(people.flatMap((p) => constraintsOf(p.answers).map(constraintLine)))];
  if (all.length) lines.push(`Hard constraints across the group (every task must respect all of them): ${all.join("; ")}.`);
  const musts = people.map((p) => answerValue(p.answers, "must_have")).filter((m): m is string => Boolean(m));
  if (musts.length) lines.push(`Must-haves someone named: ${musts.map((m) => m.replace(/[.!]+$/, "")).join("; ")}.`);
  const splits = people.map((p) => answerValue(p.answers, "splitting")).filter(Boolean);
  if (splits.includes("no")) lines.push("At least one person would rather not split up.");
  else if (splits.length === size && splits.every((s) => s === "yes")) lines.push("Everyone is fine splitting up.");
  else if (splits.length) {
    const yes = splits.filter((s) => s === "yes").length;
    lines.push(`${yes} of ${size} said they're fine splitting up${splits.length < size ? `; ${size - splits.length} haven't said` : ""}.`);
  }
  return lines.join(" ");
}

// "japlan what do you know about michael", "what's jess's budget": asking
// about someone else. Only when the name is someone on the trip (so "what do
// you know about ramen" is still a question). Returns who, for the log.
const OTHER_PERSON_ASKS: RegExp[] = [
  /\b(?:what|wat)\s+(?:do|did|can|does)\s+(?:you|u|ya)\s+(?:know|tell me|remember|have)\s+(?:about|on)\s+([a-z][a-z'-]*)/,
  /\btell me about\s+([a-z][a-z'-]*?)(?:'s)?\s+(?:survey|profile|answers|preferences|prefs|budget|diet|allergies|settings)\b/,
  /\b([a-z][a-z'-]*?)'s\s+(?:survey|profile|answers|preferences|prefs|budget|diet|allergies|settings)\b/,
];
const NOT_A_NAME = new Set(["me", "myself", "us", "you", "u", "them", "it", "this", "that", "my", "your", "our", "their", "the", "everyone", "anyone"]);

export function otherPersonAskedAbout(
  text: string,
  people: { id: string; display_name: string }[],
  senderId: string,
): { id: string; display_name: string } | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const others = people.filter((p) => p.id !== senderId).map((p) => ({ ...p, answers: {} }));
  for (const re of OTHER_PERSON_ASKS) {
    const word = t.match(re)?.[1]?.replace(/'s$/, "");
    if (!word || NOT_A_NAME.has(word)) continue;
    const hit = matchPerson(word, others);
    if (hit) return { id: hit.id, display_name: hit.display_name };
  }
  return null;
}

// Someone's strongest interest in a few words ("late nights out"), or null
// when nothing is known beyond a guess. For Wrapped's "favorite".
export function topInterestWords(prefs: Prefs): string | null {
  const ranked = PREF_DIMS.map((d) => ({ d, eff: effectiveWeight(prefs.weights[d]), c: prefs.weights[d].c }))
    .filter((r) => r.c !== "low" && r.eff >= 0.6)
    .sort((a, b) => b.eff - a.eff);
  return ranked[0] ? DIM_WORDS[ranked[0].d] : null;
}
