export type QuestionId =
  | "first_name"
  | "age_bracket"
  | "dietary"
  | "dietary_strictness"
  | "mobility"
  | "budget"
  | "blackout"
  | "interests"
  | "food_adventure"
  | "nightlife"
  | "drinking"
  | "paid_attractions"
  | "pace"
  | "chaos"
  | "chaos_dares"
  | "chaos_alternative"
  | "competitiveness"
  | "attractions"
  | "social_with"
  | "social_travelled"
  | "social_couples";

export type Question = {
  id: QuestionId;
  prompt: string;
  kind: "choice" | "free_text";
  choices?: { id: string; label: string }[];
};

// Copy: lowercase, conversational, one message each. "skip" is explained once,
// in the first question. Choice labels are what people see and can type; the
// ids (stored, used by validate.ts) also match, so old answers still work.
export const QUESTIONS: Record<QuestionId, Question> = {
  first_name: {
    id: "first_name",
    kind: "free_text",
    prompt:
      "a few quick ones so the tasks fit you. skip any of them by saying skip. what should i call you?",
  },
  age_bracket: {
    id: "age_bracket",
    kind: "choice",
    prompt: "age range? 18-24 / 25-34 / 35-44 / 45-54 / 55+",
    choices: [
      { id: "18-24", label: "18-24" },
      { id: "25-34", label: "25-34" },
      { id: "35-44", label: "35-44" },
      { id: "45-54", label: "45-54" },
      { id: "55+", label: "55+" },
    ],
  },
  dietary: {
    id: "dietary",
    kind: "choice",
    prompt: "any dietary restrictions or allergies? none / yes",
    choices: [
      { id: "none", label: "none" },
      { id: "has_restriction", label: "yes" },
    ],
  },
  dietary_strictness: {
    id: "dietary_strictness",
    kind: "choice",
    prompt: "how strict is that? allergy / preference / flexible on vacation",
    choices: [
      { id: "allergy", label: "allergy" },
      { id: "preference", label: "preference" },
      { id: "cheat_on_vacation", label: "flexible on vacation" },
    ],
  },
  mobility: {
    id: "mobility",
    kind: "choice",
    prompt: "anything physical i should plan around, like stairs or long walks? no limits / has limits",
    choices: [
      { id: "no_limits", label: "no limits" },
      { id: "has_limits", label: "has limits" },
    ],
  },
  budget: {
    id: "budget",
    kind: "choice",
    prompt: "budget for the trip? low / medium / high",
    choices: [
      { id: "low", label: "low" },
      { id: "medium", label: "medium" },
      { id: "high", label: "high" },
    ],
  },
  blackout: {
    id: "blackout",
    kind: "free_text",
    prompt: "any times you're off limits? work calls, prayer, a defended nap.",
  },
  interests: {
    id: "interests",
    kind: "choice",
    prompt: "how much of this trip is about food? mostly food / a mix / not food",
    choices: [
      { id: "food_heavy", label: "mostly food" },
      { id: "balanced", label: "a mix" },
      { id: "not_food", label: "not food" },
    ],
  },
  food_adventure: {
    id: "food_adventure",
    kind: "free_text",
    prompt: "how adventurous are you with food? spice, street food, mystery meat, say whatever.",
  },
  nightlife: {
    id: "nightlife",
    kind: "choice",
    prompt: "into nightlife this trip? yes / no",
    choices: [
      { id: "yes", label: "yes" },
      { id: "no", label: "no" },
    ],
  },
  drinking: {
    id: "drinking",
    kind: "choice",
    prompt: "drinking? yes / no / sometimes",
    choices: [
      { id: "yes", label: "yes" },
      { id: "no", label: "no" },
      { id: "sometimes", label: "sometimes" },
    ],
  },
  paid_attractions: {
    id: "paid_attractions",
    kind: "free_text",
    prompt: "any paid attractions you already know you want?",
  },
  pace: {
    id: "pace",
    kind: "choice",
    prompt: "what's your pace? early and moving / two things and lunch",
    choices: [
      { id: "early_and_moving", label: "early and moving" },
      { id: "two_things_and_lunch", label: "two things and lunch" },
    ],
  },
  chaos: {
    id: "chaos",
    kind: "choice",
    prompt: "how much chaos can you handle? high / low",
    choices: [
      { id: "high", label: "high" },
      { id: "low", label: "low" },
    ],
  },
  chaos_dares: {
    id: "chaos_dares",
    kind: "free_text",
    prompt: "which dares are fair game? strangers, singing in public, unidentifiable food, anything else.",
  },
  chaos_alternative: {
    id: "chaos_alternative",
    kind: "free_text",
    prompt: "low chaos, noted. what would you rather do instead of dares?",
  },
  competitiveness: {
    id: "competitiveness",
    kind: "choice",
    prompt: "here to win, or along for the ride? win / ride",
    choices: [
      { id: "want_to_win", label: "win" },
      { id: "along_for_the_ride", label: "ride" },
    ],
  },
  attractions: {
    id: "attractions",
    kind: "free_text",
    prompt: "anything you already want on the itinerary?",
  },
  social_with: {
    id: "social_with",
    kind: "free_text",
    prompt: "if the group splits up for an afternoon, who do you want to end up with?",
  },
  social_travelled: {
    id: "social_travelled",
    kind: "free_text",
    prompt: "who have you already travelled with a lot?",
  },
  social_couples: {
    id: "social_couples",
    kind: "choice",
    prompt: "here as a couple? split up for tasks or stay together? split / together / n/a",
    choices: [
      { id: "split", label: "split" },
      { id: "together", label: "together" },
      { id: "n/a", label: "n/a" },
    ],
  },
};

export const QUESTION_ORDER: QuestionId[] = [
  "first_name",
  "age_bracket",
  "dietary",
  "dietary_strictness",
  "mobility",
  "budget",
  "blackout",
  "interests",
  "food_adventure",
  "nightlife",
  "drinking",
  "paid_attractions",
  "pace",
  "chaos",
  "chaos_dares",
  "chaos_alternative",
  "competitiveness",
  "attractions",
  "social_with",
  "social_travelled",
  "social_couples",
];

export const FIRST_QUESTION_ID: QuestionId = "first_name";

// The organizer's trip-level questions (destination, dates, difficulty, stake)
// live in lib/game/setup.ts and lib/handlers/setup.ts.
// TODO: PLAN also lists arrival/departure times and team sizes/counts for the
// organizer; not asked yet.
