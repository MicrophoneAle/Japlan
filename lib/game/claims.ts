import {
  evaluateAddress,
  extractTaskCode,
  type AddressDecision,
} from "./addressing";
import { endOfLocalDayContaining } from "./time";

export { extractTaskCode };

export type LadderHit =
  | { step: 1; code: string }
  | { step: 2; code: string }
  | { step: 3 }
  | { step: 4 }
  | { step: 5 };

export type ClaimDecision =
  | { type: "silent"; reason: "addressing" | "no_match" | "help" }
  | {
      type: "code";
      step: 1 | 2;
      code: string;
      withPhoto: boolean;
      // Only addressed by a loose code: stay silent unless it is the sender's task.
      tentative: boolean;
    }
  | { type: "vision" }
  | { type: "fuzzy"; text: string };

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
      tentative: address.reason === "loose_task_code",
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

export type OwnedTask = {
  participant_id: string | null;
  team_id: string | null;
};

export type TeamMembership = { teamId: string; dissolvedAt: string | null };

// A team's tasks stay claimable by its members until the end of the local day
// the team dissolved. Retroactive claims cover "we did A1 yesterday", not a
// team arrangement that ended days ago.
export function splitTeamsByClaimWindow(
  memberships: TeamMembership[],
  timezone: string | null | undefined,
  now: Date,
): { active: string[]; expired: string[] } {
  const active: string[] = [];
  const expired: string[] = [];
  for (const membership of memberships) {
    if (!membership.dissolvedAt) {
      active.push(membership.teamId);
      continue;
    }
    const dissolved = new Date(membership.dissolvedAt);
    if (Number.isNaN(dissolved.getTime())) {
      expired.push(membership.teamId);
      continue;
    }
    const closes = endOfLocalDayContaining(dissolved, timezone);
    (now.getTime() <= closes.getTime() ? active : expired).push(membership.teamId);
  }
  return { active, expired };
}

// Personal tasks belong to one participant, team tasks to that team's members
// (while the team's claim window is open), shared-board tasks to anyone.
// team_members has no left_at, so membership is "has a row".
export function canClaimTask(
  task: OwnedTask,
  claimantId: string,
  claimantTeamIds: readonly string[],
): boolean {
  if (task.participant_id) return task.participant_id === claimantId;
  if (task.team_id) return claimantTeamIds.includes(task.team_id);
  return true;
}

export function tasksClaimableBy<T extends OwnedTask>(
  tasks: T[],
  claimantId: string,
  claimantTeamIds: readonly string[],
): T[] {
  return tasks.filter((task) => canClaimTask(task, claimantId, claimantTeamIds));
}

export type CodeLookup<T> =
  | { kind: "task"; task: T }
  | { kind: "not_yours" }
  | { kind: "team_expired" }
  | { kind: "unknown" };

// Codes repeat across owners (everyone has an A1), so resolve against the
// claimant: their personal task first, then their team's, then the shared board.
// claimantTeamIds are teams whose claim window is open; expiredTeamIds are the
// claimant's teams whose window closed.
export function findTaskByCodeFor<T extends OwnedTask & { code: string }>(
  tasks: T[],
  code: string,
  claimantId: string,
  claimantTeamIds: readonly string[],
  expiredTeamIds: readonly string[] = [],
): CodeLookup<T> {
  const wanted = code.toUpperCase();
  const matches = tasks.filter((task) => task.code.toUpperCase() === wanted);
  if (matches.length === 0) return { kind: "unknown" };
  const rank = (task: T): number =>
    task.participant_id ? 0 : task.team_id ? 1 : 2;
  // Day letters cycle past day 26, so the same code can exist on day 1 and
  // day 27: the most recent day wins.
  const dayOf = (task: T): number => (task as { day?: number }).day ?? 0;
  const mine = tasksClaimableBy(matches, claimantId, claimantTeamIds).sort(
    (a, b) => rank(a) - rank(b) || dayOf(b) - dayOf(a),
  );
  if (mine[0]) return { kind: "task", task: mine[0] };
  if (matches.some((task) => task.team_id && expiredTeamIds.includes(task.team_id))) {
    return { kind: "team_expired" };
  }
  return { kind: "not_yours" };
}

// Up to `limit` open codes the claimant can act on, today's first.
export function openCodesFor<
  T extends OwnedTask & { id: string; code: string; day: number },
>(
  tasks: T[],
  claims: { task_id: string; status: string }[],
  claimantId: string,
  claimantTeamIds: readonly string[],
  limit = 3,
): string[] {
  return tasksClaimableBy(tasks, claimantId, claimantTeamIds)
    .filter((task) => isOpenTask(task.id, claims))
    .sort((a, b) => b.day - a.day || a.code.localeCompare(b.code, "en", { numeric: true }))
    .slice(0, limit)
    .map((task) => task.code);
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
