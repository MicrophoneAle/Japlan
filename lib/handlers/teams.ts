// Team formation, survey edition: run once at trip activation (see
// maybeActivateTrip in lib/handlers/bootstrap.ts), from everyone's
// team_preference and social_with answers. lib/game/teams.ts decides the
// pairing; this file is the only place that writes teams/team_members.
//
// Renaming ("japlan we're team sigmas") is a separate, later action, handled
// here too via handleTeamNameCommand, detected deterministically in
// lib/game/commands.ts and routed from lib/handlers/dispatch.ts the same way
// board-time and trip commands are.

import { getServiceClient } from "@/lib/db/client";
import { TRIP_COLS } from "@/lib/db/columns";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import { defaultTeamName, pairUpTeams, teamColorFor, type TeamCandidate } from "@/lib/game/teams";
import {
  notOnATeamLine,
  teamNameTakenLine,
  teamNameUnreadableLine,
  teamRenamedLine,
  teamsAnnounceLine,
} from "@/lib/game/copy";
import { sendText } from "@/lib/linq/send";

export type FormedTeam = { id: string; name: string; members: ParticipantRow[] };

// Called once, when a group trip activates (everyone surveyed, setup done).
// A no-op if nobody opted into a team, or if teams already exist for this
// trip (activation can be re-entered; see maybeActivateTrip's own guard, but
// this stays defensive against being called twice regardless).
export async function formTeamsForTrip(
  trip: TripRow,
  people: ParticipantRow[],
): Promise<FormedTeam[]> {
  const { data: existing, error: existingErr } = await getServiceClient()
    .from("teams")
    .select("id")
    .eq("trip_id", trip.id);
  if (existingErr) throw existingErr;
  if ((existing ?? []).length > 0) return [];

  const candidates: TeamCandidate[] = people.map((p) => {
    const answers = (p.survey_json ?? {}) as SurveyAnswers;
    return {
      id: p.id,
      display_name: p.display_name,
      wantsTeam: answerValue(answers, "team_preference") === "team",
      socialWith: answerValue(answers, "social_with") ?? null,
    };
  });
  const { pairs } = pairUpTeams(candidates);
  if (pairs.length === 0) return [];

  const byId = new Map(people.map((p) => [p.id, p]));
  const formed: FormedTeam[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const memberIds = pairs[i];
    const { data: teamRow, error: teamErr } = await getServiceClient()
      .from("teams")
      .insert({
        trip_id: trip.id,
        name: defaultTeamName(i),
        color: teamColorFor(i),
        formed_at: new Date().toISOString(),
      })
      .select("id, name")
      .maybeSingle();
    if (teamErr) throw teamErr;
    if (!teamRow) throw new Error("team insert returned no row");
    const team = teamRow as { id: string; name: string };

    const { error: memberErr } = await getServiceClient()
      .from("team_members")
      .insert(memberIds.map((participant_id) => ({ team_id: team.id, participant_id })));
    if (memberErr) throw memberErr;

    formed.push({
      id: team.id,
      name: team.name,
      members: memberIds.map((id) => byId.get(id)!).filter(Boolean),
    });
  }
  console.info("[japlan.teams] formed from survey", {
    tripId: trip.id,
    teamCount: formed.length,
  });
  return formed;
}

export function teamsAnnouncement(teams: FormedTeam[]): string | null {
  if (teams.length === 0) return null;
  return teamsAnnounceLine(
    teams.map((t) => ({ name: t.name, members: t.members.map((m) => m.display_name) })),
  );
}

type ActiveTeamRow = { id: string; name: string };

async function teamsForTrip(tripId: string): Promise<ActiveTeamRow[]> {
  const { data, error } = await getServiceClient()
    .from("teams")
    .select("id, name")
    .eq("trip_id", tripId)
    // Trip-long pairings only. A conversational split (lib/game/split.ts)
    // writes day-bound teams to the same table; those never pool scores.
    .is("day", null)
    .is("dissolved_at", null);
  if (error) throw error;
  return (data ?? []) as ActiveTeamRow[];
}

// For the leaderboard (lib/game/standings.ts): every team on the trip, with
// its member ids, so a teamed person's row can show the combined score and
// nobody else's changes.
export async function teamsWithMembers(
  tripId: string,
): Promise<{ name: string; memberIds: string[] }[]> {
  const teams = await teamsForTrip(tripId);
  if (teams.length === 0) return [];
  const { data, error } = await getServiceClient()
    .from("team_members")
    .select("team_id, participant_id")
    .in("team_id", teams.map((t) => t.id));
  if (error) throw error;
  const rows = (data ?? []) as { team_id: string; participant_id: string }[];
  return teams.map((team) => ({
    name: team.name,
    memberIds: rows.filter((r) => r.team_id === team.id).map((r) => r.participant_id),
  }));
}

async function teamFor(tripId: string, participantId: string): Promise<ActiveTeamRow | null> {
  const teams = await teamsForTrip(tripId);
  if (teams.length === 0) return null;
  const { data, error } = await getServiceClient()
    .from("team_members")
    .select("team_id")
    .eq("participant_id", participantId)
    .in("team_id", teams.map((t) => t.id));
  if (error) throw error;
  const teamId = (data ?? [])[0] as { team_id: string } | undefined;
  if (!teamId) return null;
  return teams.find((t) => t.id === teamId.team_id) ?? null;
}

async function findParticipantOnTrip(
  tripId: string,
  phone: string,
): Promise<ParticipantRow | null> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select("id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at")
    .eq("trip_id", tripId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as ParticipantRow) : null;
}

// Deliberately not imported from bootstrap.ts: bootstrap.ts calls into this
// file (formTeamsForTrip) at activation, so importing back from it here would
// be a cycle. This is the same open-trip-for-chat query, kept small.
async function getTripByChatId(chatId: string): Promise<TripRow | null> {
  const { data, error } = await getServiceClient()
    .from("trips")
    .select(TRIP_COLS)
    .eq("linq_chat_id", chatId)
    .neq("state", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as TripRow) : null;
}

// "japlan we're team sigmas": rename the sender's team. A no-op reply (not a
// throw) for every real-world failure: no trip, no team, unreadable name, a
// name someone else already has.
export async function handleTeamNameCommand(opts: {
  chatId: string;
  phone: string | null;
  name: string | null;
  send?: (chatId: string, text: string) => Promise<{ messageId: string }>;
}): Promise<void> {
  const send = opts.send ?? sendText;
  const trip = await getTripByChatId(opts.chatId);
  if (!trip) {
    await send(opts.chatId, notOnATeamLine());
    return;
  }
  if (opts.name === null) {
    await send(trip.linq_chat_id, teamNameUnreadableLine());
    return;
  }
  const participant = opts.phone ? await findParticipantOnTrip(trip.id, opts.phone) : null;
  if (!participant) {
    await send(trip.linq_chat_id, notOnATeamLine());
    return;
  }
  const team = await teamFor(trip.id, participant.id);
  if (!team) {
    await send(trip.linq_chat_id, notOnATeamLine());
    return;
  }
  const others = await teamsForTrip(trip.id);
  const taken = others.some(
    (t) => t.id !== team.id && t.name.trim().toLowerCase() === opts.name!.trim().toLowerCase(),
  );
  if (taken) {
    await send(trip.linq_chat_id, teamNameTakenLine(opts.name));
    return;
  }
  const { error } = await getServiceClient()
    .from("teams")
    .update({ name: opts.name })
    .eq("id", team.id);
  if (error) throw error;
  console.info("[japlan.teams] renamed", { tripId: trip.id, teamId: team.id, name: opts.name });
  await send(trip.linq_chat_id, teamRenamedLine(opts.name));
}
