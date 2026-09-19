export const GROUP_INTRO =
  "heyyyy i'm japlan 🔥 i turn this trip into a whole points game: every morning u each get a few tasks and doing them scores points, no cap. sliding into everyone's dms rn with a few quick questions. i read this chat to catch claims but i only clap back when someone says japlan, sends a task code, or dms me 🫡";

// Kept for tests and older callers; setupCompleteLine carries the next board.
export const SETUP_COMPLETE =
  "we're live 🔥 every morning your tasks land in your dms, and a code like A1 claims one.";

export function setupCompleteLine(nextBoard: string | null): string {
  return nextBoard ? `${SETUP_COMPLETE} first board drops ${nextBoard}.` : SETUP_COMPLETE;
}

export const SURVEY_DONE_DM = "ok that's everything, ily for that 🙏";

export function surveyReaskLine(options: string[]): string {
  return `didn't catch that lol. reply ${options.join(" / ")}, or skip.`;
}

// Organizer setup. Draft wording; edit freely.
export const SETUP_QUESTIONS = {
  destination: "ok where we headed? a city is plenty.",
  dates: `when's this happening? something like "march 14-19" or "next weekend" works.`,
  difficulty: "how unhinged should the tasks be? chill / normal / unhinged",
  stake: "real talk, what's the loser doing at the end of this 💀",
} as const;

const SETUP_REQUIRED = new Set(["destination", "dates"]);

export function setupPrompt(
  id: keyof typeof SETUP_QUESTIONS,
  current: string | null,
  opts: { first?: boolean; isSolo?: boolean } = {},
): string {
  // Solo trips skip the stake question (no loser), so three, not four.
  const lead = opts.first ? `trip setup, ${opts.isSolo ? 3 : 4} quick ones. ` : "";
  const tail = current
    ? ` (rn: ${current}. skip keeps it)`
    : SETUP_REQUIRED.has(id)
      ? " (skip and i'll ask again later)"
      : " (skip is fine)";
  return `${lead}${SETUP_QUESTIONS[id]}${tail}`;
}

export function destinationSetLine(display: string, resolved: boolean): string {
  return resolved
    ? `bet, locked in: ${display}.`
    : `bet, locked in: ${display}. couldn't pin it on a map tho, so times run on utc for now.`;
}

export function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}

export function datesSetLine(start: string, end: string): string {
  return start === end
    ? `bet, locked in: ${formatShortDate(start)}.`
    : `bet, locked in: ${formatShortDate(start)} to ${formatShortDate(end)}.`;
}

export function difficultySetLine(difficulty: string): string {
  return `bet, locked in: ${difficulty}.`;
}

export const STAKE_SET_LINE = "say less, noted.";

export function datesRetryLine(
  reason: "invalid" | "backwards" | "too_long" | "in_the_past" | "unclear",
): string {
  switch (reason) {
    case "backwards":
      return `bro that ends before it starts 💀 try again, like "oct 17-20".`;
    case "too_long":
      return "that's over three months, which is giving typo. send the dates again?";
    case "in_the_past":
      return "those dates already happened lol. try again.";
    default:
      return `couldn't read those dates. try something like "oct 17-20".`;
  }
}

export function setupFinishedLine(missing: ("destination" | "dates")[]): string {
  if (missing.length === 0) return "setup's done, we're so back.";
  const what = missing.length === 2 ? "where and when" : missing[0] === "destination" ? "where" : "when";
  return `setup's paused rq. still need ${what} before the game can start, i'll ask again next time you text.`;
}

// The survey's first question already introduces itself.
export function setupNowAboutYouLine(finished: string, surveyPrompt: string): string {
  return `${finished} ${surveyPrompt}`;
}

// Asking for a day's board. Any day of the trip can be shown or made on
// request; these are the few real reasons one cannot, in the person's terms.
export function boardRefillLine(board: string): string {
  return `u cleared that board 🫡 here's more.\n${board}`;
}

// A future day's board can be remade on its morning (unless something on it
// was claimed). People need the useful part only: it may change.
export const PROVISIONAL_TAG = "might still change";

export function provisionalBoard(board: string): string {
  return board.replace(/^Day (\d+)/, `Day $1, ${PROVISIONAL_TAG}`);
}

export const BOARD_IN_DM_LINE = "board's in your dms 📩";

// REAL: the day is outside the trip.
export function dayNotInTripLine(start: string, end: string): string {
  return `that day isn't part of this trip lol. it runs ${start} to ${end}.`;
}

// REAL: nothing new is made for a day that's over (it could be claimed
// without having been done).
export function pastDayNoBoardLine(label: string, cleared: boolean): string {
  return cleared
    ? `${label} is over, and u already cleared your part of it. certified.`
    : `${label} is over, so there's no board to make for it now.`;
}

// REAL (anti-abuse): endless regeneration of one day.
export function refillLimitLine(label: string, count: number): string {
  return `that's ${count} refills for ${label} already, that's plenty for one day lol. next day's board is yours whenever tho.`;
}

// REAL, for the asker only: their tasks need their allergies and limits.
export function finishYourSurveyLine(): string {
  return "your tasks drop once u answer your questions in the dm, so nothing clashes with your allergies or limits.";
}

// REAL: a board needs a place and dates.
export function waitingOnSetupLine(organizer: string | null): string {
  return organizer
    ? `boards need a destination and dates first, ${organizer}'s setting those rn.`
    : `boards need a destination and dates first: "japlan setup".`;
}

// Our failure, said as ours.
export const BOARD_MAKE_FAILED_LINE = "couldn't make that board rn, that's on me 😭 ask again in a minute.";

// "japlan board time 7am"
export function boardTimeSetLine(time: string): string {
  return `boards now land at ${time} every morning 🫡`;
}

export const BOARD_TIME_UNREADABLE_LINE = `couldn't read that time lol. try "japlan board time 7am" or "japlan board time 10:30".`;

export const SETUP_IN_DM_LINE = "setup questions are in your dms 📩";

export function onlyOrganizerLine(
  organizerName: string,
  action: "change the setup" | "end the trip" | "change the board time",
): string {
  return `only ${organizerName} can ${action}, that's the rule lol.`;
}

// Trip lifecycle.
export const END_TRIP_CONFIRM_LINE =
  "this ends the trip and the scores are FINAL final. send 'japlan end trip confirm' if u mean it";

export const NO_TRIP_RUNNING_LINE = `no trip running here rn. "japlan new trip" starts one.`;

export const TRIP_ALREADY_RUNNING_LINE = `there's already a trip running lol. "japlan end trip" first.`;

export const TRIP_OVER_LINE = `this trip's over. "japlan new trip" starts another one.`;

export const NEW_TRIP_DM_LINE = `new trips start in a group chat. add me to one and say "japlan new trip".`;

export function finalStandingsLine(opts: {
  standings: { name: string; score: number }[];
  losers: string[];
  stake: string | null;
  wrappedUrl: string | null;
}): string {
  const lines = [`it's over 😭 final: ${opts.standings.map((s) => `${s.name} ${s.score}`).join(" · ")}`];
  const stake = opts.stake?.trim();
  if (stake && opts.losers.length > 0) {
    const who =
      opts.losers.length === 1
        ? `${opts.losers[0]} is`
        : `${opts.losers.slice(0, -1).join(", ")} and ${opts.losers.at(-1)} are`;
    lines.push(`${who} on the hook, no takebacks: ${stake}`);
  }
  if (opts.wrappedUrl) lines.push(`the recap: ${opts.wrappedUrl}`);
  return lines.join("\n");
}

// "Day 3 · Asakusa → Ueno · 22° clear": the route and the weather when known.
export function dailyBoardHeader(
  day: number,
  weatherLine?: string | null,
  route?: string | null,
): string {
  return [`Day ${day}`, route, weatherLine].filter(Boolean).join(" · ");
}

export function boardRouteLabel(first: string, last: string): string {
  return first === last ? first : `${first} → ${last}`;
}

// Rough time of day, never clock times: nobody is actually on a schedule.
// Padded so the codes line up where the font allows.
export function boardSlotLabel(slot: string): string {
  return slot.padEnd(11);
}

// One line per task, tier before points so people can pick by effort:
//   A1 · find a bench in yoyogi park · light (13)
export function dailyBoardTaskLine(
  code: string,
  title: string,
  points: number,
  tier: string,
  slot?: string | null,
): string {
  const line = `${code} · ${title} · ${tier.toLowerCase()} (${points})`;
  return slot ? `${boardSlotLabel(slot)}${line}` : line;
}

export function standingsLine(
  rows: { display_name: string; score: number }[],
): string {
  return rows.map((row) => `${row.display_name} ${row.score}`).join(" · ");
}

// Next steps. A message that CLOSES something (an error, a refusal, a cleared
// board, the cap, a finished survey, a lapsed claim) ends with one clause
// naming something specific. Routine confirmations, photo bonuses, standings
// and the board itself never get one.

export function nextStepClause(openCodes: string[]): string {
  if (openCodes.length === 0) return "next board lands in the morning, hang tight.";
  if (openCodes.length === 1) return `${openCodes[0]} is still open btw.`;
  return `still open: ${openCodes.join(", ")}.`;
}

export const DAILY_CAP_CLAUSE =
  "that's your cap for today bestie, but it still counts for the recap 📈";

export function claimConfirmedLine(opts: {
  code: string;
  name: string;
  base: number;
  photoBonus: number;
  total: number;
  capped?: boolean;
  invitePhoto?: boolean;
  // The claimant's last open personal task; a refill is on its way by DM.
  boardCleared?: boolean;
}): string {
  if (opts.capped) {
    return `✅ ${opts.code} · ${opts.name} · ${opts.total} · ${DAILY_CAP_CLAUSE}`;
  }
  const first =
    opts.photoBonus > 0
      ? `✅ ${opts.code} · ${opts.name} +${opts.base} +${opts.photoBonus} photo · ${opts.total}`
      : `✅ ${opts.code} · ${opts.name} +${opts.base} · ${opts.total}`;
  if (opts.boardCleared) {
    return `${first} · that's your whole board cleared 🔥 new tasks coming by dm.`;
  }
  if (opts.invitePhoto && opts.photoBonus === 0) {
    return `${first}\nphoto for bonus points? 👀`;
  }
  return first;
}

export function photoBonusLine(opts: {
  code: string;
  bonus: number;
  total: number;
  capped?: boolean;
}): string {
  if (opts.capped) {
    return `📸 ${opts.code} · ${opts.total} · ${DAILY_CAP_CLAUSE}`;
  }
  return `📸 ${opts.code} · +${opts.bonus} bonus · ${opts.total}`;
}

export function alreadyClaimedLine(code: string, next?: string): string {
  return next ? `${code} already got claimed lol. ${next}` : `${code} already got claimed lol.`;
}

export function notYourTaskLine(code: string, next: string): string {
  return `${code} isn't on your board bestie. ${next}`;
}

export function unknownCodeLine(code: string, next: string): string {
  return `there's no ${code} lol, made that up? ${next}`;
}

export function teamTaskExpiredLine(code: string, next: string): string {
  return `${code} expired with the team, rip. ${next}`;
}

export function reusedPhotoLine(): string {
  return `bro that photo was already used 💀 a new shot still counts tho.`;
}

export function visionRejectedLine(code: string): string {
  return `that doesn't really look like ${code} ngl, so no photo bonus. a clearer shot still counts.`;
}

export function photoCheckFailedLine(code: string): string {
  return `couldn't check that photo for ${code}, my bad. send it again in a minute.`;
}

export function photoOutsideTripLine(code: string): string {
  return `that photo's from outside the trip so no bonus on ${code}, sry. a new shot still counts.`;
}

export function photoAlreadyBonusedLine(code: string, next: string): string {
  return `${code} already got its photo bonus. ${next}`;
}

// Our failure, said as ours: someone in the group chat could not be added
// to the trip (joining is automatic, so this only happens if that broke).
export function notOnTripLine(): string {
  return `couldn't add u to this trip rn, that's on me 😭 send that again in a minute.`;
}

// Our failure: the trip for this chat could not be set up.
export function tripNotReadyLine(): string {
  return `still setting this trip up, that's on me. send that again in a minute.`;
}

export function dmUnknownPersonLine(): string {
  return `i only know people from a trip group chat lol. add me to yours and say japlan.`;
}

export const DISPATCH_ERROR_LINE =
  "something broke on my end 😭 send that again in a minute.";

export function surveyDoneLine(waitingOn: number, setupPending = false): string {
  const waits: string[] = [];
  if (waitingOn > 0) waits.push(waitingOn === 1 ? "1 more person" : `${waitingOn} more people`);
  if (setupPending) waits.push("the trip setup");
  if (waits.length > 0) {
    return `${SURVEY_DONE_DM} waiting on ${waits.join(" and ")}, then your first board drops in the morning.`;
  }
  return `${SURVEY_DONE_DM} your first board drops in the morning.`;
}

export function peerLapsedLine(codes: string[]): string {
  const list = codes.join(", ");
  return codes.length === 1
    ? `${list} never got a 👍 so it lapsed, rip. it's open again if someone can confirm it.`
    : `${list} never got a 👍 so they lapsed, rip. they're open again if someone can confirm.`;
}

export function peerConfirmLine(opts: {
  name: string;
  code: string;
  title: string;
}): string {
  return `${opts.name} says they did ${opts.code} (${opts.title}) 👀\n👍 this if u believe them.`;
}

export function freeformPeerLine(opts: {
  name: string;
  title: string;
  code: string;
}): string {
  return `${opts.name} says they ${opts.title} 👀 ${opts.code}. 👍 if that's real.`;
}

export function freeformRejectedLine(next: string): string {
  return `nah can't count that one. ${next}`;
}

export function twoMatchAskLine(left: string, right: string): string {
  return `${left} or ${right}? pick one lol`;
}

// Trip activation, teams edition: one line per pair, plus how to rename.
export function teamsAnnounceLine(
  teams: { name: string; members: string[] }[],
): string {
  const rosters = teams
    .map((t) => `${t.name}: ${t.members.join(" + ")}`)
    .join("\n");
  return `${rosters}\nnot feeling the name? "japlan we're team <name>" fixes that.`;
}

export function teamRenamedLine(name: string): string {
  return `bet, ur ${name} now 🔥`;
}

export function teamNameTakenLine(name: string): string {
  return `${name}'s already someone's team name lol. try another.`;
}

export function notOnATeamLine(): string {
  return "u aren't on a team rn, so nothing to rename lol.";
}

export function teamNameUnreadableLine(): string {
  return `couldn't read a name in that. try "japlan we're team <name>".`;
}

export const HELP_TEXT = {
  group: `ok here's the whole deal 📋

· every morning the shared board drops
· send the code (like A1) to claim one
· send a photo after and u get bonus points
· did something cool i didn't even ask for? just tell me, i'll score it
· on a team? "japlan we're team <name>" names urselves
· "japlan lb" or "japlan standings" for the leaderboard
· "japlan chill" if i'm being too much lol

that's it. now go do something unhinged.`,
  dm: `ok here's the whole deal 📋

· every morning u get 3 personal tasks
· send the code (like A1) to claim one
· send a photo after and u get bonus points
· did something cool i didn't even ask for? just tell me, i'll score it
· "japlan lb" or "japlan standings" for the leaderboard
· "japlan chill" if i'm being too much lol

that's it. now go do something unhinged.`,
} as const;

export function helpText(isDm: boolean): string {
  return isDm ? HELP_TEXT.dm : HELP_TEXT.group;
}

export const CONVERSATION_SYSTEM_PROMPT = `you are japlan, the unhinged little sibling running this trip's group chat. think: the one friend who is always online, always has an opinion, and somehow also runs the point system.

voice: lowercase always, no exceptions, use emoji or letter stretching for emphasis instead of caps. contractions always. text like an actual gen z texter: lol, lmao, fr, fr fr, ngl, no cap, lowkey, deadass, say less, bet, istg, tbh. letter elongation when it's warranted (heyyyy, noooo, omggg). emoji constantly, not just decoration: 💀 😭 🔥 😂 🫡 👀 💯 🙏. exclamation marks are fine for real excitement, not every line. one message, never two. keep it punchy, not a wall of text, unless the moment genuinely calls for more.

you only talk when addressed. you are not a general chatbot. having an opinion is fine, encouraged even. do not refuse to engage, do not lecture, never say let's get back to the game, never sound like a corporate assistant ("i'd be happy to help" is banned forever).

tools:
- get_standings: call this before stating anyone's score. never recall a score from memory or from the prompt.
- get_open_tasks: only existing tasks, plus the board state. never invent one. if asked for a new task, point at an open one. if there are no open tasks, tell them "japlan plans" makes today's board right now, or say when next_board lands. never promise a board time it did not give you.
- propose_freeform_claim: they already did something you did not assign. return title and six axes (integers 1-5). never a point value. code will score it.
- request_photo_bonus: a photo might add bonus to a recent claim.
- react_to_message: tapback their message with an emoji instead of, or alongside, texting back. use this for something funny, unhinged, or hype-worthy, not on every message.
- no_action: when you just want to talk.

hard rules:
- never award, set, or return a point value. axes only. scoring is not your job.
- never reveal another person's survey answers (budget, diet, allergies, who they wanted to be with). that stays in dm.
- unsafe, illegal, or permanent-harm ideas: refuse in character, one line, still funny about it.
- if you have nothing useful, still say something short. silence is for messages that did not address you.

next steps:
- only when they seem to be looking for something to do ("what now", "bored", "anything nearby"), end with one short clause naming something specific: an open code from get_open_tasks, the score gap from get_standings, or a named nearby place. same message.
- otherwise add no suggestion. never generic encouragement, never "let me know if you need anything".`;

export const CONVERSATION_FALLBACK = "wait fr? 💀";

export const CONVERSATION_PRIVACY_LINE = "that's between them and me, sry not sry 🤐";

export function conversationRedirect(opts: {
  task?: { code: string } | null;
  nearby?: string | null;
  trailingName?: string | null;
}): string {
  if (opts.task?.code) return `${opts.task.code} is still open btw.`;
  if (opts.nearby) return `${opts.nearby} is literally right there.`;
  if (opts.trailingName) return `${opts.trailingName} is still out here hunting.`;
  return `the board's still there whenever.`;
}
