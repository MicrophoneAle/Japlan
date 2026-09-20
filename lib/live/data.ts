// The live trip dashboard's read model: one pure function that turns raw
// rows into what the page renders. No network, no Supabase — lib/live/load.ts
// owns I/O and calls into this. Mirrors lib/wrapped/data.ts's split, but for
// a trip in progress rather than a finished one.
//
// Privacy: this is a shareable link anyone with it can open. Never put a
// phone number, survey_json, prefs_json, or resolution_json on LiveTripData.
// Only display_name, scores, task/claim facts already meant to be public in
// the group chat, and place-level (never live device) locations.

import type { ClaimRow, ParticipantRow, PlaceRow, SidequestRow, TaskRow, TripRow } from "@/lib/db/types";
import { legForDate, legsLabel, type LeggedTrip } from "@/lib/game/legs";
import { boardRouteLabel } from "@/lib/game/copy";
import { applyMultiplier, multiplierLabel, taskMultiplierInForce } from "@/lib/game/multipliers";
import { localDateString } from "@/lib/game/time";
import type { Stats } from "@/lib/game/stats";
import { groupTotals } from "@/lib/game/stats";

export type LiveStanding = {
  id: string;
  name: string;
  rank: number;
  score: number;
  pointsToday: number;
  tasksCompleted: number;
  teamId: string | null;
  teamName: string | null;
};

export type LiveTeam = {
  id: string;
  name: string;
  color: string;
  memberNames: string[];
  score: number;
  tasksCompleted: number;
};

export type LiveTaskStatus = "open" | "completed" | "expired";

export type LiveTask = {
  id: string;
  code: string;
  title: string;
  tier: string;
  points: number;
  // Set only when a multiplier day inflates this task's worth: the value the
  // task is actually worth today, and the label for the badge ("2x holiday").
  multiplier: { points: number; label: string } | null;
  verification: string;
  status: LiveTaskStatus;
  assignee: string | null;
  neighborhood: string | null;
  expiresAt: string | null;
  completedBy: string | null;
  awardedPoints: number | null;
  photo: string | null;
};

export type LiveActivityEvent = { at: string; text: string };

export type LiveItineraryAnchor = {
  order: number;
  place: string;
  time: string | null;
  status: "done" | "current" | "upcoming";
};

export type LiveTripData = {
  trip: {
    id: string;
    name: string;
    destination: string;
    day: number;
    totalDays: number | null;
    route: string | null;
    peopleCount: number;
    teamCount: number;
  };
  standings: LiveStanding[];
  teams: LiveTeam[];
  tasks: { active: LiveTask[]; completed: LiveTask[] };
  proof: LiveTask[];
  itinerary: LiveItineraryAnchor[];
  activity: LiveActivityEvent[];
  stats: {
    questsCompleted: number;
    questsAttempted: number;
    photosSubmitted: number;
    placesVisited: number;
    totalPoints: number;
  };
  japlanSays: string | null;
};

function tripDays(trip: Pick<TripRow, "start_date" | "end_date">): number | null {
  if (!trip.start_date || !trip.end_date) return null;
  return Math.max(1, Math.round((Date.parse(`${trip.end_date}T00:00:00Z`) - Date.parse(`${trip.start_date}T00:00:00Z`)) / 86_400_000) + 1);
}

function photoUrl(claim: ClaimRow): string | null {
  if (!claim.photo_claimed_at || !(claim.storage_path || claim.evidence_url)) return null;
  return `/live/photo/${claim.id}`;
}

function taskFromRow(opts: {
  task: TaskRow;
  claim: ClaimRow | undefined;
  assigneeName: string | null;
  now: Date;
}): LiveTask {
  const { task, claim, assigneeName, now } = opts;
  const boost = taskMultiplierInForce(task);
  const awarded = claim?.status === "awarded";
  const expired = !awarded && Boolean(task.expires_at) && Date.parse(task.expires_at!) <= now.getTime();
  return {
    id: task.id,
    code: task.code,
    title: task.title,
    tier: task.tier,
    points: task.base_points,
    multiplier: boost ? { points: applyMultiplier(task.base_points, boost.value), label: multiplierLabel(boost.value) } : null,
    verification: task.verification,
    status: awarded ? "completed" : expired ? "expired" : "open",
    assignee: assigneeName,
    neighborhood: task.neighborhood,
    expiresAt: task.expires_at,
    completedBy: awarded ? assigneeName : null,
    awardedPoints: awarded ? claim!.awarded_points ?? null : null,
    photo: claim ? photoUrl(claim) : null,
  };
}

// "Asakusa → Ueno": the first and last neighborhood today's tasks pass
// through, in the same order the board itself uses (lib/game/board.ts).
function routeFor(tasks: TaskRow[]): string | null {
  const hoods = tasks.map((t) => t.neighborhood).filter((n): n is string => Boolean(n));
  if (hoods.length === 0) return null;
  return boardRouteLabel(hoods[0], hoods[hoods.length - 1]);
}

export type LiveTeamInput = { id: string; name: string; color: string; formedAt: string; memberIds: string[] };

export function buildLiveTripData(opts: {
  trip: TripRow & LeggedTrip;
  people: ParticipantRow[];
  tasks: TaskRow[];
  claims: ClaimRow[];
  teams: LiveTeamInput[];
  itinerary: { order: number; place_id: string; planned_time: string | null }[];
  places: Pick<PlaceRow, "id" | "name">[];
  stats: Record<string, Stats>;
  sidequests: Pick<SidequestRow, "id" | "title" | "points">[];
  sidequestOffers: { sidequest_id: string; participant_id: string; status: string; fired_at: string | null; resolved_at: string | null; awarded_points: number | null }[];
  now: Date;
  day: number;
}): LiveTripData {
  const { trip, people, tasks, claims, teams, now, day } = opts;
  const claimByTask = new Map(claims.map((c) => [c.task_id, c]));
  const personById = new Map(people.map((p) => [p.id, p]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const teamOfPerson = new Map<string, LiveTeamInput>();
  for (const team of teams) for (const memberId of team.memberIds) teamOfPerson.set(memberId, team);

  const todaysTasks = tasks.filter((t) => t.day === day);
  const assigneeNameFor = (task: TaskRow): string | null => {
    if (task.participant_id) return personById.get(task.participant_id)?.display_name ?? null;
    if (task.team_id) return teamById.get(task.team_id)?.name ?? null;
    return null;
  };

  const toLiveTask = (task: TaskRow) =>
    taskFromRow({ task, claim: claimByTask.get(task.id), assigneeName: assigneeNameFor(task), now });
  const active = todaysTasks.map(toLiveTask).filter((t) => t.status === "open");
  const completed = tasks
    .map(toLiveTask)
    .filter((t) => t.status === "completed")
    .sort((a, b) => (claimByTask.get(b.id)?.created_at ?? "").localeCompare(claimByTask.get(a.id)?.created_at ?? ""));
  const proof = completed.filter((t) => t.photo).slice(0, 18);

  // Individuals are the scoring unit (docs/PLAN.md "who holds the score"):
  // every person's own row and score, annotated with their team if paired.
  const pointsTodayByPerson = new Map<string, number>();
  for (const claim of claims) {
    if (claim.status !== "awarded") continue;
    const task = tasks.find((t) => t.id === claim.task_id);
    if (!task || task.day !== day) continue;
    pointsTodayByPerson.set(claim.participant_id, (pointsTodayByPerson.get(claim.participant_id) ?? 0) + (claim.awarded_points ?? 0));
  }
  const tasksCompletedByPerson = new Map<string, number>();
  for (const claim of claims) {
    if (claim.status !== "awarded") continue;
    tasksCompletedByPerson.set(claim.participant_id, (tasksCompletedByPerson.get(claim.participant_id) ?? 0) + 1);
  }
  const ranked = [...people].sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));
  const standings: LiveStanding[] = ranked.map((person) => {
    const team = teamOfPerson.get(person.id) ?? null;
    return {
      id: person.id,
      name: person.display_name,
      // Competition ranking: ties share a rank (160, 145, 145, 95 -> 1, 2, 2, 4).
      rank: 1 + ranked.filter((p) => p.score > person.score).length,
      score: person.score,
      pointsToday: pointsTodayByPerson.get(person.id) ?? 0,
      tasksCompleted: tasksCompletedByPerson.get(person.id) ?? 0,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
    };
  });

  const liveTeams: LiveTeam[] = teams.map((team) => {
    const members = team.memberIds.map((id) => personById.get(id)).filter((p): p is ParticipantRow => Boolean(p));
    return {
      id: team.id,
      name: team.name,
      color: team.color,
      memberNames: members.map((m) => m.display_name),
      score: members.reduce((sum, m) => sum + m.score, 0),
      tasksCompleted: members.reduce((sum, m) => sum + (tasksCompletedByPerson.get(m.id) ?? 0), 0),
    };
  });

  const zone = legForDate(trip, localDateString(now, trip.timezone)).timezone ?? trip.timezone ?? "UTC";
  const anchorRows = opts.itinerary.map((row) => {
    const place = opts.places.find((p) => p.id === row.place_id);
    const plannedMs = row.planned_time ? Date.parse(row.planned_time) : null;
    return {
      order: row.order,
      place: place?.name ?? "somewhere on the route",
      time: plannedMs ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(plannedMs) : null,
      plannedMs,
    };
  });
  // Time-based, not claim-based: the itinerary has no "visited" flag, so an
  // anchor is "done" once its planned time has passed and a later one has
  // already started too, "current" once its time arrives, else "upcoming".
  // With no clock times at all, the first anchor is just assumed current.
  const nowMs = now.getTime();
  const itinerary: LiveItineraryAnchor[] = anchorRows.map((anchor, index) => {
    if (anchor.plannedMs === null) {
      return { order: anchor.order, place: anchor.place, time: anchor.time, status: index === 0 ? "current" : "upcoming" };
    }
    if (anchor.plannedMs > nowMs) {
      return { order: anchor.order, place: anchor.place, time: anchor.time, status: "upcoming" };
    }
    const nextHasStarted = anchorRows.slice(index + 1).some((later) => later.plannedMs !== null && later.plannedMs <= nowMs);
    return { order: anchor.order, place: anchor.place, time: anchor.time, status: nextHasStarted ? "done" : "current" };
  });

  const totals = groupTotals(people.map((p) => opts.stats[p.id]).filter(Boolean));
  const questsCompleted = claims.filter((c) => c.status === "awarded").length;
  const activity = buildActivityFeed({ tasks, claims, teams, people, sidequests: opts.sidequests, sidequestOffers: opts.sidequestOffers });

  return {
    trip: {
      id: trip.id,
      name: trip.name,
      destination: legsLabel(trip) || trip.destination || "the trip",
      day,
      totalDays: tripDays(trip),
      route: routeFor(todaysTasks),
      peopleCount: people.length,
      teamCount: teams.length,
    },
    standings,
    teams: liveTeams,
    tasks: { active, completed },
    proof,
    itinerary,
    activity,
    stats: {
      questsCompleted,
      questsAttempted: claims.length,
      photosSubmitted: totals.photos_submitted,
      placesVisited: totals.places_visited,
      totalPoints: people.reduce((sum, p) => sum + p.score, 0),
    },
    japlanSays: japlanSaysLine(standings),
  };
}

// One data-driven line, never a generic filler. Whoever is furthest ahead
// today, only when there is something to say; null when there is not enough
// signal (day 1, nobody has scored yet).
function japlanSaysLine(standings: LiveStanding[]): string | null {
  const scoredToday = standings.filter((s) => s.pointsToday > 0);
  const leader = [...scoredToday].sort((a, b) => b.pointsToday - a.pointsToday)[0];
  if (!leader) return null;
  if (leader.pointsToday >= 40) return `${leader.name} is having a day: +${leader.pointsToday} so far.`;
  if (scoredToday.length === standings.length && standings.length > 1) {
    return "everybody's on the board today.";
  }
  return `${leader.name} leads today with +${leader.pointsToday}.`;
}

// Recent events, merged from whatever already exists (claims, team
// formation, sidequests) and sorted newest first. No new table: every event
// is derived from a row that already had to be written for game logic to
// work, so there is nothing here that duplicates or competes with it.
function buildActivityFeed(opts: {
  tasks: TaskRow[];
  claims: ClaimRow[];
  teams: LiveTeamInput[];
  people: ParticipantRow[];
  sidequests: Pick<SidequestRow, "id" | "title" | "points">[];
  sidequestOffers: { sidequest_id: string; participant_id: string; status: string; fired_at: string | null; resolved_at: string | null; awarded_points: number | null }[];
}): LiveActivityEvent[] {
  const taskById = new Map(opts.tasks.map((t) => [t.id, t]));
  const personById = new Map(opts.people.map((p) => [p.id, p]));
  const sidequestById = new Map(opts.sidequests.map((s) => [s.id, s]));
  const events: LiveActivityEvent[] = [];

  for (const claim of opts.claims) {
    if (claim.status !== "awarded" || !claim.created_at) continue;
    const task = taskById.get(claim.task_id);
    const person = personById.get(claim.participant_id);
    if (!task || !person) continue;
    events.push({ at: claim.created_at, text: `${person.display_name} completed ${task.code} · +${claim.awarded_points ?? 0}` });
  }
  for (const team of opts.teams) {
    const names = team.memberIds.map((id) => personById.get(id)?.display_name).filter((n): n is string => Boolean(n));
    events.push({ at: team.formedAt, text: `${team.name} formed: ${names.join(" + ") || `${team.memberIds.length} people`}` });
  }
  for (const offer of opts.sidequestOffers) {
    const person = personById.get(offer.participant_id);
    const sidequest = sidequestById.get(offer.sidequest_id);
    if (!person) continue;
    if (offer.status === "live" && offer.fired_at) {
      events.push({ at: offer.fired_at, text: `Japlan issued a sidequest to ${person.display_name}` });
    }
    if (offer.status === "won" && offer.resolved_at) {
      events.push({ at: offer.resolved_at, text: `${person.display_name} won ${sidequest?.title ?? "the sidequest"} · +${offer.awarded_points ?? sidequest?.points ?? 0}` });
    }
  }
  return events
    .filter((e) => e.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 40);
}
