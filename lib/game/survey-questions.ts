export type QuestionId =
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

export const QUESTIONS: Record<QuestionId, Question> = {
  age_bracket: {
    id: "age_bracket",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Age bracket? (18-24 / 25-34 / 35-44 / 45-54 / 55+) — 18+ only. Reply skip to skip.",
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
    prompt:
      "PLACEHOLDER: Any dietary restrictions or allergies? (none / has_restriction). Reply skip to skip.",
    choices: [
      { id: "none", label: "none" },
      { id: "has_restriction", label: "has_restriction" },
    ],
  },
  dietary_strictness: {
    id: "dietary_strictness",
    kind: "choice",
    prompt:
      "PLACEHOLDER: How strict is that dietary restriction? (allergy / preference / cheat_on_vacation). Reply skip to skip.",
    choices: [
      { id: "allergy", label: "allergy" },
      { id: "preference", label: "preference" },
      { id: "cheat_on_vacation", label: "cheat_on_vacation" },
    ],
  },
  mobility: {
    id: "mobility",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Any mobility or physical limits we should treat as hard constraints? Reply skip to skip.",
  },
  budget: {
    id: "budget",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Budget band for this trip? (low / medium / high). Reply skip to skip.",
    choices: [
      { id: "low", label: "low" },
      { id: "medium", label: "medium" },
      { id: "high", label: "high" },
    ],
  },
  blackout: {
    id: "blackout",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Any blackout times (work calls, prayer, a defended nap)? Reply skip to skip.",
  },
  interests: {
    id: "interests",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Is your interest allocation food-heavy? (food_heavy / balanced / not_food). Reply skip to skip.",
    choices: [
      { id: "food_heavy", label: "food_heavy" },
      { id: "balanced", label: "balanced" },
      { id: "not_food", label: "not_food" },
    ],
  },
  food_adventure: {
    id: "food_adventure",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Spice tolerance, street food, adventurousness? Reply skip to skip.",
  },
  nightlife: {
    id: "nightlife",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Did you put points on nightlife? (yes / no). Reply skip to skip.",
    choices: [
      { id: "yes", label: "yes" },
      { id: "no", label: "no" },
    ],
  },
  drinking: {
    id: "drinking",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Drinking on this trip? (yes / no / sometimes). Reply skip to skip.",
    choices: [
      { id: "yes", label: "yes" },
      { id: "no", label: "no" },
      { id: "sometimes", label: "sometimes" },
    ],
  },
  paid_attractions: {
    id: "paid_attractions",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Any paid attractions you already want? Reply skip to skip.",
  },
  pace: {
    id: "pace",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Pace? (early_and_moving / two_things_and_lunch). Reply skip to skip.",
    choices: [
      { id: "early_and_moving", label: "early_and_moving" },
      { id: "two_things_and_lunch", label: "two_things_and_lunch" },
    ],
  },
  chaos: {
    id: "chaos",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Chaos tolerance? (high / low). Reply skip to skip.",
    choices: [
      { id: "high", label: "high" },
      { id: "low", label: "low" },
    ],
  },
  chaos_dares: {
    id: "chaos_dares",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Which dare categories are ok: strangers, public singing, unidentifiable food? Reply skip to skip.",
  },
  chaos_alternative: {
    id: "chaos_alternative",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Low chaos — what would you rather do instead of dares? Reply skip to skip.",
  },
  competitiveness: {
    id: "competitiveness",
    kind: "choice",
    prompt:
      "PLACEHOLDER: Competitiveness? (want_to_win / along_for_the_ride). Reply skip to skip.",
    choices: [
      { id: "want_to_win", label: "want_to_win" },
      { id: "along_for_the_ride", label: "along_for_the_ride" },
    ],
  },
  attractions: {
    id: "attractions",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Any attractions you already want on the itinerary? Reply skip to skip.",
  },
  social_with: {
    id: "social_with",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Who would you like to be with if the group splits up for an afternoon? Reply skip to skip.",
  },
  social_travelled: {
    id: "social_travelled",
    kind: "free_text",
    prompt:
      "PLACEHOLDER: Who have you already travelled with a lot? Reply skip to skip.",
  },
  social_couples: {
    id: "social_couples",
    kind: "choice",
    prompt:
      "PLACEHOLDER: If you are a couple on this trip, split or keep together? (split / together / n/a). Reply skip to skip.",
    choices: [
      { id: "split", label: "split" },
      { id: "together", label: "together" },
      { id: "n/a", label: "n/a" },
    ],
  },
};

export const QUESTION_ORDER: QuestionId[] = [
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

export const FIRST_QUESTION_ID: QuestionId = "age_bracket";

export const ORGANIZER_QUESTIONS_PLACEHOLDER = [
  "PLACEHOLDER (group-level, organizer only, not yet asked): destination and dates",
  "PLACEHOLDER (group-level, organizer only, not yet asked): arrival and departure times",
  "PLACEHOLDER (group-level, organizer only, not yet asked): team sizes and counts",
  "PLACEHOLDER (group-level, organizer only, not yet asked): task difficulty",
  "PLACEHOLDER (group-level, organizer only, not yet asked): what is the loser doing?",
] as const;
