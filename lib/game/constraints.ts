import { parseDiet, type DietKey } from "./diet";

// "anything i genuinely cannot screw up?" in one free-text answer: allergies,
// food rules, accessibility, age, physical limits, hard no's. Parsed in code
// so a hard constraint is never softened by a model's paraphrase. The raw
// words are kept verbatim for the profile.

export type ConstraintKind = "allergy" | "diet" | "mobility" | "age" | "hard_no";

export type Constraint = {
  kind: ConstraintKind;
  // Their words, verbatim.
  text: string;
  diet?: DietKey[];
  // allergy: cross-contamination matters. diet: a hard rule, not a preference.
  strict?: boolean;
};

export type ConstraintParse = {
  none: boolean;
  items: Constraint[];
  // Words that say there is something, but not what ("a few things").
  vague: boolean;
  // A follow-up that changes a decision: how strict an allergy or a diet is.
  followUp: "allergy_strictness" | "diet_strictness" | null;
};

const NONE_RE = /^(?:(?:none|nothing|nope|no|nah|n\/?a)(?:[ ,]+(?:all good|nothing|no restrictions?|i'?m easy))?|all good|not really|nothing really|i'?m easy|no restrictions?|none at all)[.!]*$/i;
const VAGUE_RE = /^(some stuff|a few things|a couple things|some things|yes|yeah|maybe|kind of|sort of|a bit|depends|not sure)[.!]*$/i;
const ALLERGY_WORD = /allerg|anaphyla|epipen|intoleran|celiac|coeliac/i;
const PREFERENCE_WORD = /prefer|not (?:that |super |too )?strict|flexible|on vacation|mostly|try to|ish\b|when i can|loosely/i;
const STRICT_WORD = /strict|hard rule|never|religious|halal|kosher|serious/i;
const MOBILITY_RE = /wheelchair|crutch|knee|hip|back (?:pain|problem|issue)|ankle|injur|mobility|can'?t walk|walking (?:is )?hard|long walks?|stairs|cane|pregnan|disab|accessib|bad legs?|limp/i;
const AGE_RE = /\b(1[0-7]) ?(?:y\/?o|years? old)?\b|\bunder ?18\b|\bunder ?age\b|\bminor\b|\bnot 18\b|\bhigh school\b/i;
const HARD_NO_RE = /\bno\s+([a-z][a-z' ]{2,30})|\bhate\s+([a-z][a-z' ]{2,30})|\bnot doing\s+([a-z][a-z' ]{2,30})|\bscared of\s+([a-z][a-z' ]{2,30})|\bafraid of\s+([a-z][a-z' ]{2,30})|\bphobia of\s+([a-z][a-z' ]{2,30})|\bdon'?t do\s+([a-z][a-z' ]{2,30})/gi;

// "no idea", "no worries": not something to rule out.
const NOT_A_THING_RE = /^(idea|clue|worries|worry|problem|problems|thanks|preference|preferences|restrictions?|rush|pressure|biggie|way|matter)\b/i;

function pieces(text: string): string[] {
  return text
    .split(/,|;|\band\b|\balso\b|\bplus\b|\n|\./i)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);
}

export function parseConstraints(text: string | null | undefined): ConstraintParse {
  const raw = (text ?? "").trim();
  if (!raw || NONE_RE.test(raw)) return { none: true, items: [], vague: false, followUp: null };
  if (VAGUE_RE.test(raw)) return { none: false, items: [], vague: true, followUp: null };
  const items: Constraint[] = [];
  let followUp: ConstraintParse["followUp"] = null;
  for (const piece of pieces(raw)) {
    const diet = parseDiet(piece);
    if (diet.understood) {
      const allergy =
        ALLERGY_WORD.test(piece) ||
        (/shellfish|peanut|\bnuts?\b|sesame|gluten/i.test(piece) && !PREFERENCE_WORD.test(piece));
      if (allergy) {
        // Said outright whether traces matter: no need to ask.
        const said = /cross|trace|severe|anaphyla|epipen|even a little/i.test(piece)
          ? true
          : /traces? (?:are|is) fine|not severe|mild/i.test(piece)
            ? false
            : undefined;
        items.push({ kind: "allergy", text: piece, diet: diet.keys, ...(said !== undefined ? { strict: said } : {}) });
        if (said === undefined) followUp ??= "allergy_strictness";
      } else {
        const preference = PREFERENCE_WORD.test(piece);
        // "not strict" contains "strict": the preference reading wins.
        const strict = preference ? false : STRICT_WORD.test(piece) ? true : undefined;
        items.push({ kind: "diet", text: piece, diet: diet.keys, ...(strict !== undefined ? { strict } : {}) });
        // Unsaid either way, or said as a preference: one question settles it.
        if (strict === undefined || preference) followUp ??= "diet_strictness";
      }
      continue;
    }
    if (MOBILITY_RE.test(piece)) {
      items.push({ kind: "mobility", text: piece });
      continue;
    }
    if (AGE_RE.test(piece)) {
      items.push({ kind: "age", text: piece });
      continue;
    }
    const hardNo = [...piece.matchAll(HARD_NO_RE)].some((m) => {
      const what = m.slice(1).find(Boolean);
      return Boolean(what) && !NOT_A_THING_RE.test(what!.trim());
    });
    if (hardNo) items.push({ kind: "hard_no", text: piece });
  }
  // Something was said, but nothing in it is a usable constraint.
  if (items.length === 0) return { none: false, items: [], vague: true, followUp: null };
  return { none: false, items, vague: false, followUp };
}

// The words a hard no rules out, for validation: "no heights" -> heights.
export function hardNoWords(items: Constraint[]): string[] {
  const words: string[] = [];
  for (const item of items.filter((i) => i.kind === "hard_no")) {
    for (const m of item.text.toLowerCase().matchAll(HARD_NO_RE)) {
      const what = m.slice(1).find(Boolean)?.trim();
      if (what && !NOT_A_THING_RE.test(what)) words.push(...what.split(/\s+/).filter((w) => w.length >= 4));
    }
  }
  return [...new Set(words)];
}

// A reply to "actual allergy where cross-contamination matters too?" or
// "got it, preference not a hard rule?": yes / no / anything in between.
export function readYesNo(text: string): boolean | null {
  const t = text.toLowerCase().trim();
  if (/^(y|ya|yes|yeah|yep|yup|correct|right|exactly|it does|it matters|100|definitely|for sure|sure|preference|just a preference)\b/.test(t)) return true;
  if (/^(n|no|nope|nah|not really|it doesn'?t|doesn'?t matter|hard rule|strict)\b/.test(t)) return false;
  return null;
}
