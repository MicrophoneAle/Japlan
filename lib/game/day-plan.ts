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
}): DayWindow {
  const shape = PACE_WINDOW[opts.pace];
  let start = parseClockMinutes(opts.boardTime) + shape.lateStartMinutes;
  if (opts.nowMinutes !== null && opts.nowMinutes !== undefined) {
    start = Math.max(start, opts.nowMinutes);
  }
  const end = Math.max(shape.endHour * 60, Math.min(24 * 60, start + MIN_EVENING_WINDOW_MINUTES));
  const span = Math.max(0, end - start);
  const mealWindow = MEALS.reduce((sum, meal) => sum + (meal[1] - meal[0]), 0);
  const covered = MEALS.reduce((sum, meal) => sum + overlap([start, end], meal), 0);
  const meals = Math.round(shape.mealMinutes * (covered / mealWindow));
  return {
    pace: opts.pace,
    startMinutes: start,
    endMinutes: end,
    usableMinutes: Math.max(0, span - meals),
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
export function candidatesToRequest(window: DayWindow): number {
  return Math.min(8, Math.max(4, Math.ceil(targetMinutes(window) / 80) + 2));
}

export type Plannable = {
  minutes: number;
  coords: LatLng | null;
  stranger: boolean;
  kind?: string;
  when?: "morning" | "evening";
};

// Morning-pinned first, evening-pinned last; the rest by nearest neighbour
// from the task farthest from the middle (one end of the route), so the day
// moves across the city once instead of back and forth. Tasks that can
// happen anywhere are spread evenly between the located ones.
export function orderRoute<T extends Plannable>(tasks: T[]): T[] {
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
    let current = remaining.reduce((far, t) =>
      haversineKm(t.coords!, centre) > haversineKm(far.coords!, centre) ? t : far,
    );
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

function allOneKind(tasks: Plannable[]): boolean {
  return tasks.length >= 2 && tasks.every((t) => t.kind !== undefined && t.kind === tasks[0].kind);
}

// Pick main tasks, in the pool's order of preference, until the day is
// 60-70% full. At least one involves a stranger when any candidate does. A
// task that would make the board all one kind waits while other kinds are
// still available. `fixed` tasks are already on the board. `conflicts` says
// two tasks cannot share a board (same place, same template).
export function selectForDay<T extends Plannable>(
  pool: T[],
  window: DayWindow,
  opts: { fixed?: T[]; conflicts?: (a: T, b: T) => boolean } = {},
): T[] {
  const low = window.usableMinutes * FILL_LOW;
  const high = window.usableMinutes * FILL_HIGH;
  const span = maxTaskMinutes(window);
  const fits = (t: T) => t.minutes <= span;
  const chosen: T[] = [...(opts.fixed ?? [])];
  const fixedCount = chosen.length;
  const candidates = pool.filter((t) => fits(t) && !chosen.includes(t));
  const clashes = (task: T) =>
    opts.conflicts ? chosen.some((c) => opts.conflicts!(c, task)) : false;

  if (!chosen.some((t) => t.stranger)) {
    const stranger = candidates.find((t) => t.stranger && !clashes(t));
    if (stranger) {
      chosen.push(stranger);
      // Make room for it rather than go over: drop the latest non-fixed,
      // non-stranger picks first.
      while (dayMinutes(chosen) > high && chosen.length > 1) {
        const drop = chosen.findLastIndex((t, i) => i >= fixedCount && !t.stranger);
        if (drop < 0) break;
        chosen.splice(drop, 1);
      }
    }
  }

  for (const strict of [true, false]) {
    for (const task of candidates) {
      if (chosen.length >= MAX_MAIN_TASKS || dayMinutes(chosen) >= low) break;
      if (chosen.includes(task) || clashes(task)) continue;
      if (dayMinutes([...chosen, task]) > high) continue;
      if (strict && allOneKind([...chosen, task])) {
        const other = candidates.some(
          (t) => !chosen.includes(t) && t !== task && t.kind !== task.kind,
        );
        if (other) continue;
      }
      chosen.push(task);
    }
  }

  // Even a short evening gets one task if anything fits at all.
  if (chosen.length === 0 && candidates.length > 0) {
    chosen.push(candidates.reduce((a, b) => (b.minutes < a.minutes ? b : a)));
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

export function planDay<T extends Plannable>(tasks: T[], window: DayWindow): (T & { slot: DaySlot })[] {
  return assignSlots(orderRoute(tasks), window);
}
