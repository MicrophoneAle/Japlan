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
  // Did a tool that actually CHANGES something run this turn? Reading the
  // standings or searching the web does not count.
  stateChanged: boolean;
};

// Tools that write. A reply may claim something was added, saved or scheduled
// only if one of these ran in the same turn.
export const STATE_CHANGING_TOOLS = new Set([
  "add_suggestion",
  "avoid_category",
  "record_split",
  "record_regroup",
  "update_my_setting",
  "update_trip_setting",
  "request_tasks",
  "redo_today",
  "propose_freeform_claim",
  "request_photo_bonus",
]);

export function changedState(toolNames: string[]): boolean {
  return toolNames.some((name) => STATE_CHANGING_TOOLS.has(name));
}

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

// A reply that says the bot did, or is about to do, something that changes
// state: "added it to day 3", "i'll get that on the board", "saved", "locked
// in". Promising an action no tool performed is its own bug class ("got it
// bob, profile locked in" when nothing changed), and it is worse than saying
// nothing because nobody finds out until they look.
//
// First person or bare past tense only. "you added it", "want me to add it?"
// and "should i put it on day 3" are not claims, so they are not matched.
// A reply that says the bot did, or is about to do, something that changes
// state: "added it to day 3", "i'll get that on the board", "saved",
// "locked in". Promising an action no tool performed is its own bug class
// ("got it bob, profile locked in" when nothing changed), and it is worse
// than saying nothing because nobody finds out until they look.
//
// First person or a bare report only. "you added it", "want me to add it?"
// and "should i put it on day 3" are offers or questions, not claims.
// A reply that says the bot did, or is about to do, something that changes
// state: "added it to day 3", "i'll get that on the board", "saved",
// "locked in". Promising an action no tool performed is its own bug class
// ("got it bob, profile locked in" when nothing changed), and it is worse
// than saying nothing because nobody finds out until they look.
//
// First person or a bare report only. "you added it", "want me to add it?"
// and "should i put it on day 3" are offers or questions, not claims, and
// OFFERS_RE below lets them through.
// A reply that says the bot did, or is about to do, something that changes
// state: "added it to day 3", "i'll get that on the board", "saved",
// "locked in". Promising an action no tool performed is its own bug class
// ("got it bob, profile locked in" when nothing changed), and it is worse
// than saying nothing because nobody finds out until they look.
//
// First person or a bare report only. "you added it", "want me to add it?"
// and "should i put it on day 3" are offers or questions, not claims, and
// OFFERS_RE below lets them through. "sort" is deliberately NOT a verb
// here: "i'll sort that once we're done" is a deferral, not a claim that
// anything was written, and it is real survey copy.
const NARRATES_ACTION_RE = new RegExp(
  [
    "\\b(?:i|i'?ll|i'?m|i'?ve|ill|lemme|let me)\\s+(?:\\w+\\s+){0,2}(?:add|added|adding|put|putting|save|saved|saving|schedul\\w+|book|booked|booking|pencil\\w*|lock\\w*|set|setting|updat\\w+|chuck|chucking|slot\\w*|drop\\w*)\\b",
    "\\b(?:locked in|on the board|on your board|on the list|on the itinerary|add(?:ed|ing) to day|put(?:ting)? it on day|pencill?ed in)\\b",
    "^(?:(?:ok(?:ay)?|bet|say less|done|yeah|yep|word)[,!\\s]*)*(?:added|adding|saved|saving|putting|scheduled|booked|noted|locked in|updated|pencill?ed)\\b",
  ].join("|"),
  "i",
);

// A question or an offer is not a claim.
const OFFERS_RE = /\b(?:want me to|should i|shall i|do you want me|lemme know if|say the word)\b/i;

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

  // Promised an action that no tool performed.
  if (!facts.stateChanged && NARRATES_ACTION_RE.test(text) && !OFFERS_RE.test(text)) {
    return { ok: false, reason: "narrated_uncompleted_action" };
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
