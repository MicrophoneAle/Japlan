import { GROUP_INTRO, SETUP_COMPLETE, SURVEY_DONE_DM } from "./copy";
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

export function answerValue(
  answers: SurveyAnswers,
  id: QuestionId,
): string | undefined {
  const entry = answers[id];
  if (!entry || entry.skipped) return undefined;
  return entry.value;
}

export function includeQuestion(
  id: QuestionId,
  answers: SurveyAnswers,
): boolean {
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
): QuestionId | "done" {
  const start = after ? QUESTION_ORDER.indexOf(after) + 1 : 0;
  for (let i = start; i < QUESTION_ORDER.length; i++) {
    const id = QUESTION_ORDER[i];
    if (includeQuestion(id, answers)) return id;
  }
  return "done";
}

function matchChoice(question: Question, text: string): string | undefined {
  const needle = text.trim().toLowerCase();
  return question.choices?.find(
    (choice) =>
      choice.id.toLowerCase() === needle ||
      choice.label.toLowerCase() === needle,
  )?.id;
}

export function recordAnswer(
  answers: SurveyAnswers,
  questionId: QuestionId,
  text: string,
): SurveyAnswers {
  if (isSkip(text)) {
    return { ...answers, [questionId]: { skipped: true } };
  }
  const question = QUESTIONS[questionId];
  const matched = question.kind === "choice" ? matchChoice(question, text) : undefined;
  return {
    ...answers,
    [questionId]: { value: matched ?? text.trim() },
  };
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
): SurveyStep {
  if (state.awaiting === "done") {
    return { state, prompt: null, completed: true };
  }

  if (state.awaiting === "not_started") {
    return startSurvey();
  }

  const answers = recordAnswer(state.answers, state.awaiting, text);
  const next = nextQuestion(answers, state.awaiting);
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
