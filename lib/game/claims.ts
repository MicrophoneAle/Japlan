import { evaluateAddress, type AddressDecision } from "./addressing";

export const TASK_CODE_RE = /\b[A-Za-z]\d{1,2}\b/;

export type LadderHit =
  | { step: 1; code: string }
  | { step: 2; code: string }
  | { step: 3 }
  | { step: 4 }
  | { step: 5 };

export type ClaimDecision =
  | { type: "silent"; reason: "addressing" | "no_match" }
  | { type: "code"; step: 1 | 2; code: string; withPhoto: boolean }
  | { type: "vision" }
  | { type: "fuzzy"; text: string };

export function extractTaskCode(text: string): string | null {
  const match = text.match(TASK_CODE_RE);
  if (!match) return null;
  const raw = match[0];
  return `${raw[0].toUpperCase()}${raw.slice(1)}`;
}

export function ladder(input: {
  text: string;
  hasPhoto: boolean;
  recentCode: string | null;
}): LadderHit {
  const code = extractTaskCode(input.text);
  if (code) return { step: 1, code };
  if (input.hasPhoto && input.recentCode) {
    return { step: 2, code: input.recentCode };
  }
  if (input.hasPhoto) return { step: 3 };
  if (input.text.trim()) return { step: 4 };
  return { step: 5 };
}

export function decideClaim(input: {
  text: string;
  hasPhoto: boolean;
  recentCode: string | null;
  isDm: boolean;
  openTaskContext: boolean;
  address?: AddressDecision;
}): ClaimDecision {
  const address =
    input.address ??
    evaluateAddress({
      text: input.text,
      isDm: input.isDm,
      openTaskContext: input.openTaskContext,
    });
  if (!address.respond) {
    return { type: "silent", reason: "addressing" };
  }

  const hit = ladder({
    text: input.text,
    hasPhoto: input.hasPhoto,
    recentCode: input.recentCode,
  });
  if (hit.step === 5) return { type: "silent", reason: "no_match" };
  if (hit.step === 1 || hit.step === 2) {
    return {
      type: "code",
      step: hit.step,
      code: hit.code,
      withPhoto: input.hasPhoto,
    };
  }
  if (hit.step === 3) return { type: "vision" };
  return { type: "fuzzy", text: input.text };
}

export const CLAIM_MATCH_CONFIDENCE_MIN = 0.75;

export function hashAlreadyUsed(
  existing: Iterable<string>,
  hash: string,
): boolean {
  for (const value of existing) {
    if (value === hash) return true;
  }
  return false;
}

export function awardFanout(opts: {
  teamId: string | null;
  claimantId: string;
  teamMemberIds: string[];
  basePoints: number;
  photoBonus: number;
}): { participantId: string; points: number }[] {
  const points = opts.basePoints + opts.photoBonus;
  const ids = opts.teamId
    ? Array.from(new Set([...opts.teamMemberIds, opts.claimantId]))
    : [opts.claimantId];
  return ids.map((participantId) => ({ participantId, points }));
}

export function canResolveNow(
  verification: string,
  withPhoto: boolean,
): boolean {
  if (verification === "photo" && !withPhoto) return false;
  return true;
}

export function isOpenTask(
  taskId: string,
  claims: { task_id: string; status: string }[],
): boolean {
  return !claims.some(
    (claim) =>
      claim.task_id === taskId &&
      (claim.status === "awarded" || claim.status === "pending_peer"),
  );
}

export function applyPhotoBonusRules(opts: {
  fidelity: number;
  hasExif: boolean;
  takenAt: Date | null;
  tripStart: string | null;
  tripEnd: string | null;
}): { bonus: number; reject: boolean } {
  if (opts.takenAt && (opts.tripStart || opts.tripEnd)) {
    const taken = opts.takenAt.getTime();
    if (opts.tripStart) {
      const start = Date.parse(opts.tripStart);
      if (!Number.isNaN(start) && taken < start) {
        return { bonus: 0, reject: true };
      }
    }
    if (opts.tripEnd) {
      const end = Date.parse(opts.tripEnd);
      if (!Number.isNaN(end) && taken > end + 24 * 60 * 60 * 1000 - 1) {
        return { bonus: 0, reject: true };
      }
    }
  }
  // TODO: trips often have null dates; window check is skipped until those are set.
  const bonus = opts.hasExif
    ? opts.fidelity
    : Math.min(opts.fidelity, 1);
  return { bonus, reject: false };
}
