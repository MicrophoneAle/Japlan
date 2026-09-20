import { BUDGET_CEILING } from "./validate";
import {
  displayNameFromFirstName,
  interestPicksOf,
  recordAnswer,
  answerValue,
  type SurveyAnswers,
} from "./survey";
import { parseConstraints } from "./constraints";
import { effectiveWeight, PREF_DIMS, prefsOf, v2View, type PrefDim } from "./prefs";
import { QUESTIONS, type QuestionId } from "./survey-questions";

export type SettingsOverviewSection = { title: string; lines: string[] };

// Everyone's own survey answers are theirs to change, any time, in plain
// words: "my pace is too slow", "change my budget to 150", "actually i do
// like museums", "i'm fine talking to strangers now", "i want more tasks".
// The model names the setting and passes their words; this decides the
// stored value. Nothing here refuses: an unreadable value re-asks with the
// options.

// "none", "no restrictions": an answer that means nothing is stored. A new
// constraint replaces it rather than appending to it, and saying it fresh
// clears the list rather than joining it ("peanuts, none" would have kept
// filtering peanuts forever).
//
// Anchored at BOTH ends on purpose. A leading-edge match also caught real
// constraints: "no heights" starts with "no", so storing a second red line
// would have quietly wiped the first one.
const NO_CONSTRAINT_TEXT_RE =
  /^(?:none|no|nope|nothing|n\/?a|na|all good|no (?:more )?(?:dietary |food )?restrictions?|nothing at all)(?:\s+(?:any\s?more|now))?[.!]?$/i;

function meansNoConstraint(text: string): boolean {
  return NO_CONSTRAINT_TEXT_RE.test(text.trim());
}

// What people call each setting, to its survey question.
const SETTING_NAMES: [RegExp, QuestionId][] = [
  [/pace|speed|busy|tempo/, "pace"],
  [/strangers?|sociab|social|talking to people|locals/, "sociability"],
  [/interest|into|like|museum|food|nature|nightlife|shopping|architecture|weird/, "interest_picks"],
  [/budget|money|spend/, "budget"],
  [/chaos|dares?|wild/, "chaos"],
  [/task count|tasks per day|how many tasks|more tasks|fewer tasks|number of tasks|tasks a day/, "tasks_per_day"],
  // SAFETY: allergy language goes to hard_constraints, NOT dietary_detail.
  // compatAnswers DERIVES dietary/dietary_detail/dietary_strictness from
  // hard_constraints, so a write to dietary_detail is regenerated away on the
  // next read and gates nothing. "actually i'm allergic to shellfish too"
  // acknowledged them and still sent them to a fish market.
  // Listed before the diet matcher so allergy wins the match.
  [/allerg|anaphyla|epipen|coeliac|celiac|intoleran/, "hard_constraints"],
  [/red ?line|no heights|scared of|phobia|won'?t do|wont do|off the table|hard no|hard limit/, "sidequest_red_lines"],
  [/diet|vegetarian|vegan|food restriction|eat|gluten|halal|kosher|pescatarian/, "hard_constraints"],
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

  // hard_constraints and sidequest_red_lines are free text that GATES task
  // generation, so they APPEND by default rather than replace: "also allergic
  // to shellfish" must not wipe the peanut allergy already stored. An explicit
  // "set"/"remove" still does what it says.
  if (id === "hard_constraints" || id === "sidequest_red_lines") {
    const current = (answerValue(opts.answers, id) ?? "").trim();
    const clean = value.replace(/^(?:also|and|actually|oh and|plus)\s+/i, "").trim();
    if (!clean) return { ok: false, id, options: [] };
    let next: string;
    if (opts.mode === "remove") {
      next = current
        .split(/\s*[,;]\s*/)
        .filter((part) => part && !part.toLowerCase().includes(clean.toLowerCase()))
        .join(", ");
    } else if (meansNoConstraint(clean)) {
      // They are saying the constraint is gone, not adding "none" to it.
      next = clean;
    } else if (opts.mode === "set" || !current || meansNoConstraint(current)) {
      next = clean;
    } else if (current.toLowerCase().includes(clean.toLowerCase())) {
      next = current;
    } else {
      next = `${current}, ${clean}`;
    }
    return { ok: true, id, answers: recordAnswer(opts.answers, id, next) ?? opts.answers, shown: next };
  }

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

function answerLine(
  answers: SurveyAnswers,
  id: QuestionId,
  label: string,
  format: (value: string) => string = (value) => value,
  missing = "not answered yet",
): string {
  const entry = answers[id];
  if (entry?.skipped) return `${label}: skipped (no answer saved)`;
  if (!entry?.value) return `${label}: ${missing}`;
  return `${label}: ${format(entry.value)}`;
}

function eitherOr(value: string, a: string, b: string): string {
  if (value === "a") return a;
  if (value === "b") return b;
  if (value === "both") return `both sound good (${a}; ${b})`;
  if (value === "none") return "neither is a strong preference";
  return "no clear preference yet";
}

function budgetLabel(value: string): string {
  const label = QUESTIONS.budget_band.choices?.find((choice) => choice.id === value)?.label;
  if (value === "no_limit") return "no fixed daily cap";
  return label ? `${label} per day` : value;
}

function constraintsLabel(value: string): string {
  const parsed = parseConstraints(value);
  if (parsed.none) return "none reported";
  if (parsed.vague) return `needs details: ${value}`;
  return value;
}

function sidequestLabel(value: string): string {
  return ({ "1": "gentle", "2": "social", "3": "wild", "4": "off" } as Record<string, string>)[value] ?? value;
}

// The settings command uses the current survey's actual fields. v2View also
// translates older answers, so returning players still see what they saved.
export function settingsOverview(
  rawAnswers: SurveyAnswers,
  opts: { displayName?: string; sidequestsMuted?: boolean; prefsJson?: unknown } = {},
): SettingsOverviewSection[] {
  const answers = v2View(rawAnswers);
  const firstName = answerValue(answers, "first_name");
  const name = firstName
    ? displayNameFromFirstName(firstName, opts.displayName ?? firstName)
    : opts.displayName
      ? `${opts.displayName} (using your chat name)`
      : "not set";

  const personal: SettingsOverviewSection[] = [
    {
      title: "about you",
      lines: [
        `name on your board: ${name}`,
        `tasks per day: ${answerValue(answers, "tasks_per_day") ?? "automatic, based on your pace"}`,
      ],
    },
    {
      title: "what you enjoy",
      lines: [
        answerLine(answers, "ab_food_outdoors", "food or outdoors", (value) => eitherOr(value, "local food", "outdoors and kayaking"), "no clear preference saved yet"),
        answerLine(answers, "ab_discover_iconic", "exploring style", (value) => eitherOr(value, "wandering neighborhoods", "famous sights"), "no clear preference saved yet"),
        answerLine(answers, "ab_culture_nightlife", "day or night out", (value) => eitherOr(value, "museums, cafes, and dinner", "activities and a late night"), "no clear preference saved yet"),
        answerLine(answers, "ab_pace", "day pace", (value) => eitherOr(value, "packed and active", "one great thing, then free time"), "no clear preference saved yet"),
        `learned preferences: ${learnedPreferenceLine(rawAnswers, opts.prefsJson)}`,
      ],
    },
    {
      title: "budget and boundaries",
      lines: [
        answerLine(answers, "budget_band", "daily spending", budgetLabel, "no personal budget saved"),
        answerLine(answers, "hard_constraints", "allergies, access needs, and hard no's", constraintsLabel, "not provided yet"),
        answerLine(answers, "must_have", "your must-do", (value) => value, "not answered yet"),
        answerLine(answers, "splitting", "splitting up", (value) => value === "yes" ? "you're okay with it" : value === "no" ? "you prefer staying together" : value === "depends" ? "depends on the situation" : value, "not answered yet"),
      ],
    },
  ];

  const sidequestLevel = answerValue(answers, "sidequest_level");
  const sidequestLines = [
    answerLine(answers, "sidequest_level", "challenge intensity", sidequestLabel, "not answered yet"),
  ];
  if (sidequestLevel === "2" || sidequestLevel === "3" || answers.sidequest_red_lines) {
    sidequestLines.push(answerLine(answers, "sidequest_red_lines", "challenge boundaries", (value) => value, "none listed"));
  }
  if (opts.sidequestsMuted !== undefined) {
    const status = opts.sidequestsMuted
      ? "paused by you"
      : sidequestLevel === "4"
        ? "off (you chose none)"
        : "on for you";
    sidequestLines.push(`bonus challenges: ${status}`);
  }
  personal.push({ title: "optional bonus challenges", lines: sidequestLines });

  const extraFields: [QuestionId, string][] = [
    ["blackout", "times to avoid"],
    ["food_adventure", "food adventure"],
    ["drinking", "alcohol"],
    ["attractions", "places you asked for"],
  ];
  const extras = extraFields
    .filter(([id]) => rawAnswers[id] !== undefined)
    .map(([id, label]) => answerLine(rawAnswers, id, label, (value) => value, "not answered yet"));
  if (extras.length > 0) personal.push({ title: "other saved details", lines: extras });

  return personal;
}

function learnedPreferenceLine(answers: SurveyAnswers, prefsJson: unknown): string {
  const labels: Record<PrefDim, string> = {
    food: "local food",
    outdoors: "outdoors",
    adventure: "adventure",
    local_discovery: "neighborhood exploring",
    iconic: "famous sights",
    culture: "museums and culture",
    chill: "slower days",
    activity: "active outings",
    nightlife: "nightlife",
  };
  const prefs = prefsOf(prefsJson, answers);
  const leans = PREF_DIMS.flatMap((dim) => {
    const weight = effectiveWeight(prefs.weights[dim]);
    if (weight >= 0.62) return [`more ${labels[dim]}`];
    if (weight <= 0.38) return [`less ${labels[dim]}`];
    return [];
  });
  return leans.length > 0
    ? leans.join(", ")
    : "no clear pattern yet; tell me what you'd like more or less of";
}
