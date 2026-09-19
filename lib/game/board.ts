import {
  dailyBoardHeader,
  dailyBoardTaskLine,
  standingsLine,
} from "./copy";

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
}): string {
  const tasks = [...opts.tasks].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
  const standings = [...opts.standings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.display_name.localeCompare(b.display_name);
  });

  const lines = [
    dailyBoardHeader(opts.day),
    "",
    ...tasks.map((task) =>
      dailyBoardTaskLine(task.code, task.title, task.base_points),
    ),
    "",
    standingsLine(standings),
  ];
  return lines.join("\n");
}
