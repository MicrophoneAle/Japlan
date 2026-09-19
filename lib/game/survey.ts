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
  type Question,
  type QuestionId,
} from "./survey-questions";

export type AnswerValue = {
  skipped?: boolean;
  value?: string;
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
};

export type PublicTripFields = {
  id: string;
  linq_chat_id: string;
  name: string;
  state: string;
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
// social graph (who to split with, who you have travelled with, couples) and
// competitiveness (there is no one to beat). Hard constraints and preference
// weights still apply to a solo trip.
export const GROUP_ONLY_QUESTIONS: ReadonlySet<QuestionId> = new Set<QuestionId>([
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
  switch (id) {
    case "dietary_strictness":
      return answerValue(answers, "dietary") === "has_restriction";
    case "food_adventure":
      return answerValue(answers, "interests") === "food_heavy";
    case "drinking":
      return answerValue(answers, "nightlife") === "yes";
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

export function nextQuestion(
  answers: SurveyAnswers,
  after?: QuestionId,
  ctx: SurveyContext = {},
): QuestionId | "done" {
  const start = after ? QUESTION_ORDER.indexOf(after) + 1 : 0;
  for (let i = start; i < QUESTION_ORDER.length; i++) {
    const id = QUESTION_ORDER[i];
    if (includeQuestion(id, answers, ctx)) return id;
  }
  return "done";
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

// Choice questions never store raw text: an unmatched reply leaves the
// question unanswered (applyReply re-asks). Raw text here used to silently
// disable the allergy, budget and mobility checks in validate.ts.
export function recordAnswer(
  answers: SurveyAnswers,
  questionId: QuestionId,
  text: string,
): SurveyAnswers | null {
  if (isSkip(text)) {
    return { ...answers, [questionId]: { skipped: true } };
  }
  const question = QUESTIONS[questionId];
  if (question.kind === "choice") {
    const matched = matchChoice(question, text);
    if (!matched) return null;
    return { ...answers, [questionId]: { value: matched } };
  }
  return { ...answers, [questionId]: { value: text.trim() } };
}

export function startSurvey(): SurveyStep {
  return {
    state: { awaiting: FIRST_QUESTION_ID, answers: {} },
    prompt: QUESTIONS[FIRST_QUESTION_ID].prompt,
    completed: false,
  };
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

  const answers = recordAnswer(state.answers, state.awaiting, text);
  if (!answers) {
    const question = QUESTIONS[state.awaiting];
    return {
      state,
      prompt: surveyReaskLine(
        (question.choices ?? []).map((choice) => choice.label),
      ),
      completed: false,
    };
  }
  const next = nextQuestion(answers, state.awaiting, ctx);
  if (next === "done") {
    return {
      state: { awaiting: "done", answers },
      prompt: SURVEY_DONE_DM,
      completed: true,
    };
  }

  return {
    state: { awaiting: next, answers },
    prompt: QUESTIONS[next].prompt,
    completed: false,
  };
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
  void trip;
  return GROUP_INTRO;
}

export function buildSetupCompleteGroupPost(trip: PublicTripFields): string {
  void trip;
  return SETUP_COMPLETE;
}
