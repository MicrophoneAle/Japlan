import type { DestinationProfile } from "./destination";
import {
  bandForMinutes,
  estimateTaskMinutes,
  haversineKm,
  reconcileTimeAxis,
  type LatLng,
} from "./duration";
import {
  allOneKind,
  dayMinutes,
  FILL_LOW,
  MAX_MAIN_TASKS,
  maxTaskMinutes,
  planDay,
  selectForDay,
  type DaySlot,
  type DayWindow,
  type RouteEnds,
} from "./day-plan";
import { boldTasksWanted } from "./generate";
import {
  boldnessFit,
  boldnessTarget,
  categoriesOf,
  groupSociability,
  interestWeights,
  strangerLimits,
  type Sociability,
} from "./preferences";
import type { SurveyAnswers } from "./survey";
import { tasksPerDayOf } from "./settings";
import { dietClashes, parseDiet, type DietKey } from "./diet";
import { templateById, type InterestKey, type TaskTemplate } from "./templates";
import {
  CURVEBALL,
  enforceBoardMix,
  involvesStranger,
  normalizeTitle,
  validateGeneratedTask,
  type AssigneeConstraints,
  type ProposedTask,
  type TaskKind,
  type TemplateFacts,
} from "./validate";

// From proposals to a planned day, in code: validate, place, time, pick,
// order. The model proposes; everything here decides.

export type ResolvedPlace = {
  name: string;
  coords: LatLng | null;
  category: string | null;
  neighborhood: string | null;
};

function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function coordsOf(p: { lat: number | null; lng: number | null }): LatLng | null {
  return p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng } : null;
}

// The profile neighborhood a point is in (nearest within 3 km), for the
// board's "Asakusa → Ueno" header.
export function nearestNeighborhood(coords: LatLng | null, profile: DestinationProfile): string | null {
  if (!coords) return null;
  let best: { name: string; km: number } | null = null;
  for (const n of profile.neighborhoods) {
    const at = coordsOf(n);
    if (!at) continue;
    const km = haversineKm(coords, at);
    if (!best || km < best.km) best = { name: n.name, km };
  }
  return best && best.km <= 3 ? best.name : null;
}

// A name the model (or a template) gave, matched to the destination profile:
// exact names first, then one containing the other ("Ueno" vs "Ueno Park").
// Unknown names still count as a place (for "no two at one place"), just
// without coordinates.
export function resolvePlace(name: string, profile: DestinationProfile): ResolvedPlace | null {
  const wanted = norm(name);
  if (!wanted) return null;
  const entries = [
    ...profile.landmarks.map((l) => ({ name: l.name, coords: coordsOf(l), category: l.category, hood: false })),
    ...profile.neighborhoods.map((n) => ({ name: n.name, coords: coordsOf(n), category: null, hood: true })),
  ];
  const match =
    entries.find((e) => norm(e.name) === wanted) ??
    entries.find((e) => wanted.includes(norm(e.name)) || norm(e.name).includes(wanted));
  if (!match) return { name, coords: null, category: null, neighborhood: null };
  return {
    name: match.name,
    coords: match.coords,
    category: match.category,
    neighborhood: match.hood ? match.name : nearestNeighborhood(match.coords, profile),
  };
}

function medianPriceBand(profile: DestinationProfile): number | null {
  const bands = [...profile.price_bands].sort((a, b) => a - b);
  return bands.length > 0 ? bands[Math.floor(bands.length / 2)] : null;
}

export type Candidate = ProposedTask & {
  minutes: number;
  coords: LatLng | null;
  stranger: boolean;
  // Survey interests it serves (the template's, or guessed from a
  // curveball's kind) and the avoidable categories it falls in.
  interests: InterestKey[];
  categories: string[];
  // Someone in the group asked for this place: shown as "+ teamLab, dev's
  // pick" on the board. Set for anchors and tasks at a suggested place.
  suggestedBy?: string | null;
  anchor?: boolean;
  // Resolved profile neighborhood, or null when the task can be anywhere.
  resolvedNeighborhood: string | null;
  // True when the model's time axis was overruled by the estimate.
  timeOverridden: boolean;
};

export type PlannedTask = Candidate & { slot: DaySlot };

export type PrepareContext = {
  profile: DestinationProfile;
  solo: boolean;
  window: DayWindow;
  assignees: AssigneeConstraints[];
  completedTitles: string[];
  expiresAt: Date;
  now?: Date;
  onReject?: (reason: string, title: string) => void;
};

// Per-task gate for one proposal. Everything the existing validation rejects
// is still rejected (booking, budget, diet, mobility, unsafe, duplicate,
// expiry); on top: it has to come from a board template (or be the
// curveball), be a main task by duration, and fit in the time left today.
export function prepareCandidates(proposals: ProposedTask[], ctx: PrepareContext): Candidate[] {
  const reject = (reason: string, title: string) => ctx.onReject?.(reason, title);
  const done = new Set(ctx.completedTitles.map(normalizeTitle));
  // The same title twice in one batch (a template filled the same way twice)
  // is not a rejection, just a repeat: skipped quietly.
  const batch = new Set<string>();
  const priceBand = medianPriceBand(ctx.profile);
  const out: Candidate[] = [];
  for (const task of proposals) {
    const curveball = task.template === CURVEBALL;
    const template = templateById(task.template);
    if (!template && !curveball) {
      reject("no_template", task.title);
      continue;
    }
    if (template?.duration === "sidequest") {
      reject("sidequest_template", task.title);
      continue;
    }
    if (template?.groupOnly && ctx.solo) {
      reject("group_only", task.title);
      continue;
    }
    const key = normalizeTitle(task.title);
    if (batch.has(key)) continue;
    batch.add(key);
    if (done.has(key)) {
      reject("duplicate", task.title);
      continue;
    }
    const reason = validateGeneratedTask(task, {
      assignees: ctx.assignees,
      completedTitles: ctx.completedTitles,
      expiresAt: ctx.expiresAt,
      now: ctx.now,
      template: template ? templateFacts(template) : null,
    });
    if (reason) {
      reject(reason, task.title);
      continue;
    }

    const names = task.places ?? (task.place ? [task.place] : []);
    const places = names
      .map((name) => resolvePlace(name, ctx.profile))
      .filter((p): p is ResolvedPlace => p !== null);
    const first = places[0] ?? null;
    const hood = task.neighborhood ? resolvePlace(task.neighborhood, ctx.profile) : null;
    const venueCategory =
      template?.venue === "place" || curveball ? (first?.category ?? null) : (template?.venue ?? null);
    const leg =
      template?.leg && places[0]?.coords && places[1]?.coords
        ? { from: places[0].coords, to: places[1].coords, mode: template.leg }
        : null;
    // The model's axes stay inside its template's ranges, which are set so
    // the bank spreads across the scoring space. Time is decided below.
    const axes = { ...task.axes };
    if (template) {
      for (const key of ["boldness", "physical", "scarcity", "cultural", "aesthetics"] as const) {
        const { min, max } = template.axes[key];
        axes[key] = Math.min(max, Math.max(min, axes[key]));
      }
    }
    const estimate = estimateTaskMinutes({
      boldness: axes.boldness,
      venueCategory,
      priceBand,
      leg,
      fixedMinutes: template?.fixedMinutes,
    });
    const reconciled = reconcileTimeAxis(task.axes.time, estimate);
    axes.time = reconciled.time;

    if (bandForMinutes(reconciled.minutes) === "sidequest") {
      reject("sidequest_length", task.title);
      continue;
    }
    if (reconciled.minutes > maxTaskMinutes(ctx.window)) {
      reject("too_long_for_window", task.title);
      continue;
    }
    const when = template?.when ?? task.when;
    if (when === "morning" && ctx.window.startMinutes >= 11 * 60) {
      reject("wrong_time_of_day", task.title);
      continue;
    }

    // A route task is placed at its end; anything else at its first place,
    // else in its neighborhood.
    const anchor = (leg ? places[1] : first) ?? null;
    const coords = anchor?.coords ?? hood?.coords ?? null;
    out.push({
      ...task,
      axes,
      kind: template?.kind ?? task.kind,
      stranger: involvesStranger(task, template ? templateFacts(template) : null),
      interests: template?.interests ?? interestsForKind(task.kind),
      categories: categoriesOf(task.title, first?.category ?? null),
      ...(when ? { when } : {}),
      source: curveball ? "curveball" : (task.source ?? "generated"),
      place: first?.name ?? task.place,
      minutes: reconciled.minutes,
      timeOverridden: reconciled.overridden,
      coords,
      resolvedNeighborhood: anchor?.neighborhood ?? hood?.neighborhood ?? null,
    });
  }
  return out;
}

export function templateFacts(template: TaskTemplate): TemplateFacts {
  return {
    needs_stranger: template.needs_stranger,
    blind_food: template.blind_food,
    alcohol: template.alcohol,
    kind: template.kind,
    typical_cost: template.typical_cost,
    physicalMin: template.axes.physical.min,
  };
}

// A curveball has no template tags; its kind is the best guess.
function interestsForKind(kind: TaskKind | undefined): InterestKey[] {
  switch (kind) {
    case "food":
      return ["food"];
    case "culture":
      return ["museums", "architecture"];
    case "explore":
      return ["weird", "nature"];
    case "creative":
      return ["shopping", "weird"];
    case "challenge":
      return ["nature"];
    default:
      return ["weird"];
  }
}

// Two tasks that cannot share a board: the same place, the same template, or
// two curveballs. Anchors (places the group asked for) conflict with nothing.
export function boardConflict(a: Partial<Candidate> & ProposedTask, b: Partial<Candidate> & ProposedTask): boolean {
  if (a.anchor || b.anchor) return false;
  return enforceBoardMix([a, b], { oneKind: false }).kept.length < 2;
}

// A place someone in the group asked for ("we should go to teamLab").
export type Suggestion = {
  name: string;
  coords: LatLng | null;
  // Display name of who asked, for the board's "dev's pick".
  by: string | null;
};

// Everything about the people on a board that shapes it, beyond the per-task
// filters in validate.ts. Built once per board by boardPreferencesFor.
export type BoardPreferences = {
  sociability: Sociability;
  minStranger: number;
  maxStranger: number;
  interestWeights: Record<InterestKey, number>;
  boldnessTarget: number;
  minBold: number;
  // category -> multiplier below 1 ("we don't want to do temples").
  avoid: Record<string, number>;
  suggestions: Suggestion[];
  // A requested task count (tasks_per_day, or "7 attractions today").
  targetCount: number | null;
  // Diet preferences (not hard rules): food that clashes is less preferred.
  softDiet: DietKey[];
};

export function boardPreferencesFor(opts: {
  answers: SurveyAnswers[];
  difficulty: string | null | undefined;
  avoid?: Record<string, number>;
  suggestions?: Suggestion[];
  targetCount?: number | null;
}): BoardPreferences {
  const sociability = groupSociability(opts.answers);
  // More is a request anyone on the board can make: the largest one wins.
  const asked = opts.answers.map(tasksPerDayOf).filter((n): n is number => n !== null);
  const limits = strangerLimits(sociability);
  return {
    sociability,
    minStranger: limits.min,
    maxStranger: limits.max,
    interestWeights: interestWeights(opts.answers),
    boldnessTarget: boldnessTarget(opts.difficulty, opts.answers),
    // Same count the prompt asks for, now enforced: chill still gets one.
    minBold: boldTasksWanted(opts.difficulty, 3),
    avoid: opts.avoid ?? {},
    suggestions: opts.suggestions ?? [],
    targetCount: opts.targetCount ?? (asked.length ? Math.max(...asked) : null),
    softDiet: [
      ...new Set(
        opts.answers
          .filter((a) => a.dietary_strictness?.value === "preference")
          .flatMap((a) => parseDiet(a.dietary_detail?.value).keys),
      ),
    ],
  };
}

export const NEUTRAL_PREFERENCES: BoardPreferences = boardPreferencesFor({
  answers: [{ sociability: { value: "love_it" } }],
  difficulty: null,
});

const SUGGESTION_KM = 0.6;

// The suggestion a task goes to, if any: within 600 m, or naming it.
export function suggestionFor(task: Pick<Candidate, "title" | "coords">, suggestions: Suggestion[]): Suggestion | null {
  const title = norm(task.title);
  return (
    suggestions.find(
      (s) =>
        (s.coords && task.coords && haversineKm(s.coords, task.coords) <= SUGGESTION_KM) ||
        (norm(s.name).length > 3 && title.includes(norm(s.name))),
    ) ?? null
  );
}

// How much a board wants a task: what the people on it are into, how close
// it sits to the board's boldness target, whether someone asked for the
// place, and whether the group asked to avoid its category.
export function taskPriority(task: Candidate, prefs: BoardPreferences): number {
  const interest = task.interests.length
    ? Math.max(...task.interests.map((k) => prefs.interestWeights[k] ?? 1))
    : 1;
  const avoid = task.categories.reduce((f, c) => f * (prefs.avoid[c] ?? 1), 1);
  const suggested = suggestionFor(task, prefs.suggestions) ? 2.5 : 1;
  const diet = dietClashes(task.title, prefs.softDiet).length > 0 ? 0.4 : 1;
  return interest * boldnessFit(task.axes.boldness, prefs.boldnessTarget) * suggested * avoid * diet;
}

// Preference order within a pool: the curveball first (the point of
// generating one is to see if it lands), then by taskPriority.
function preferred(pool: Candidate[], prefs: BoardPreferences): Candidate[] {
  return pool
    .map((t, i) => ({ t, i, p: taskPriority(t, prefs) }))
    .sort(
      (a, b) =>
        Number(b.t.template === CURVEBALL) - Number(a.t.template === CURVEBALL) ||
        b.p - a.p ||
        a.i - b.i,
    )
    .map(({ t }) => t);
}

// The day's main tasks: the model's first, topped up from templates when the
// model fell short of 60% of the day, missed a hard limit (stranger count,
// bold count), or its curveball failed validation. Places the group asked for
// ride along as anchors. Then ordered along a route, labelled by time of day.
export function planAssigneeBoard(opts: {
  modelPool: Candidate[];
  fallbackPool: Candidate[];
  window: DayWindow;
  prefs?: BoardPreferences;
  anchors?: Candidate[];
  ends?: RouteEnds;
}): { tasks: PlannedTask[]; anchors: PlannedTask[]; usedFallback: boolean } {
  const prefs = opts.prefs ?? NEUTRAL_PREFERENCES;
  const limits = {
    conflicts: boardConflict,
    minStranger: prefs.minStranger,
    maxStranger: prefs.maxStranger,
    minBold: prefs.minBold,
    targetCount: prefs.targetCount,
  };
  const anchors = opts.anchors ?? [];
  const modelPool = preferred(opts.modelPool, prefs);
  let chosen = selectForDay(modelPool, opts.window, { ...limits, fixed: anchors });
  const tasksIn = (list: Candidate[]) => list.filter((t) => !t.anchor);
  const short = prefs.targetCount
    ? tasksIn(chosen).length < prefs.targetCount
    : dayMinutes(chosen) < opts.window.usableMinutes * FILL_LOW &&
      tasksIn(chosen).length < MAX_MAIN_TASKS;
  const strangers = tasksIn(chosen).filter((t) => t.stranger).length;
  const bold = tasksIn(chosen).filter((t) => t.axes.boldness >= 3).length;
  const missing =
    strangers < prefs.minStranger || bold < prefs.minBold || allOneKind(tasksIn(chosen));
  let usedFallback = false;
  if (short || missing) {
    const rest = modelPool.filter((t) => !chosen.includes(t));
    const base = tasksIn(chosen);
    // Keep the model's picks, but let the hard limits re-run over the
    // combined pool: a missing stranger or bold task comes from templates.
    chosen = selectForDay(
      [...base, ...rest, ...preferred(opts.fallbackPool, prefs)],
      opts.window,
      { ...limits, fixed: anchors },
    );
    usedFallback = chosen.some((t) => opts.fallbackPool.includes(t));
  }
  const planned = planDay(chosen, opts.window, opts.ends).map((t) => {
    const s = t.anchor ? null : suggestionFor(t, prefs.suggestions);
    return s && !t.suggestedBy ? { ...t, suggestedBy: s.by } : t;
  });
  return {
    tasks: planned.filter((t) => !t.anchor),
    anchors: planned.filter((t) => t.anchor),
    usedFallback,
  };
}

// Board templates the model is even shown, after the group's hard filters:
// no stranger templates for "rather not", no alcohol for a non-drinker, no
// blind food for a restricted diet or a cautious eater, nothing physical for
// a mobility limit. Validation checks every task again regardless.
export function templatesAllowedFor(templates: TaskTemplate[], answers: SurveyAnswers[]): TaskTemplate[] {
  return templates.filter((t) => {
    const probe: ProposedTask = {
      code: "",
      title: t.archetype,
      axes: { boldness: t.axes.boldness.min, physical: t.axes.physical.min, time: t.axes.time.min, scarcity: 1, cultural: 1, aesthetics: 1 },
      verification: t.verification,
      photo_bonus_max: t.photo_bonus_max,
      neighborhood: "",
    };
    const reason = validateGeneratedTask(probe, {
      assignees: answers.map((a) => ({ answers: a })),
      completedTitles: [],
      template: templateFacts(t),
    });
    return reason === null;
  });
}

// A place the group asked for, as a fixed stop on the day's route.
export function anchorCandidate(opts: {
  name: string;
  coords: LatLng | null;
  category: string | null;
  by: string | null;
  neighborhood: string | null;
}): Candidate {
  return {
    code: "",
    title: opts.name,
    axes: { boldness: 1, physical: 1, time: 3, scarcity: 1, cultural: 1, aesthetics: 1 },
    verification: "honor",
    photo_bonus_max: 0,
    neighborhood: opts.neighborhood ?? "",
    minutes: estimateTaskMinutes({ boldness: 1, venueCategory: opts.category }) ?? 60,
    coords: opts.coords,
    stranger: false,
    interests: [],
    categories: [],
    resolvedNeighborhood: opts.neighborhood,
    timeOverridden: false,
    suggestedBy: opts.by,
    anchor: true,
    place: opts.name,
  };
}

export type Personalization = {
  people: number;
  // Survey fields that reached the prompt as text.
  prompt: string[];
  // Survey answers that acted as hard filters, and how.
  filters: Record<string, unknown>;
  // Survey answers that weighted which valid tasks won.
  weights: Record<string, unknown>;
  templatesOffered: string;
};

export function personalizationFor(opts: {
  answers: SurveyAnswers[];
  prefs: BoardPreferences;
  window: DayWindow;
  offered: number;
  total: number;
  promptFields: string[];
}): Personalization {
  const { answers, prefs } = opts;
  const value = (a: SurveyAnswers, id: keyof SurveyAnswers) => {
    const entry = a[id];
    return entry && !entry.skipped ? entry.value : undefined;
  };
  const diets = answers
    .filter((a) => value(a, "dietary") === "has_restriction" && value(a, "dietary_strictness") !== "cheat_on_vacation")
    .map((a) => value(a, "dietary_detail") ?? "unknown restriction (no food tasks)");
  return {
    people: answers.length,
    prompt: opts.promptFields,
    filters: {
      sociability: prefs.sociability,
      strangerTasks: `${prefs.minStranger}-${prefs.maxStranger === Infinity ? "any" : prefs.maxStranger}`,
      minBold: prefs.minBold,
      diet: diets,
      budget: answers.map((a) => value(a, "budget")).filter(Boolean),
      mobility: answers.some((a) => value(a, "mobility") === "has_limits"),
      noAlcohol: answers.some((a) => value(a, "drinking") === "no" || value(a, "age_bracket") === "under_18"),
      cautiousEater: answers.some((a) => /not (?:very )?adventurous|picky|plain|mild/.test(value(a, "food_adventure") ?? "")),
      blackoutText: answers.map((a) => value(a, "blackout")).filter(Boolean),
      window: `${opts.window.startMinutes}-${opts.window.endMinutes} (${opts.window.usableMinutes} usable, ${opts.window.pace})`,
    },
    weights: {
      interests: Object.fromEntries(
        Object.entries(prefs.interestWeights).filter(([, w]) => w !== 1),
      ),
      boldnessTarget: prefs.boldnessTarget,
      avoid: prefs.avoid,
      suggestions: prefs.suggestions.map((s) => s.name),
    },
    templatesOffered: `${opts.offered}/${opts.total}`,
  };
}

// The whole code side of a board, from the model's proposals: gate, time,
// prefer, top up, route. The board pipeline and the survey tests both call
// this, so what the tests pin is what runs.
export function planFromProposals(input: {
  proposals: ProposedTask[];
  fallback: ProposedTask[];
  ctx: PrepareContext;
  prefs: BoardPreferences;
  anchors?: Candidate[];
  ends?: RouteEnds;
}): { tasks: PlannedTask[]; anchors: PlannedTask[]; usedFallback: boolean } {
  const modelPool = prepareCandidates(input.proposals, input.ctx);
  const fallbackPool = prepareCandidates(input.fallback, { ...input.ctx, onReject: undefined });
  return planAssigneeBoard({
    modelPool,
    fallbackPool,
    window: input.ctx.window,
    prefs: input.prefs,
    anchors: input.anchors,
    ends: input.ends,
  });
}
