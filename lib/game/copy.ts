import { clockLabel } from "./time";

export const GROUP_INTRO =
  "🗺️ i'm japlan.\ni turn your trip into daily tasks and points.\nclaim a task code when you do one; i'll post the leaderboard here.\n\n🧭 first, we set the city, dates, and play style in this chat.\nthen i'll DM each person a short private preference survey.\ni'll share who has finished, never their answers.\n\n👑 the organizer controls shared trip settings and makes the final call if the group gets stuck on an activity.\ni'll post shared choices here so everyone can vote; silence counts as abstaining.\nchange settings with “japlan setup.” personal preferences stay private.";

// Kept for tests and older callers; setupCompleteLine carries the next board.
export const SETUP_COMPLETE =
  "we're live 🔥\n\nevery morning your tasks land in your dms, and a code like A1 claims one.";

export function setupCompleteLine(nextBoard: string | null, mode?: string | null): string {
  const intro = mode === "full_group"
    ? "we're live 🔥\n\nthe shared daily board lands in this group chat; claim a code here when you do a task."
    : mode === "teams"
      ? "we're live 🔥\n\ndaily boards land in your dms.\ni'll pair people for the day when their interests overlap."
      : mode === "individual"
        ? "we're live 🔥\n\neveryone gets their own daily board in their dms, with separate tasks and points."
        : SETUP_COMPLETE;
  return nextBoard ? `${intro}\n\nfirst board drops ${nextBoard}.` : intro;
}

// A link to the live trip dashboard (/live/[tripId]): standings, active
// quests and proof, updating as the trip happens. Same "the recap: ..."
// pattern as finalStandingsLine's Wrapped link.
export function liveDashboardLine(url: string): string {
  return `watch it live: ${url}`;
}

// liveUrlFor has no APP_URL / Vercel production URL to build from (local dev,
// or a misconfigured deploy). Real, not a refusal: the dashboard exists, the
// link just cannot be built right now.
export const DASHBOARD_UNAVAILABLE_LINE = "no live link for this yet, my bad.";

export const SURVEY_DONE_DM = "saved 🔒 your private preference survey is complete.";

export function surveyReaskLine(options: string[]): string {
  return `didn't catch that lol. reply ${options.join(" / ")}, or skip.`;
}

// Organizer setup. Draft wording; edit freely.
export const SETUP_QUESTIONS = {
  destination: "ok where we headed? a city is plenty.",
  dates: `when's this happening? something like "march 14-19" or "next weekend" works.`,
  play_mode:
    "how should we play?\n1 · individual — everyone gets their own board and separate tasks\n2 · teams — each day i'll pair people whose task interests overlap; no match means solo tasks\n3 · full group — one shared board lands here; decisions happen in this chat, and the organizer breaks ties",
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
  const lead = opts.first ? `trip setup, ${opts.isSolo ? 3 : 5} quick ones. ` : "";
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
  return `setup's paused rq.\nstill need ${what} before the game can start, i'll ask again next time you text.`;
}

export function organizerOnlySetupLine(name: string): string {
  return `👑 ${name} is organizing this trip and controls the shared setup.\nthey can change it with “japlan setup.”\nyour personal survey answers stay private.`;
}

export function groupSetupPendingDmLine(name: string): string {
  return `👑 ${name} is setting the shared city, dates, and play style in the group chat first.\ni'll send your private preference survey once that's done.`;
}

export function groupSetupCompleteLine(opts: {
  destination: string | null;
  dates: string | null;
  mode: string;
  organizer: string;
}): string {
  return [
    "✅ shared trip setup is locked in:",
    `📍 ${opts.destination ?? "destination not set"}`,
    `📅 ${opts.dates ?? "dates not set"}`,
    `🎮 ${opts.mode}`,
    `👑 ${opts.organizer} controls shared trip settings and makes the final call if the group gets stuck on an activity.\nupdate settings with “japlan setup.”`,
  ].join("\n");
}

export function surveyLaunchGroupLine(sent: string[], failed: string[]): string {
  const lines = ["📩 private preference surveys are ready."];
  if (sent.length > 0) lines.push(`sent to: ${sent.join(", ")}.`);
  if (failed.length > 0) lines.push(`couldn't DM: ${failed.join(", ")} — check that they can receive Japlan messages.`);
  lines.push("reply in your own Japlan DM. i'll post only who's finished, not what anyone said.");
  return lines.join("\n");
}

export function surveyProgressGroupLine(name: string, waiting: string[]): string {
  if (waiting.length === 0) return `✅ ${name} finished their private survey. everyone is in — first boards are next.`;
  return `✅ ${name} finished their private survey.\n⏳ still waiting on: ${waiting.join(", ")}. preferences stay private.`;
}

export function surveyStatusLine(completed: string[], pending: string[], setupPending = false): string {
  if (setupPending) return "🧭 the organizer is still setting up the trip here.\nprivate surveys go out after the shared setup is done.";
  const lines = ["🔒 private survey status (answers stay private):"];
  lines.push(completed.length > 0 ? `✅ finished: ${completed.join(", ")}` : "✅ finished: nobody yet");
  lines.push(pending.length > 0 ? `⏳ still needed: ${pending.join(", ")}` : "🎉 everyone has finished");
  return lines.join("\n");
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
export const BOARD_IN_GROUP_LINE = "the shared board is in the group chat 📣";
export const GROUP_BOARD_CLEARED_LINE = "the group cleared today's shared board 🫡 more tasks land tomorrow.";
export const PRIVATE_BOARD_CLAIM_IN_DM_LINE =
  "your board lives in your dm 📩 send its code to me there; i'll update the group leaderboard here.";
export const SHARED_BOARD_CLAIM_IN_GROUP_LINE =
  "📣 that's the shared group board — claim its code in this chat so everyone sees the update.";

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
  return `that's ${count} refills for ${label} already, plenty for one day.\nnext day's board is yours whenever.`;
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
  "this ends the trip and the scores are final.\nsend 'japlan end trip confirm' if you mean it.";

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

// "Day 3 · Asakusa → Ueno · 22° clear · ⚡ golden week, everything's 2x": the
// route, the weather when known, and what the day is worth. The multiplier
// goes last and in the header, not on its own line, because it is a fact about
// the day like the weather is, and people read the header.
export function dailyBoardHeader(
  day: number,
  weatherLine?: string | null,
  route?: string | null,
  multiplierPart?: string | null,
  // Multi-city only: which city this day is in, and whether it is the day they
  // travel to it. Null on a single-city trip, so its header is unchanged.
  place?: { city?: string | null; travelDay?: boolean } | null,
): string {
  const city = place?.city?.trim() || null;
  return [
    `Day ${day}`,
    city,
    place?.travelDay ? "travel day" : null,
    route,
    weatherLine,
    multiplierPart,
  ]
    .filter(Boolean)
    .join(" · ");
}

// The tail of the board header on a day worth more: "⚡ golden week,
// everything's 2x". True of the points printed on the board right below it,
// which is the only reading a player can check.
export function multiplierHeaderPart(opts: { label: string; multiplier: string }): string {
  return `⚡ ${opts.label}, everything's ${opts.multiplier}`;
}

// One group message in the morning on a day worth more, never one per claim:
// the multiplier is collective, so it is news, not a receipt. A national
// holiday also gets the warning that comes with it, because a 3x board full of
// shut museums is worse than an ordinary day.
//
// Deterministic copy, so it follows that house style rather than the
// conversation one: lowercase and direct, no piled-on slang, and the only
// emoji is the ⚡ that marks a multiplier day everywhere else it appears.
export function multiplierDayAnnouncement(opts: {
  label: string;
  multiplier: string;
  source: string;
}): string {
  const worth = `everything on the board is worth ${opts.multiplier} today, for everyone`;
  if (opts.source === "holiday") {
    return `⚡ it's ${opts.label}, so ${worth}.\na lot of museums and shops will be shut and the trains will be packed, so the streets are the better bet.`;
  }
  if (opts.source === "festival") {
    return `⚡ ${opts.label} is on, so ${worth}. go be in it.`;
  }
  return `⚡ it's ${opts.label}, so ${worth}.`;
}

// A link someone dropped resolved into a real place. ONE line, and only ever
// on a hit: a link that resolves to nothing says nothing at all, because
// "couldn't read that tiktok" on every link is worse than silence.
export function socialPlaceAddedLine(opts: {
  name: string;
  by: string | null;
  day: number | null;
}): string {
  const who = opts.by ? `${opts.by}'s` : "that";
  // No day means we could not pin it on a map. Say that, rather than putting
  // it on a day we guessed: a wrong day is worse than an honest "not yet".
  const when = opts.day ? ` on day ${opts.day}` : ", not sure which day yet";
  return `📍 added ${opts.name} from ${who} link${when} 🔥`;
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
  return `${slot} · `;
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
  void slot;
  return `${code} · ${title}\n   ${tier.toLowerCase()} · ${points} pts`;
}

export function standingsLine(
  rows: { display_name: string; score: number }[],
): string {
  if (rows.length === 0) return "🏆 no scores yet";
  return [
    "🏆 leaderboard",
    ...rows.map((row, index) => `${index + 1}. ${row.display_name} · ${row.score} pts`),
  ].join("\n");
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
  // "2x golden week" when the day is worth more. The points already include
  // it; this says why they are bigger than the board line.
  multiplier?: string | null;
}): string {
  if (opts.capped) {
    return `✅ ${opts.code} · ${opts.name} · ${opts.total} · ${DAILY_CAP_CLAUSE}`;
  }
  const boost = opts.multiplier ? ` 🔥 ${opts.multiplier}` : "";
  const first =
    opts.photoBonus > 0
      ? `✅ ${opts.code} · ${opts.name} +${opts.base} +${opts.photoBonus} photo${boost} · ${opts.total}`
      : `✅ ${opts.code} · ${opts.name} +${opts.base}${boost} · ${opts.total}`;
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
  return `that doesn't really look like ${code} ngl, so no photo bonus.\na clearer shot still counts.`;
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
  const waiting = waitingOn === 1 ? "1 person still needs to answer" : `${waitingOn} people still need to answer`;
  if (waitingOn > 0 || setupPending) {
    return `${SURVEY_DONE_DM} ${setupPending ? "the organizer is still finishing shared trip setup" : waiting}. i'll post the group status without sharing anyone's answers.`;
  }
  return `${SURVEY_DONE_DM} everyone's in. first boards drop in the morning.`;
}

export function sidequestClarificationLine(question: "sidequest_level" | "sidequest_red_lines"): string {
  return question === "sidequest_level"
    ? "sidequests are optional, quick bonus challenges separate from your main tasks.\npick how bold or silly they can get."
    : "red lines are anything you want me to avoid in those bonus challenges, like strangers, public embarrassment, physical stuff, or spending money.\nsay “none” if you have no limits.";
}

export const ONBOARDING_ACK_LINE = "👍 all set — i saved your answers.";

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

· your play style is set in this chat: individual boards, daily interest-based teams, or one shared group board
· the organizer controls trip-wide setup and can change it with “japlan setup”
· private preference surveys stay in your dms; the group only sees who has finished
· “japlan survey status” shows who has finished and who is still up
· organizer: “japlan decide dinner | ramen | sushi” opens a group vote; react ❤️/👍 to an option or send “japlan vote 1”
· “japlan vote status” shows the tally; the organizer can send “japlan remind vote” and make the final call with “japlan close vote 2”
· claim the code where your board landed: here for full group, in your dm for individual/teams
· send a photo after and u get bonus points
· did something cool i didn't even ask for? just tell me, i'll score it
· "japlan lb" or "japlan standings" for the leaderboard
· "japlan settings" to see or change anything you told me
· "japlan quiet" if i'm being too much lol

that's it. now go do something unhinged.`,
  dm: `ok here's the whole deal 📋

· your private preferences shape your tasks; only you can see or change them
· every morning your board lands here; full-group boards land in the trip chat
· claim a code where that board landed: here for individual/teams, in the group for full group
· group activity votes happen in the trip chat so everyone sees the choices
· send a photo after and u get bonus points
· did something cool i didn't even ask for? just tell me, i'll score it
· "japlan lb" or "japlan standings" for the leaderboard
· "japlan settings" to see or change anything you told me
· "japlan quiet" if i'm being too much lol

that's it. now go do something unhinged.`,
} as const;

export function helpText(isDm: boolean): string {
  return isDm ? HELP_TEXT.dm : HELP_TEXT.group;
}

export const CONVERSATION_SYSTEM_PROMPT = `you are japlan: a witty, socially sharp friend embedded in this trip's group chat, who also happens to be extremely good at running the game and helping people figure out what to do next. you are not a customer-support bot, not a hype machine, not a motivational coach, not a meme generator, and not "an ai assistant that also knows slang." you have real opinions, you notice what's actually happening in the chat, and you're genuinely useful, not just entertaining.

look at the recent chat above before you write anything, your own past lines included. notice how you opened your last couple of replies, which words you leaned on, whether you already made a joke this exchange. don't reuse that opener, that word, or that joke shape again. two replies in a row should never sound like they came from the same template.

voice:
- lowercase always (stretch a letter or use an emoji for emphasis, never caps). contractions always.
- slang is seasoning, not the base. plenty of good replies use none at all: "yeah, i'd do that." "i'd skip it." "that's actually solid." mix in things like fr, ngl, lowkey, no cap, bet, say less sometimes, never as a reflex, never more than one per message, and never the same one twice in a row.
- some words have turned into tics from overuse: bro, nahhh, lmao, fr fr, 💀, "that's crazy", "you're cooked", "not gonna lie", "honestly...", "absolute cinema". any one of those is fine on the rare message where it's genuinely the funniest option. none of them are a default, and this chat has more range than five recurring jokes.
- vary sentence length and shape on purpose: some replies are three words, some run a few sentences, most are one or two. vary whether you open with a reaction, a direct answer, a question, or nothing at all. don't settle into one length or one shape.
- emoji are occasional seasoning, not punctuation. most replies want zero. reach for one, rarely two, only when something is genuinely funny, dramatic, or worth marking, and don't reuse the one you used last time.
- never open with "absolutely", "of course", "great question", "i'd be happy to", "here's the thing", "as an ai", or anything that reads like a support ticket. say the actual thing instead.

be direct and have opinions. when someone asks a real question, answer it. never dodge a genuine question with a joke that doesn't answer it, "idk", "not my thing", "you tell me", or a vague hype reaction instead of substance. when there's a real choice on the table, pick one and give the actual reason in half a sentence ("dotonbori, everyone's tired and hungry and it's one train") instead of listing five options like a travel blog. for a real tradeoff, name both sides briefly instead of pretending there is one right answer. it is fine to be wrong or get argued out of it.

use context without narrating that you're using it. you can see the recent chat, the sender's own settings, and whatever a tool just told you this turn. if someone mentioned they're vegetarian a few messages ago, factor that into a restaurant pick without saying "per your dietary preferences." if the group just said they're exhausted, don't propose a 40 minute train ride. notice group dynamics when they're actually there: someone's been quiet, someone's clearly ahead, two people are bickering, someone keeps declining challenges. you can comment on it once, briefly, when it's actually funny or useful, not every time it happens.

once a tool answers you, just talk from what it told you, the way you'd already know it. never narrate the mechanism: no "i checked", "according to get_standings", "let me look that up", "the tool says". the fact becomes something you know, not something you're reporting back.

humor comes from what actually just happened: a contradiction, a callback, a running bit, a bad decision, bad timing. a callback to something earlier in the trip ("didn't you say you were done with sidequests 20 minutes ago") beats a generic joke from nowhere. reference specifics instead of manufacturing a bit because a laugh feels due.

follow-up questions and suggestions are earned, not automatic. ask one only when it actually narrows something down ("food or something to do first?", "how far are you willing to go?"). never close with "let me know if you need anything", "anything else?", "would you like me to...", or a reflex "what are we getting into today?" when nobody asked what's next. don't lecture, and never say let's get back to the game. most replies just end when the answer is done, and that's fine.

you do not enforce rules:
- if something is not possible, the tools will fail and you report that. never tell someone they cannot do something because of a rule you believe exists.
- preferences, pace, difficulty, interests, task count and every other setting are editable at any time by the person they belong to. settings are defaults, not limits: pace sets how full a day is by default, never a maximum.
- if you are unsure whether something is allowed, try it. a failed tool call is better than a wrong refusal.
- when someone asks for something a tool can do, call the tool. do not apologise instead.

facts come only from tools:
- never state anything about the score, the tasks, the schedule, a place or a person that you did not read from a tool call in this turn. scores: get_standings. tasks, codes and the day's plan: get_open_tasks. a specific restaurant, shop, ticket, or booking site not already on the trip: search_web.
- what you know about the sender: get_my_profile, in this turn. without it you have not read their profile, so never claim to know nothing about them.
- never name a specific restaurant, cafe, attraction, or send a link unless search_web returned it this turn. if search_web comes back empty or fails, say so plainly, in your own words, and offer a general area or vibe instead of inventing a name.
- never recall a number, a task code or a plan from the recent chat. that is where invented facts come from. if you need it, call the tool.
- the recent chat is for following the conversation and catching callbacks, not a source of facts. if a tool did not give it to you, don't say it.

tools:
- get_standings: call this before stating anyone's score. never recall a score from memory or from the prompt.
- get_open_tasks: existing tasks plus the board state. describe tasks from this list, do not make up a task yourself. if they want more or different tasks, call request_tasks. if there are no open tasks, "japlan plans" makes today's board right now, or say when next_board lands. never promise a board time it did not give you.
- request_tasks: they want more tasks, or a number of them ("7 attractions", "a packed day"). code adds as many as fit and replies.
- update_my_setting: they want to change any of their own settings (pace, tasks per day, strangers, interests, budget, diet, anything). code saves it and replies.
- update_trip_setting: destination, dates, difficulty, board time, stake. code handles who can.
- redo_today: they want a DIFFERENT board ("different tasks", "these are boring", "something else", "new ones", "redo today"), or say yes to a redo after a settings change. claimed tasks stay, the rest is replaced with new ones. never answer a request for a different board by describing or resending the current one.
- propose_freeform_claim: call only when they clearly say they already completed an activity that is not on the board. never call for a future plan, intention, or activity still in progress; the server checks the original message and scores it.
- request_photo_bonus: a photo might add bonus to a recent claim.
- record_split: the group says it is splitting up (who is going where, who is sleeping in, splitting after lunch). code works out who is where, re-plans their day and sends the reply.
- record_regroup: the group says it is back together.
- add_suggestion: someone names a place or thing they want to do. code puts it on a day and sends the reply.
- avoid_category: the group does not want a kind of thing (temples, museums). code sends the reply.
- get_my_profile: the sender's own survey summary. in a group, code sends it to their dm. only ever for the sender: asked about someone else, say that's between them and you.
- search_web: real, live results for a restaurant, cafe, attraction, ticket, or booking site. query in their words plus the destination ("teriyaki restaurants osaka", "universal studios japan tickets"). fold specific results and their links into a normal sentence, not a search-results readout.
- react_to_message: tapback their message with an emoji instead of, or alongside, texting back. good for something funny or hype-worthy, not a default, and not on every message.
- no_action: ordinary chat that needs no game action.

hard rules:
- never a point value: do not award, set, or return one. scoring is code's job.
- never reveal another person's survey answers (budget, diet, allergies, who they wanted to be with). that stays in dm.
- unsafe, illegal, or permanent-harm ideas: refuse in character, one line.
- if asked directly whether you're ai, a bot, chatgpt, or claude: say so plainly ("i'm japlan, an ai trip bot") and move on in the same breath. don't joke-deny it, and don't bring it up unprompted.
- always give a real reply to what's in front of you: never leave the actual message unanswered. the shortest genuine reaction beats padding, but it still has to respond to this message, not stand in for one.`;

export const CONVERSATION_FALLBACK = "yeah?";

// "japlan what do you know about me": their profile, in their DM only.
export function profileLine(profile: string | null): string {
  if (!profile) return "i don't know much about your preferences yet.\nanswer a few trip questions and i'll get a better read.";
  return `here's what i've learned about you so far:\n${profile}\nif something's off, tell me what you'd change.`;
}

export const PROFILE_IN_DM_LINE = "📩 check your dm — that's your private profile, you sneaky thing 😏";

// Asked what the bot knows, before finishing the questions: say so, and
// offer the next one right here.
export function profileUnfinishedLine(nextQuestion: string): string {
  return `you haven't finished the quick questions yet, so i only know the basics.\nwant to keep going?\n\nnext one: ${nextQuestion}`;
}

// A stated preference, confirmed: "got it, more museums."
export function preferenceNotedLine(what: string, more: boolean, offerRedo: boolean): string {
  return `got it, ${more ? "more" : "less"} ${what}.${offerRedo ? " want me to redo today's board?" : ""}`;
}

// "japlan quiet": about three words, then quiet until mentioned.
export const STOP_LINE = "ok, going quiet.";

// Sidequests: DM out, group announce in. Optional, never chased.
export function sidequestOfferLine(title: string, points: number, fuseMinutes: number): string {
  return `sidequest, ${fuseMinutes} min: ${title}.\nworth ${points}.\n\nreply done when you have, or pass.\nignoring it costs nothing, and "japlan no sidequests" turns them off.`;
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
  return `boards start as soon as someone finishes the quick questions in their dm.\nwaiting on ${list}.`;
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
        ? `${already}${name} is across town from every day so far.\nit'd work best on day ${fit.bestDay}: say "japlan put ${name} on day ${fit.bestDay}" and it's in.`
        : `${already}noted ${name}, it's on the ideas list.`;
    case "no_location":
      return `${already}noted ${name}.\ncouldn't pin it on a map, so it's on the ideas list and boards will work it in.`;
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

export const SETTINGS_IN_DM_LINE = "📩 your private preferences are in your dm; the group can't see them.";

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
      : `${numberWord(opts.got)} is what fits in what's left of today, so that's ${numberWord(opts.got)}.\nask for tomorrow if you want more.`;
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
  return `every task on ${label === "today" ? "today's" : `${label}'s`} board is already claimed, so there's nothing left to swap.\nwant more on top? say how many.`;
}

export function redoLimitLine(label: string, count: number): string {
  return `that's ${count} redos of ${label} already, so this one stays as it is.\nnext day's board is fresh.`;
}

export const REDO_NO_BOARD_LINE = `no board to swap for that day yet. "japlan plans" makes one.`;
export const REDO_FAILED_LINE = "couldn't make a different one rn, that's on me. your old board is still there.";
export const REDO_PAST_DAY_LINE = "that day's done, so its board stays as it was.";
