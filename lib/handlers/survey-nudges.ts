import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { waitingOnSurveysLine } from "@/lib/game/copy";
import { sendDM, sendText } from "@/lib/linq/send";
import { nextUnansweredQuestion, surveyFinished } from "./bootstrap";

// Board time, for people still answering: instead of a board, one DM with
// the next unanswered question and nothing else, at most once a local day.
// And, only while nobody at all has finished, one line in the group saying
// who it is waiting on, once per trip. Both read columns from migration
// 2026-09-28 in their own queries: before it runs they log and do nothing,
// and boards are unaffected.

function nudgeStep(step: string, fields: Record<string, unknown>): void {
  console.info("[japlan.survey] nudge", { step, ...fields });
}

type Person = Pick<ParticipantRow, "id" | "phone" | "display_name" | "survey_state"> & {
  survey_nudged_on?: string | null;
};

async function unfinishedPeople(tripId: string): Promise<Person[] | null> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select("id, phone, display_name, survey_state, survey_nudged_on")
    .eq("trip_id", tripId);
  if (error) {
    nudgeStep("skipped", { tripId, reason: "read_failed (migration 2026-09-28 applied?)", code: error.code });
    return null;
  }
  return ((data ?? []) as Person[]).filter((p) => !surveyFinished(p.survey_state));
}

export async function nudgeUnfinished(trip: TripRow, localDate: string): Promise<number> {
  const people = await unfinishedPeople(trip.id);
  if (!people) return 0;
  let sent = 0;
  for (const person of people) {
    if (person.survey_nudged_on === localDate) continue;
    // Claim today's nudge first, so two ticks cannot both send it.
    const { data, error } = await getServiceClient()
      .from("participants")
      .update({ survey_nudged_on: localDate })
      .eq("id", person.id)
      .select("id");
    if (error || !data?.length) continue;
    try {
      await sendDM(person.phone, await nextUnansweredQuestion(person));
      sent += 1;
    } catch (err) {
      console.error("[japlan.survey] nudge DM failed", { participantId: person.id, err });
    }
  }
  nudgeStep("sent", { tripId: trip.id, localDate, unfinished: people.length, sent });
  return sent;
}

export async function announceWaitingOnce(trip: TripRow): Promise<boolean> {
  if (trip.is_solo) return false;
  const { data, error } = await getServiceClient()
    .from("trips")
    .select("waiting_notice_sent_at")
    .eq("id", trip.id)
    .maybeSingle();
  if (error) {
    nudgeStep("waiting_notice.skipped", { tripId: trip.id, code: error.code });
    return false;
  }
  if ((data as { waiting_notice_sent_at: string | null } | null)?.waiting_notice_sent_at) return false;
  const people = await unfinishedPeople(trip.id);
  if (!people || people.length === 0) return false;
  const claimed = await getServiceClient()
    .from("trips")
    .update({ waiting_notice_sent_at: new Date().toISOString() })
    .eq("id", trip.id)
    .is("waiting_notice_sent_at", null)
    .select("id");
  if (claimed.error || !claimed.data?.length) return false;
  await sendText(trip.linq_chat_id, waitingOnSurveysLine(people.map((p) => p.display_name)));
  nudgeStep("waiting_notice.sent", { tripId: trip.id, waitingOn: people.length });
  return true;
}
