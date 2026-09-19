import { evaluateAddress, type AddressDecision } from "./addressing";

export const TASK_CODE_RE = /\b[A-Za-z]\d{1,2}\b/;

export type LadderHit =
  | { step: 1; code: string }
  | { step: 2; code: string }
  | { step: 3 }
  | { step: 4 }
  | { step: 5 };

export type ClaimDecision =
  | { type: "silent"; reason: "addressing" | "no_match" | "help" }
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
  if (address.intent === "help") {
    return { type: "silent", reason: "help" };
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
export const DEFAULT_PHOTO_BONUS_WINDOW_MS = 2 * 60 * 60 * 1000;

export function photoBonusWindowMs(
  value = process.env.JAPLAN_PHOTO_BONUS_WINDOW_MS,
): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_PHOTO_BONUS_WINDOW_MS;
}

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
  _withPhoto?: boolean,
): boolean {
  void verification;
  return true;
}

export function verificationRequiresPeer(verification: string): boolean {
  return verification === "peer";
}

export function clampPhotoBonus(bonus: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(bonus, max));
}

export type LatePhotoClaim = {
  id: string;
  task_id: string;
  participant_id: string;
  status: string;
  photo_claimed_at?: string | null;
  created_at?: string | null;
};

export type LatePhotoBind =
  | { kind: "bonus"; taskId: string; claimId: string }
  | { kind: "already_bonused" }
  | { kind: "none" };

export function claimAcceptsLatePhoto(opts: {
  claim: LatePhotoClaim;
  now: number;
  windowMs: number;
}): boolean {
  if (opts.claim.status !== "awarded") return false;
  if (opts.claim.photo_claimed_at) return false;
  if (!opts.claim.created_at) return false;
  const created = Date.parse(opts.claim.created_at);
  if (Number.isNaN(created)) return false;
  return opts.now - created <= opts.windowMs;
}

function taskAllowsPhotoBonus(
  task: { id: string; code: string; photo_bonus_max?: number } | undefined,
): boolean {
  return (task?.photo_bonus_max ?? 0) > 0;
}

export function pickLatePhotoTarget(opts: {
  hasPhoto: boolean;
  code: string | null;
  claimantId: string;
  claims: LatePhotoClaim[];
  tasks: { id: string; code: string; photo_bonus_max?: number }[];
  now: number;
  windowMs: number;
}): LatePhotoBind {
  if (!opts.hasPhoto) return { kind: "none" };

  if (opts.code) {
    const task = opts.tasks.find((row) => row.code === opts.code);
    if (!task) return { kind: "none" };
    const claim = opts.claims.find(
      (row) =>
        row.task_id === task.id &&
        row.participant_id === opts.claimantId &&
        (row.status === "awarded" || row.status === "pending_peer"),
    );
    if (!claim) return { kind: "none" };
    if (claim.status === "pending_peer") return { kind: "none" };
    if (claim.photo_claimed_at) return { kind: "already_bonused" };
    if (
      taskAllowsPhotoBonus(task) &&
      claimAcceptsLatePhoto({ claim, now: opts.now, windowMs: opts.windowMs })
    ) {
      return { kind: "bonus", taskId: task.id, claimId: claim.id };
    }
    return { kind: "none" };
  }

  const bonusTaskIds = new Set(
    opts.tasks.filter((task) => taskAllowsPhotoBonus(task)).map((task) => task.id),
  );
  const recent = opts.claims
    .filter(
      (claim) =>
        claim.participant_id === opts.claimantId &&
        bonusTaskIds.has(claim.task_id) &&
        claimAcceptsLatePhoto({
          claim,
          now: opts.now,
          windowMs: opts.windowMs,
        }),
    )
    .sort(
      (a, b) =>
        Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""),
    );
  const top = recent[0];
  if (!top) return { kind: "none" };
  return { kind: "bonus", taskId: top.task_id, claimId: top.id };
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
  photoBonusMax?: number;
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
  const raw = opts.hasExif
    ? opts.fidelity
    : Math.min(opts.fidelity, 1);
  const max = opts.photoBonusMax ?? raw;
  return { bonus: clampPhotoBonus(raw, max), reject: false };
}
