import { clockLabel } from "./time";

export const GROUP_INTRO =
  "heyyyy i'm japlan 🔥 i turn this trip into a whole points game: every morning u each get a few tasks and doing them scores points, no cap. sliding into everyone's dms rn with a few quick questions. i read this chat to catch claims but i only clap back when someone says japlan, sends a task code, or dms me 🫡";

// Kept for tests and older callers; setupCompleteLine carries the next board.
export const SETUP_COMPLETE =
  "we're live 🔥 every morning your tasks land in your dms, and a code like A1 claims one.";

export function setupCompleteLine(nextBoard: string | null): string {
  return nextBoard ? `${SETUP_COMPLETE} first board drops ${nextBoard}.` : SETUP_COMPLETE;
}

export const SURVEY_DONE_DM = "done. you're less mysterious than you think.";

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
    ? `got it: ${display}.`
    : `got it: ${display}. couldn't pin it on a map though, so times run on utc for now.`;
}

export function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}

export function datesSetLine(start: string, end: string): string {
  return start === end
    ? `locked in: ${formatShortDate(start)}.`
    : `locked in: ${formatShortDate(start)} to ${formatShortDate(end)}.`;
}

export function difficultySetLine(difficulty: string): string {
  return `${difficulty}, noted.`;
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
    ? `${label} is over, and you already cleared your part of it.`
    : `${label} is over, so there's no board to make for it now.`;
}

// REAL (anti-abuse): endless regeneration of one day.
export function refillLimitLine(label: string, count: number): string {
  return `that's ${count} refills for ${label} already, plenty for one day. next day's board is yours whenever.`;
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
  "this ends the trip and the scores are final. send 'japlan end trip confirm' if you mean it.";

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

// A place someone in the group asked for, on the day's route. Credit is the
// point: people need to see their idea survive.
export function boardAnchorLine(name: string, by: string | null, slot?: string | null): string {
  const line = `+ ${name}${by ? ` (${by}'s pick)` : ""}`;
  return slot ? `${boardSlotLabel(slot)}${line}` : line;
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

· every morning your board lands in your dm, one plan for the group
· send the code (like A1) to claim one
· send a photo after and u get bonus points
· did something cool i didn't even ask for? just tell me, i'll score it
· on a team? "japlan we're team <name>" names urselves
· "japlan lb" or "japlan standings" for the leaderboard
· "japlan settings" to see or change anything you told me
· "japlan chill" if i'm being too much lol

that's it. now go do something unhinged.`,
  dm: `ok here's the whole deal 📋

· every morning you get a board that fits your day. want more? just ask
· send the code (like A1) to claim one
· send a photo after and u get bonus points
· did something cool i didn't even ask for? just tell me, i'll score it
· "japlan lb" or "japlan standings" for the leaderboard
· "japlan settings" to see or change anything you told me
· "japlan chill" if i'm being too much lol

that's it. now go do something unhinged.`,
} as const;

export function helpText(isDm: boolean): string {
  return isDm ? HELP_TEXT.dm : HELP_TEXT.group;
}

export const CONVERSATION_SYSTEM_PROMPT = `you are japlan, the trip's group-chat game and planning bot. be relaxed and direct, like a person texting, without performing a character.

voice: lowercase always, no exceptions (use emoji or a stretched letter for emphasis, never caps). contractions always. casual, like a real text, not a performance of one: a little slang fits naturally here and there (fr, ngl, lowkey, no cap, lol, bet), but don't cram it into every line, and don't reach for the same word twice in a row. vary your openers and sentence shape from message to message so you don't fall into a pattern. emoji are a light touch, not a requirement: most replies want zero or one, never a row of them, and don't reuse the same one every time.

length is not fixed, it depends on the message. reacting to something funny can be three words. a real question deserves a real answer. explaining or handing someone something worth detail can run a few sentences. read the message in front of you instead of defaulting to one length.

answer the message in front of you. if someone asks a genuine question, especially something concrete like "where's good ramen near here" or "what's a good teriyaki spot in tokyo", give a useful, specific answer rather than a shrug. for a greeting, test, joke, or simple personal question, respond to that message briefly if a reply feels natural. if asked whether you're AI, ChatGPT, Claude, or a robot, answer honestly and directly: "i'm japlan, an ai trip bot." don't joke-deny being a robot. don't turn casual chat into a planning prompt: avoid generic follow-ups like "what are we getting into today?" unless they asked what to do next. don't pad a reply with an acknowledgement, question, or game reminder just to keep the conversation going. don't lecture, never say let's get back to the game, and never sound like a corporate assistant ("i'd be happy to help" is banned forever).

you do not enforce rules:
- if something is not possible, the tools will fail and you report that. never tell someone they cannot do something because of a rule you believe exists.
- preferences, pace, difficulty, interests, task count and every other setting are editable at any time by the person they belong to. settings are defaults, not limits: pace sets how full a day is by default, never a maximum.
- if you are unsure whether something is allowed, try it. a failed tool call is better than a wrong refusal.
- when someone asks for something a tool can do, call the tool. do not apologise instead.

facts come only from tools:
- never state anything about the score, the tasks, the schedule, a place or a person that you did not read from a tool call in this turn. scores: get_standings. tasks, codes and the day's plan: get_open_tasks.
- what you know about the sender: get_my_profile, in this turn. without it you have not read their profile, so never claim to know nothing about them.
- never recall a number, a task code or a plan from the recent chat. that is where invented facts come from. if you need it, call the tool.
- the recent chat is for following the conversation, not a source of facts. if a tool did not give it to you, don't say it.

tools:
- get_standings: call this before stating anyone's score. never recall a score from memory or from the prompt.
- get_open_tasks: existing tasks plus the board state. describe tasks from this list, do not make up a task yourself. if they want more or different tasks, call request_tasks. if there are no open tasks, "japlan plans" makes today's board right now, or say when next_board lands. never promise a board time it did not give you.
- request_tasks: they want more tasks, or a number of them ("7 attractions", "a packed day"). code adds as many as fit and replies.
- update_my_setting: they want to change any of their own settings (pace, tasks per day, strangers, interests, budget, diet, anything). code saves it and replies.
- update_trip_setting: destination, dates, difficulty, board time, stake. code handles who can.
- redo_today: they want a DIFFERENT board ("different tasks", "these are boring", "something else", "new ones", "redo today"), or say yes to a redo after a settings change. claimed tasks stay, the rest is replaced with new ones. never answer a request for a different board by describing or resending the current one.
- propose_freeform_claim: call only when they clearly say they already completed an activity that is not on the board. Never call for a future plan, intention, or activity still in progress; the server checks the original message and scores it.
- request_photo_bonus: a photo might add bonus to a recent claim.
- record_split: the group says it is splitting up (who is going where, who is sleeping in, splitting after lunch). code works out who is where, re-plans their day and sends the reply.
- record_regroup: the group says it is back together.
- add_suggestion: someone names a place or thing they want to do. code puts it on a day and sends the reply.
- avoid_category: the group does not want a kind of thing (temples, museums). code sends the reply.
- get_my_profile: the sender's own survey summary. in a group, code sends it to their dm. only ever for the sender: asked about someone else, say that's between them and you.
- react_to_message: tapback their message with an emoji instead of, or alongside, texting back. good for something funny or hype-worthy, not a default, and not on every message.
- no_action: ordinary chat that needs no game action.

hard rules:
- never a point value: do not award, set, or return one. scoring is code's job.
- never reveal another person's survey answers (budget, diet, allergies, who they wanted to be with). that stays in dm.
- unsafe, illegal, or permanent-harm ideas: refuse in character, one line.
- a reply is optional when you have nothing useful to add. don't invent filler to keep the chat moving.

next steps:
- only when they seem to be looking for something to do ("what now", "bored", "anything nearby"), end with one short clause naming something specific: an open code from get_open_tasks, the score gap from get_standings, or a named nearby place. same message.
- otherwise add no suggestion. never generic encouragement, never "let me know if you need anything".`;

export const CONVERSATION_FALLBACK = "yeah?";

// "japlan what do you know about me": their profile, in their DM only.
export function profileLine(profile: string | null): string {
  if (!profile) return "i don't know much about your preferences yet. answer a few trip questions and i'll get a better read.";
  return `here's what i've learned about you so far:\n${profile}\nif something's off, tell me what you'd change.`;
}

export const PROFILE_IN_DM_LINE = "that's in your dm.";

// Asked what the bot knows, before finishing the questions: say so, and
// offer the next one right here.
export function profileUnfinishedLine(nextQuestion: string): string {
  return `you haven't finished the quick questions yet, so i only know the basics. want to keep going? next one: ${nextQuestion}`;
}

// A stated preference, confirmed: "got it, more museums."
export function preferenceNotedLine(what: string, more: boolean, offerRedo: boolean): string {
  return `got it, ${more ? "more" : "less"} ${what}.${offerRedo ? " want me to redo today's board?" : ""}`;
}

// "japlan chill": about three words, then quiet until mentioned.
export const STOP_LINE = "ok, going quiet.";

// Sidequests: DM out, group announce in. Optional, never chased.
export function sidequestOfferLine(title: string, points: number, fuseMinutes: number): string {
  return `sidequest, ${fuseMinutes} min: ${title}. worth ${points}. reply done when you have, or pass. ignoring it costs nothing, and "japlan no sidequests" turns them off.`;
}

export function sidequestWonLine(points: number, bonus: number, total: number): string {
  return `✅ sidequest done · +${points}${bonus > 0 ? ` (+${bonus} photo)` : ""} · ${total}`;
}

export function sidequestWinnerGroupLine(name: string, title: string, points: number): string {
  return `sidequest: ${title}. ${name} got it first, +${points}.`;
}

export const SIDEQUEST_CAPPED_LINE = "✅ sidequest done, but you're at today's points cap, so it's for glory only.";
export const SIDEQUEST_BEATEN_LINE = "someone got to that one first. no harm done.";
export const SIDEQUEST_EXPIRED_LINE = "that one ran out. no harm done.";
export const SIDEQUEST_PASSED_LINE = "no worries.";
export const SIDEQUESTS_OFF_LINE = `sidequests off for you. "japlan sidequests on" brings them back.`;
export const SIDEQUESTS_ON_LINE = "sidequests back on.";
export const SIDEQUESTS_ON_CIVILIZED_LINE = "sidequests back on, the civilized ones.";

// Nobody has finished the questions yet, at board time: said once.
export function waitingOnSurveysLine(names: string[]): string {
  const list = names.length <= 1 ? (names[0] ?? "everyone") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `boards start as soon as someone finishes the quick questions in their dm. waiting on ${list}.`;
}

// Finished the survey on a day that is already under way: their board now.
export function lateFinisherLine(board: string): string {
  return `${SURVEY_DONE_DM} you're in. here's today:

${board}`;
}

// A reply that failed the checks (untrue, unrelated, empty): this instead.
export const DISCARD_FALLBACK = "lost the thread for a sec. say that again?";

export const CONVERSATION_PRIVACY_LINE = "that one's between them and me.";

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

// Splits and regrouping. Names are the group's own display names; why anyone
// was placed where (a couple's survey answer) is never said.
export function splitNotedLine(opts: {
  groups: { names: string; area: string | null; from: number | null }[];
  rejoinAt: number | null;
  rejoinPlace: string | null;
  dayLabel: string | null;
  replanned: boolean;
  ask: string | null;
}): string {
  const groups = opts.groups
    .map((g) => `${g.names}${g.area ? ` on ${g.area}` : ""}${g.from !== null ? ` from ${clockLabel(g.from)}` : ""}`)
    .join(", ");
  const rejoin =
    opts.rejoinAt !== null
      ? ` back together at ${clockLabel(opts.rejoinAt)}${opts.rejoinPlace ? ` near ${opts.rejoinPlace}` : ""}.`
      : "";
  const when = opts.dayLabel ? ` for ${opts.dayLabel}` : "";
  const boards = opts.replanned ? " new boards are in your dms." : "";
  const head = `split noted${when}: ${groups}.${rejoin}${boards}`;
  return opts.ask ? `${head} ${opts.ask}` : head;
}

// Only about the people nobody could place. Never a registration step.
export function splitAskLine(opts: { unplaced: string[]; unresolved: string[]; areas: string[] }): string {
  const choice = opts.areas.length > 1 ? `${opts.areas.slice(0, -1).join(", ")} or ${opts.areas.at(-1)}` : opts.areas[0];
  const parts: string[] = [];
  if (opts.unresolved.length > 0) parts.push(`who's ${opts.unresolved.map((u) => `"${u}"`).join(" and ")}?`);
  if (opts.unplaced.length > 0) {
    const who = opts.unplaced.length === 1 ? opts.unplaced[0] : `${opts.unplaced.slice(0, -1).join(", ")} and ${opts.unplaced.at(-1)}`;
    parts.push(choice ? `where's ${who}: ${choice}?` : `where's ${who} going?`);
  }
  return parts.join(" ");
}

export function regroupLine(replanned: boolean): string {
  if (!replanned) return "noted, everyone's together.";
  return "back together. one plan again, new boards are in your dms.";
}

// A place someone asked for, and where it landed.
export function suggestionLine(opts: {
  name: string;
  duplicate: boolean;
  fit:
    | { kind: "near"; day: number; area: string | null }
    | { kind: "open_day"; day: number }
    | { kind: "asked_day"; day: number }
    | { kind: "no_fit"; bestDay: number | null }
    | { kind: "no_location" };
}): string {
  const { name, fit } = opts;
  const already = opts.duplicate ? `${name} was already on the list. ` : "";
  switch (fit.kind) {
    case "near":
      return `${already}added ${name} to day ${fit.day}, it's near the rest of that day${fit.area ? ` (${fit.area})` : ""}.`;
    case "open_day":
      return `${already}added ${name} to day ${fit.day}, that day gets planned around it.`;
    case "asked_day":
      return `${already}added ${name} to day ${fit.day}.`;
    case "no_fit":
      return fit.bestDay
        ? `${already}${name} is across town from every day so far. it'd work best on day ${fit.bestDay}: say "japlan put ${name} on day ${fit.bestDay}" and it's in.`
        : `${already}noted ${name}, it's on the ideas list.`;
    case "no_location":
      return `${already}noted ${name}. couldn't pin it on a map, so it's on the ideas list and boards will work it in.`;
  }
}

export function avoidNotedLine(what: string, understood: boolean): string {
  return understood ? `noted, fewer ${what} from here on.` : `noted, i'll steer away from ${what}.`;
}

// PLAN's 18+ gate for v1.
export const UNDER_AGE_LINE = "japlan is 18+ for now, so there won't be tasks for you on this trip. sorry.";

// Settings: everyone's own answers are editable any time, in plain words.
export function settingChangedLine(label: string, shown: string, offerRedo: boolean): string {
  return `${label} is now ${shown}.${offerRedo ? " want me to redo today's board?" : ""}`;
}

export function settingUnclearLine(label: string, options: string[]): string {
  return options.length
    ? `didn't catch the new ${label}. say ${options.join(" / ")}.`
    : `didn't catch the new ${label}. say it another way?`;
}

export const SETTING_UNKNOWN_LINE = `which setting? "japlan settings" lists them all.`;

export const SETTING_IN_DM_LINE = "done, details are in your dm.";

export function settingsListLine(lines: string[]): string {
  return `your settings:\n${lines.map((l) => `· ${l}`).join("\n")}\nchange any by saying it, like "japlan pace faster", "japlan budget 150" or "japlan i'm into museums now".`;
}

export const SETTINGS_IN_DM_LINE = "your settings are in your dm.";

export function resurveyStartLine(prompt: string): string {
  return `starting over, one question at a time. skip keeps what you said before. ${prompt}`;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

// A task count someone asked for: what they got, and the real tradeoff.
// Fewer only when the day genuinely has no more room, and it says so.
export function tasksRequestedLine(opts: {
  want: number;
  got: number;
  minutesLeft: number;
  board: string;
}): string {
  const head =
    opts.got >= opts.want
      ? opts.minutesLeft < 90
        ? `${numberWord(opts.want)} it is. that's a full day, you'll be moving.`
        : `${numberWord(opts.want)} it is.`
      : `${numberWord(opts.got)} is what fits in what's left of today, so that's ${numberWord(opts.got)}. ask for tomorrow if you want more.`;
  return `${head}\n${opts.board}`;
}

export const EVERYONE_REDONE_LINE = "redone for everyone, new boards are in your dms.";

// "Give me a different board": say what changed, never resend silently.
export function redoSwappedLine(opts: { replaced: number; added: number; keptCodes: string[]; board: string }): string {
  const kept = opts.keptCodes.length
    ? `, kept ${opts.keptCodes.join(", ")} since you claimed ${opts.keptCodes.length === 1 ? "it" : "them"}`
    : "";
  return `fresh board: ${opts.replaced} out, ${opts.added} new${kept}.
${opts.board}`;
}

export function redoAllClaimedLine(label: string): string {
  return `every task on ${label === "today" ? "today's" : `${label}'s`} board is already claimed, so there's nothing left to swap. want more on top? say how many.`;
}

export function redoLimitLine(label: string, count: number): string {
  return `that's ${count} redos of ${label} already, so this one stays as it is. next day's board is fresh.`;
}

export const REDO_NO_BOARD_LINE = `no board to swap for that day yet. "japlan plans" makes one.`;
export const REDO_FAILED_LINE = "couldn't make a different one rn, that's on me. your old board is still there.";
export const REDO_PAST_DAY_LINE = "that day's done, so its board stays as it was.";
