import { describe, expect, it } from "vitest";
import {
  defaultTeamName,
  pairUpTeams,
  teamColorFor,
  TEAM_COLORS,
  type TeamCandidate,
} from "./teams";

function candidate(
  id: string,
  display_name: string,
  wantsTeam: boolean,
  socialWith: string | null = null,
): TeamCandidate {
  return { id, display_name, wantsTeam, socialWith };
}

function pairsOf(result: { pairs: string[][] }): Set<string>[] {
  return result.pairs.map((pair) => new Set(pair));
}

describe("pairUpTeams", () => {
  it("pairs a clean group of 4 who all opted in with no preferences", () => {
    const people = [
      candidate("alice", "Alice", true),
      candidate("bob", "Bob", true),
      candidate("carol", "Carol", true),
      candidate("dave", "Dave", true),
    ];
    const result = pairUpTeams(people);
    expect(result.pairs).toHaveLength(2);
    // Every wanting person appears in exactly one pair.
    const flat = result.pairs.flat();
    expect(new Set(flat)).toEqual(new Set(["alice", "bob", "carol", "dave"]));
  });

  it("leaves solo-preference people out entirely", () => {
    const people = [
      candidate("alice", "Alice", true),
      candidate("bob", "Bob", true),
      candidate("carol", "Carol", false),
      candidate("dave", "Dave", false),
    ];
    const result = pairUpTeams(people);
    expect(result.pairs).toEqual([["alice", "bob"]]);
  });

  it("prefers a mutual social_with match over an arbitrary pairing", () => {
    const people = [
      candidate("alice", "Alice", true, "bob"),
      candidate("bob", "Bob", true, "Alice"),
      candidate("carol", "Carol", true, "dave"),
      candidate("dave", "Dave", true, "Carol"),
    ];
    const result = pairUpTeams(people);
    expect(pairsOf(result)).toEqual([
      new Set(["alice", "bob"]),
      new Set(["carol", "dave"]),
    ]);
  });

  it("resolves a one-directional preference when the mutual match isn't there", () => {
    // Alice wants Carol, but Carol wants nobody in particular; Bob and Dave
    // have no preference either. Alice+Carol should still form.
    const people = [
      candidate("alice", "Alice", true, "carol"),
      candidate("bob", "Bob", true),
      candidate("carol", "Carol", true),
      candidate("dave", "Dave", true),
    ];
    const result = pairUpTeams(people);
    const hasAliceCarol = result.pairs.some(
      (pair) => new Set(pair).has("alice") && new Set(pair).has("carol"),
    );
    expect(hasAliceCarol).toBe(true);
    expect(result.pairs).toHaveLength(2);
  });

  it("leaves an odd one out unpaired rather than forcing a trio", () => {
    const people = [
      candidate("alice", "Alice", true),
      candidate("bob", "Bob", true),
      candidate("carol", "Carol", true),
    ];
    const result = pairUpTeams(people);
    expect(result.pairs).toHaveLength(1);
    const paired = new Set(result.pairs[0]);
    expect(paired.size).toBe(2);
    const unpaired = ["alice", "bob", "carol"].filter((id) => !paired.has(id));
    expect(unpaired).toHaveLength(1);
  });

  it("returns no pairs when nobody wants a team", () => {
    const people = [candidate("alice", "Alice", false), candidate("bob", "Bob", false)];
    expect(pairUpTeams(people).pairs).toEqual([]);
  });

  it("is case-insensitive and substring-tolerant when matching social_with", () => {
    const people = [
      candidate("alice", "Alice", true, "def want to be with BOB!!"),
      candidate("bob", "Bob", true, "alice for sure"),
    ];
    const result = pairUpTeams(people);
    expect(pairsOf(result)).toEqual([new Set(["alice", "bob"])]);
  });
});

describe("defaultTeamName", () => {
  it("is 1-indexed", () => {
    expect(defaultTeamName(0)).toBe("team 1");
    expect(defaultTeamName(1)).toBe("team 2");
  });
});

describe("teamColorFor", () => {
  it("cycles through the palette by index", () => {
    expect(teamColorFor(0)).toBe(TEAM_COLORS[0]);
    expect(teamColorFor(TEAM_COLORS.length)).toBe(TEAM_COLORS[0]);
  });
});
