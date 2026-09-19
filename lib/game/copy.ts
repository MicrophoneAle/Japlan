export const GROUP_INTRO =
  "PLACEHOLDER: Japlan is in this chat. It reads the thread to find task claims and place mentions. It only replies when spoken to.";

export const SETUP_COMPLETE =
  "PLACEHOLDER: Setup is complete. The trip is now active.";

export const SURVEY_DONE_DM =
  "PLACEHOLDER: that's everything from me for now.";

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

export function claimConfirmedLine(opts: {
  code: string;
  name: string;
  base: number;
  photoBonus: number;
  total: number;
  capped?: boolean;
  invitePhoto?: boolean;
}): string {
  if (opts.capped) {
    return `✅ ${opts.code} · ${opts.name} · daily cap reached · ${opts.total}`;
  }
  if (opts.photoBonus > 0) {
    return `✅ ${opts.code} · ${opts.name} +${opts.base} +${opts.photoBonus} photo · ${opts.total}`;
  }
  const first = `✅ ${opts.code} · ${opts.name} +${opts.base} · ${opts.total}`;
  if (opts.invitePhoto) {
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
    return `📸 ${opts.code} · daily cap reached · ${opts.total}`;
  }
  return `📸 ${opts.code} · +${opts.bonus} bonus · ${opts.total}`;
}

export function alreadyClaimedLine(code: string): string {
  return `${code} already claimed.`;
}

export function reusedPhotoLine(): string {
  return `that photo was already used.`;
}

export function visionRejectedLine(code: string): string {
  return `doesn't look like ${code}.`;
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

export function freeformAlreadyUsedLine(): string {
  return `already used today's freeform.`;
}

export function freeformRejectedLine(): string {
  return `can't count that.`;
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
- if you have nothing useful, still say something short. silence is for messages that did not address you.`;

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
