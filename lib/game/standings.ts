// Leaderboard rows, mixed: someone on a team shows their team's combined
// score once (never a duplicate row per member); someone who chose to play
// solo (survey team_preference != "team", or never paired) shows their own.
// participants.score stays authoritative and per-person either way (see
// docs/PLAN.md "Who holds the score"); this only decides what a row reads.

export type ScoredPerson = { id: string; display_name: string; score: number };
export type ScoringTeam = { name: string; memberIds: string[] };

export type StandingsRow = { display_name: string; score: number };

export function buildStandingsRows(
  people: ScoredPerson[],
  teams: ScoringTeam[],
): StandingsRow[] {
  const teamed = new Set(teams.flatMap((t) => t.memberIds));
  const rows: StandingsRow[] = [];
  for (const team of teams) {
    const total = people
      .filter((p) => team.memberIds.includes(p.id))
      .reduce((sum, p) => sum + p.score, 0);
    rows.push({ display_name: team.name, score: total });
  }
  for (const person of people) {
    if (teamed.has(person.id)) continue;
    rows.push({ display_name: person.display_name, score: person.score });
  }
  return rows;
}
