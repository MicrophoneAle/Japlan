import {
  boardAnchorLine,
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

const SLOT_LABEL: Record<string, string> = {
  morning: "🌅 MORNING",
  afternoon: "☀️ AFTERNOON",
  evening: "🌙 EVENING",
  anytime: "✨ ANYTIME",
};

function taskSections(
  tasks: BoardTask[],
  anchors: BoardAnchorItem[] = [],
): string[] {
  const sections: string[] = [];
  for (const slot of ["morning", "afternoon", "evening", "anytime"]) {
    const slotTasks = tasks.filter((task) => (task.slot ?? "anytime") === slot);
    const slotAnchors = anchors.filter((anchor) => (anchor.slot ?? "anytime") === slot);
    if (slotTasks.length === 0 && slotAnchors.length === 0) continue;
    sections.push(`${SLOT_LABEL[slot]}${slotTasks.length > 0 ? ` · ${slotTasks.length} ${slotTasks.length === 1 ? "task" : "tasks"}` : ""}`);
    const rows = [
      ...slotTasks.map(taskLine),
      ...slotAnchors.map((anchor) => boardAnchorLine(anchor.name, anchor.by)),
    ];
    rows.forEach((row, index) => {
      if (index > 0) sections.push("");
      sections.push(row);
    });
    sections.push("");
  }
  while (sections.at(-1) === "") sections.pop();
  return sections;
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
  // "⚡ golden week, everything's 2x": rides in the header next to the
  // weather, so it changes what people do and not only what they score.
  multiplierPart?: string | null;
  place?: { city?: string | null; travelDay?: boolean } | null;
  // When set, render only the selected section. Standings appear with morning.
  slot?: "morning" | "afternoon" | "evening";
}): string {
  const tasks = boardOrder(opts.slot ? opts.tasks.filter((task) => belongsToSlot(task, opts.slot!)) : opts.tasks);
  const standings = [...opts.standings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.display_name.localeCompare(b.display_name);
  });

  const lines = [
    dailyBoardHeader(opts.day, opts.weatherLine, routeOf(tasks), opts.multiplierPart, opts.place),
    "",
    ...taskSections(tasks),
    ...(opts.slot === "afternoon" || opts.slot === "evening"
      ? []
      : ["", standingsLine(standings)]),
  ];
  return lines.join("\n");
}

export type BoardAnchorItem = { name: string; by: string | null; slot: string | null };

function belongsToSlot(task: BoardTask, slot: "morning" | "afternoon" | "evening"): boolean {
  // Older tasks without a slot were originally delivered with the morning
  // board, so keep them there when showing one period at a time.
  return (task.slot ?? "morning") === slot;
}

export function formatPersonalBoard(opts: {
  day: number;
  tasks: BoardTask[];
  weatherLine?: string | null;
  // Places the group asked for, on this day's route.
  anchors?: BoardAnchorItem[];
  multiplierPart?: string | null;
  place?: { city?: string | null; travelDay?: boolean } | null;
  // Render one time-of-day section rather than the whole day's board.
  slot?: "morning" | "afternoon" | "evening";
}): string {
  const tasks = boardOrder(opts.slot ? opts.tasks.filter((task) => belongsToSlot(task, opts.slot!)) : opts.tasks);
  // Anchors sit in their time of day, after that slot's tasks.
  const anchors = opts.slot
    ? (opts.anchors ?? []).filter((anchor) => (anchor.slot ?? "morning") === opts.slot)
    : opts.anchors;
  return [
    dailyBoardHeader(opts.day, opts.weatherLine, routeOf(tasks), opts.multiplierPart, opts.place),
    "",
    ...taskSections(tasks, anchors),
  ].join("\n");
}

export function formatMorningStandings(opts: {
  day: number;
  standings: BoardStanding[];
  weatherLine?: string | null;
  multiplierPart?: string | null;
  place?: { city?: string | null; travelDay?: boolean } | null;
}): string {
  const standings = [...opts.standings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.display_name.localeCompare(b.display_name);
  });
  return [
    dailyBoardHeader(opts.day, opts.weatherLine, null, opts.multiplierPart, opts.place),
    "",
    standingsLine(standings),
  ].join("\n");
}
