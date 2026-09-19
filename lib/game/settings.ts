import { BUDGET_CEILING } from "./validate";
import {
  displayNameFromFirstName,
  interestPicksOf,
  recordAnswer,
  answerValue,
  type SurveyAnswers,
} from "./survey";
import { QUESTIONS, type QuestionId } from "./survey-questions";

// Everyone's own survey answers are theirs to change, any time, in plain
// words: "my pace is too slow", "change my budget to 150", "actually i do
// like museums", "i'm fine talking to strangers now", "i want more tasks".
// The model names the setting and passes their words; this decides the
// stored value. Nothing here refuses: an unreadable value re-asks with the
// options.

// What people call each setting, to its survey question.
const SETTING_NAMES: [RegExp, QuestionId][] = [
  [/pace|speed|busy|tempo/, "pace"],
  [/strangers?|sociab|social|talking to people|locals/, "sociability"],
  [/interest|into|like|museum|food|nature|nightlife|shopping|architecture|weird/, "interest_picks"],
  [/budget|money|spend/, "budget"],
  [/chaos|dares?|wild/, "chaos"],
  [/task count|tasks per day|how many tasks|more tasks|fewer tasks|number of tasks|tasks a day/, "tasks_per_day"],
  [/diet|allerg|vegetarian|vegan|food restriction|eat/, "dietary_detail"],
  [/strict/, "dietary_strictness"],
  [/mobility|walking|stairs|physical|knee/, "mobility"],
  [/drink|alcohol/, "drinking"],
  [/blackout|off limits|busy times|calls|nap/, "blackout"],
  [/adventur|spice/, "food_adventure"],
  [/name|call me/, "first_name"],
  [/age/, "age_bracket"],
  [/attraction|itinerary|want to see/, "attractions"],
  [/couple/, "social_couples"],
  [/end up with|split with|who .* with/, "social_with"],
];

// Questions no longer asked, to the ones that replaced them.
const LEGACY: Partial<Record<QuestionId, QuestionId>> = {
  interests: "interest_picks",
  nightlife: "interest_picks",
  dietary: "dietary_detail",
};

export function settingIdFor(name: string): QuestionId | null {
  const lower = name.toLowerCase().trim().replace(/[_-]+/g, " ");
  const legacy = LEGACY[lower.replace(/ /g, "_") as QuestionId];
  if (legacy) return legacy;
  if ((Object.keys(QUESTIONS) as QuestionId[]).includes(lower.replace(/ /g, "_") as QuestionId)) {
    return lower.replace(/ /g, "_") as QuestionId;
  }
  return SETTING_NAMES.find(([re]) => re.test(lower))?.[1] ?? null;
}

// Plain words for choice settings, checked before exact option matching.
// Order matters: the more specific phrases first.
const CHOICE_WORDS: Partial<Record<QuestionId, [RegExp, string][]>> = {
  pace: [
    [/between|middle|steady|normal|medium|default|moderate/, "steady"],
    [/chaotic|fast|faster|quick|more|busy|packed|early|moving|high|max|highest|intense|up/, "early_and_moving"],
    [/slow|relax|chill|less|lunch|easy|lazy|low|down/, "two_things_and_lunch"],
  ],
  sociability: [
    [/small dose|sometimes|a bit|a little|some|occasional|once/, "small_doses"],
    [/rather not|\bnot\b|never|hate|avoid|don'?t|no\b|introvert/, "rather_not"],
    [/love|fine|happy|yes|ok|okay|sure|up for|comfortable|bring it|any/, "love_it"],
  ],
  chaos: [
    [/low|less|calm|tame|gentle|down/, "low"],
    [/high|more|lots|bring it|wild|up|max/, "high"],
  ],
  mobility: [
    [/no limit|none|fine|all good|nothing|no problem/, "no_limits"],
    [/limit|knee|injur|stairs|can'?t walk|wheelchair|slow walker|hip|back/, "has_limits"],
  ],
  drinking: [
    [/sometimes|occasional|a bit/, "sometimes"],
    [/\bno\b|don'?t|not|sober|never/, "no"],
    [/yes|sure|do|love/, "yes"],
  ],
  dietary_strictness: [
    [/allerg|serious|strict/, "allergy"],
    [/prefer/, "preference"],
    [/flexible|cheat|relaxed/, "cheat_on_vacation"],
  ],
};

// "150", "$150 a day", "cheap", "splurge": a budget band. Numbers go by the
// ceilings the budget filter uses.
function budgetBand(text: string): string | null {
  const number = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (number) {
    const amount = Number(number[0]);
    if (amount <= BUDGET_CEILING.low) return "low";
    if (amount <= BUDGET_CEILING.medium) return "medium";
    return "high";
  }
  if (/cheap|low|tight|broke|small|less/.test(text)) return "low";
  if (/splurge|high|big|unlimited|no budget|loaded|more/.test(text)) return "high";
  if (/mid|medium|normal|moderate/.test(text)) return "medium";
  return null;
}

// How many main tasks a board gets when someone asked for more than the
// pace default. Upper bound is what fits in a day, checked when planning.
export const DEFAULT_MORE_STEP = 2;
export const MAX_TASKS_PER_DAY = 12;

export function tasksPerDayOf(answers: SurveyAnswers): number | null {
  const n = Number(answerValue(answers, "tasks_per_day"));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_TASKS_PER_DAY, Math.round(n)) : null;
}

function taskCount(text: string, current: number | null, fallback: number): string | null {
  const number = text.match(/\d+/);
  if (number) return String(Math.max(1, Math.min(MAX_TASKS_PER_DAY, Number(number[0]))));
  if (/default|normal|reset|whatever|pace/.test(text)) return "";
  const base = current ?? fallback;
  if (/more|extra|double|lots|max|heaps/.test(text)) return String(Math.min(MAX_TASKS_PER_DAY, base + DEFAULT_MORE_STEP));
  if (/fewer|less|lighter|chill/.test(text)) return String(Math.max(1, base - 1));
  return null;
}

export type SettingUpdate =
  | { ok: true; id: QuestionId; answers: SurveyAnswers; shown: string }
  | { ok: false; id: QuestionId | null; options: string[] };

export function showSetting(id: QuestionId, answers: SurveyAnswers): string {
  if (id === "interest_picks") {
    const picks = interestPicksOf(answers);
    return picks.length ? picks.map((p) => QUESTIONS.interest_picks.choices?.find((c) => c.id === p)?.label ?? p).join(" and ") : "not set";
  }
  if (id === "tasks_per_day") {
    const n = tasksPerDayOf(answers);
    return n ? `${n} a day` : "the pace default";
  }
  const value = answerValue(answers, id);
  if (!value) return "not set";
  if (id === "first_name") return displayNameFromFirstName(value, value);
  const choice = QUESTIONS[id].choices?.find((c) => c.id === value);
  return choice?.label ?? value;
}

// One setting, changed. mode is for interests: add or remove one pick.
export function applySettingUpdate(opts: {
  answers: SurveyAnswers;
  setting: string;
  value: string;
  mode?: "set" | "add" | "remove";
  // The board's current task count, for "more tasks" from a default board.
  currentTasks?: number;
}): SettingUpdate {
  const id = settingIdFor(opts.setting);
  if (!id) return { ok: false, id: null, options: [] };
  let value = opts.value.trim();
  if (id === "first_name") {
    value = value
      .replace(/^(?:(?:please|actually|well)\s+)*(?:call me|my name is|i am|i'm)\s+/i, "")
      .trim();
    if (!value) return { ok: false, id, options: [] };
  }
  const lower = value.toLowerCase();
  let answers: SurveyAnswers | null = null;

  if (id === "interest_picks") {
    const current = interestPicksOf(opts.answers);
    const parsed = recordAnswer({}, "interest_picks", value);
    const said = parsed ? interestPicksOf(parsed) : [];
    if (said.length === 0) {
      return { ok: false, id, options: (QUESTIONS.interest_picks.choices ?? []).map((c) => c.label) };
    }
    let next: string[];
    if (opts.mode === "remove") next = current.filter((p) => !said.includes(p));
    else if (opts.mode === "add") next = [...said, ...current.filter((p) => !said.includes(p))].slice(0, 2);
    else next = said;
    answers = { ...opts.answers, interest_picks: { value: next.join(",") } };
  } else if (id === "budget") {
    const band = budgetBand(lower);
    if (band) answers = { ...opts.answers, budget: { value: band } };
  } else if (id === "tasks_per_day") {
    const n = taskCount(lower, tasksPerDayOf(opts.answers), opts.currentTasks ?? 3);
    if (n === "") answers = { ...opts.answers, tasks_per_day: { skipped: true } };
    else if (n !== null) answers = { ...opts.answers, tasks_per_day: { value: n } };
  } else if (id === "dietary_detail") {
    // Saying what it is means there is one; "none" clears it.
    if (/^(none|nothing|no restrictions?|not anymore|all good)$/.test(lower)) {
      answers = { ...opts.answers, dietary: { value: "none" }, dietary_detail: { skipped: true } };
    } else {
      answers = {
        ...opts.answers,
        dietary: { value: "has_restriction" },
        dietary_detail: { value },
        dietary_strictness: opts.answers.dietary_strictness ?? { value: "allergy" },
      };
    }
  } else if (QUESTIONS[id].kind === "choice") {
    const exact = recordAnswer(opts.answers, id, value);
    const word = CHOICE_WORDS[id]?.find(([re]) => re.test(lower))?.[1];
    if (exact && !(exact[id]?.skipped)) answers = exact;
    else if (word) answers = { ...opts.answers, [id]: { value: word } };
  } else {
    answers = { ...opts.answers, [id]: { value } };
  }

  if (!answers) {
    const options =
      id === "budget"
        ? ["low", "medium", "high", "or a daily amount"]
        : id === "tasks_per_day"
          ? ["a number", "more", "fewer", "default"]
          : (QUESTIONS[id].choices ?? []).map((c) => c.label);
    return { ok: false, id, options };
  }
  return { ok: true, id, answers, shown: showSetting(id, answers) };
}

// Names people use, for the settings list.
export const SETTING_LABELS: Partial<Record<QuestionId, string>> = {
  pace: "pace",
  tasks_per_day: "tasks per day",
  sociability: "talking to strangers",
  interest_picks: "interests",
  chaos: "chaos",
  budget: "budget",
  dietary_detail: "diet",
  mobility: "mobility",
  drinking: "drinking",
  blackout: "off-limits times",
  food_adventure: "food adventure",
  first_name: "name",
};

export function settingsSummary(answers: SurveyAnswers): string[] {
  return (Object.keys(SETTING_LABELS) as QuestionId[]).map(
    (id) => `${SETTING_LABELS[id]}: ${showSetting(id, answers)}`,
  );
}
