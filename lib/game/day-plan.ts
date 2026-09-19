import { haversineKm, travelMinutes, type LatLng } from "./duration";

// Shaping a day: how many usable hours there are, which main tasks fill
// 60-70% of them, what order they go in, and roughly when. All pure; the
// board pipeline feeds it candidates that already have minutes and places.

export type Pace = "relaxed" | "steady" | "chaotic";
export type DaySlot = "morning" | "afternoon" | "evening";

// Usable hours by pace. A relaxed group starts later, stops earlier and eats
// longer than a chaotic one. Meal time is only taken out for the part of the
// window that covers lunch (11:30-14:00) or dinner (18:00-20:30).
export const PACE_WINDOW: Record<Pace, { lateStartMinutes: number; endHour: number; mealMinutes: number }> = {
  relaxed: { lateStartMinutes: 90, endHour: 20, mealMinutes: 120 },
  steady: { lateStartMinutes: 30, endHour: 21, mealMinutes: 75 },
  chaotic: { lateStartMinutes: 0, endHour: 22, mealMinutes: 45 },
};

const MEALS: [number, number][] = [
  [11 * 60 + 30, 14 * 60],
  [18 * 60, 20 * 60 + 30],
];

// Asked late, there is still an evening: the window runs at least this long
// past now (up to midnight) even after the pace's usual end.
export const MIN_EVENING_WINDOW_MINUTES = 120;

// Main tasks fill 60-70% of usable time; the rest is the deliberate gap that
// sidequests and wandering live in.
export const FILL_LOW = 0.6;
export const FILL_TARGET = 0.65;
export const FILL_HIGH = 0.7;
export const MAX_MAIN_TASKS = 6;

// Survey pace: "early and moving" is chaotic, "two things and lunch" relaxed.
// A group goes with its majority; a tie, or nobody answered, is steady.
export function paceFor(answers: (string | null | undefined)[]): Pace {
  const chaotic = answers.filter((a) => a === "early_and_moving").length;
  const relaxed = answers.filter((a) => a === "two_things_and_lunch").length;
  if (chaotic > relaxed) return "chaotic";
  if (relaxed > chaotic) return "relaxed";
  return "steady";
}

export type DayWindow = {
  pace: Pace;
  // Minutes after local midnight.
  startMinutes: number;
  endMinutes: number;
  usableMinutes: number;
};

export function parseClockMinutes(hhmm: string | null | undefined, fallback = 8 * 60): number {
  const match = (hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function overlap(a: [number, number], b: [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

// From board_time to a reasonable end of day, adjusted by pace. nowMinutes is
// set only when the board is for today: then the day starts now, not at
// board_time, and everything else shrinks with it.
export function usableWindow(opts: {
  boardTime: string | null | undefined;
  pace: Pace;
  nowMinutes?: number | null;
  // Survey blackout times (minutes after midnight): one covering the start
  // pushes the day later; any inside it come off the usable time.
  blackouts?: [number, number][];
  // A split group's own start and end (a later board_time for the group
  // sleeping in, the time they rejoin everyone).
  startAt?: number | null;
  endAt?: number | null;
}): DayWindow {
  const shape = PACE_WINDOW[opts.pace];
  let start = opts.startAt ?? parseClockMinutes(opts.boardTime) + shape.lateStartMinutes;
  if (opts.nowMinutes !== null && opts.nowMinutes !== undefined) {
    start = Math.max(start, opts.nowMinutes);
  }
  const blackouts = [...(opts.blackouts ?? [])].sort((a, b) => a[0] - b[0]);
  for (const [from, to] of blackouts) {
    if (from <= start && start < to) start = to;
  }
  const end =
    opts.endAt ??
    Math.max(shape.endHour * 60, Math.min(24 * 60, start + MIN_EVENING_WINDOW_MINUTES));
  const span = Math.max(0, end - start);
  const mealWindow = MEALS.reduce((sum, meal) => sum + (meal[1] - meal[0]), 0);
  const covered = MEALS.reduce((sum, meal) => sum + overlap([start, end], meal), 0);
  const meals = Math.round(shape.mealMinutes * (covered / mealWindow));
  const blocked = blackouts.reduce((sum, b) => sum + overlap([start, end], b), 0);
  return {
    pace: opts.pace,
    startMinutes: start,
    endMinutes: end,
    usableMinutes: Math.max(0, span - meals - blocked),
  };
}

export function targetMinutes(window: DayWindow): number {
  return Math.round(window.usableMinutes * FILL_TARGET);
}

// No single task may be longer than the time left in the day.
export function maxTaskMinutes(window: DayWindow): number {
  return Math.max(0, window.endMinutes - window.startMinutes);
}

// How many proposals to ask the model for: enough to fill the target with
// ~80-minute tasks, plus spares for validation to reject.
export function candidatesToRequest(window: DayWindow, targetCount?: number | null): number {
  if (targetCount) return Math.min(15, targetCount + 3);
  return Math.min(8, Math.max(4, Math.ceil(targetMinutes(window) / 80) + 2));
}

export type Plannable = {
  minutes: number;
  coords: LatLng | null;
  stranger: boolean;
  kind?: string;
  when?: "morning" | "evening";
  axes?: { boldness: number };
  // A place the group asked for, on the day's route: takes time, is not a
  // task, never conflicts, never counts toward the task limits.
  anchor?: boolean;
};

// Morning-pinned first, evening-pinned last; the rest by nearest neighbour
// from the task farthest from the middle (one end of the route), so the day
// moves across the city once instead of back and forth. Tasks that can
// happen anywhere are spread evenly between the located ones.
// With `start`, the route begins nearest it (a group picking up where they
// rejoined); with `end`, it begins farthest from it so it finishes close by
// (a group due to rejoin the others there).
export type RouteEnds = { start?: LatLng | null; end?: LatLng | null };

export function orderRoute<T extends Plannable>(tasks: T[], ends: RouteEnds = {}): T[] {
  const morning = tasks.filter((t) => t.when === "morning");
  const evening = tasks.filter((t) => t.when === "evening");
  const middle = tasks.filter((t) => !t.when);
  const located = middle.filter((t) => t.coords);
  const anywhere = middle.filter((t) => !t.coords);

  const route: T[] = [];
  if (located.length > 0) {
    const centre = {
      lat: located.reduce((s, t) => s + t.coords!.lat, 0) / located.length,
      lng: located.reduce((s, t) => s + t.coords!.lng, 0) / located.length,
    };
    const remaining = [...located];
    let current = ends.start
      ? remaining.reduce((near, t) =>
          haversineKm(t.coords!, ends.start!) < haversineKm(near.coords!, ends.start!) ? t : near,
        )
      : remaining.reduce((far, t) => {
          const from = ends.end ?? centre;
          return haversineKm(t.coords!, from) > haversineKm(far.coords!, from) ? t : far;
        });
    while (remaining.length > 0) {
      remaining.splice(remaining.indexOf(current), 1);
      route.push(current);
      if (remaining.length === 0) break;
      const from = current.coords!;
      current = remaining.reduce((near, t) =>
        haversineKm(from, t.coords!) < haversineKm(from, near.coords!) ? t : near,
      );
    }
  }
  // Spread "anywhere" tasks into the gaps of the route.
  const mixed = [...route];
  anywhere.forEach((task, i) => {
    const at = Math.round(((i + 1) * (mixed.length + 1)) / (anywhere.length + 1));
    mixed.splice(Math.min(at, mixed.length), 0, task);
  });
  return [...morning, ...mixed, ...evening];
}

// Travel between consecutive located tasks, by city transport.
export function routeTravelMinutes(ordered: Plannable[]): number {
  let total = 0;
  let last: LatLng | null = null;
  for (const task of ordered) {
    if (!task.coords) continue;
    if (last) total += travelMinutes(last, task.coords, "city");
    last = task.coords;
  }
  return total;
}

// Everything the day's main tasks cost, travel between them included.
export function dayMinutes(tasks: Plannable[]): number {
  const ordered = orderRoute(tasks);
  return ordered.reduce((sum, t) => sum + t.minutes, 0) + routeTravelMinutes(ordered);
}

export function allOneKind(tasks: Plannable[]): boolean {
  return tasks.length >= 2 && tasks.every((t) => t.kind !== undefined && t.kind === tasks[0].kind);
}

export type SelectOptions<T> = {
  // Already on the board (claimed tasks, the group's suggested places).
  fixed?: T[];
  // Two tasks that cannot share a board (same place, same template).
  conflicts?: (a: T, b: T) => boolean;
  // Sociability, as limits on tasks involving a stranger. Default: at least
  // one, no cap.
  minStranger?: number;
  maxStranger?: number;
  // At least this many tasks at boldness 3+ when the pool has them, so a
  // chill board is gentle but never all boldness 1.
  minBold?: number;
  // Someone asked for this many tasks. Pace sets the default fill; a request
  // overrides it, bounded only by what fits in the usable time.
  targetCount?: number | null;
};

// Pick main tasks, in the pool's order of preference, until the day is
// 60-70% full. Hard limits first (stranger count, bold count), then fill. A
// task that would make the board all one kind waits while other kinds are
// still available.
export function selectForDay<T extends Plannable>(
  pool: T[],
  window: DayWindow,
  opts: SelectOptions<T> = {},
): T[] {
  const target = opts.targetCount ?? null;
  // A requested count fills to the whole usable day, not 60-70% of it.
  const low = target ? Infinity : window.usableMinutes * FILL_LOW;
  const high = target ? window.usableMinutes : window.usableMinutes * FILL_HIGH;
  const maxTasks = Math.max(MAX_MAIN_TASKS, target ?? 0);
  const span = maxTaskMinutes(window);
  const minStranger = opts.minStranger ?? 1;
  const maxStranger = opts.maxStranger ?? Infinity;
  const chosen: T[] = [...(opts.fixed ?? [])];
  const fixedCount = chosen.length;
  const candidates = pool.filter((t) => t.minutes <= span && !chosen.includes(t));
  const clashes = (task: T) =>
    opts.conflicts ? chosen.some((c) => opts.conflicts!(c, task)) : false;
  const strangers = () => chosen.filter((t) => t.stranger && !t.anchor).length;
  const bold = () => chosen.filter((t) => (t.axes?.boldness ?? 0) >= 3 && !t.anchor).length;
  const allowed = (task: T) => !(task.stranger && strangers() >= maxStranger) && !clashes(task);
  const tasks = () => chosen.filter((t) => !t.anchor).length;
  // Make room rather than go over: drop the latest non-fixed pick that is
  // not what a hard limit needed.
  const trim = (keep: (t: T) => boolean) => {
    while (dayMinutes(chosen) > high && chosen.length > fixedCount + 1) {
      const drop = chosen.findLastIndex((t, i) => i >= fixedCount && !keep(t));
      if (drop < 0) break;
      chosen.splice(drop, 1);
    }
  };

  while (strangers() < minStranger) {
    const next = candidates.find((t) => t.stranger && !chosen.includes(t) && allowed(t));
    if (!next) break;
    chosen.push(next);
    trim((t) => t.stranger);
  }
  while (bold() < (opts.minBold ?? 0)) {
    const next = candidates.find(
      (t) => (t.axes?.boldness ?? 0) >= 3 && !chosen.includes(t) && allowed(t),
    );
    if (!next) break;
    chosen.push(next);
    trim((t) => t.stranger || (t.axes?.boldness ?? 0) >= 3);
  }

  for (const strict of [true, false]) {
    for (const task of candidates) {
      if (tasks() >= (target ?? maxTasks) || dayMinutes(chosen) >= low) break;
      if (chosen.includes(task) || !allowed(task)) continue;
      if (dayMinutes([...chosen, task]) > high) continue;
      if (strict && allOneKind([...chosen, task].filter((t) => !t.anchor))) {
        const other = candidates.some(
          (t) => !chosen.includes(t) && t !== task && t.kind !== task.kind && allowed(t),
        );
        if (other) continue;
      }
      chosen.push(task);
    }
  }

  // Even a short evening gets one task if anything fits at all.
  if (tasks() === 0) {
    const fits = candidates.filter(allowed);
    if (fits.length > 0) chosen.push(fits.reduce((a, b) => (b.minutes < a.minutes ? b : a)));
  }
  return chosen;
}

export function slotForMinute(minute: number): DaySlot {
  if (minute < 12 * 60) return "morning";
  if (minute < 17 * 60) return "afternoon";
  return "evening";
}

// Rough shape, not a schedule: tasks in route order, the spare time spread
// evenly between them, each labelled by when its middle falls.
export function assignSlots<T extends Plannable>(
  ordered: T[],
  window: DayWindow,
): (T & { slot: DaySlot })[] {
  if (ordered.length === 0) return [];
  const legs: number[] = [];
  let last: LatLng | null = null;
  for (const task of ordered) {
    legs.push(last && task.coords ? travelMinutes(last, task.coords, "city") : 0);
    if (task.coords) last = task.coords;
  }
  const busy = ordered.reduce((sum, t) => sum + t.minutes, 0) + legs.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, window.endMinutes - window.startMinutes - busy);
  const gap = spare / ordered.length;
  let clock = window.startMinutes;
  return ordered.map((task, i) => {
    clock += legs[i];
    const middle = clock + task.minutes / 2;
    clock += task.minutes + gap;
    const slot = task.when === "morning" ? "morning" : slotForMinute(middle);
    return { ...task, slot };
  });
}

export function planDay<T extends Plannable>(
  tasks: T[],
  window: DayWindow,
  ends: RouteEnds = {},
): (T & { slot: DaySlot })[] {
  return assignSlots(orderRoute(tasks, ends), window);
}
