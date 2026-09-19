export const GROUP_INTRO =
  "PLACEHOLDER: Japlan is in this chat. It reads the thread to find task claims and place mentions. It only replies when spoken to.";

export const SETUP_COMPLETE =
  "PLACEHOLDER: Setup is complete. The trip is now active.";

export const SURVEY_DONE_DM =
  "PLACEHOLDER: that's everything from me for now.";

export function dailyBoardHeader(day: number): string {
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
}): string {
  if (opts.photoBonus > 0) {
    return `✅ ${opts.code} · ${opts.name} +${opts.base} +${opts.photoBonus} photo · ${opts.total}`;
  }
  return `✅ ${opts.code} · ${opts.name} +${opts.base} · ${opts.total}`;
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

export function twoMatchAskLine(left: string, right: string): string {
  return `${left} or ${right}?`;
}
