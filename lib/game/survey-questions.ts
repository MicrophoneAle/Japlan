export type QuestionId =
  | "first_name"
  | "age_bracket"
  | "dietary"
  | "dietary_detail"
  | "dietary_strictness"
  | "mobility"
  | "budget"
  | "blackout"
  | "interests"
  | "interest_picks"
  | "food_adventure"
  | "nightlife"
  | "drinking"
  | "paid_attractions"
  | "pace"
  | "sociability"
  | "chaos"
  | "chaos_dares"
  | "chaos_alternative"
  | "competitiveness"
  | "attractions"
  | "social_with"
  | "social_travelled"
  | "social_couples"
  | "tasks_per_day"
  // Survey v2: four either-or questions (weights, not facts), four direct.
  | "ab_food_outdoors"
  | "ab_discover_iconic"
  | "ab_culture_nightlife"
  | "ab_pace"
  | "budget_band"
  | "hard_constraints"
  | "must_have"
  | "splitting"
  // Follow-ups, asked only when the answer changes a decision.
  | "fu_budget"
  | "fu_constraints"
  | "fu_allergy_cc"
  | "fu_diet_strict"
  | "fu_split"
  // Sidequests' own mini-onboarding, at trip start.
  | "sidequest_level"
  | "sidequest_red_lines";

export type Question = {
  id: QuestionId;
  prompt: string;
  kind: "choice" | "multi_choice" | "free_text" | "either_or";
  choices?: { id: string; label: string }[];
  // multi_choice: how many picks count (a forced tradeoff, per PLAN).
  maxPicks?: number;
  // Asked again another way after an off-topic reply, not repeated verbatim.
  reask?: string;
  // either_or: the two scenarios, and words that point at each.
  sides?: { a: string; b: string; aWords: RegExp; bWords: RegExp };
};

// Copy: lowercase, conversational, one message each. "skip" is explained once,
// in the first question. Choice labels are what people see and can type; the
// ids (stored, used by validate.ts) also match, so old answers still work.
const LEGACY_QUESTIONS: Partial<Record<QuestionId, Question>> = {
  first_name: {
    id: "first_name",
    kind: "free_text",
    prompt:
      "a few quick ones so the tasks fit you. skip any of them by saying skip. what should i call you?",
  },
  age_bracket: {
    id: "age_bracket",
    kind: "choice",
    prompt: "age range? under 18 / 18-24 / 25-34 / 35-44 / 45-54 / 55+",
    choices: [
      { id: "under_18", label: "under 18" },
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
  // What the restriction is, so food tasks can avoid it rather than every
  // food task disappearing. Parsed by lib/game/diet.ts.
  dietary_detail: {
    id: "dietary_detail",
    kind: "free_text",
    prompt: "what is it? say it like you'd tell a waiter: shellfish, no pork, vegetarian, nuts.",
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
  // Older question, kept so answers already given still count. New surveys
  // ask interest_picks instead.
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
  // PLAN's interest allocation as a forced tradeoff: two picks, not a 1-5
  // rating of everything (everyone rates everything a 4).
  interest_picks: {
    id: "interest_picks",
    kind: "multi_choice",
    maxPicks: 2,
    prompt:
      "pick your top two: food / nature / museums / nightlife / shopping / architecture / weird local stuff",
    choices: [
      { id: "food", label: "food" },
      { id: "nature", label: "nature" },
      { id: "museums", label: "museums" },
      { id: "nightlife", label: "nightlife" },
      { id: "shopping", label: "shopping" },
      { id: "architecture", label: "architecture" },
      { id: "weird", label: "weird local stuff" },
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
    prompt: "what's your pace? early and moving / somewhere in between / two things and lunch",
    choices: [
      { id: "early_and_moving", label: "early and moving" },
      { id: "two_things_and_lunch", label: "two things and lunch" },
      { id: "steady", label: "somewhere in between" },
    ],
  },
  // A hard filter, not a weight: someone can be up for anything and still
  // not want to talk to strangers.
  sociability: {
    id: "sociability",
    kind: "choice",
    prompt: "how do you feel about talking to strangers? love it / fine in small doses / rather not",
    choices: [
      { id: "love_it", label: "love it" },
      { id: "small_doses", label: "fine in small doses" },
      { id: "rather_not", label: "rather not" },
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
  // Never asked: set when someone says "i want more tasks" or "7 a day".
  // Overrides the pace default for how many main tasks their board gets.
  tasks_per_day: {
    id: "tasks_per_day",
    kind: "free_text",
    prompt: "how many tasks a day?",
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

// v2 questions live in SURVEY_V2 (below) and are merged in, so QUESTIONS
// covers every id.
// Asked in this order (the original survey). Not asked any more, because nothing reads them now
// that teams form from conversation instead of being assigned:
// competitiveness, social_travelled. "interests" and "nightlife" became
// interest_picks. Their ids stay in QuestionId so old answers still parse.
export const LEGACY_QUESTION_ORDER: QuestionId[] = [
  "first_name",
  "age_bracket",
  "dietary",
  "dietary_detail",
  "dietary_strictness",
  "mobility",
  "budget",
  "blackout",
  "interest_picks",
  "food_adventure",
  "drinking",
  "paid_attractions",
  "pace",
  "sociability",
  "chaos",
  "chaos_dares",
  "chaos_alternative",
  "attractions",
  "social_with",
  "social_couples",
];



// The organizer's trip-level questions (destination, dates, difficulty, stake)
// live in lib/game/setup.ts and lib/handlers/setup.ts.
// TODO: PLAN also lists arrival/departure times and team sizes/counts for the
// organizer; not asked yet.

// ---------------------------------------------------------------------------
// Survey v2: fast, playful, hypothetical. Eight interactions at most. The
// either-or questions are weights with confidence (lib/game/prefs.ts), not
// facts; vague answers are stored as vague, never re-asked. Only budget and
// hard constraints get clarified, because only they are unusable when vague.

export const SURVEY_INTRO =
  `quick personality test, because asking "what do you like" is useless. pick whatever you'd rather be doing, don't overthink it. say skip whenever.`;

export const SURVEY_V2: Partial<Record<QuestionId, Question>> = {
  ab_food_outdoors: {
    id: "ab_food_outdoors",
    kind: "either_or",
    prompt: "insane local food spot you've never heard of, or kayaking somewhere stupidly pretty?",
    reask: "so: mystery food spot or pretty kayak?",
    sides: {
      a: "insane local food spot",
      b: "kayaking somewhere stupidly pretty",
      aWords: /\b(food|eat|spot|restaurant|eats|hungry|snack|the first|first|option a|a|1)\b/i,
      bWords: /\b(kayak\w*|outdoor\w*|pretty|nature|water|adventure|paddle|the second|second|option b|b|2)\b/i,
    },
  },
  ab_discover_iconic: {
    id: "ab_discover_iconic",
    kind: "either_or",
    prompt: "wander a neighbourhood and find random shit, or finally see the famous thing everyone talks about?",
    reask: "wandering and finding random stuff, or the famous thing?",
    sides: {
      a: "wander and find random shit",
      b: "see the famous thing",
      aWords: /\b(wander\w*|random|neighbou?rhood|discover\w*|explor\w*|lost|find stuff|the first|first|option a|a|1)\b/i,
      bWords: /\b(famous|iconic|landmark\w*|the famous thing|sights?|must.?see|the second|second|option b|b|2)\b/i,
    },
  },
  ab_culture_nightlife: {
    id: "ab_culture_nightlife",
    kind: "either_or",
    prompt: "museum + café + nice dinner, or activity + street food + bar at 1am?",
    reask: "museum-café-dinner day, or activity-street-food-1am-bar day?",
    sides: {
      a: "museum, café, nice dinner",
      b: "activity, street food, bar at 1am",
      aWords: /\b(museum|caf[eé]|dinner|chill|culture|art|calm|the first|first|option a|a|1)\b/i,
      bWords: /\b(activity|street food|bar|1am|night\w*|party|drinks?|late|the second|second|option b|b|2)\b/i,
    },
  },
  ab_pace: {
    id: "ab_pace",
    kind: "either_or",
    prompt: "you've got 4 free hours: cram in 3 things, or do one really good thing and vibe after?",
    reask: "4 free hours: cram three things in, or one good thing and vibe?",
    sides: {
      a: "cram in 3 things",
      b: "one really good thing, then vibe",
      aWords: /\b(cram\w*|three|3 things|packed|busy|all of it|max|the first|first|option a|a)\b/i,
      bWords: /\b(one thing|one good|one really|vibe|relax\w*|slow|chill|the second|second|option b|b)\b/i,
    },
  },
  budget_band: {
    id: "budget_band",
    kind: "choice",
    prompt:
      "money check. excluding flights and hotel, what feels normal to spend in a day? <$50 / $50-100 / $100-200 / don't make me think about money",
    reask: "rough daily spend, flights and hotel aside? under 50, 50-100, 100-200, or don't care?",
    choices: [
      { id: "under_50", label: "<$50" },
      { id: "50_100", label: "$50-100" },
      { id: "100_200", label: "$100-200" },
      { id: "no_limit", label: "don't make me think about money" },
    ],
  },
  hard_constraints: {
    id: "hard_constraints",
    kind: "free_text",
    prompt:
      "anything i genuinely cannot screw up? allergies, food rules, accessibility, age-restricted stuff, physical limits, hard no's. none is a valid answer.",
    reask: "anything i can't get wrong for you: allergies, food rules, physical stuff, hard no's? none is fine.",
  },
  must_have: {
    id: "must_have",
    kind: "free_text",
    prompt: "finish this sentence: this trip was a waste if we didn't ___",
    reask: "this trip was a waste if we didn't...?",
  },
  splitting: {
    id: "splitting",
    kind: "choice",
    prompt: "if everyone wants different stuff, are you cool splitting up for a few hours? yes / depends / absolutely not",
    reask: "cool splitting up for a few hours if people want different things? yes, depends, or absolutely not?",
    choices: [
      { id: "yes", label: "yes" },
      { id: "depends", label: "depends" },
      { id: "no", label: "absolutely not" },
    ],
  },
  fu_budget: {
    id: "fu_budget",
    kind: "choice",
    prompt: "fair. rough number then: under $50, 50-100, 100-200, or more?",
    reask: "just a ballpark per day: under 50, 50-100, 100-200?",
  },
  fu_constraints: {
    id: "fu_constraints",
    kind: "free_text",
    prompt: "what are they? i need the actual things for this one, it's how i keep tasks safe for you.",
    reask: "which things exactly? an allergy, a food rule, something physical?",
  },
  fu_allergy_cc: {
    id: "fu_allergy_cc",
    kind: "free_text",
    prompt: "actual allergy where cross-contamination matters too?",
    reask: "does cross-contamination matter for that one?",
  },
  fu_diet_strict: {
    id: "fu_diet_strict",
    kind: "free_text",
    prompt: "got it, preference not a hard rule?",
    reask: "preference, or a hard rule?",
  },
  fu_split: {
    id: "fu_split",
    kind: "free_text",
    prompt: "depends on what? someone you want to stick with, or just what we're doing?",
    reask: "a person you'd stick with, or more about what the plan is?",
  },
  sidequest_level: {
    id: "sidequest_level",
    kind: "choice",
    prompt:
      "btw i'm turning on sidequests. how unhinged am i allowed to get?\n1 civilized (food, photos, exploring)\n2 questionable (strangers, mild embarrassment)\n3 feral (surprise me)\n4 absolutely not",
    reask: "sidequests: 1 civilized, 2 questionable, 3 feral, or 4 absolutely not?",
    choices: [
      { id: "1", label: "civilized" },
      { id: "2", label: "questionable" },
      { id: "3", label: "feral" },
      { id: "4", label: "absolutely not" },
    ],
  },
  sidequest_red_lines: {
    id: "sidequest_red_lines",
    kind: "free_text",
    prompt: "any red lines? strangers / public embarrassment / physical stuff / spending money / anything else",
    reask: "red lines for sidequests? strangers, embarrassment, physical, money, or none?",
  },
};

export const SURVEY_V2_ORDER: QuestionId[] = [
  "ab_food_outdoors",
  "ab_discover_iconic",
  "ab_culture_nightlife",
  "ab_pace",
  "budget_band",
  "fu_budget",
  "hard_constraints",
  "fu_constraints",
  "fu_allergy_cc",
  "fu_diet_strict",
  "must_have",
  "splitting",
  "fu_split",
];

export const SIDEQUEST_ORDER: QuestionId[] = ["sidequest_level", "sidequest_red_lines"];

export const SURVEY_V2_CLOSE = "done. you're less mysterious than you think.";

export const QUESTIONS = { ...LEGACY_QUESTIONS, ...SURVEY_V2 } as Record<QuestionId, Question>;

// The survey everyone is asked now.
export const QUESTION_ORDER: QuestionId[] = SURVEY_V2_ORDER;

export const FIRST_QUESTION_ID: QuestionId = "ab_food_outdoors";
