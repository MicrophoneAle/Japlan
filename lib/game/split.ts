import { answerValue, type SurveyAnswers } from "./survey";
export { clockLabel } from "./time";

// The group is one group until someone says otherwise. A split comes from
// conversation ("me and jess are doing shimokita, boys are going to
// akihabara", "i'm sleeping in, you guys go ahead", "we're splitting after
// lunch"): the model extracts who / where / when, and this file decides who
// is actually placed, what nobody could place, and each group's hours.

export type SplitGroupInput = {
  // Names as said: "me", "jess", "everyone else", "the boys".
  who: string[];
  where?: string | null;
  // "now", "11am", "after lunch", "late".
  starts?: string | null;
};

export type SplitInput = {
  groups: SplitGroupInput[];
  // When the split begins, for everyone ("after lunch").
  from?: string | null;
  rejoinTime?: string | null;
  rejoinPlace?: string | null;
};

export type SplitPerson = { id: string; display_name: string; answers: SurveyAnswers };

export type ResolvedGroup = {
  memberIds: string[];
  area: string | null;
  startsAt: number | null;
  // Words for people nobody could match ("the boys"): the bot asks.
  unresolved: string[];
};

export type ResolvedSplit = {
  groups: ResolvedGroup[];
  // Trip members in no group.
  unplaced: SplitPerson[];
  startsAt: number | null;
  rejoinAt: number | null;
  rejoinPlace: string | null;
};

const SELF = /^(me|i|myself|i'm|im)$/;
const REST = /^(everyone else|every one else|everybody else|the rest|the rest of us|rest of us|the rest of you|you guys|you all|y'?all|others|the others|everyone|everybody|all of you)$/;

function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
}

// A name as said, to a trip member: whole display name, first name, or a
// prefix of three letters or more ("jess" for Jessica). Ambiguous: nobody.
export function matchPerson(said: string, people: SplitPerson[]): SplitPerson | null {
  const want = norm(said);
  if (!want) return null;
  const first = (p: SplitPerson) => norm(p.display_name).split(" ")[0] ?? "";
  const exact = people.filter((p) => norm(p.display_name) === want || first(p) === want);
  if (exact.length === 1) return exact[0];
  if (want.length < 3) return null;
  const prefix = people.filter((p) => first(p).startsWith(want) || want.startsWith(first(p)) && first(p).length >= 3);
  return prefix.length === 1 ? prefix[0] : null;
}

// Loose times, to minutes after midnight. Unreadable: null.
export function parseLooseTime(text: string | null | undefined, nowMinutes: number): number | null {
  const t = norm(text ?? "");
  if (!t) return null;
  if (/^(now|right now|already|early|this morning|morning)$/.test(t)) return nowMinutes;
  if (/after lunch|this afternoon|afternoon/.test(t)) return 13 * 60 + 30;
  if (/lunch/.test(t)) return 12 * 60;
  if (/sleep|late|lie in|slow start/.test(t)) return 11 * 60 + 30;
  if (/after dinner|tonight|evening/.test(t)) return 19 * 60;
  if (/dinner/.test(t)) return 18 * 60 + 30;
  // From the raw text: normalising drops the colon in "10:30".
  const clock = (text ?? "").toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  if (clock[3] === "pm" && hour < 12) hour += 12;
  if (clock[3] === "am" && hour === 12) hour = 0;
  // "at 3" during the day means 3pm.
  if (!clock[3] && hour >= 1 && hour <= 7) hour += 12;
  return hour * 60 + minute;
}

// Couples who said "together" in their survey go with the person they named
// as who they want to be with, when that person is placed. Private: the bot
// never says why.
function placeCouples(groups: ResolvedGroup[], people: SplitPerson[]): void {
  const placed = new Set(groups.flatMap((g) => g.memberIds));
  for (const person of people) {
    if (placed.has(person.id)) continue;
    if (answerValue(person.answers, "social_couples") !== "together") continue;
    const withText = answerValue(person.answers, "social_with") ?? "";
    const partner = people.find(
      (p) => p.id !== person.id && placed.has(p.id) && norm(withText).split(" ").includes(norm(p.display_name).split(" ")[0]),
    );
    if (!partner) continue;
    groups.find((g) => g.memberIds.includes(partner.id))?.memberIds.push(person.id);
    placed.add(person.id);
  }
}

// Who is where, from what the model heard. "me" is the sender; "everyone
// else" is whoever no other group names; names match trip members; anything
// else (the boys) stays unresolved for the bot to ask about.
export function resolveSplit(input: SplitInput, people: SplitPerson[], senderId: string, nowMinutes: number): ResolvedSplit {
  const groups: ResolvedGroup[] = input.groups.map((g) => ({
    memberIds: [],
    area: g.where?.trim() || null,
    startsAt: parseLooseTime(g.starts, nowMinutes),
    unresolved: [],
  }));
  const restGroups: number[] = [];
  input.groups.forEach((g, i) => {
    for (const said of g.who) {
      const word = norm(said);
      if (SELF.test(word)) {
        groups[i].memberIds.push(senderId);
      } else if (REST.test(word)) {
        restGroups.push(i);
      } else {
        const person = matchPerson(said, people);
        if (person) groups[i].memberIds.push(person.id);
        else groups[i].unresolved.push(said);
      }
    }
  });
  // One person, one group: the first mention wins.
  const seen = new Set<string>();
  for (const g of groups) {
    g.memberIds = g.memberIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  }
  if (restGroups.length > 0) {
    const rest = people.filter((p) => !seen.has(p.id)).map((p) => p.id);
    groups[restGroups[0]].memberIds.push(...rest);
    rest.forEach((id) => seen.add(id));
  }
  placeCouples(groups, people);
  const placed = new Set(groups.flatMap((g) => g.memberIds));
  const startsAt = parseLooseTime(input.from, nowMinutes);
  for (const g of groups) if (g.startsAt === null && startsAt !== null) g.startsAt = startsAt;
  let rejoinAt = parseLooseTime(input.rejoinTime, nowMinutes);
  let rejoinPlace = input.rejoinPlace?.trim() || null;
  const starts = groups.map((g) => g.startsAt ?? nowMinutes);
  // Different start times and no stated meeting: that is a partial split,
  // converging later. They meet three hours after the late group starts, where
  // the late group is (else wherever the early group went).
  if (rejoinAt === null && new Set(starts).size > 1) {
    const late = Math.max(...starts);
    rejoinAt = Math.min(late + 180, 21 * 60);
    const lateGroup = groups[starts.indexOf(late)];
    rejoinPlace ??= lateGroup.area ?? groups.find((g) => g.area)?.area ?? null;
  }
  return {
    groups,
    unplaced: people.filter((p) => !placed.has(p.id)),
    startsAt,
    rejoinAt,
    rejoinPlace,
  };
}

// A day's teams, as stored.
export type DayTeam = {
  id: string;
  name: string;
  memberIds: string[];
  startsAt: number | null;
  rejoinAt: number | null;
  rejoinPlace: string | null;
  area: string | null;
};

// The groups a day's board is planned for. No split: everyone together, one
// plan. A split: each team its own window (its own start, ending where and
// when it rejoins), anyone not in a team together until the split ends, and
// everyone together again after the last rejoin, starting where they met.
export type DayGroup = {
  key: string;
  teamId: string | null;
  memberIds: string[];
  label: string;
  startAt: number | null;
  endAt: number | null;
  startNear: string | null;
  endNear: string | null;
  area: string | null;
};

export function dayGroups(peopleIds: string[], teams: DayTeam[]): DayGroup[] {
  const live = teams.filter((t) => t.memberIds.some((id) => peopleIds.includes(id)));
  if (live.length === 0) {
    return [
      { key: "together", teamId: null, memberIds: peopleIds, label: "everyone", startAt: null, endAt: null, startNear: null, endNear: null, area: null },
    ];
  }
  const out: DayGroup[] = live.map((t) => ({
    key: `team:${t.id}`,
    teamId: t.id,
    memberIds: t.memberIds.filter((id) => peopleIds.includes(id)),
    label: t.name,
    startAt: t.startsAt,
    endAt: t.rejoinAt,
    startNear: t.area,
    endNear: t.rejoinPlace,
    area: t.area,
  }));
  const inTeam = new Set(live.flatMap((t) => t.memberIds));
  const rejoins = live.map((t) => t.rejoinAt).filter((r): r is number => r !== null);
  const lastRejoin = rejoins.length === live.length ? Math.max(...rejoins) : null;
  const unteamed = peopleIds.filter((id) => !inTeam.has(id));
  if (unteamed.length > 0) {
    out.push({
      key: "together:before",
      teamId: null,
      memberIds: unteamed,
      label: "everyone else",
      startAt: null,
      endAt: lastRejoin,
      startNear: null,
      endNear: live.find((t) => t.rejoinAt === lastRejoin)?.rejoinPlace ?? null,
      area: null,
    });
  }
  if (lastRejoin !== null) {
    const meet = live.find((t) => t.rejoinAt === lastRejoin)?.rejoinPlace ?? null;
    out.push({
      key: "together:after",
      teamId: null,
      memberIds: peopleIds,
      label: "everyone, after regrouping",
      startAt: lastRejoin,
      endAt: null,
      startNear: meet,
      endNear: null,
      area: meet,
    });
  }
  return out;
}

export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
