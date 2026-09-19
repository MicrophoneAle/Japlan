import type { DestinationProfile } from "./destination";
import {
  bandForMinutes,
  estimateTaskMinutes,
  haversineKm,
  reconcileTimeAxis,
  type LatLng,
} from "./duration";
import {
  dayMinutes,
  FILL_LOW,
  MAX_MAIN_TASKS,
  maxTaskMinutes,
  planDay,
  selectForDay,
  type DaySlot,
  type DayWindow,
} from "./day-plan";
import { templateById } from "./templates";
import {
  CURVEBALL,
  enforceBoardMix,
  normalizeTitle,
  validateGeneratedTask,
  type AssigneeConstraints,
  type ProposedTask,
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
      stranger: template ? template.stranger : Boolean(task.stranger),
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

// Two tasks that cannot share a board: the same place, the same template, or
// two curveballs.
export function boardConflict(a: ProposedTask, b: ProposedTask): boolean {
  return enforceBoardMix([a, b], { oneKind: false }).kept.length < 2;
}

// Preference order within a pool: the curveball first (the point of
// generating one is to see if it lands), then bolder tasks.
function preferred(pool: Candidate[]): Candidate[] {
  return pool
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        Number(b.t.template === CURVEBALL) - Number(a.t.template === CURVEBALL) ||
        b.t.axes.boldness - a.t.axes.boldness ||
        a.i - b.i,
    )
    .map(({ t }) => t);
}

// The day's main tasks: the model's first, topped up from templates when the
// model fell short of 60% of the day, gave no stranger task, or its curveball
// failed validation. Then ordered along a route and labelled by time of day.
export function planAssigneeBoard(opts: {
  modelPool: Candidate[];
  fallbackPool: Candidate[];
  window: DayWindow;
}): { tasks: PlannedTask[]; usedFallback: boolean } {
  const modelPool = preferred(opts.modelPool);
  const conflicts = boardConflict;
  let chosen = selectForDay(modelPool, opts.window, { conflicts });
  const short =
    dayMinutes(chosen) < opts.window.usableMinutes * FILL_LOW && chosen.length < MAX_MAIN_TASKS;
  const noStranger = !chosen.some((t) => t.stranger);
  let usedFallback = false;
  if (short || noStranger) {
    const rest = modelPool.filter((t) => !chosen.includes(t));
    chosen = selectForDay([...rest, ...preferred(opts.fallbackPool)], opts.window, {
      fixed: chosen,
      conflicts,
    });
    usedFallback = chosen.some((t) => opts.fallbackPool.includes(t));
  }
  return { tasks: planDay(chosen, opts.window), usedFallback };
}
