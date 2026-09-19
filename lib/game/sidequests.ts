import { layoutDay } from "./day-plan";
import { templateFacts } from "./plan-board";
import { isUnderAge } from "./preferences";
import { computePoints } from "./scoring";
import { answerValue, type SurveyAnswers } from "./survey";
import { midpointAxes, type TaskTemplate } from "./templates";
import { validateGeneratedTask } from "./validate";

// Sidequests (PLAN.md "Sidequests"): something that happens to you, not a
// menu you choose from. Offered privately, entirely optional, first to finish
// wins, the win is announced in the group. Pure logic here; delivery and I/O
// live in lib/handlers/sidequests.ts.

// Low value so they never decide the game.
export const SIDEQUEST_MIN_POINTS = 5;
export const SIDEQUEST_MAX_POINTS = 15;
// Smaller than the main photo bonus (at most 5).
export const SIDEQUEST_PHOTO_BONUS_MAX = 2;
// Short fuse: urgency is the mechanic.
export const FUSE_MIN_MINUTES = 30;
export const FUSE_MAX_MINUTES = 60;
// Triggers.
export const GAP_TRIGGER_MINUTES = 90;
export const IDLE_TRIGGER_MINUTES = 180;
export const ANCHOR_ARRIVAL_WINDOW_MINUTES = 20;
// Not in PLAN: a ceiling so a busy day of triggers cannot turn into spam.
export const SIDEQUESTS_PER_DAY = 4;

export type SidequestLevel = 1 | 2 | 3 | 4;
export type SidequestTrigger = "gap" | "idle" | "weather" | "anchor" | "challenging" | "random";

// The onboarding answer. Never asked (a trip that went live before
// sidequests existed): civilized, the tamest.
export function sidequestLevelOf(answers: SurveyAnswers): SidequestLevel {
  const v = answerValue(answers, "sidequest_level");
  return v === "2" ? 2 : v === "3" ? 3 : v === "4" ? 4 : 1;
}

// 1 civilized (food, photos, exploring), 2 questionable (strangers, mild
// embarrassment), 3 feral (anything on the list).
export function maxBoldnessFor(level: SidequestLevel): number {
  return level === 1 ? 2 : level === 2 ? 3 : level === 3 ? 5 : 0;
}

export type SidequestPerson = {
  id: string;
  answers: SurveyAnswers;
  muted: boolean;
  surveyDone: boolean;
};

// Muted, level 4, under 18 (PLAN's 18+ gate), or not finished with the
// survey (constraints unknown): nothing is sent.
export function canReceiveSidequests(person: SidequestPerson): boolean {
  if (person.muted || !person.surveyDone) return false;
  if (isUnderAge(person.answers)) return false;
  return sidequestLevelOf(person.answers) !== 4;
}

// Red lines are hard filters, like allergies: the same validation the board
// uses (red_line, sociability, diet, mobility, hard no's, alcohol, budget),
// plus the level's boldness cap and "strangers" read directly.
export function templateAllowedFor(template: TaskTemplate, answers: SurveyAnswers): boolean {
  const level = sidequestLevelOf(answers);
  if (template.axes.boldness.min > maxBoldnessFor(level)) return false;
  const redLines = (answerValue(answers, "sidequest_red_lines") ?? "").toLowerCase();
  if (template.needs_stranger && /stranger|people|talking/.test(redLines)) return false;
  const reason = validateGeneratedTask(
    {
      code: "",
      title: template.archetype,
      axes: midpointAxes(template),
      verification: template.verification,
      photo_bonus_max: 0,
      neighborhood: "",
    },
    { assignees: [{ answers }], completedTitles: [], template: templateFacts(template) },
  );
  return reason === null;
}

export function sidequestPoints(template: TaskTemplate): number {
  return Math.min(SIDEQUEST_MAX_POINTS, Math.max(SIDEQUEST_MIN_POINTS, computePoints(midpointAxes(template))));
}

export function sidequestBonusMax(template: TaskTemplate, points: number): number {
  return Math.max(0, Math.min(template.photo_bonus_max, SIDEQUEST_PHOTO_BONUS_MAX, Math.floor(points * 0.2)));
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The template that suits the most of the people it would go to (a race is
// the same task for everyone); ties broken by the seed. Templates already
// sent today are skipped.
export function pickSidequest(opts: {
  templates: TaskTemplate[];
  recipients: { id: string; answers: SurveyAnswers }[];
  usedToday: string[];
  seed: number;
}): { template: TaskTemplate; eligible: string[] } | null {
  const pool = opts.templates.filter((t) => !opts.usedToday.includes(t.id));
  if (pool.length === 0 || opts.recipients.length === 0) return null;
  let best: { template: TaskTemplate; eligible: string[] } | null = null;
  for (let i = 0; i < pool.length; i++) {
    const template = pool[(opts.seed + i) % pool.length];
    const eligible = opts.recipients.filter((r) => templateAllowedFor(template, r.answers)).map((r) => r.id);
    if (eligible.length > (best?.eligible.length ?? 0)) best = { template, eligible };
  }
  return best;
}

// 30-60 minutes, and never past the start of their next main task.
export function fuseMinutes(availableMinutes: number | null): number {
  const available = availableMinutes ?? FUSE_MAX_MINUTES;
  return Math.min(FUSE_MAX_MINUTES, Math.max(FUSE_MIN_MINUTES, Math.floor(available)));
}

// A person's day as the planner laid it out: their main tasks in board order,
// each with its minutes, spread across the usable window.
export type DayTask = { id: string; minutes: number; resolved: boolean };
export type PersonDay = {
  window: { startMinutes: number; endMinutes: number };
  tasks: { id: string; startMinutes: number; endMinutes: number; resolved: boolean }[];
};

export function personDay(tasks: DayTask[], window: { startMinutes: number; endMinutes: number }): PersonDay {
  const laid = layoutDay(
    tasks.map((t) => ({ ...t, coords: null })),
    window,
  );
  return {
    window,
    tasks: laid.map(({ task, startMinutes, endMinutes }) => ({
      id: task.id,
      startMinutes,
      endMinutes,
      resolved: task.resolved,
    })),
  };
}

export function inWindow(day: PersonDay, nowMinutes: number): boolean {
  return nowMinutes >= day.window.startMinutes && nowMinutes < day.window.endMinutes;
}

// Mid-way through a main task they have not claimed: a sidequest waits.
export function busyNow(day: PersonDay, nowMinutes: number): boolean {
  return day.tasks.some((t) => !t.resolved && nowMinutes >= t.startMinutes && nowMinutes < t.endMinutes);
}

// The dead time they are in right now, if any: between the end of the last
// task (or the window start) and the start of the next (or the window end).
export function gapNow(day: PersonDay, nowMinutes: number): { gapMinutes: number; remainingMinutes: number } | null {
  if (!inWindow(day, nowMinutes) || busyNow(day, nowMinutes)) return null;
  const pending = day.tasks.filter((t) => !t.resolved);
  const before = pending.filter((t) => t.endMinutes <= nowMinutes).map((t) => t.endMinutes);
  const after = pending.filter((t) => t.startMinutes > nowMinutes).map((t) => t.startMinutes);
  const from = before.length ? Math.max(...before) : day.window.startMinutes;
  const to = after.length ? Math.min(...after) : day.window.endMinutes;
  return { gapMinutes: to - from, remainingMinutes: to - nowMinutes };
}

export function minutesUntilNextTask(day: PersonDay, nowMinutes: number): number {
  const next = day.tasks.filter((t) => !t.resolved && t.startMinutes > nowMinutes).map((t) => t.startMinutes);
  return (next.length ? Math.min(...next) : day.window.endMinutes) - nowMinutes;
}

// "Pure random, once or twice a day": the times are picked once per trip-day,
// seeded, inside the window with half an hour clear at each end.
export function randomFireTimes(seedText: string, window: { startMinutes: number; endMinutes: number }): number[] {
  const seed = hashSeed(seedText);
  const from = window.startMinutes + 30;
  const to = window.endMinutes - 30;
  if (to <= from) return [];
  const count = 1 + (seed % 2);
  const span = to - from;
  const times = [from + (seed % span)];
  if (count === 2) times.push(from + (Math.floor(seed / 7) % span));
  return times.sort((a, b) => a - b);
}

export type TriggerInputs = {
  anchorArrived: boolean;
  weatherTurned: boolean;
  idle: boolean;
  gapPeople: string[];
  randomDue: boolean;
};

// Which trigger fires now, most specific first. A Challenging completion is
// an event, handled where the claim lands, not here.
export function dueTrigger(inputs: TriggerInputs): { trigger: SidequestTrigger; gapOnly: boolean } | null {
  if (inputs.anchorArrived) return { trigger: "anchor", gapOnly: false };
  if (inputs.weatherTurned) return { trigger: "weather", gapOnly: false };
  if (inputs.idle) return { trigger: "idle", gapOnly: false };
  if (inputs.gapPeople.length > 0) return { trigger: "gap", gapOnly: true };
  if (inputs.randomDue) return { trigger: "random", gapOnly: false };
  return null;
}

// Replies in the DM while a sidequest is live.
export const SIDEQUEST_DONE_RE = /^(done|did it|done it|finished|completed?|got it done|sidequest done|all done|✅)[.! ]*$/i;
export const SIDEQUEST_PASS_RE = /^(pass|skip|nah|no thanks|not this one|i'?ll pass|not now)[.! ]*$/i;
