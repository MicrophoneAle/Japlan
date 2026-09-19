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
