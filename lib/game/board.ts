import {
  dailyBoardHeader,
  dailyBoardTaskLine,
  standingsLine,
} from "./copy";
import { tierForPoints } from "./scoring";

// From the points, not the stored tier, so the label always matches the
// number beside it. Weighted totals can pass 30; that is still the top tier.
function tierLabel(points: number): string {
  return tierForPoints(points) ?? "Challenging";
}

export type BoardTask = {
  code: string;
  title: string;
  base_points: number;
};

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
  const tasks = [...opts.tasks].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
  const standings = [...opts.standings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.display_name.localeCompare(b.display_name);
  });

  const lines = [
    dailyBoardHeader(opts.day, opts.weatherLine),
    "",
    ...tasks.map((task) =>
      dailyBoardTaskLine(task.code, task.title, task.base_points, tierLabel(task.base_points)),
    ),
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
  const tasks = [...opts.tasks].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
  return [
    dailyBoardHeader(opts.day, opts.weatherLine),
    "",
    ...tasks.map((task) =>
      dailyBoardTaskLine(task.code, task.title, task.base_points, tierLabel(task.base_points)),
    ),
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
