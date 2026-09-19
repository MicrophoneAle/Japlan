// Survey-driven team pairing: decided once, at trip activation, from
// everyone's team_preference and social_with answers. Pure (no network
// calls); lib/handlers/teams.ts owns the actual reads/writes.
//
// Teams here are permanent for the trip (not the ad hoc, time-boxed splits
// docs/PLAN.md describes elsewhere) - a simpler model the group opted into
// during the survey. A team's combined score only ever adds up its members'
// individual scores (lib/game/standings.ts); participants.score stays the
// one authoritative number per person.

export type TeamCandidate = {
  id: string;
  display_name: string;
  wantsTeam: boolean;
  // Free-text survey answer: who they'd like to end up with.
  socialWith: string | null;
};

export type TeamPairing = {
  // One array of participant ids per team, always length 2.
  pairs: string[][];
};

function mentions(text: string | null, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!text || !needle) return false;
  return text.toLowerCase().includes(needle);
}

// Pairs everyone who opted into a team, preferring a mutual "who do you want
// to end up with" match, then a one-directional match, then whoever's left
// in input order. An odd one out plays individually rather than being forced
// into a trio: the "of 2" in the spec is a promise, not a best-effort.
export function pairUpTeams(people: TeamCandidate[]): TeamPairing {
  const wanting = people.filter((p) => p.wantsTeam);
  const unpaired = new Set(wanting.map((p) => p.id));
  const pairs: string[][] = [];

  function pair(a: string, b: string): void {
    pairs.push([a, b]);
    unpaired.delete(a);
    unpaired.delete(b);
  }

  for (const person of wanting) {
    if (!unpaired.has(person.id)) continue;
    const mutual = wanting.find(
      (other) =>
        other.id !== person.id &&
        unpaired.has(other.id) &&
        mentions(person.socialWith, other.display_name) &&
        mentions(other.socialWith, person.display_name),
    );
    if (mutual) pair(person.id, mutual.id);
  }

  for (const person of wanting) {
    if (!unpaired.has(person.id)) continue;
    const requested = wanting.find(
      (other) =>
        other.id !== person.id &&
        unpaired.has(other.id) &&
        mentions(person.socialWith, other.display_name),
    );
    if (requested) pair(person.id, requested.id);
  }

  const rest = wanting.filter((p) => unpaired.has(p.id));
  for (let i = 0; i + 1 < rest.length; i += 2) {
    pair(rest[i].id, rest[i + 1].id);
  }

  return { pairs };
}

export const TEAM_COLORS = ["red", "blue", "green", "purple", "orange", "teal"];

export function teamColorFor(index: number): string {
  return TEAM_COLORS[index % TEAM_COLORS.length];
}

// The placeholder name a team carries until it renames itself
// ("japlan we're team <name>"), 1-indexed to match how people count teams.
export function defaultTeamName(index: number): string {
  return `team ${index + 1}`;
}
