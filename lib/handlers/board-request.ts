import { getServiceClient } from "@/lib/db/client";
import type { TaskRow } from "@/lib/db/types";
import { formatPersonalBoard } from "@/lib/game/board";
import {
  boardDueNow,
  parseBoardDay,
  shortDate,
  tripDayForDate,
} from "@/lib/game/board-schedule";
import { isOpenTask, tasksClaimableBy } from "@/lib/game/claims";
import {
  BOARD_IN_DM_LINE,
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
import { localDateString } from "@/lib/game/time";
import { sendDM } from "@/lib/linq/send";
import type { ClaimFallthrough } from "./claims";
import {
  buildBoardForDate,
  constraintsKnown,
  dayAnchorsForBoard,
  type BoardAnchor,
  deliverExistingBoard,
  getBoard,
  lockNewBoard,
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
): string {
  return formatPersonalBoard({
    day,
    anchors,
    tasks: tasks.map((t) => ({
      code: t.code,
      title: t.title,
      base_points: t.base_points,
      slot: t.slot ?? null,
      neighborhood: t.neighborhood,
    })),
  });
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
  const today = localDateString(now, trip.timezone);
  const reply = async (text: string, opts: { board?: boolean } = {}) => {
    if (opts.board && trip.play_mode === "full_group") {
      await miss.send(trip.linq_chat_id, `📣 ${miss.claimant.display_name} asked for the shared board:\n\n${text}`);
      if (miss.isDm) await miss.send(miss.chatId, BOARD_IN_GROUP_LINE);
      return;
    }
    // A board is personal: in a group it goes to the DM, with one line here.
    if (opts.board && !miss.isDm) {
      await sendDM(miss.claimant.phone, text);
      await miss.send(miss.chatId, BOARD_IN_DM_LINE);
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

  const target = parseBoardDay(miss.text, {
    today,
    startDate: trip.start_date,
    endDate: trip.end_date,
  });
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
  const dayTasks = board ? await tasksForDay(trip.id, day) : miss.tasks.filter((t) => t.day === day);
  const mine = trip.play_mode === "full_group"
    ? dayTasks.filter((task) => !task.participant_id)
    : tasksClaimableBy(dayTasks, miss.claimant.id, miss.claimantTeamIds);
  const open = mine.filter((task) => isOpenTask(task.id, miss.claims));
  const provisional = Boolean(board?.provisional);

  if (open.length > 0) {
    // Served the stored board: a request to SEE it. Asking for a different
    // one is isRedoRequest, routed before this (redo_today).
    boardStep("list", { path: "served_existing", tripId: trip.id, day, open: open.length, provisional });
    const text = boardText(day, open, await dayAnchorsForBoard(trip, day));
    await reply(provisional ? provisionalBoard(text) : text, { board: true });
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
    const text = boardText(day, rows, await dayAnchorsForBoard(trip, day));
    await reply(isRefill ? boardRefillLine(text) : provisional ? provisionalBoard(text) : text, {
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

  // Today's board, asked for after its board_time: the scheduled post for
  // today has passed, so everyone else gets theirs now rather than never.
  // Before board_time, the cron delivers to the others at their time. The
  // requester is skipped there (board_requests) since this reply is theirs.
  if (!isFuture && boardDueNow(trip, now).due) {
    await deliverExistingBoard(trip, day, target.date, now);
    await updateBoard(lock.id, { delivered_at: new Date().toISOString() });
    boardStep("delivered_to_others", { tripId: trip.id, day });
  }

  const myRows = trip.play_mode === "full_group"
    ? built.rows.filter((row) => !row.participant_id)
    : tasksClaimableBy(
        built.rows.map((row, i) => ({ ...row, id: `new-${i}` })),
        miss.claimant.id,
        miss.claimantTeamIds,
      );
  if (myRows.length === 0) {
    await reply(BOARD_MAKE_FAILED_LINE);
    return;
  }
  const text = boardText(day, myRows, await dayAnchorsForBoard(trip, day));
  await reply(isFuture ? provisionalBoard(text) : text, { board: true });
}

// Someone just became ready (finished the survey): their board for today, or
// for day 1 if the trip has not started (marked "might still change"), made
// now and returned for the reply they are already getting. Per person:
//  - the day's board exists: their own tasks on it, or a top-up for them
//    alone if they joined after it was made;
//  - it does not: the day is made through the cron's pipeline (which only
//    covers people who are ready) and nothing is sent to anyone else. The
//    cron later delivers it to the others at board time and skips this
//    person, who is logged in board_requests.
// null when there is no day to make (no dates, trip over) or generation
// failed; the caller falls back to its usual line.
export async function boardForNewlyReady(
  trip: import("@/lib/db/types").TripRow,
  participantId: string,
  now: Date,
): Promise<string | null> {
  if (!trip.start_date || !trip.end_date || missingRequiredSetup(trip as SetupFields).length > 0) return null;
  const today = localDateString(now, trip.timezone || "UTC");
  if (today > trip.end_date) return null;
  const date = today < trip.start_date ? trip.start_date : today;
  const day = tripDayForDate(trip.start_date, date);
  try {
    const people = await getServiceClient()
      .from("participants")
      .select("id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at")
      .eq("trip_id", trip.id);
    if (people.error) throw people.error;
    const me = ((people.data ?? []) as import("@/lib/db/types").ParticipantRow[]).find((p) => p.id === participantId);
    if (!me || !constraintsKnown(me) || isUnderAge((me.survey_json ?? {}) as SurveyAnswers)) return null;

    let board = await getBoard(trip.id, day);
    if (board?.status === "generating") board = await waitWhileGenerating(trip.id, day);
    let rows: Pick<TaskRow, "code" | "title" | "base_points" | "slot" | "neighborhood" | "participant_id" | "team_id">[];
    if (board) {
      const existing = tasksClaimableBy(await tasksForDay(trip.id, day), participantId, []);
      rows = existing.length
        ? existing
        : await refillPersonalTasksIfNeeded({ trip, claimant: me, people: [], remainingOpenPersonal: 0, deliver: false, date, now });
      boardStep("ready.board", { path: existing.length ? "served_existing" : "regenerated", tripId: trip.id, day, participantId, count: rows.length });
    } else {
      const lock = await lockNewBoard(trip.id, day, date, { provisional: date > today, requestedBy: participantId });
      if (!lock) {
        board = await waitWhileGenerating(trip.id, day);
        rows = tasksClaimableBy(await tasksForDay(trip.id, day), participantId, []);
      } else {
        try {
          const built = await buildBoardForDate(trip, { date, now });
          await updateBoard(lock.id, { status: "ready", provisional: date > today });
          rows = tasksClaimableBy(
            built.rows.map((row, i) => ({ ...row, id: `new-${i}` })),
            participantId,
            [],
          );
        } catch (err) {
          await getServiceClient().from("boards").delete().eq("id", lock.id);
          throw err;
        }
      }
      boardStep("ready.board", { path: "regenerated", tripId: trip.id, day, participantId, count: rows.length, madeDay: true });
    }
    if (rows.length === 0) return null;
    // The cron skips people who already got this day's board.
    await logRequest(trip.id, participantId, today, day, "generate");
    const text = boardText(day, rows, await dayAnchorsForBoard(trip, day));
    return date > today ? provisionalBoard(text) : text;
  } catch (err) {
    boardStep("ready.board.failed", { tripId: trip.id, day, participantId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
