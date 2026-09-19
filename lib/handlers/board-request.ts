import { getServiceClient } from "@/lib/db/client";
import type { TaskRow } from "@/lib/db/types";
import { formatPersonalBoard } from "@/lib/game/board";
import {
  describeBoardTime,
  nextBoardAt,
  parseBoardDay,
  shortDate,
  tripDayForDate,
} from "@/lib/game/board-schedule";
import { isOpenTask, tasksClaimableBy } from "@/lib/game/claims";
import {
  BOARD_BEING_MADE_LINE,
  BOARD_IN_DM_LINE,
  BOARD_MAKE_FAILED_LINE,
  PAST_DAY_NO_BOARD_LINE,
  TRIP_NOT_ACTIVE_BOARD_LINE,
  boardClearedLine,
  boardRefillLine,
  boardRequestLimitLine,
  noTasksForYouLine,
  provisionalBoard,
  tripEndedForDayLine,
  tripNotStartedLine,
} from "@/lib/game/copy";
import { localDateString } from "@/lib/game/time";
import { sendDM } from "@/lib/linq/send";
import type { ClaimFallthrough } from "./claims";
import {
  buildBoardForDate,
  deliverExistingBoard,
  getBoard,
  lockNewBoard,
  refillPersonalTasksIfNeeded,
  tasksForDay,
  updateBoard,
} from "./daily-board";
import { boardDueNow } from "@/lib/game/board-schedule";

function boardStep(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.board] step", { step, ...fields });
}

function boardText(day: number, tasks: Pick<TaskRow, "code" | "title" | "base_points">[]): string {
  return formatPersonalBoard({
    day,
    tasks: tasks.map((t) => ({ code: t.code, title: t.title, base_points: t.base_points })),
  });
}

// The abuse guard: one on-demand generation per person per trip-local day,
// enforced by board_requests' unique index. False when already used.
async function takeRequestSlot(
  tripId: string,
  participantId: string,
  requestedOn: string,
  day: number,
): Promise<{ id: string } | null> {
  const { data, error } = await getServiceClient()
    .from("board_requests")
    .insert({ trip_id: tripId, participant_id: participantId, requested_on: requestedOn, day })
    .select("id")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data as { id: string };
}

async function releaseRequestSlot(id: string): Promise<void> {
  const { error } = await getServiceClient().from("board_requests").delete().eq("id", id);
  if (error) console.error("[japlan.board] release slot failed", error);
}

// "japlan plans", "japlan tomorrow", "japlan day 3": the board for that day,
// made now if it does not exist yet. One reply.
export async function answerBoardRequest(miss: ClaimFallthrough, nowMs: number): Promise<void> {
  const now = new Date(nowMs);
  const trip = miss.trip;
  const tz = trip.timezone;
  const today = localDateString(now, tz);
  const reply = async (text: string, opts: { board?: boolean } = {}) => {
    // A board is personal: in a group it goes to the DM, with one line here.
    if (opts.board && !miss.isDm) {
      await sendDM(miss.claimant.phone, text);
      await miss.send(miss.chatId, BOARD_IN_DM_LINE);
      return;
    }
    await miss.send(miss.chatId, text);
  };
  // When the next scheduled board lands, knowing whether today's exists (it
  // may have just been made, by this person or someone else).
  const nextWhen = async () => {
    const todayDay = trip.start_date ? tripDayForDate(trip.start_date, today) : null;
    const todayBoardExists =
      todayDay !== null &&
      (Boolean(await getBoard(trip.id, todayDay)) ||
        miss.tasks.some((task) => task.day === todayDay));
    const next = nextBoardAt(trip, now, { todayBoardExists });
    return next ? describeBoardTime(next.at, now, tz) : null;
  };

  if (trip.state !== "active" || !trip.start_date || !trip.end_date) {
    await reply(TRIP_NOT_ACTIVE_BOARD_LINE);
    return;
  }

  const target = parseBoardDay(miss.text, { today, startDate: trip.start_date });
  boardStep("request", { tripId: trip.id, text: miss.text.slice(0, 80), target: target.date, label: target.label });
  if (target.date < trip.start_date) {
    await reply(tripNotStartedLine(shortDate(trip.start_date), await nextWhen()));
    return;
  }
  if (target.date > trip.end_date) {
    await reply(tripEndedForDayLine(shortDate(trip.end_date)));
    return;
  }

  const day = tripDayForDate(trip.start_date, target.date);
  const board = await getBoard(trip.id, day);
  const dayTasks = board ? await tasksForDay(trip.id, day) : miss.tasks.filter((t) => t.day === day);
  const mine = tasksClaimableBy(dayTasks, miss.claimant.id, miss.claimantTeamIds);
  const open = mine.filter((task) => isOpenTask(task.id, miss.claims));
  const provisional = Boolean(board?.provisional);

  if (board?.status === "generating") {
    await reply(BOARD_BEING_MADE_LINE);
    return;
  }

  if (open.length > 0) {
    boardStep("list", { tripId: trip.id, day, open: open.length, provisional });
    const text = boardText(day, open);
    await reply(provisional ? provisionalBoard(text) : text, { board: true });
    return;
  }

  if (mine.length > 0) {
    // Cleared. Today: a refill, which is a generation, so it uses the slot.
    if (target.date === today) {
      const slot = await takeRequestSlot(trip.id, miss.claimant.id, today, day);
      if (slot) {
        const rows = await refillPersonalTasksIfNeeded({
          trip,
          claimant: miss.claimant,
          people: miss.people,
          remainingOpenPersonal: 0,
          deliver: false,
        });
        if (rows.length > 0) {
          boardStep("refill", { tripId: trip.id, day, count: rows.length });
          await reply(boardRefillLine(boardText(day, rows)), { board: true });
          return;
        }
        await releaseRequestSlot(slot.id);
      }
    }
    await reply(boardClearedLine(await nextWhen()));
    return;
  }

  if (dayTasks.length > 0) {
    // A board exists for the day but has nothing of theirs (joined late).
    await reply(noTasksForYouLine(target.label, await nextWhen()));
    return;
  }

  if (target.date < today) {
    await reply(PAST_DAY_NO_BOARD_LINE);
    return;
  }

  // No board for that day yet: make it now, through the same pipeline as the cron.
  const slot = await takeRequestSlot(trip.id, miss.claimant.id, today, day);
  if (!slot) {
    boardStep("limit", { tripId: trip.id, participantId: miss.claimant.id });
    await reply(boardRequestLimitLine(await nextWhen()));
    return;
  }
  const isFuture = target.date > today;
  const lock = await lockNewBoard(trip.id, day, target.date, {
    provisional: isFuture,
    requestedBy: miss.claimant.id,
  });
  if (!lock) {
    // Someone (or the cron) is making it right now; do not spend their slot.
    await releaseRequestSlot(slot.id);
    await reply(BOARD_BEING_MADE_LINE);
    return;
  }

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
    await releaseRequestSlot(slot.id);
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

  const myRows = tasksClaimableBy(
    built.rows.map((row, i) => ({ ...row, id: `new-${i}` })),
    miss.claimant.id,
    miss.claimantTeamIds,
  );
  if (myRows.length === 0) {
    await reply(BOARD_MAKE_FAILED_LINE);
    return;
  }
  const text = boardText(day, myRows);
  await reply(isFuture ? provisionalBoard(text) : text, { board: true });
}
