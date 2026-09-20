// One show, once a trip, for the person who said the trip is a waste without
// one.
//
// "this trip is a waste if we don't ___" is the highest signal answer in the
// survey, and until now it fed a written profile and four keyword buckets.
// This closes the loop: if somebody named something you can buy a ticket to,
// go find a real one with a real link.
//
// INVENTORY COMES FROM trip_events, never from an API at match time. A row is
// a row: seeded by hand or written by the Discovery client, the matching,
// attribution and copy below are identical, so a seeded demo exercises the
// real path rather than a mock of it. Only `source` tells them apart.
//
// Why seeding exists: probed 2026-10-04 with a live key, Discovery has no
// usable Japan inventory. countryCode=JP returns one sporting feed with 0%
// venue coordinates, 0% price and, fatally, 0% purchase URL, which was the
// whole mechanism. A London control had 100% of all three, so the Discovery
// client stays worth keeping for non-Japan trips.
//
// NO BUDGET CHECK. priceRanges was 0% filled in London and New York too, so a
// budget rule would suppress every suggestion in every market rather than
// filter any. The message says the price is unknown and a human looks before
// buying, which is where the bot stops anyway.
//
// At most ONE per trip. A single well-matched suggestion is delightful; a
// daily feed is a spam bot.

import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import { cityFor, todayFor } from "@/lib/game/legs";
import { showSuggestionLine } from "@/lib/game/copy";

// What a must-have has to sound like before this goes looking. Deliberately
// narrow: a show, a match, a gig. "eat at a 7-eleven" is a must-have too and
// has nothing to buy a ticket for.
const TICKETED_RE =
  /\b(show|gig|concert|live music|musical|theatre|theater|play|match|game|festival|dj|club night|comedy|standup|stand-up|sumo|baseball|opera|ballet|performance)\b/i;

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.show] step", { step, ...fields });
}

// One row of inventory, whatever wrote it.
export type TripEvent = {
  id: string;
  name: string;
  venue: string | null;
  lat: number | null;
  lng: number | null;
  starts_at: string;
  category: string | null;
  url: string;
  price_note: string | null;
  source: string;
};

export const EVENT_COLS =
  "id, name, venue, lat, lng, starts_at, category, url, price_note, source";

// Whose must-have is worth a ticket search, if anyone's. First match wins:
// one suggestion per trip means one person's answer.
export function ticketedMustHave(
  people: ParticipantRow[],
): { person: ParticipantRow; mustHave: string } | null {
  for (const person of people) {
    const answers = (person.survey_json ?? {}) as SurveyAnswers;
    const value = answerValue(answers, "must_have")?.trim().replace(/[.!]+$/, "");
    if (value && TICKETED_RE.test(value)) return { person, mustHave: value };
  }
  return null;
}

// Already suggested? One per trip, tracked on the trip row so a redeploy or a
// second cron tick cannot send a second one.
async function alreadySuggested(tripId: string): Promise<boolean> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select("show_suggested_at")
    .eq("id", tripId)
    .maybeSingle();
  if (error) {
    step("check.skipped", { code: error.code, note: "migration 2026-10-05 applied?" });
    // Unknown means do not send: a duplicate suggestion is worse than none.
    return true;
  }
  return Boolean((data as { show_suggested_at?: string | null } | null)?.show_suggested_at);
}

async function markSuggested(tripId: string): Promise<boolean> {
  const { error } = await getServiceClient()
    .from("trips")
    .update({ show_suggested_at: new Date().toISOString() })
    // Only if nobody else got there first: the guard and the write are one
    // statement, so two ticks cannot both send.
    .eq("id", tripId)
    .is("show_suggested_at", null);
  if (error) {
    step("mark.failed", { code: error.code });
    return false;
  }
  return true;
}

// The trip's events that fall inside its dates, soonest first.
export async function eventsForTrip(trip: TripRow): Promise<TripEvent[]> {
  const { data, error } = await getServiceClient()
    .from("trip_events")
    .select(EVENT_COLS)
    .eq("trip_id", trip.id)
    .order("starts_at");
  if (error) {
    step("events.skipped", { code: error.code, note: "migration 2026-10-06 applied?" });
    return [];
  }
  const rows = (data ?? []) as TripEvent[];
  if (!trip.start_date || !trip.end_date) return rows;
  // Inside the trip only. An event the day after everyone flies home is not a
  // suggestion, it is a taunt.
  return rows.filter((e) => {
    const day = e.starts_at.slice(0, 10);
    return day >= trip.start_date! && day <= trip.end_date!;
  });
}

// Which event best answers what somebody said. Scored, not filtered, so a
// thin inventory still produces the best available rather than nothing:
//   + the must-have's own words appear in the name or category
//   + the category matches a group interest lean
//   + it is on an evening, which is when a show actually fits a day
// No budget term: priceRanges was 0% filled in every Discovery market probed,
// so there is nothing to score and a budget filter would suppress everything.
export function pickEvent(opts: {
  events: TripEvent[];
  mustHave: string;
  interests: string[];
}): TripEvent | null {
  const words = opts.mustHave.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  let best: { event: TripEvent; score: number } | null = null;
  for (const event of opts.events) {
    const hay = `${event.name} ${event.venue ?? ""} ${event.category ?? ""}`.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 3;
    if (event.category && opts.interests.includes(event.category.toLowerCase())) score += 2;
    const hour = Number(event.starts_at.slice(11, 13));
    if (Number.isFinite(hour) && hour >= 17) score += 1;
    if (!best || score > best.score) best = { event, score };
  }
  return best?.event ?? null;
}

// The whole thing, for one trip. Returns the message to send, or null for
// silence. Never throws: a show is a bonus, never a gate.
export async function suggestShowOnce(opts: {
  trip: TripRow;
  people: ParticipantRow[];
  // The group's interest leans, to break ties between events.
  interests?: string[];
  now?: Date;
}): Promise<string | null> {
  try {
    const match = ticketedMustHave(opts.people);
    if (!match) return null;
    if (await alreadySuggested(opts.trip.id)) {
      step("skip", { tripId: opts.trip.id, reason: "already_suggested" });
      return null;
    }
    const now = opts.now ?? new Date();
    const city = cityFor(opts.trip, todayFor(opts.trip, now)) || opts.trip.destination || "";
    if (!city) return null;

    const events = await eventsForTrip(opts.trip);
    if (events.length === 0) {
      step("skip", { tripId: opts.trip.id, reason: "no_events", city });
      return null;
    }
    const show = pickEvent({ events, mustHave: match.mustHave, interests: opts.interests ?? [] });
    if (!show) return null;
    // Claim the one slot BEFORE sending, so a failure to send costs the
    // suggestion rather than sending it twice.
    if (!(await markSuggested(opts.trip.id))) return null;

    step("suggested", {
      tripId: opts.trip.id,
      who: match.person.display_name,
      mustHave: match.mustHave,
      event: show.name,
      source: show.source,
      url: show.url,
    });
    return showSuggestionLine({
      who: match.person.display_name,
      mustHave: match.mustHave,
      title: show.name,
      venue: show.venue,
      startsAt: show.starts_at,
      priceNote: show.price_note,
      url: show.url,
    });
  } catch (err) {
    step("failed", { tripId: opts.trip.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
