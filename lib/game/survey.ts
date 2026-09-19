import {
  GROUP_INTRO,
  SETUP_COMPLETE,
  SURVEY_DONE_DM,
  surveyReaskLine,
} from "./copy";
import {
  FIRST_QUESTION_ID,
  QUESTIONS,
  QUESTION_ORDER,
  SIDEQUEST_ORDER,
  SURVEY_INTRO,
  SURVEY_V2_CLOSE,
  type Question,
  type QuestionId,
} from "./survey-questions";
import { parseConstraints, readYesNo } from "./constraints";

// How sure an answer is. Either-or answers start at medium (hypothetical);
// vague or skipped ones are low, and still count, gently.
export type Confidence = "low" | "medium" | "high";

export type AnswerValue = {
  skipped?: boolean;
  value?: string;
  confidence?: Confidence;
  // Given before its question came up ("also i'm vegetarian"): that
  // question is skipped when it arrives.
  early?: boolean;
};

export type SurveyAnswers = Partial<Record<QuestionId, AnswerValue>>;

export type SurveyAwaiting = QuestionId | "done" | "not_started";

export type SurveyMachineState = {
  awaiting: SurveyAwaiting;
  answers: SurveyAnswers;
};

export type SurveyStep = {
  state: SurveyMachineState;
  prompt: string | null;
  completed: boolean;
  // The reply said nothing about the question (off topic, or something the
  // parser cannot read). The handler asks the model, then re-asks naturally.
  unclear?: boolean;
  // Something from the reply was kept for a later question.
  noted?: boolean;
};

export type PublicTripFields = {
  id: string;
  linq_chat_id: string;
  name: string;
  state: string;
  organizerName?: string | null;
};

export function isSkip(text: string): boolean {
  return text.trim().toLowerCase() === "skip";
}

export function displayNameFromFirstName(
  value: string | undefined,
  fallback: string,
): string {
  const name = value?.trim();
  if (!name) return fallback;
  return name.split(/\s+/)[0] ?? fallback;
}

export function answerValue(
  answers: SurveyAnswers,
  id: QuestionId,
): string | undefined {
  const entry = answers[id];
  if (!entry || entry.skipped) return undefined;
  return entry.value;
}

export type SurveyContext = { isSolo?: boolean };

// Questions that only mean something with other people on the trip: the
// social graph (who to split with, couples). Hard constraints and preference
// weights still apply to a solo trip. competitiveness and social_travelled
// are no longer asked at all; they stay listed for older surveys.
export const GROUP_ONLY_QUESTIONS: ReadonlySet<QuestionId> = new Set<QuestionId>([
  "splitting",
  "fu_split",
  "social_with",
  "social_travelled",
  "social_couples",
  "competitiveness",
  "team_preference",
]);

export function includeQuestion(
  id: QuestionId,
  answers: SurveyAnswers,
  ctx: SurveyContext = {},
): boolean {
  if (ctx.isSolo && GROUP_ONLY_QUESTIONS.has(id)) return false;
  // Answered early, in some other reply: not asked again.
  if (answers[id]?.early) return false;
  const constraints = () => parseConstraints(answerValue(answers, "hard_constraints"));
  switch (id) {
    case "fu_budget":
      return false;
    case "fu_constraints":
      return Boolean(answerValue(answers, "hard_constraints")) && constraints().vague;
    case "fu_allergy_cc":
      return constraints().items.some((c) => c.kind === "allergy" && c.strict === undefined);
    case "fu_diet_strict":
      return constraints().followUp === "diet_strictness" ||
        constraints().items.some((c) => c.kind === "diet" && c.strict === undefined);
    case "fu_split":
      return false;
    case "sidequest_red_lines": {
      const level = answerValue(answers, "sidequest_level");
      return level === "2" || level === "3";
    }
    case "dietary_detail":
    case "dietary_strictness":
      return answerValue(answers, "dietary") === "has_restriction";
    case "food_adventure":
      return (
        interestPicksOf(answers).includes("food") ||
        answerValue(answers, "interests") === "food_heavy"
      );
    case "drinking":
      return (
        interestPicksOf(answers).includes("nightlife") ||
        answerValue(answers, "nightlife") === "yes"
      );
    case "paid_attractions":
      return answerValue(answers, "budget") !== "low";
    case "chaos_dares":
      return answerValue(answers, "chaos") === "high";
    case "chaos_alternative":
      return answerValue(answers, "chaos") === "low";
    default:
      return true;
  }
}

// The order a question belongs to: the survey, or the sidequest onboarding.
function orderOf(id: QuestionId | undefined): QuestionId[] {
  return id && SIDEQUEST_ORDER.includes(id) ? SIDEQUEST_ORDER : QUESTION_ORDER;
}

export function nextQuestion(
  answers: SurveyAnswers,
  after?: QuestionId,
  ctx: SurveyContext = {},
): QuestionId | "done" {
  const order = orderOf(after);
  const start = after && order.includes(after) ? order.indexOf(after) + 1 : 0;
  for (let i = start; i < order.length; i++) {
    const id = order[i];
    if (includeQuestion(id, answers, ctx)) return id;
  }
  return "done";
}

// ---- reading loose answers --------------------------------------------------

const VAGUE_RE = /\b(both|either|in between|in the middle|mix|depends|not sure|idk|i don'?t know|dunno|whatever|no preference|hmm+|can'?t decide|up to (?:you|the group)|whatever the group wants|equally|50.?50|kinda both)\b/i;
const NEITHER_RE = /\b(neither|none of (?:those|them)|nah to both)\b/i;
const STRONG_RE = /\b(definitely|obviously|100|easy|hands down|always|no question|absolutely)\b/i;

// An either-or pick, or a vague one. null: nothing to go on (off topic).
export function readEitherOr(question: Question, text: string): AnswerValue | null {
  const sides = question.sides;
  if (!sides) return null;
  const t = text.toLowerCase().trim();
  if (/^(a|1|first|option a|the first one)[.!]*$/.test(t)) return { value: "a", confidence: "medium" };
  if (/^(b|2|second|option b|the second one)[.!]*$/.test(t)) return { value: "b", confidence: "medium" };
  if (NEITHER_RE.test(t)) return { value: "none", confidence: "low" };
  const a = sides.aWords.test(t);
  const b = sides.bWords.test(t);
  if (VAGUE_RE.test(t) || (a && b)) return { value: "both", confidence: "low" };
  if (a) return { value: "a", confidence: STRONG_RE.test(t) ? "high" : "medium" };
  if (b) return { value: "b", confidence: STRONG_RE.test(t) ? "high" : "medium" };
  return null;
}

// A daily budget band from whatever they said. When `afterClarifying` is true,
// a vague answer settles on the middle band with low confidence; null is
// nothing about money at all.
export function readBudget(text: string, afterClarifying = false): AnswerValue | null {
  const t = text.toLowerCase().replace(/,/g, "");
  const choice = t.trim().match(/^([1-4])[.!]?$/)?.[1];
  if (choice) {
    const value = ({
      "1": "under_50",
      "2": "50_100",
      "3": "100_200",
      "4": "no_limit",
    } as const)[choice as "1" | "2" | "3" | "4"];
    return { value, confidence: "high" };
  }
  if (/don'?t make me think|no limit|money'?s no object|don'?t care|whatever it costs|unlimited|not worried|no budget/.test(t)) {
    return { value: "no_limit", confidence: "medium" };
  }
  const numbers = [...t.matchAll(/\$?\s?(\d+(?:\.\d+)?)\s?(k)?/g)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1));
  if (numbers.length > 0) {
    const n = numbers.length > 1 ? (numbers[0] + numbers[1]) / 2 : numbers[0];
    const band = /under|less than|below|<|max|at most/.test(t) && numbers.length === 1 && n <= 50
      ? "under_50"
      : n < 50 ? "under_50" : n <= 100 ? "50_100" : n <= 200 ? "100_200" : "no_limit";
    return { value: band, confidence: "medium" };
  }
  if (/\bcheap|broke|tight|low\b|minimal|as little/.test(t)) return { value: "under_50", confidence: "low" };
  if (/splurge|loaded|high\b|go big|treat/.test(t)) return { value: "100_200", confidence: "low" };
  if (/not too expensive|reasonable|normal|medium|moderate|depends|average|mid|not sure|idk/.test(t)) {
    // Unusable as a filter: ask once, then settle on the middle, low confidence.
    return afterClarifying ? { value: "50_100", confidence: "low" } : { value: "vague", confidence: "low" };
  }
  return null;
}

function readSplitting(text: string): AnswerValue | null {
  const t = text.toLowerCase();
  if (/^\s*1\s*[.!]?\s*$/.test(t)) return { value: "yes", confidence: "high" };
  if (/^\s*2\s*[.!]?\s*$/.test(t)) return { value: "depends", confidence: "high" };
  if (/^\s*3\s*[.!]?\s*$/.test(t)) return { value: "no", confidence: "high" };
  if (/absolutely not|\bno\b|never|nope|nah|rather not|hate/.test(t)) return { value: "no", confidence: "medium" };
  if (/depends|maybe|kinda|sometimes|situational|could be|possibly|if /.test(t)) return { value: "depends", confidence: "medium" };
  if (/whatever the group|up to the group|don'?t mind|either way|whatever/.test(t)) return { value: "yes", confidence: "low" };
  if (/\byes|yeah|yep|sure|cool|fine|down|of course|totally|ya\b/.test(t)) return { value: "yes", confidence: "medium" };
  return null;
}

function readSidequestLevel(text: string): AnswerValue | null {
  if (isSidequestClarificationRequest(text)) return null;
  const t = text.toLowerCase();
  const digit = t.match(/\b([1-4])\b/)?.[1];
  if (digit) return { value: digit, confidence: "high" };
  if (/absolutely not|no sidequests|none|\bno\b|off/.test(t)) return { value: "4", confidence: "high" };
  if (/feral|surprise|unhinged|anything|wild/.test(t)) return { value: "3", confidence: "high" };
  if (/questionable|strangers|embarrass|medium|some/.test(t)) return { value: "2", confidence: "high" };
  if (/civili|tame|mild|food|photos|chill/.test(t)) return { value: "1", confidence: "high" };
  return null;
}

// Things said that answer a question not asked yet: a food rule or allergy,
// a physical limit, a daily budget. Stored now, and that question skipped.
function earlyAnswers(answers: SurveyAnswers, awaiting: QuestionId, text: string): SurveyAnswers {
  const out = { ...answers };
  let changed = false;
  const constraintQs: QuestionId[] = ["hard_constraints", "fu_constraints", "fu_allergy_cc", "fu_diet_strict"];
  if (!constraintQs.includes(awaiting) && !answerValue(out, "hard_constraints")) {
    const parse = parseConstraints(text);
    const concrete = parse.items.filter((c) => c.kind !== "hard_no");
    if (!parse.vague && concrete.length > 0) {
      out.hard_constraints = { value: concrete.map((c) => c.text).join(", "), early: true, confidence: "high" };
      changed = true;
    }
  }
  if (awaiting !== "budget_band" && awaiting !== "fu_budget" && !answerValue(out, "budget_band")) {
    if (/\$\s?\d|\d+\s?(?:dollars|bucks|usd)|a day\b.*\d|\d.*\ba day\b/i.test(text)) {
      const band = readBudget(text);
      if (band && band.value !== "vague") {
        out.budget_band = { ...band, early: true };
        changed = true;
      }
    }
  }
  // The same object when nothing was picked up: callers compare identity.
  return changed ? out : answers;
}

// "wait, go back", "change my last answer": the question before this one.
const GO_BACK_RE = /\b(go back|back up|change my (?:last )?answer|undo|previous question|redo that|wait,? no)\b/i;

function previousQuestion(answers: SurveyAnswers, awaiting: QuestionId, ctx: SurveyContext): QuestionId | null {
  const order = orderOf(awaiting);
  const at = order.indexOf(awaiting);
  for (let i = at - 1; i >= 0; i--) {
    const id = order[i];
    if (answers[id] && !answers[id]?.early && includeQuestion(id, { ...answers, [id]: undefined }, ctx)) return id;
    if (answers[id]) return id;
  }
  return null;
}

// v2 questions: what their reply means, or null when it says nothing about
// the question (the handler then asks the model, and re-asks naturally).
function recordV2(answers: SurveyAnswers, id: QuestionId, text: string): SurveyAnswers | null | undefined {
  const question = QUESTIONS[id];
  const put = (value: AnswerValue | null) => (value ? { ...answers, [id]: value } : null);
  switch (id) {
    case "ab_food_outdoors":
    case "ab_discover_iconic":
    case "ab_culture_nightlife":
    case "ab_pace":
      return put(readEitherOr(question, text));
    case "budget_band":
      return put(readBudget(text, true));
    case "fu_budget": {
      const band = readBudget(text, true);
      return band ? { ...answers, budget_band: band, fu_budget: { value: band.value } } : null;
    }
    case "hard_constraints":
    case "fu_constraints": {
      const prior = id === "fu_constraints" ? "" : "";
      void prior;
      const value = text.trim();
      if (id === "fu_constraints") {
        const parse = parseConstraints(value);
        // Still nothing usable after asking: keep their words, move on.
        return {
          ...answers,
          hard_constraints: { value: parse.vague ? `unspecified: ${value}` : value, confidence: parse.vague ? "low" : "high" },
          fu_constraints: { value },
        };
      }
      return { ...answers, hard_constraints: { value, confidence: "high" } };
    }
    case "fu_allergy_cc": {
      const yes = readYesNo(text);
      // Unclear: treat traces as mattering. Safe beats sorry.
      return { ...answers, fu_allergy_cc: { value: yes === false ? "no" : "yes", confidence: yes === null ? "low" : "high" } };
    }
    case "fu_diet_strict": {
      const t = text.toLowerCase();
      const preference = /prefer|flexible|not strict|loose|not a hard|yes|yeah|yep|correct|right|sure/.test(t) && !/hard rule|strict about|always|never eat/.test(t);
      return { ...answers, fu_diet_strict: { value: preference ? "preference" : "hard", confidence: "high" } };
    }
    case "must_have":
      return { ...answers, must_have: { value: text.trim(), confidence: "high" } };
    case "splitting":
      return put(readSplitting(text));
    case "fu_split":
      return { ...answers, fu_split: { value: text.trim(), confidence: "medium" } };
    case "sidequest_level":
      return put(readSidequestLevel(text));
    case "sidequest_red_lines":
      if (isSidequestClarificationRequest(text)) return undefined;
      return { ...answers, sidequest_red_lines: { value: text.trim(), confidence: "high" } };
    default:
      return undefined;
  }
}

// Stored as comma-separated choice ids ("food,museums").
export function interestPicksOf(answers: SurveyAnswers): string[] {
  const value = answerValue(answers, "interest_picks");
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

// "Has Restriction", "has_restriction" and "has restriction." all match.
function normalizeChoice(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/[\s_]+/g, " ")
    .trim();
}

function matchChoice(question: Question, text: string): string | undefined {
  const needle = normalizeChoice(text);
  return question.choices?.find(
    (choice) =>
      normalizeChoice(choice.id) === needle ||
      normalizeChoice(choice.label) === needle,
  )?.id;
}

// "museums and food", "food, weird stuff", "nature/shopping": each piece
// matched to a choice (whole label or id, or a label word like "weird").
// Up to maxPicks, in the order given. Nothing recognised: null (re-ask).
function matchPicks(question: Question, text: string): string | undefined {
  const pieces = text
    .toLowerCase()
    .split(/,|\/|&|\+|\band\b|\bor\b/)
    .map((piece) => normalizeChoice(piece))
    .filter(Boolean);
  const picks: string[] = [];
  for (const piece of pieces) {
    const choice = question.choices?.find((c) => {
      const label = normalizeChoice(c.label);
      return (
        normalizeChoice(c.id) === piece ||
        label === piece ||
        label.split(" ").includes(piece) ||
        piece.split(" ").includes(normalizeChoice(c.id))
      );
    });
    if (choice && !picks.includes(choice.id)) picks.push(choice.id);
  }
  const kept = picks.slice(0, question.maxPicks ?? picks.length);
  return kept.length > 0 ? kept.join(",") : undefined;
}

// Choice questions never store raw text: an unmatched reply leaves the
// question unanswered (applyReply re-asks). Raw text here used to silently
// disable the allergy, budget and mobility checks in validate.ts.
export function recordAnswer(
  answers: SurveyAnswers,
  questionId: QuestionId,
  text: string,
): SurveyAnswers | null {
  if (isSkip(text)) {
    // Going through the questions again: skip keeps what they said before.
    // A skipped either-or still counts, as a low-confidence middle.
    const before = answers[questionId];
    return {
      ...answers,
      [questionId]: before && !before.skipped ? before : { skipped: true, confidence: "low" },
    };
  }
  const v2 = recordV2(answers, questionId, text);
  if (v2 !== undefined) return v2;
  const question = QUESTIONS[questionId];
  if (question.kind === "choice") {
    const matched = matchChoice(question, text);
    if (!matched) return null;
    return { ...answers, [questionId]: { value: matched } };
  }
  if (question.kind === "multi_choice") {
    const picks = matchPicks(question, text);
    if (!picks) return null;
    return { ...answers, [questionId]: { value: picks } };
  }
  return { ...answers, [questionId]: { value: text.trim() } };
}

export function startSurvey(answers: SurveyAnswers = {}): SurveyStep {
  return {
    state: { awaiting: FIRST_QUESTION_ID, answers },
    prompt: `${SURVEY_INTRO} ${QUESTIONS[FIRST_QUESTION_ID].prompt}`,
    completed: false,
  };
}

// Sidequests' mini-onboarding, at trip start, separate from the survey.
export function startSidequestOnboarding(answers: SurveyAnswers): SurveyStep {
  return {
    state: { awaiting: "sidequest_level", answers },
    prompt: QUESTIONS.sidequest_level.prompt,
    completed: false,
  };
}

export function isSidequestQuestion(id: string | null | undefined): boolean {
  return Boolean(id) && SIDEQUEST_ORDER.includes(id as QuestionId);
}

export function isSidequestClarificationRequest(text: string): boolean {
  return /\b(?:what.{0,24}\bmean|what are you up to|what(?:'s| is)\s+(?:a\s+)?sidequests?|how does (?:this|that) work|explain sidequests?)\b/i.test(text);
}

export function applyReply(
  state: SurveyMachineState,
  text: string,
  ctx: SurveyContext = {},
): SurveyStep {
  if (state.awaiting === "done") {
    return { state, prompt: null, completed: true };
  }

  if (state.awaiting === "not_started") {
    return startSurvey();
  }

  const awaiting = state.awaiting;
  const isV2 = orderOf(awaiting) !== QUESTION_ORDER || QUESTION_ORDER.includes(awaiting);

  if (isV2 && GO_BACK_RE.test(text)) {
    const back = previousQuestion(state.answers, awaiting, ctx);
    if (back) {
      const answers = { ...state.answers };
      delete answers[back];
      return { state: { awaiting: back, answers }, prompt: `sure. ${QUESTIONS[back].prompt}`, completed: false };
    }
  }

  const withEarly = isV2 ? earlyAnswers(state.answers, awaiting, text) : state.answers;
  const noted = withEarly !== state.answers;
  const answers = recordAnswer(withEarly, awaiting, text);
  if (!answers) {
    const question = QUESTIONS[awaiting];
    if (isV2) {
      return {
        state: { awaiting, answers: withEarly },
        prompt: question.reask ?? question.prompt,
        completed: false,
        unclear: true,
        noted,
      };
    }
    return {
      state,
      prompt: surveyReaskLine(
        (question.choices ?? []).map((choice) => choice.label),
      ),
      completed: false,
    };
  }
  const next = nextQuestion(answers, awaiting, ctx);
  if (next === "done") {
    const sidequests = isSidequestQuestion(awaiting);
    return {
      state: { awaiting: "done", answers },
      prompt: sidequests ? sidequestDoneLine(answers) : isV2 ? SURVEY_V2_CLOSE : SURVEY_DONE_DM,
      completed: true,
    };
  }

  return {
    state: { awaiting: next, answers },
    prompt: QUESTIONS[next].prompt,
    completed: false,
  };
}

export function sidequestDoneLine(answers: SurveyAnswers): string {
  switch (answerValue(answers, "sidequest_level")) {
    case "4":
      return "fine, no sidequests. boring, but noted.";
    case "1":
      return "civilized it is. i'll keep it polite.";
    case "3":
      return "feral. noted. you asked for this.";
    default:
      return "noted. i'll behave. mostly.";
  }
}

export function allParticipantsComplete(
  surveyStates: Array<string | null | undefined>,
): boolean {
  return (
    surveyStates.length > 0 &&
    surveyStates.every((value) => value === "done")
  );
}

export function buildIntroGroupPost(trip: PublicTripFields): string {
  return trip.organizerName
    ? `👑 ${trip.organizerName} is the organizer for this trip.\n\n${GROUP_INTRO}`
    : GROUP_INTRO;
}

export function buildSetupCompleteGroupPost(trip: PublicTripFields): string {
  void trip;
  return SETUP_COMPLETE;
}
