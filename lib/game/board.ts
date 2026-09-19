import {
  boardRouteLabel,
  dailyBoardHeader,
  dailyBoardTaskLine,
  standingsLine,
} from "./copy";
import { tierForPoints } from "./scoring";

// From the points, not the stored tier, so the label always matches the
// number beside it.
function tierLabel(points: number): string {
  return tierForPoints(points) ?? "Challenging";
}

export type BoardTask = {
  code: string;
  title: string;
  base_points: number;
  // Day planning (null on older tasks): time of day, and the neighborhood the
  // task is in, for the header's route.
  slot?: string | null;
  neighborhood?: string | null;
};

const SLOT_ORDER: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };

// Time of day first, then code: a person's team, personal and shared tasks
// interleave into one day.
function boardOrder(tasks: BoardTask[]): BoardTask[] {
  return [...tasks].sort(
    (a, b) =>
      (SLOT_ORDER[a.slot ?? ""] ?? 1) - (SLOT_ORDER[b.slot ?? ""] ?? 1) ||
      a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
}

// "Asakusa → Ueno": the first and last neighborhood the day passes through.
function routeOf(tasks: BoardTask[]): string | null {
  const hoods = tasks.map((t) => t.neighborhood).filter((n): n is string => Boolean(n));
  if (hoods.length === 0) return null;
  return boardRouteLabel(hoods[0], hoods[hoods.length - 1]);
}

function taskLine(task: BoardTask): string {
  return dailyBoardTaskLine(
    task.code,
    task.title,
    task.base_points,
    tierLabel(task.base_points),
    task.slot,
  );
}

export type BoardStanding = {
  display_name: string;
  score: number;
};

export function formatDailyBoard(opts: {
  day: number;
  tasks: BoardTask[];
  standings: BoardStanding[];
  weatherLine?: string | null;
}): string {
  const tasks = boardOrder(opts.tasks);
  const standings = [...opts.standings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.display_name.localeCompare(b.display_name);
  });

  const lines = [
    dailyBoardHeader(opts.day, opts.weatherLine, routeOf(tasks)),
    "",
    ...tasks.map(taskLine),
    "",
    standingsLine(standings),
  ];
  return lines.join("\n");
}

export function formatPersonalBoard(opts: {
  day: number;
  tasks: BoardTask[];
  weatherLine?: string | null;
}): string {
  const tasks = boardOrder(opts.tasks);
  return [
    dailyBoardHeader(opts.day, opts.weatherLine, routeOf(tasks)),
    "",
    ...tasks.map(taskLine),
  ].join("\n");
}

export function formatMorningStandings(opts: {
  day: number;
  standings: BoardStanding[];
  weatherLine?: string | null;
}): string {
  const standings = [...opts.standings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.display_name.localeCompare(b.display_name);
  });
  return [dailyBoardHeader(opts.day, opts.weatherLine), "", standingsLine(standings)].join(
    "\n",
  );
}
