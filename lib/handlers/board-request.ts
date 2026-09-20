import { getServiceClient } from "@/lib/db/client";
import { cityFor, isMultiCity, isTravelDate, todayFor } from "@/lib/game/legs";
import type { TaskRow, TripRow } from "@/lib/db/types";
import { formatPersonalBoard } from "@/lib/game/board";
import {
  boardDueNow,
  dateForTripDay,
  currentBoardPeriod,
  nextBoardPeriod,
  parseBoardDay,
  shortDate,
  type BoardPeriod,
  tripDayForDate,
} from "@/lib/game/board-schedule";
import { dayMultiplierFor } from "./holidays";
import { multiplierHeaderPart } from "@/lib/game/copy";
import { multiplierLabel } from "@/lib/game/multipliers";
import { isOpenTask, tasksClaimableBy } from "@/lib/game/claims";
import {
  BOARD_IN_GROUP_LINE,
  BOARD_MAKE_FAILED_LINE,
  boardRefillLine,
  dayNotInTripLine,
  pastDayNoBoardLine,
  provisionalBoard,
  finishYourSurveyLine,
  GROUP_BOARD_CLEARED_LINE,
  refillLimitLine,
  waitingOnSetupLine,
  UNDER_AGE_LINE,
} from "@/lib/game/copy";
import { isUnderAge } from "@/lib/game/preferences";
import type { SurveyAnswers } from "@/lib/game/survey";
import { missingRequiredSetup, type SetupFields } from "@/lib/game/setup";
import { sendDM } from "@/lib/linq/send";
import type { ClaimFallthrough } from "./claims";
import {
  buildBoardForDate,
  constraintsKnown,
  dayAnchorsForBoard,
  dayHasClaims,
  deleteUnclaimedTasksForDay,
  type BoardAnchor,
  getBoard,
  lockNewBoard,
  relockBoard,
  refillPersonalTasksIfNeeded,
  tasksForDay,
  updateBoard,
  type BoardRow,
} from "./daily-board";
import { resumeSetup } from "./setup";

// Refills are the only way to regenerate a day on request, so they are the
// only thing rate-limited: generous, per person per day of the trip. Asking
// for different days is never limited.
export const REFILLS_PER_DAY = 5;

// Another request (or the cron) is generating the same day: wait for it
// rather than telling the person to come back.
const WAIT_FOR_BOARD_MS = 25_000;
const WAIT_STEP_MS = 1_000;

function boardStep(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.board] step", { step, ...fields });
}

function boardText(
  day: number,
  tasks: Pick<TaskRow, "code" | "title" | "base_points" | "slot" | "neighborhood">[],
  anchors: BoardAnchor[] = [],
  multiplierPart: string | null = null,
  place: { city?: string | null; travelDay?: boolean } | null = null,
  slot?: BoardPeriod,
): string {
  return formatPersonalBoard({
    day,
    anchors,
    multiplierPart,
    place,
    ...(slot ? { slot } : {}),
    tasks: tasks.map((t) => ({
      code: t.code,
      title: t.title,
      base_points: t.base_points,
      slot: t.slot ?? null,
      neighborhood: t.neighborhood,
    })),
  });
}

// The day's multiplier, as the tail of the board header. Weekends need
// nothing looked up, so this answers before any holiday lookup has run.
// Multi-city only: the city and whether they travel that day.
function placeFor(trip: TripRow, day: number): { city?: string | null; travelDay?: boolean } | null {
  if (!trip.start_date || !isMultiCity(trip)) return null;
  const date = dateForTripDay(trip.start_date, day);
  return { city: cityFor(trip, date), travelDay: isTravelDate(trip, date) };
}

async function bannerFor(trip: TripRow, day: number): Promise<string | null> {
  if (!trip.start_date) return null;
  const special = await dayMultiplierFor(trip, day, dateForTripDay(trip.start_date, day));
  if (!special) return null;
  return multiplierHeaderPart({
    label: special.label,
    multiplier: multiplierLabel(special.value),
  });
}

function isNextPeriodRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/\bjaplan\b[,:]?/g, " ").replace(/\s+/g, " ").trim();
  return /\b(next|upcoming)\s+(period|drop|tasks?)\b/.test(t) || /^what'?s next[?.!]*$/.test(t);
}

function periodLabel(period: BoardPeriod): string {
  return period === "morning" ? "morning" : period;
}

function explicitBoardPeriod(text: string): BoardPeriod | null {
  const normalized = text.toLowerCase().replace(/\bjaplan\b[,:]?/g, " ").replace(/\s+/g, " ");
  const match = normalized.match(/\b(morning|afternoon|evening|night)\b/);
  if (!match) return null;
  return match[1] === "night" ? "evening" : (match[1] as BoardPeriod);
}

function boardViewIntro(period: BoardPeriod | undefined, label: string): string {
  if (!period) return `📋 all parts of ${label === "today" ? "today's" : `${label}'s`} board:`;
  const emoji = period === "morning" ? "🌅" : period === "afternoon" ? "☀️" : "🌙";
  if (label === "the next period") return `${emoji} your next ${period} tasks`;
  return `${emoji} ${period} tasks · ${label}`;
}

function boardReply(
  text: string,
  period: BoardPeriod | undefined,
  label: string,
  provisional: boolean,
): string {
  const board = provisional ? provisionalBoard(text) : text;
  return `${boardViewIntro(period, label)}\n\n${board}`;
}

async function logRequest(
  tripId: string,
  participantId: string,
  requestedOn: string,
  day: number,
  kind: "generate" | "refill",
): Promise<{ id: string }> {
  const { data, error } = await getServiceClient()
    .from("board_requests")
    .insert({ trip_id: tripId, participant_id: participantId, requested_on: requestedOn, day, kind })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data as { id: string };
}

async function dropRequest(id: string): Promise<void> {
  const { error } = await getServiceClient().from("board_requests").delete().eq("id", id);
  if (error) console.error("[japlan.board] drop request failed", error);
}

async function refillsUsed(tripId: string, participantId: string, day: number): Promise<number> {
  const { data, error } = await getServiceClient()
    .from("board_requests")
    .select("id")
    .eq("trip_id", tripId)
    .eq("participant_id", participantId)
    .eq("day", day)
    .eq("kind", "refill");
  if (error) throw error;
  return (data ?? []).length;
}

async function waitWhileGenerating(tripId: string, day: number): Promise<BoardRow | null> {
  const deadline = Date.now() + WAIT_FOR_BOARD_MS;
  let board = await getBoard(tripId, day);
  while (board?.status === "generating" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    board = await getBoard(tripId, day);
  }
  return board;
}

// Any day of the trip, on request: "japlan plans", "japlan day 3",
// "japlan oct 19", "japlan the last day". Shows the day's board, or makes it
// now through the same pipeline as the cron. One reply. The only refusals
// left are real ones: no destination or dates yet, a day outside the trip, a
// day already over, the asker's own allergies and limits still unanswered,
// and endless refills of one day.
export async function answerBoardRequest(
  miss: ClaimFallthrough,
  nowMs: number,
  attempt = 0,
): Promise<void> {
  const now = new Date(nowMs);
  const trip = miss.trip;
  const today = todayFor(trip, now);
  const asksForNextPeriod = isNextPeriodRequest(miss.text);
  const upcoming = asksForNextPeriod ? nextBoardPeriod(trip, now) : null;
  const normalizedRequest = miss.text.toLowerCase().replace(/\bjaplan\b[,:]?/g, " ").trim();
  const asksForAll = /\bshow(?: me)? all\b/.test(normalizedRequest);
  const selectedPeriod = upcoming?.slot ?? explicitBoardPeriod(miss.text) ??
    (asksForAll ? undefined : currentBoardPeriod(trip, now));
  const reply = async (text: string, opts: { board?: boolean } = {}) => {
    if (opts.board && trip.play_mode === "full_group") {
      await miss.send(trip.linq_chat_id, `📣 ${miss.claimant.display_name} asked for the shared board:\n\n${text}`);
      if (miss.isDm) await miss.send(miss.chatId, BOARD_IN_GROUP_LINE);
      return;
    }
    // A board is personal: in a group it goes to the DM, with one line here.
    if (opts.board && !miss.isDm) {
      await sendDM(miss.claimant.phone, text);
      await miss.send(miss.chatId, `📩 sent ${text.split("\n")[0].toLowerCase()} to your dm.`);
      return;
    }
    await miss.send(miss.chatId, text);
  };

  // REAL: a board needs a place and dates. The organizer is asked the missing
  // question right here; anyone else learns who it is waiting on.
  const missing = missingRequiredSetup(trip as SetupFields);
  if (missing.length > 0 || !trip.start_date || !trip.end_date) {
    if (trip.organizer_participant_id === miss.claimant.id) {
      await reply(await resumeSetup(trip));
    } else {
      const organizer = miss.people.find((p) => p.id === trip.organizer_participant_id);
      await reply(waitingOnSetupLine(organizer?.display_name ?? null));
    }
    return;
  }

  // REAL: PLAN's 18+ gate for v1.
  if (isUnderAge((miss.claimant.survey_json ?? {}) as SurveyAnswers)) {
    await reply(UNDER_AGE_LINE);
    return;
  }

  if (asksForNextPeriod && !upcoming) {
    await reply("there isn't a later period in this trip. say “japlan show all” to review today's board.");
    return;
  }
  const target = upcoming
    ? { date: upcoming.date, label: "the next period" }
    : parseBoardDay(miss.text, {
    today,
    startDate: trip.start_date,
    endDate: trip.end_date,
  });
  const requestedPeriod = selectedPeriod;
  boardStep("request", {
    tripId: trip.id,
    text: miss.text.slice(0, 80),
    target: target.date,
    label: target.label,
  });

  // REAL: outside the trip there is no day to make a board for.
  if (target.date < trip.start_date || target.date > trip.end_date) {
    await reply(dayNotInTripLine(shortDate(trip.start_date), shortDate(trip.end_date)));
    return;
  }

  const day = tripDayForDate(trip.start_date, target.date);
  let board = await getBoard(trip.id, day);
  if (board?.status === "generating") {
    boardStep("wait", { tripId: trip.id, day });
    board = await waitWhileGenerating(trip.id, day);
  }
  // Future-day previews are provisional. Refresh one on the day it becomes
  // current, preserving any tasks the group already claimed from the preview.
  if (board?.provisional && target.date <= today) {
    if (await dayHasClaims(trip.id, day)) {
      await updateBoard(board.id, { provisional: false });
      board = { ...board, provisional: false };
    } else if (await relockBoard(board, now)) {
      await deleteUnclaimedTasksForDay(trip.id, day);
      await buildBoardForDate(trip, { date: target.date, now });
      await updateBoard(board.id, { status: "ready", provisional: false });
      board = { ...board, status: "ready", provisional: false };
    } else {
      board = await waitWhileGenerating(trip.id, day);
    }
  }
  const dayTasks = board ? await tasksForDay(trip.id, day) : miss.tasks.filter((t) => t.day === day);
  const periodTasks = requestedPeriod
    ? dayTasks.filter((task) => (task.slot ?? "morning") === requestedPeriod)
    : dayTasks;
  const mine = trip.play_mode === "full_group"
    ? periodTasks.filter((task) => !task.participant_id)
    : tasksClaimableBy(periodTasks, miss.claimant.id, miss.claimantTeamIds);
  const open = mine.filter((task) => isOpenTask(task.id, miss.claims));
  const provisional = Boolean(board?.provisional);

  if (open.length > 0) {
    // Served the stored board: a request to SEE it. Asking for a different
    // one is isRedoRequest, routed before this (redo_today).
    boardStep("list", { path: "served_existing", tripId: trip.id, day, open: open.length, provisional });
    const text = boardText(day, open, await dayAnchorsForBoard(trip, day), await bannerFor(trip, day), placeFor(trip, day), requestedPeriod);
    await reply(boardReply(text, requestedPeriod, target.label, provisional), { board: true });
    return;
  }

  if (requestedPeriod && dayTasks.length > 0) {
    await reply(
      periodTasks.length > 0
        ? "there are no open " + periodLabel(requestedPeriod) + " tasks left. say “japlan show all” to see the full day."
        : "there are no " + periodLabel(requestedPeriod) + " tasks on this board. say “japlan show all” to see the full day.",
    );
    return;
  }

  if (trip.play_mode === "full_group" && dayTasks.length > 0) {
    await reply(GROUP_BOARD_CLEARED_LINE);
    return;
  }

  // REAL: nothing new is made for a day that is over. Tasks created after the
  // fact could be claimed as "done yesterday" without anyone having done them.
  if (target.date < today) {
    await reply(pastDayNoBoardLine(target.label, mine.length > 0));
    return;
  }

  // REAL, and only for the asker: their tasks need their allergies and limits,
  // or a task could clash with them. Everyone else's board does not wait on
  // anyone: generation covers whoever has answered (constraintsKnown).
  if (!constraintsKnown(miss.claimant)) {
    await reply(finishYourSurveyLine());
    return;
  }

  if (dayTasks.length > 0) {
    // The day has a board: either they cleared their part of it, or they
    // joined after it was made. Either way, more tasks for them on that day.
    const isRefill = mine.length > 0;
    if (isRefill) {
      const used = await refillsUsed(trip.id, miss.claimant.id, day);
      if (used >= REFILLS_PER_DAY) {
        // REAL (anti-abuse): regenerating the same day without end.
        boardStep("refill.refused", { path: "refused", reason: "rate_limit", tripId: trip.id, day, used });
        await reply(refillLimitLine(target.label, REFILLS_PER_DAY));
        return;
      }
    }
    const logged = await logRequest(trip.id, miss.claimant.id, today, day, isRefill ? "refill" : "generate");
    const rows = await refillPersonalTasksIfNeeded({
      trip,
      claimant: miss.claimant,
      people: miss.people,
      remainingOpenPersonal: 0,
      deliver: false,
      date: target.date,
    });
    if (rows.length === 0) {
      await dropRequest(logged.id);
      await reply(BOARD_MAKE_FAILED_LINE);
      return;
    }
    boardStep(isRefill ? "refill" : "late_joiner", { path: "regenerated", tripId: trip.id, day, count: rows.length });
    const selectedRows = requestedPeriod
      ? rows.filter((row) => (row.slot ?? "morning") === requestedPeriod)
      : rows;
    if (selectedRows.length === 0) {
      await dropRequest(logged.id);
      await reply(
        requestedPeriod
          ? "there are no " + periodLabel(requestedPeriod) + " tasks available on this board."
          : BOARD_MAKE_FAILED_LINE,
      );
      return;
    }
    const text = boardText(day, selectedRows, await dayAnchorsForBoard(trip, day), await bannerFor(trip, day), placeFor(trip, day), requestedPeriod);
    const board = boardReply(text, requestedPeriod, target.label, provisional);
    await reply(isRefill ? boardRefillLine(board) : board, {
      board: true,
    });
    return;
  }

  // No board for that day yet: make it now, through the same pipeline as the cron.
  const isFuture = target.date > today;
  const lock = await lockNewBoard(trip.id, day, target.date, {
    provisional: isFuture,
    requestedBy: miss.claimant.id,
  });
  if (!lock) {
    // Someone else started it a moment ago: wait, then show it. One retry;
    // a second collision means their run is stuck, which is our failure.
    if (attempt > 0) {
      await reply(BOARD_MAKE_FAILED_LINE);
      return;
    }
    await waitWhileGenerating(trip.id, day);
    return answerBoardRequest(miss, nowMs, attempt + 1);
  }
  const logged = await logRequest(trip.id, miss.claimant.id, today, day, "generate");

  let built;
  try {
    boardStep("generate.before", { tripId: trip.id, day, date: target.date, provisional: isFuture });
    built = await buildBoardForDate(trip, { date: target.date, now });
    boardStep("generate.after", { tripId: trip.id, day, count: built.rows.length });
  } catch (err) {
    boardStep("generate.failed", {
      tripId: trip.id,
      day,
      error: err instanceof Error ? err.message : String(err),
    });
    await getServiceClient().from("boards").delete().eq("id", lock.id);
    await dropRequest(logged.id);
    await reply(BOARD_MAKE_FAILED_LINE);
    return;
  }

  await updateBoard(lock.id, { status: "ready", provisional: isFuture });

  const myRows = trip.play_mode === "full_group"
    ? built.rows.filter((row) => !row.participant_id)
    : tasksClaimableBy(
        built.rows.map((row, i) => ({ ...row, id: `new-${i}` })),
        miss.claimant.id,
      miss.claimantTeamIds,
      );
  const selectedRows = requestedPeriod
    ? myRows.filter((row) => (row.slot ?? "morning") === requestedPeriod)
    : myRows;
  if (selectedRows.length === 0) {
    await reply(
      requestedPeriod
        ? "there are no " + periodLabel(requestedPeriod) + " tasks on this board yet."
        : BOARD_MAKE_FAILED_LINE,
    );
    return;
  }
  const text = boardText(day, selectedRows, await dayAnchorsForBoard(trip, day), await bannerFor(trip, day), placeFor(trip, day), requestedPeriod);
  await reply(boardReply(text, requestedPeriod, target.label, isFuture), { board: true });
}

// Survey completion explains how to request tasks. Do not generate or push a
// board until the participant asks for one.
export async function boardForNewlyReady(
  trip: import("@/lib/db/types").TripRow,
  _participantId: string,
  _now: Date,
): Promise<string | null> {
  if (!trip.start_date || !trip.end_date || missingRequiredSetup(trip as SetupFields).length > 0) return null;
  return trip.play_mode === "full_group"
    ? "you're set. say “japlan show” in the trip chat whenever you want the shared board."
    : "you're set. say “japlan show” here whenever you want your current tasks; “japlan show all” shows the full day.";
}
