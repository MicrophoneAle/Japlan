export const GROUP_INTRO =
  "PLACEHOLDER: Japlan is in this chat. It reads the thread to find task claims and place mentions. It only replies when spoken to.";

export const SETUP_COMPLETE =
  "PLACEHOLDER: Setup is complete. The trip is now active.";

export const SURVEY_DONE_DM =
  "PLACEHOLDER: that's everything from me for now.";

export function surveyReaskLine(options: string[]): string {
  return `didn't catch that. reply ${options.join(" / ")}, or skip.`;
}

export function dailyBoardHeader(
  day: number,
  weatherLine?: string | null,
): string {
  if (weatherLine) return `Day ${day} · ${weatherLine}`;
  return `Day ${day}`;
}

export function dailyBoardTaskLine(
  code: string,
  title: string,
  points: number,
): string {
  return `${code} · ${title} (${points})`;
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
  if (openCodes.length === 0) return "your next board comes in the morning.";
  if (openCodes.length === 1) return `${openCodes[0]} is still open.`;
  return `still open: ${openCodes.join(", ")}.`;
}

export const DAILY_CAP_CLAUSE =
  "that's your cap for today, but claims still count for the recap.";

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
    return `${first} · that clears your board, new tasks coming by dm.`;
  }
  if (opts.invitePhoto && opts.photoBonus === 0) {
    return `${first}\nphoto for bonus points?`;
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
  return next ? `${code} already claimed. ${next}` : `${code} already claimed.`;
}

export function notYourTaskLine(code: string, next: string): string {
  return `${code} isn't on your board. ${next}`;
}

export function unknownCodeLine(code: string, next: string): string {
  return `there's no ${code}. ${next}`;
}

export function teamTaskExpiredLine(code: string, next: string): string {
  return `${code} expired with the team. ${next}`;
}

export function reusedPhotoLine(): string {
  return `that photo was already used. a new shot still counts.`;
}

export function visionRejectedLine(code: string): string {
  return `doesn't look like ${code}, so no photo bonus. a clearer shot still counts.`;
}

export function photoOutsideTripLine(code: string): string {
  return `that photo is from outside the trip, so no bonus on ${code}. a new shot still counts.`;
}

export function photoAlreadyBonusedLine(code: string, next: string): string {
  return `${code} already has its photo bonus. ${next}`;
}

export function notOnTripLine(): string {
  return `you're not on this trip yet, so i can't score that. whoever set up japlan can add you.`;
}

export function tripNotReadyLine(): string {
  return `still setting this trip up. send that again in a minute.`;
}

export function dmClaimInGroupLine(next: string): string {
  return `you're all set. claims go in the group chat. ${next}`;
}

export function dmUnknownPersonLine(): string {
  return `i only know people from a trip group chat. add me to yours and say japlan.`;
}

export function conversationCapLine(next: string): string {
  return `i've said plenty this hour. ${next}`;
}

export const DISPATCH_ERROR_LINE =
  "something broke on my end. send that again in a minute.";

export function surveyDoneLine(waitingOn: number): string {
  if (waitingOn > 0) {
    const people = waitingOn === 1 ? "1 more person" : `${waitingOn} more people`;
    return `${SURVEY_DONE_DM} waiting on ${people}, then your first board lands in the morning.`;
  }
  return `${SURVEY_DONE_DM} your first board lands in the morning.`;
}

export function peerLapsedLine(codes: string[]): string {
  const list = codes.join(", ");
  return codes.length === 1
    ? `${list} never got a 👍, so it lapsed. it's open again if someone can confirm.`
    : `${list} never got a 👍, so they lapsed. they're open again if someone can confirm.`;
}

export function peerConfirmLine(opts: {
  name: string;
  code: string;
  title: string;
}): string {
  return `${opts.name} claims ${opts.code} (${opts.title}).\n👍 this if you believe them.`;
}

export function freeformPeerLine(opts: {
  name: string;
  title: string;
  code: string;
}): string {
  return `${opts.name} says they ${opts.title}. ${opts.code}. 👍 if that happened.`;
}

export function freeformAlreadyUsedLine(next: string): string {
  return `already used today's freeform. ${next}`;
}

export function freeformRejectedLine(next: string): string {
  return `can't count that. ${next}`;
}

export function twoMatchAskLine(left: string, right: string): string {
  return `${left} or ${right}?`;
}

export const HELP_TEXT = {
  group: `here's the deal

· every morning the shared board goes up
· send the code (like A1) to claim one
· send a photo after and you get bonus points
· did something cool i didn't ask for? just tell me, i'll score it
· "japlan standings" for the leaderboard
· "japlan chill" if i'm being annoying

that's it. go do something stupid.`,
  dm: `here's the deal

· every morning you get 3 personal tasks
· send the code (like A1) to claim one
· send a photo after and you get bonus points
· did something cool i didn't ask for? just tell me, i'll score it
· "japlan standings" for the leaderboard
· "japlan chill" if i'm being annoying

that's it. go do something stupid.`,
} as const;

export function helpText(isDm: boolean): string {
  return isDm ? HELP_TEXT.dm : HELP_TEXT.group;
}

export const CONVERSATION_SYSTEM_PROMPT = `you are japlan, a trip game host sitting in the group chat. referee who is also fun, not a hype account.

voice: lowercase. no exclamation marks. no emoji except ✅ 📸 👍. one message, never two. short.

you only talk when addressed. you are not a general chatbot. having an opinion is fine. do not refuse to engage, do not lecture, never say let's get back to the game.

tools:
- get_standings: call this before stating anyone's score. never recall a score from memory or from the prompt.
- get_open_tasks: only existing tasks. never invent one. if asked for a new task, point at an open one.
- propose_freeform_claim: they already did something you did not assign. return title and six axes (integers 1-5). never a point value. code will score it.
- request_photo_bonus: a photo might add bonus to a recent claim.
- no_action: when you just want to talk.

hard rules:
- never award, set, or return a point value. axes only. scoring is not your job.
- never reveal another person's survey answers (budget, diet, allergies, who they wanted to be with). that stays in dm.
- unsafe, illegal, or permanent-harm ideas: refuse in character, one line.
- if you have nothing useful, still say something short. silence is for messages that did not address you.

next steps:
- only when they seem to be looking for something to do ("what now", "bored", "anything nearby"), end with one short clause naming something specific: an open code from get_open_tasks, the score gap from get_standings, or a named nearby place. same message.
- otherwise add no suggestion. never generic encouragement, never "let me know if you need anything".`;

export const CONVERSATION_FALLBACK = "yeah?";

export const CONVERSATION_PRIVACY_LINE = "that's between them and me.";

export function conversationRedirect(opts: {
  task?: { code: string } | null;
  nearby?: string | null;
  trailingName?: string | null;
}): string {
  if (opts.task?.code) return `${opts.task.code} is still open.`;
  if (opts.nearby) return `${opts.nearby} is right there.`;
  if (opts.trailingName) return `${opts.trailingName} is still hunting.`;
  return `the board is still there.`;
}
