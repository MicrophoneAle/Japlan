// A conversational reply, checked against reality before it is sent. The
// voice is not checked: only whether it says something that is not true or
// is not a reply at all. Anything that fails is discarded for a short
// fallback, and logged with the reason.

export type ReplyFacts = {
  // Every task code on this trip.
  taskCodes: string[];
  // Everyone on the trip, by display name.
  people: string[];
  // Text a fact may come from: this turn's tool results, what the person
  // said, the recent chat, the trip's own places and task titles.
  toolText: string;
  userText: string;
  contextText: string;
};

export type ReplyCheck = { ok: true } | { ok: false; reason: string };

const MALFORMED_RE = /\bundefined\b|\bnull\b|\[object |NaN|\{\s*"|```|<\/?[a-z]+>/;
// Codes as the board writes them (A1, B12). Lowercase "b4" is slang.
const CODE_RE = /\b([A-Z])(\d{1,2})\b/g;
// Numbers, including clock times and decimals.
const NUMBER_RE = /\d+(?:[.:]\d+)?/g;
const PRONOUNS = new Set(["you", "they", "he", "she", "we", "everyone", "nobody", "someone", "it", "that", "this", "whoever", "who", "one", "mine", "yours"]);
// "sam is winning", "dev has 40", "maya leads": a claim about a person.
const PERSON_CLAIM_RE = /\b([a-z][a-z'-]{1,20})(?:'s|\s+is|\s+has|\s+leads|\s+got|\s+scored|\s+needs|\s+won)\s+(?:winning|leading|ahead|behind|up|down|on\s+\d|at\s+\d|\d|the lead|first|last)/gi;
// A named place: up to three words ending in a place noun.
const PLACE_RE = /\b((?:[a-z][a-z'-]+\s+){0,2}(?:park|temple|shrine|station|market|museum|tower|crossing|street|dori|gai|garden|gardens|bridge|izakaya|hall|square|beach|castle|palace|alley|yokocho|-ji))\b/gi;
const GENERIC_PLACE_WORDS = new Set(["the", "a", "an", "that", "this", "any", "some", "your", "our", "local", "nearest", "next", "big", "old", "main", "little"]);

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

export function checkReply(reply: string, facts: ReplyFacts): ReplyCheck {
  const text = reply.trim();
  // A few characters of nothing.
  if (text.length < 2 || !/[a-z]/i.test(text)) return { ok: false, reason: "empty" };
  if (MALFORMED_RE.test(text)) return { ok: false, reason: "malformed" };

  const codes = new Set(facts.taskCodes.map((c) => c.toUpperCase()));
  for (const m of text.matchAll(CODE_RE)) {
    const code = `${m[1]}${m[2]}`;
    if (!codes.has(code)) return { ok: false, reason: `unknown_code:${code}` };
  }

  // A number is a fact: it has to have come from a tool this turn, or from
  // what they said. Codes' digits are not numbers.
  const withoutCodes = text.replace(CODE_RE, " ");
  const sources = `${facts.toolText} ${facts.userText}`;
  for (const m of withoutCodes.matchAll(NUMBER_RE)) {
    if (!sources.includes(m[0])) return { ok: false, reason: `unsourced_number:${m[0]}` };
  }

  const people = new Set(facts.people.flatMap((p) => [norm(p), norm(p).split(" ")[0]]));
  for (const m of text.matchAll(PERSON_CLAIM_RE)) {
    const who = norm(m[1]);
    if (PRONOUNS.has(who)) continue;
    if (!people.has(who)) return { ok: false, reason: `unknown_person:${who}` };
  }

  const known = norm(`${facts.toolText} ${facts.userText} ${facts.contextText}`);
  for (const m of text.matchAll(PLACE_RE)) {
    const words = norm(m[1]).split(" ").filter((w) => !GENERIC_PLACE_WORDS.has(w));
    // "the park", "a market": not a named place.
    if (words.length < 2 && !m[1].includes("-ji")) continue;
    // The match can carry words before the name ("visit yoyogi park"): the
    // place is known if any tail of it, two words or more, is.
    const tails = words.map((_, i) => words.slice(i).join(" ")).filter((t) => t.includes(" ") || t.includes("-ji"));
    if (!tails.some((t) => known.includes(t))) return { ok: false, reason: `unknown_place:${tails.at(-1) ?? words.join(" ")}` };
  }
  return { ok: true };
}
