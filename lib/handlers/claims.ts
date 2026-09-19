import { getServiceClient } from "@/lib/db/client";
import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { formatMorningStandings } from "@/lib/game/board";
import { buildStandingsRows } from "@/lib/game/standings";
import { teamsWithMembers } from "@/lib/handlers/teams";
import {
  CLAIM_MATCH_CONFIDENCE_MIN,
  applyPhotoBonusRules,
  awardFanout,
  canClaimTask,
  clampPhotoBonus,
  decideClaim,
  findTaskByCodeFor,
  hashAlreadyUsed,
  isOpenTask,
  openCodesFor,
  photoBonusWindowMs,
  pickLatePhotoTarget,
  splitTeamsByClaimWindow,
  tasksClaimableBy,
  verificationRequiresPeer,
  type ClaimDecision,
  type TeamMembership,
} from "@/lib/game/claims";
import { evaluateAddress, findTaskCode } from "@/lib/game/addressing";
import {
  alreadyClaimedLine,
  claimConfirmedLine,
  freeformPeerLine,
  freeformRejectedLine,
  nextStepClause,
  notOnTripLine,
  notYourTaskLine,
  peerConfirmLine,
  photoAlreadyBonusedLine,
  photoBonusLine,
  photoCheckFailedLine,
  photoOutsideTripLine,
  reusedPhotoLine,
  PRIVATE_BOARD_CLAIM_IN_DM_LINE,
  SHARED_BOARD_CLAIM_IN_GROUP_LINE,
  teamTaskExpiredLine,
  TRIP_OVER_LINE,
  tripNotReadyLine,
  twoMatchAskLine,
  unknownCodeLine,
  visionRejectedLine,
} from "@/lib/game/copy";
import { endOfLocalDayContaining, localDateString } from "@/lib/game/time";
import { prefDimsFor } from "@/lib/game/prefs";
import { learnFrom } from "./profiles";
import { isBoardRequest, isRedoRequest } from "@/lib/game/board-schedule";
import { bumpStats, recordClaimAwarded } from "@/lib/handlers/stats";
import {
  FREEFORM_PHOTO_BONUS_MAX,
  FREEFORM_SOURCE,
  isClaimantTapback,
  isLikelyUncompletedActivity,
  openPersonalTaskIds,
  parseFreeformExtraction,
  type FreeformExtraction,
} from "@/lib/game/freeform";
import { imageFingerprint, imageTakenAt, prepareForVision, sniffImageMime } from "@/lib/game/image-hash";
import { fetchWithTimeout, withTimeout } from "@/lib/timeout";
import { nextFreeformCode } from "@/lib/game/generate";
import {
  applyDailyPointsCap,
  claimEarnsScreenEffect,
  clampPhotoBonusMax,
  photoBonusMaxFor,
  DEFAULT_DAILY_POINTS_CAP,
  pointsForFreeform,
  tripLengthDays,
} from "@/lib/game/scoring";
import { resetOffTopicOnClaim } from "@/lib/game/conversation";
import { verificationForSolo } from "@/lib/game/solo";
import type { SurveyAnswers } from "@/lib/game/survey";
import { validateGeneratedTask } from "@/lib/game/validate";
import {
  findParticipantOnTrip,
  getLatestTripByChatId,
  getTripByChatId,
} from "@/lib/handlers/bootstrap";
import {
  currentTripDay,
  refillPersonalTasksIfNeeded,
} from "@/lib/handlers/daily-board";
import type { LLMProvider } from "@/lib/llm";
import {
  extractFreeformActivity,
  matchClaimText,
  scorePhotoFidelity,
} from "@/lib/llm/gemini";
import {
  chatIdFromData,
  isDirectChat,
  photoPartsFrom,
  senderFromData,
  textFromParts,
} from "@/lib/linq/payload";
import { react, sendText, type MessageEffect } from "@/lib/linq/send";

// A claim that scores something: react on the claiming message itself,
// alongside the text confirmation, instead of only ever replying with words.
const CLAIM_REACTION_EMOJI = "🔥";

async function reactToClaim(messageId: string | null | undefined): Promise<void> {
  if (!messageId) return;
  try {
    await react(messageId, { emoji: CLAIM_REACTION_EMOJI });
  } catch (err) {
    // A tapback is flavor, never load-bearing: losing it must not touch the
    // claim, the score, or the text confirmation already sent.
    console.error("[japlan.claim] reaction failed", { messageId, err });
  }
}

const TASK_COLS =
  "id, trip_id, participant_id, team_id, code, title, tier, axes_json, base_points, photo_bonus_max, verification, day, expires_at, neighborhood, source, slot, duration_minutes";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";
const CLAIM_COLS =
  "id, task_id, participant_id, evidence_url, image_hash, status, awarded_points, resolved_by, resolution_json, capped, photo_claimed_at, expires_at, created_at";

const recentCodeMentions = new Map<string, { code: string; at: number }>();

function mentionKey(chatId: string, phone: string): string {
  return `${chatId}:${phone}`;
}

export function rememberTaskMention(
  chatId: string,
  phone: string,
  code: string,
  at = Date.now(),
): void {
  recentCodeMentions.set(mentionKey(chatId, phone), { code, at });
}

export function recentCodeFor(
  chatId: string,
  phone: string,
  now = Date.now(),
): string | null {
  const entry = recentCodeMentions.get(mentionKey(chatId, phone));
  if (!entry) return null;
  if (now - entry.at > 60_000) {
    recentCodeMentions.delete(mentionKey(chatId, phone));
    return null;
  }
  return entry.code;
}

function claimStep(step: string, fields: Record<string, unknown> = {}): void {
  console.log("[japlan.claim] step", { step, ...fields });
}

function claimThrow(
  step: string,
  err: unknown,
  fields: Record<string, unknown> = {},
): never {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error("[japlan.claim] step", {
    step,
    ...fields,
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
  });
  throw error;
}

async function claimAwait<T>(
  step: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  claimStep(`${step}.before`, fields);
  // Yield so the .before line can flush before a hanging query kills the isolate.
  await Promise.resolve();
  try {
    const result = await run();
    claimStep(`${step}.after`, fields);
    return result;
  } catch (err) {
    claimThrow(`${step}.throw`, err, fields);
  }
}

type SendFn = (
  chatId: string,
  text: string,
  opts?: { effect?: MessageEffect },
) => Promise<{ messageId: string }>;

export type ClaimHandlerDeps = {
  send?: SendFn;
  provider?: LLMProvider;
  now?: number;
  // Dispatch found an awarded claim still inside the photo bonus window, so a
  // bare photo from this sender is addressed.
  photoBonusOpen?: boolean;
  // A DM from someone on a group trip: which trip chat the claim belongs to.
  // Replies go to the DM; the claim confirmation also goes to the group.
  tripChatId?: string;
  // The group is in a conversation with the bot: no keyword needed.
  engaged?: boolean;
};

export type ClaimFallthrough = {
  data: Record<string, unknown>;
  text: string;
  hasPhoto: boolean;
  photo: { url: string; mime: string } | null;
  claimant: ParticipantRow;
  // Teams whose claim window is still open (see splitTeamsByClaimWindow).
  claimantTeamIds: string[];
  people: ParticipantRow[];
  trip: TripRow;
  tasks: TaskRow[];
  claims: ClaimRow[];
  chatId: string;
  isDm: boolean;
  send: SendFn;
  provider?: LLMProvider;
  now?: number;
  // One clause naming the claimant's open codes, for replies that close something.
  nextStep: string;
  engaged?: boolean;
};

function asTasks(rows: unknown): TaskRow[] {
  return (rows ?? []) as TaskRow[];
}

function asParticipants(rows: unknown): ParticipantRow[] {
  return (rows ?? []) as ParticipantRow[];
}

function asClaims(rows: unknown): ClaimRow[] {
  return (rows ?? []) as ClaimRow[];
}

async function loadTripContext(chatId: string): Promise<{
  trip: TripRow;
  tasks: TaskRow[];
  people: ParticipantRow[];
  claims: ClaimRow[];
} | null> {
  claimStep("loadTripContext.enter", { chatId });
  const supabase = getServiceClient();
  claimStep("loadTripContext.client_ready", { chatId });

  const trip = await claimAwait("trip.lookup", { chatId }, () =>
    getTripByChatId(chatId),
  );
  if (!trip) {
    claimStep("trip.lookup.miss", { chatId });
    return null;
  }

  const tasksRes = await claimAwait(
    "tasks.lookup",
    { tripId: trip.id },
    async () => await supabase.from("tasks").select(TASK_COLS).eq("trip_id", trip.id),
  );
  if (tasksRes.error) throw tasksRes.error;
  const tasks = asTasks(tasksRes.data);
  claimStep("tasks.lookup.count", { tripId: trip.id, count: tasks.length });

  const peopleRes = await claimAwait(
    "people.lookup",
    { tripId: trip.id },
    async () =>
      await supabase
        .from("participants")
        .select(PARTICIPANT_COLS)
        .eq("trip_id", trip.id),
  );
  if (peopleRes.error) throw peopleRes.error;
  const people = asParticipants(peopleRes.data);
  claimStep("people.lookup.count", { tripId: trip.id, count: people.length });

  let claims: ClaimRow[] = [];
  if (tasks.length > 0) {
    const taskIds = tasks.map((task) => task.id);
    // Lapse pending_peer claims past end of their local day, so the task opens
    // up again and claims_one_winner_per_task stops blocking it.
    const sweep = await claimAwait(
      "peer_expiry.sweep",
      { tripId: trip.id },
      async () =>
        await supabase
          .from("claims")
          .update({ status: "expired" })
          .eq("status", "pending_peer")
          .lte("expires_at", new Date().toISOString())
          .in("task_id", taskIds),
    );
    if (sweep.error) throw sweep.error;
    const claimsRes = await claimAwait(
      "open_claims.lookup",
      { tripId: trip.id, taskCount: taskIds.length },
      async () =>
        await supabase.from("claims").select(CLAIM_COLS).in("task_id", taskIds),
    );
    if (claimsRes.error) throw claimsRes.error;
    claims = asClaims(claimsRes.data);
    claimStep("open_claims.lookup.count", {
      tripId: trip.id,
      count: claims.length,
    });
  } else {
    claimStep("open_claims.lookup.skip", { tripId: trip.id, reason: "no_tasks" });
  }

  claimStep("loadTripContext.exit", {
    chatId,
    tripId: trip.id,
    taskCount: tasks.length,
    peopleCount: people.length,
    claimCount: claims.length,
  });
  return {
    trip,
    tasks,
    people,
    claims,
  };
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const { data, error } = await getServiceClient()
    .from("team_members")
    .select("participant_id")
    .eq("team_id", teamId);
  if (error) throw error;
  return (data ?? []).map((row) => (row as { participant_id: string }).participant_id);
}

// Two flat queries, no embed: nested embeds are a suspect in the isolate hang.
async function teamMembershipsFor(participantId: string): Promise<TeamMembership[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("participant_id", participantId);
  if (error) throw error;
  const teamIds = (data ?? []).map((row) => (row as { team_id: string }).team_id);
  if (teamIds.length === 0) return [];
  const teams = await supabase
    .from("teams")
    .select("id, dissolved_at")
    .in("id", teamIds);
  if (teams.error) throw teams.error;
  return (teams.data ?? []).map((row) => {
    const team = row as { id: string; dissolved_at: string | null };
    return { teamId: team.id, dissolvedAt: team.dissolved_at };
  });
}

// The next-step clause for someone outside the claim flow (e.g. a DM).
export async function nextStepForParticipant(
  trip: TripRow,
  participantId: string,
): Promise<string> {
  const supabase = getServiceClient();
  const tasksRes = await supabase.from("tasks").select(TASK_COLS).eq("trip_id", trip.id);
  if (tasksRes.error) throw tasksRes.error;
  const tasks = asTasks(tasksRes.data);
  let claims: ClaimRow[] = [];
  if (tasks.length > 0) {
    const claimsRes = await supabase
      .from("claims")
      .select("task_id, status")
      .in("task_id", tasks.map((task) => task.id));
    if (claimsRes.error) throw claimsRes.error;
    claims = asClaims(claimsRes.data);
  }
  const teams = splitTeamsByClaimWindow(
    await teamMembershipsFor(participantId),
    trip.timezone,
    new Date(),
  );
  return nextStepClause(openCodesFor(tasks, claims, participantId, teams.active));
}

async function tripHashes(tripId: string): Promise<string[]> {
  const supabase = getServiceClient();
  const tasksRes = await claimAwait("photo_hash.tasks", { tripId }, async () =>
    await supabase.from("tasks").select("id").eq("trip_id", tripId),
  );
  if (tasksRes.error) throw tasksRes.error;
  const taskIds = (tasksRes.data ?? []).map((row) => (row as { id: string }).id);
  if (taskIds.length === 0) return [];
  const { data, error } = await claimAwait(
    "photo_hash.claims",
    { tripId, taskCount: taskIds.length },
    async () =>
      await supabase
        .from("claims")
        .select("image_hash")
        .in("task_id", taskIds)
        .not("image_hash", "is", null),
  );
  if (error) throw error;
  return (data ?? [])
    .map((row) => (row as { image_hash: string | null }).image_hash)
    .filter((value): value is string => Boolean(value));
}

async function existingClaimsForTask(taskId: string): Promise<ClaimRow[]> {
  const { data, error } = await claimAwait("already_claimed", { taskId }, async () =>
    await getServiceClient().from("claims").select(CLAIM_COLS).eq("task_id", taskId),
  );
  if (error) throw error;
  return asClaims(data);
}

export const DEFAULT_PHOTO_FETCH_TIMEOUT_MS = 10_000;

function photoFetchTimeoutMs(value = process.env.JAPLAN_PHOTO_FETCH_TIMEOUT_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PHOTO_FETCH_TIMEOUT_MS;
}

// Media URLs are signed and can carry tokens; log the host and path only.
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

async function fetchPhoto(url: string, reason: string): Promise<Buffer> {
  const ms = photoFetchTimeoutMs();
  const res = await claimAwait("photo.fetch", { reason, url: safeUrl(url), timeoutMs: ms }, () =>
    fetchWithTimeout(url, ms, "photo.fetch"),
  );
  claimStep("photo.fetch.response", {
    reason,
    status: res.status,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
  });
  if (!res.ok) throw new Error(`photo fetch HTTP ${res.status}`);
  const bytes = await claimAwait("photo.bytes", { reason }, () =>
    withTimeout(res.arrayBuffer(), ms, "photo.bytes"),
  );
  return Buffer.from(bytes);
}

type LoadedPhoto = {
  bytes: Buffer;
  hash: string;
  mime: string;
  takenAt: Date | null;
  // Upright and downscaled for the vision model (original if undecodable).
  vision: { data: string; mime: string };
};

// fetch -> sniff -> fingerprint -> EXIF, each step logged .before/.after.
// Undecodable images (HEIC) get an exact hash and a raw-bytes EXIF read
// rather than throwing, so a photo can never sink the claim it rides on.
async function loadPhoto(
  photo: { url: string; mime: string },
  reason: string,
): Promise<LoadedPhoto> {
  const bytes = await fetchPhoto(photo.url, reason);
  const sniffed = sniffImageMime(bytes);
  const mime = sniffed ?? (photo.mime.startsWith("image/") ? photo.mime : "image/jpeg");
  claimStep("photo.sniff", {
    reason,
    bytes: bytes.length,
    declaredMime: photo.mime || null,
    sniffedMime: sniffed,
    usingMime: mime,
  });
  const fingerprint = await claimAwait("photo.hash", { reason }, () =>
    imageFingerprint(bytes),
  );
  claimStep("photo.hash.kind", { reason, kind: fingerprint.kind });
  const takenAt = await claimAwait("photo.exif", { reason }, () => imageTakenAt(bytes));
  claimStep("photo.exif.result", { reason, takenAt: takenAt?.toISOString() ?? null });
  const prepared = await claimAwait("photo.prepare", { reason }, () => prepareForVision(bytes, mime));
  claimStep("photo.prepare.result", {
    reason,
    prepared: prepared.prepared,
    bytesIn: bytes.length,
    bytesOut: prepared.data.length,
    mime: prepared.mime,
  });
  return {
    bytes,
    hash: fingerprint.hash,
    mime,
    takenAt,
    vision: { data: prepared.data.toString("base64"), mime: prepared.mime },
  };
}

function taskCreatedOn(task: TaskRow, trip: TripRow): string | null {
  return task.created_at ? localDateString(new Date(task.created_at), trip.timezone) : null;
}

type VisionResult =
  | { status: "scored"; showsTask: boolean; fidelity: number }
  | { status: "failed"; error: string };

// A vision failure or timeout costs the bonus, never the claim.
async function scoreVision(opts: {
  provider?: LLMProvider;
  title: string;
  photoBonusMax: number;
  photo: LoadedPhoto;
  code: string;
  reason: string;
}): Promise<VisionResult> {
  try {
    const scored = await claimAwait(
      "gemini.vision",
      { code: opts.code, reason: opts.reason, mime: opts.photo.vision.mime },
      () =>
        scorePhotoFidelity({
          provider: opts.provider,
          title: opts.title,
          photoBonusMax: opts.photoBonusMax,
          image: opts.photo.vision,
        }),
    );
    if (!scored) {
      // An empty or unreadable answer is our failure, not a "no".
      claimStep("gemini.vision.unreadable", { code: opts.code, reason: opts.reason });
      return { status: "failed", error: "empty or unreadable vision response" };
    }
    claimStep("gemini.vision.raw", {
      code: opts.code,
      task: opts.title.slice(0, 120),
      seen: scored.seen,
      relates: scored.raw.relates.slice(0, 400),
      fidelity: scored.raw.fidelity?.slice(0, 200) ?? null,
    });
    const result: VisionResult = {
      status: "scored",
      showsTask: scored.shows_task,
      fidelity: scored.fidelity,
    };
    claimStep("gemini.vision.result", { code: opts.code, ...result });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    claimStep("gemini.vision.failed", { code: opts.code, reason: opts.reason, error });
    return { status: "failed", error };
  }
}

// score = score + delta in one statement; concurrent claims cannot lose a bump.
async function bumpScore(participantId: string, delta: number): Promise<number> {
  const { data, error } = await claimAwait(
    "score.increment",
    { participantId, delta },
    async () =>
      await getServiceClient().rpc("increment_participant_score", {
        p_participant_id: participantId,
        p_delta: delta,
      }),
  );
  if (error) throw error;
  if (typeof data !== "number") {
    throw new Error(`participant not found: ${participantId}`);
  }
  return data;
}

async function insertClaim(row: {
  task_id: string;
  participant_id: string;
  evidence_url: string | null;
  image_hash: string | null;
  status: string;
  awarded_points: number | null;
  resolved_by: string | null;
  resolution_json: unknown;
  capped?: boolean;
  photo_claimed_at?: string | null;
  // false only for team fanout rows; claims_one_winner_per_task keys on it.
  primary_claim?: boolean;
  // pending_peer only: when the claim lapses.
  expires_at?: string | null;
}): Promise<string> {
  const { data, error } = await claimAwait(
    "claim.insert",
    {
      taskId: row.task_id,
      participantId: row.participant_id,
      status: row.status,
    },
    async () =>
      await getServiceClient()
        .from("claims")
        .insert({
          ...row,
          capped: row.capped ?? false,
          primary_claim: row.primary_claim ?? true,
        })
        .select("id")
        .maybeSingle(),
  );
  if (error) {
    if (error.code === "23505") {
      const conflict = new Error("claim_conflict");
      (conflict as Error & { code: string }).code = "23505";
      throw conflict;
    }
    throw error;
  }
  if (!data) throw new Error("claim insert returned no row");
  return (data as { id: string }).id;
}

function isClaimConflict(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: string }).code === "23505"
  );
}

export async function postDailyBoard(tripId: string, send: SendFn = sendText): Promise<void> {
  const supabase = getServiceClient();
  const tripRes = await supabase
    .from("trips")
    .select("id, linq_chat_id, name, state")
    .eq("id", tripId)
    .maybeSingle();
  if (tripRes.error) throw tripRes.error;
  if (!tripRes.data) throw new Error(`trip not found: ${tripId}`);
  const trip = tripRes.data as { id: string; linq_chat_id: string };
  const [tasksRes, peopleRes] = await Promise.all([
    supabase.from("tasks").select("code, title, base_points, day").eq("trip_id", tripId),
    supabase.from("participants").select("id, display_name, score").eq("trip_id", tripId),
  ]);
  if (tasksRes.error) throw tasksRes.error;
  if (peopleRes.error) throw peopleRes.error;
  const tasks = (tasksRes.data ?? []) as {
    code: string;
    title: string;
    base_points: number;
    day: number;
  }[];
  const day = tasks[0]?.day ?? 1;
  const people = (peopleRes.data ?? []) as { id: string; display_name: string; score: number }[];
  const teams = await teamsWithMembers(tripId);
  const text = formatMorningStandings({
    day,
    standings: buildStandingsRows(people, teams),
  });
  await send(trip.linq_chat_id, text);
}

async function pointsAwardedOnDay(
  participantId: string,
  tripId: string,
  day: number,
): Promise<number> {
  const supabase = getServiceClient();
  const tasksRes = await claimAwait(
    "daily_cap.tasks",
    { participantId, tripId, day },
    async () =>
      await supabase.from("tasks").select("id").eq("trip_id", tripId).eq("day", day),
  );
  if (tasksRes.error) throw tasksRes.error;
  const taskIds = (tasksRes.data ?? []).map((row) => (row as { id: string }).id);
  if (taskIds.length === 0) return 0;
  const { data, error } = await claimAwait(
    "daily_cap.claims",
    { participantId, tripId, day, taskCount: taskIds.length },
    async () =>
      await supabase
        .from("claims")
        .select("awarded_points")
        .eq("participant_id", participantId)
        .eq("status", "awarded")
        .in("task_id", taskIds),
  );
  if (error) throw error;
  return (data ?? []).reduce(
    (sum, row) => sum + ((row as { awarded_points: number | null }).awarded_points ?? 0),
    0,
  );
}

async function individualClaimGroupUpdate(opts: {
  tripId: string;
  day: number;
  name: string;
  code: string;
  title: string;
  awardedPoints: number;
}): Promise<string> {
  const { data, error } = await getServiceClient()
    .from("participants")
    .select("id, display_name, score")
    .eq("trip_id", opts.tripId);
  if (error) throw error;
  const people = (data ?? []) as { id: string; display_name: string; score: number }[];
  const teams = await teamsWithMembers(opts.tripId);
  const label = opts.code || opts.title;
  const result = opts.awardedPoints > 0
    ? `🎯 ${opts.name} scored +${opts.awardedPoints} pts for ${label}.`
    : `✅ ${opts.name} finished ${label}; today's points cap held.`;
  const standings = formatMorningStandings({
    day: opts.day,
    standings: buildStandingsRows(people, teams),
  });
  return `${result}\n\n${standings}`;
}

async function applyAwards(opts: {
  task: TaskRow;
  claimant: ParticipantRow;
  people: ParticipantRow[];
  photoBonus: number;
  evidenceUrl: string | null;
  imageHash: string | null;
  resolvedBy: string;
  resolution: unknown;
  trip: TripRow;
  send: SendFn;
  photoClaimedAt?: string | null;
  // Fired once the claimant's primary row exists.
  onClaimWritten?: () => void;
  // A claim made by DM: the confirmation goes to the group (the scoreboard)
  // and to the DM (the answer to what they sent).
  alsoConfirmTo?: string | null;
  // The inbound message that made the claim, if known: reacted to alongside
  // the text confirmation.
  sourceMessageId?: string | null;
}): Promise<void> {
  const memberIds = opts.task.team_id
    ? Array.from(
        new Set([
          opts.claimant.id,
          ...(await claimAwait("team_members.lookup", { teamId: opts.task.team_id }, () =>
            teamMemberIds(opts.task.team_id as string),
          )),
        ]),
      )
    : [opts.claimant.id];
  // Claimant's primary row goes first: if another claim already won the task,
  // claims_one_winner_per_task rejects it before any fanout row or score bump.
  const rows = awardFanout({
    teamId: opts.task.team_id,
    claimantId: opts.claimant.id,
    teamMemberIds: memberIds,
    basePoints: opts.task.base_points,
    photoBonus: opts.photoBonus,
  }).sort(
    (a, b) =>
      Number(b.participantId === opts.claimant.id) -
      Number(a.participantId === opts.claimant.id),
  );
  const cap = opts.trip.daily_points_cap ?? DEFAULT_DAILY_POINTS_CAP;
  const confirmChatId = opts.trip.linq_chat_id;

  let claimantTotal = opts.claimant.score;
  let claimantCapped = false;
  let claimantAwardedPoints = 0;
  for (const row of rows) {
    const pointsToday = await claimAwait(
      "daily_cap",
      { participantId: row.participantId, tripId: opts.trip.id, day: opts.task.day },
      () => pointsAwardedOnDay(row.participantId, opts.trip.id, opts.task.day),
    );
    const capped = applyDailyPointsCap({
      pointsToday,
      incoming: row.points,
      cap,
    });
    const resolution: Record<string, unknown> =
      typeof opts.resolution === "object" && opts.resolution !== null
        ? { ...(opts.resolution as Record<string, unknown>), capped: capped.capped }
        : { capped: capped.capped };
    // The bonus this claim's photo earned, on the row, so the stats (and
    // anyone reading a dispute) can see it.
    if (opts.photoBonus > 0 && resolution.photo_bonus === undefined) resolution.photo_bonus = opts.photoBonus;
    await insertClaim({
      task_id: opts.task.id,
      participant_id: row.participantId,
      evidence_url: opts.evidenceUrl,
      image_hash: opts.imageHash,
      status: "awarded",
      awarded_points: capped.awarded_points,
      resolved_by: opts.resolvedBy,
      resolution_json: resolution,
      capped: capped.capped,
      photo_claimed_at: opts.photoClaimedAt ?? null,
      primary_claim: row.participantId === opts.claimant.id,
    });
    await recordClaimAwarded({
      tripId: opts.trip.id,
      participantId: row.participantId,
      task: opts.task,
      evidenceUrl: opts.evidenceUrl,
      resolution,
    });
    if (row.participantId === opts.claimant.id) opts.onClaimWritten?.();
    if (capped.awarded_points > 0) {
      const total = await bumpScore(row.participantId, capped.awarded_points);
      if (row.participantId === opts.claimant.id) claimantTotal = total;
    }
    if (row.participantId === opts.claimant.id) {
      claimantCapped = capped.capped;
      claimantAwardedPoints = capped.awarded_points;
    }
  }

  // A personal generated task may be the claimant's last open one. Count first
  // so the confirmation can say what comes next; the refill runs after it.
  const personalBoardTask =
    opts.task.participant_id === opts.claimant.id &&
    opts.task.source !== FREEFORM_SOURCE;
  let remainingOpenPersonal = 1;
  if (personalBoardTask) {
    remainingOpenPersonal = await countOpenPersonal(opts.trip.id, opts.claimant.id);
  }

  const name =
    opts.people.find((p) => p.id === opts.claimant.id)?.display_name ??
    opts.claimant.display_name;
  // Rare on purpose: only a claim that was genuinely worth it before the day
  // multiplier inflated it, and only when the claim actually paid out.
  const effect: MessageEffect | undefined =
    !claimantCapped && claimEarnsScreenEffect(opts.task.axes_json)
      ? { type: "screen", name: "fireworks" }
      : undefined;
  const confirmTo = [confirmChatId, ...(opts.alsoConfirmTo && opts.alsoConfirmTo !== confirmChatId ? [opts.alsoConfirmTo] : [])];
  const groupUpdate = opts.trip.play_mode === "individual" &&
    opts.alsoConfirmTo && opts.alsoConfirmTo !== confirmChatId
    ? await individualClaimGroupUpdate({
        tripId: opts.trip.id,
        day: opts.task.day,
        name,
        code: opts.task.code,
        title: opts.task.title,
        awardedPoints: claimantAwardedPoints,
      })
    : null;
  for (const target of confirmTo) {
    const text = target === confirmChatId && groupUpdate
      ? groupUpdate
      : claimConfirmedLine({
          code: opts.task.code,
          name,
          base: opts.task.base_points,
          photoBonus: claimantCapped ? 0 : opts.photoBonus,
          total: claimantTotal,
          capped: claimantCapped,
          invitePhoto:
            !claimantCapped &&
            !opts.photoClaimedAt &&
            photoBonusMaxFor(opts.task) > 0,
          boardCleared:
            personalBoardTask && !claimantCapped && remainingOpenPersonal === 0,
        });
    await claimAwait("outbound.confirm", { chatId: target, code: opts.task.code }, () =>
      opts.send(target, text, { effect }),
    );
  }
  console.info("[japlan.claim]", {
    task: opts.task.code,
    participant: opts.claimant.id,
    points: claimantCapped ? 0 : opts.task.base_points + opts.photoBonus,
    capped: claimantCapped,
    photo: Boolean(opts.evidenceUrl),
    at: new Date().toISOString(),
  });
  resetOffTopicOnClaim(confirmChatId);
  if (!claimantCapped) await reactToClaim(opts.sourceMessageId);

  if (personalBoardTask) {
    // The claim is already confirmed; a refill failure must not surface as a
    // second "something broke" message after the ✅.
    try {
      await claimAwait(
        "refill.generate",
        { remainingOpenPersonal },
        () =>
          refillPersonalTasksIfNeeded({
            trip: opts.trip,
            claimant: opts.claimant,
            people: opts.people,
            remainingOpenPersonal,
          }),
      );
    } catch (err) {
      console.error("[japlan.claim] refill failed after confirm", {
        participantId: opts.claimant.id,
        err,
      });
    }
  }
}

async function countOpenPersonal(tripId: string, participantId: string): Promise<number> {
  const { data: personal, error: personalErr } = await claimAwait(
    "refill.personal_tasks",
    { tripId, participantId },
    async () =>
      await getServiceClient()
        .from("tasks")
        .select("id, participant_id, source")
        .eq("trip_id", tripId)
        .eq("participant_id", participantId),
  );
  if (personalErr) throw personalErr;
  const { data: claimRows, error: claimErr } = await claimAwait(
    "refill.personal_claims",
    { participantId },
    async () =>
      await getServiceClient()
        .from("claims")
        .select("task_id, status")
        .eq("participant_id", participantId),
  );
  if (claimErr) throw claimErr;
  return openPersonalTaskIds(
    (personal ?? []) as {
      id: string;
      participant_id: string | null;
      source?: string | null;
    }[],
    (claimRows ?? []) as { task_id: string; status: string }[],
    participantId,
  ).length;
}

async function resolveKnownTask(opts: {
  task: TaskRow;
  claimant: ParticipantRow;
  claimantTeamIds: string[];
  people: ParticipantRow[];
  trip: TripRow;
  withPhoto: boolean;
  photo: { url: string; mime: string } | null;
  chatId: string;
  send: SendFn;
  provider?: LLMProvider;
  decision: ClaimDecision;
  photoBonusOverride?: number;
  nextStep: string;
  sourceMessageId?: string | null;
}): Promise<void> {
  // Safety net: callers already filter to claimable tasks, but never award a
  // task to someone it does not belong to.
  if (!canClaimTask(opts.task, opts.claimant.id, opts.claimantTeamIds)) {
    claimStep("ownership.reject", {
      code: opts.task.code,
      taskParticipant: opts.task.participant_id,
      taskTeam: opts.task.team_id,
    });
    await claimAwait("outbound.send", { reason: "not_your_task" }, () =>
      opts.send(opts.chatId, notYourTaskLine(opts.task.code, opts.nextStep)),
    );
    return;
  }

  const existing = await existingClaimsForTask(opts.task.id);
  const blocking = existing.filter(
    (c) => c.status === "awarded" || c.status === "pending_peer",
  );
  if (blocking.length > 0) {
    claimStep("already_claimed.hit", { code: opts.task.code });
    await claimAwait("outbound.send", { reason: "already_claimed" }, () =>
      opts.send(opts.chatId, alreadyClaimedLine(opts.task.code, opts.nextStep)),
    );
    return;
  }
  // A lapsed peer claim by this same person would trip the (task, participant)
  // unique index on the new claim; clear it first.
  const lapsed = existing.find(
    (c) => c.participant_id === opts.claimant.id && c.status === "expired",
  );
  if (lapsed) {
    const { error: lapsedErr } = await claimAwait(
      "claim.clear_lapsed",
      { claimId: lapsed.id },
      async () =>
        await getServiceClient()
          .from("claims")
          .delete()
          .eq("id", lapsed.id)
          .eq("status", "expired"),
    );
    if (lapsedErr) throw lapsedErr;
  }

  const codeDecision = opts.decision.type === "code";
  if (codeDecision && !opts.withPhoto) {
    claimStep("gemini.skip", {
      reason: "ladder_code_no_photo",
      code: opts.task.code,
      verification: opts.task.verification,
    });
  }

  let imageHash: string | null = null;
  let photoBonus = 0;
  let evidenceUrl: string | null = null;
  let loaded: LoadedPhoto | null = null;
  let photoClaimedAt: string | null = null;

  if (opts.withPhoto && opts.photo) {
    try {
      loaded = await loadPhoto(opts.photo, "code_with_photo");
    } catch (err) {
      // The code alone is a valid claim; a photo we cannot fetch only costs
      // the bonus.
      claimStep("photo.load_failed", {
        code: opts.task.code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (loaded && opts.photo) {
    evidenceUrl = opts.photo.url;
    imageHash = loaded.hash;
    const hashes = await tripHashes(opts.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await claimAwait("outbound.send", { reason: "reused_photo" }, () =>
        opts.send(opts.chatId, reusedPhotoLine()),
      );
      return;
    }
  }

  if (verificationRequiresPeer(opts.task.verification)) {
    // Take the task first so a lost race never posts a tapback prompt.
    let pendingId: string;
    try {
      pendingId = await insertClaim({
        task_id: opts.task.id,
        participant_id: opts.claimant.id,
        evidence_url: evidenceUrl,
        image_hash: imageHash,
        status: "pending_peer",
        awarded_points: null,
        resolved_by: "peer",
        resolution_json: {},
        expires_at: endOfLocalDayContaining(new Date(), opts.trip.timezone).toISOString(),
      });
    } catch (err) {
      if (!isClaimConflict(err)) throw err;
      await claimAwait("outbound.send", { reason: "claim_conflict" }, () =>
        opts.send(opts.chatId, alreadyClaimedLine(opts.task.code, opts.nextStep)),
      );
      return;
    }
    let sent: { messageId: string };
    try {
      sent = await claimAwait("outbound.send", { reason: "peer_confirm" }, () =>
        opts.send(
          opts.trip.linq_chat_id,
          peerConfirmLine({
            name: opts.claimant.display_name,
            code: opts.task.code,
            title: opts.task.title,
          }),
        ),
      );
    } catch (err) {
      // Nobody can tap back on a message that never went out; release the task.
      await getServiceClient().from("claims").delete().eq("id", pendingId);
      throw err;
    }
    const { error: peerErr } = await claimAwait(
      "claim.peer_message",
      { claimId: pendingId },
      async () =>
        await getServiceClient()
          .from("claims")
          .update({ resolution_json: { peer_message_id: sent.messageId } })
          .eq("id", pendingId),
    );
    if (peerErr) throw peerErr;
    return;
  }

  if (loaded && photoBonusMaxFor(opts.task) > 0) {
    const priorReject = existing.find(
      (c) =>
        c.participant_id === opts.claimant.id &&
        c.status === "rejected" &&
        c.resolved_by === "vision",
    );
    if (priorReject) {
      claimStep("photo_bonus.skip", { code: opts.task.code, reason: "prior_vision_reject" });
    } else {
      let scoredFidelity = opts.photoBonusOverride;
      if (scoredFidelity === undefined) {
        const vision = await scoreVision({
          provider: opts.provider,
          title: opts.task.title,
          photoBonusMax: photoBonusMaxFor(opts.task),
          photo: loaded,
          code: opts.task.code,
          reason: "code_with_photo",
        });
        if (vision.status === "scored" && vision.showsTask) {
          scoredFidelity = vision.fidelity;
        }
      }
      if (scoredFidelity !== undefined) {
        const bonus = applyPhotoBonusRules({
          fidelity: scoredFidelity,
          hasExif: Boolean(loaded.takenAt),
          takenAt: loaded.takenAt,
          tripStart: opts.trip.start_date,
          tripEnd: opts.trip.end_date,
          photoBonusMax: photoBonusMaxFor(opts.task),
          taskCreatedOn: taskCreatedOn(opts.task, opts.trip),
        });
        claimStep("photo_bonus.rules", {
          code: opts.task.code,
          fidelity: scoredFidelity,
          bonus: bonus.bonus,
          reject: bonus.reject,
        });
        if (!bonus.reject) {
          photoBonus = bonus.bonus;
          photoClaimedAt = new Date().toISOString();
        }
      }
    }
  }

  if (!photoClaimedAt) {
    evidenceUrl = null;
    imageHash = null;
  }

  try {
    await applyAwards({
      task: opts.task,
      claimant: opts.claimant,
      people: opts.people,
      photoBonus,
      evidenceUrl,
      imageHash,
      resolvedBy:
        opts.decision.type === "code"
          ? opts.decision.withPhoto
            ? "photo_code"
            : "code"
          : opts.task.verification,
      resolution: { ladder: opts.decision },
      trip: opts.trip,
      send: opts.send,
      photoClaimedAt,
      alsoConfirmTo: opts.chatId !== opts.trip.linq_chat_id ? opts.chatId : null,
      sourceMessageId: opts.sourceMessageId,
    });
  } catch (err) {
    if (isClaimConflict(err)) {
      await claimAwait("outbound.send", { reason: "claim_conflict" }, () =>
        opts.send(opts.chatId, alreadyClaimedLine(opts.task.code, opts.nextStep)),
      );
      return;
    }
    throw err;
  }
  // What people actually do moves their weights, a little each time.
  await learnFrom(opts.trip, opts.claimant.id, {
    dims: prefDimsFor(`${opts.task.title} ${opts.task.neighborhood ?? ""}`),
    direction: 1,
    why: `claimed ${opts.task.code}`,
  }).catch((err) => console.error("[japlan.profile] learn failed", err));
}

async function tryHandleFreeform(opts: {
  text: string;
  hasPhoto: boolean;
  photo: { url: string; mime: string } | null;
  claimant: ParticipantRow;
  people: ParticipantRow[];
  trip: TripRow;
  tasks: TaskRow[];
  claims: ClaimRow[];
  send: SendFn;
  provider?: LLMProvider;
  extraction?: FreeformExtraction | null;
  nextStep: string;
}): Promise<boolean> {
  if (isLikelyUncompletedActivity(opts.text)) {
    claimStep("freeform.not_completed", { participantId: opts.claimant.id });
    return false;
  }

  // No one-freeform-a-day quota: PLAN has no such rule, and points are
  // already bounded by the daily cap. Real refusals (unsafe, illegal, a repeat
  // of something already done) are below.
  const day = currentTripDay(opts.trip, new Date());

  let extracted = opts.extraction ?? null;
  if (!extracted) {
    if (!opts.text.trim()) return false;
    const raw = await claimAwait("gemini.extractFreeform", {}, () =>
      extractFreeformActivity({
        provider: opts.provider,
        text: opts.text,
      }),
    );
    extracted = parseFreeformExtraction(raw);
  }
  if (!extracted) return false;

  const completed = opts.tasks
    .filter((task) =>
      opts.claims.some(
        (claim) =>
          claim.task_id === task.id &&
          claim.status === "awarded" &&
          claim.participant_id === opts.claimant.id,
      ),
    )
    .map((task) => task.title);
  const proposed = {
    code: "",
    title: extracted.title,
    axes: extracted.axes,
    verification: "peer" as const,
    photo_bonus_max: FREEFORM_PHOTO_BONUS_MAX,
    neighborhood: extracted.neighborhood || extracted.place_name || "",
    participantId: opts.claimant.id,
    teamId: null,
    source: "freeform" as const,
  };
  const reason = validateGeneratedTask(proposed, {
    assignees: [
      { answers: (opts.claimant.survey_json ?? {}) as SurveyAnswers },
    ],
    completedTitles: completed,
  });
  if (reason === "unsafe" || reason === "illegal" || reason === "duplicate") {
    await opts.send(opts.trip.linq_chat_id, freeformRejectedLine(opts.nextStep));
    return true;
  }

  const tripDays = tripLengthDays(opts.trip.start_date, opts.trip.end_date);
  const scored = pointsForFreeform(extracted.axes, { day, tripDays });
  const freeformBonusMax = clampPhotoBonusMax(FREEFORM_PHOTO_BONUS_MAX, scored.points).value;
  const verification = verificationForSolo(
    "peer",
    Boolean(opts.trip.is_solo),
  );
  // Photo checks come before the task insert: a reused photo used to leave an
  // orphaned X-code task on the board that anyone could claim.
  let imageHash: string | null = null;
  let evidenceUrl: string | null = null;
  let photoBonus = 0;
  let loaded: LoadedPhoto | null = null;
  if (opts.hasPhoto && opts.photo) {
    try {
      loaded = await loadPhoto(opts.photo, "freeform");
    } catch (err) {
      claimStep("photo.load_failed", {
        reason: "freeform",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (loaded && opts.photo) {
    evidenceUrl = opts.photo.url;
    imageHash = loaded.hash;
    const hashes = await tripHashes(opts.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await opts.send(opts.trip.linq_chat_id, reusedPhotoLine());
      return true;
    }
    const takenAt = loaded.takenAt;
    const vision = await scoreVision({
      provider: opts.provider,
      title: extracted.title,
      photoBonusMax: freeformBonusMax,
      photo: loaded,
      code: "freeform",
      reason: "freeform",
    });
    if (vision.status === "scored" && vision.showsTask) {
      const bonus = applyPhotoBonusRules({
        fidelity: vision.fidelity,
        hasExif: Boolean(takenAt),
        takenAt,
        tripStart: opts.trip.start_date,
        tripEnd: opts.trip.end_date,
        taskCreatedOn: localDateString(new Date(), opts.trip.timezone),
      });
      if (!bonus.reject) {
        photoBonus = Math.min(bonus.bonus, freeformBonusMax);
      }
    }
  }

  const code = nextFreeformCode(opts.tasks.map((task) => task.code));
  const { data: inserted, error: insertErr } = await claimAwait(
    "freeform.task_insert",
    { code },
    async () =>
      await getServiceClient()
        .from("tasks")
        .insert({
          trip_id: opts.trip.id,
          participant_id: opts.claimant.id,
          team_id: null,
          code,
          title: extracted.title,
          tier: scored.tier,
          axes_json: extracted.axes,
          base_points: scored.points,
          photo_bonus_max: freeformBonusMax,
          verification,
          day,
          neighborhood: extracted.neighborhood || extracted.place_name || null,
          source: FREEFORM_SOURCE,
        })
        .select(TASK_COLS)
        .maybeSingle(),
  );
  if (insertErr) throw insertErr;
  if (!inserted) throw new Error("freeform task insert returned no row");
  const task = inserted as TaskRow;

  // Nothing after this point may leave the task without a claim: if any step
  // fails before the claim row exists, delete the task.
  let claimWritten = false;
  try {
    if (verification === "peer") {
      const pendingId = await insertClaim({
        task_id: task.id,
        participant_id: opts.claimant.id,
        evidence_url: evidenceUrl,
        image_hash: imageHash,
        status: "pending_peer",
        awarded_points: null,
        resolved_by: "peer",
        resolution_json: { photoBonus },
        expires_at: endOfLocalDayContaining(new Date(), opts.trip.timezone).toISOString(),
      });
      claimWritten = true;
      const sent = await opts.send(
        opts.trip.linq_chat_id,
        freeformPeerLine({
          name: opts.claimant.display_name,
          title: extracted.title,
          code,
        }),
      );
      const { error: peerErr } = await getServiceClient()
        .from("claims")
        .update({ resolution_json: { peer_message_id: sent.messageId, photoBonus } })
        .eq("id", pendingId);
      if (peerErr) throw peerErr;
    } else {
      await applyAwards({
        task,
        claimant: opts.claimant,
        people: opts.people,
        photoBonus,
        evidenceUrl,
        imageHash,
        resolvedBy: "freeform",
        resolution: { freeform: true },
        trip: opts.trip,
        send: opts.send,
        onClaimWritten: () => {
          claimWritten = true;
        },
      });
    }
  } catch (err) {
    // A task with a claim row is owned and not orphaned (a stuck pending_peer
    // lapses at end of day). Only a task with no claim at all is removed.
    if (!claimWritten) await rollbackFreeformTask(task.id);
    throw err;
  }

  if (extracted.place_name) {
    const { error: placeErr } = await getServiceClient().from("places").insert({
      trip_id: opts.trip.id,
      name: extracted.place_name,
      lat: extracted.lat,
      lng: extracted.lng,
      category: extracted.category,
      source: FREEFORM_SOURCE,
      suggested_by: opts.claimant.id,
    });
    if (placeErr) {
      console.error("[japlan.freeform] place insert failed", placeErr);
    }
  }
  return true;
}

async function rollbackFreeformTask(taskId: string): Promise<void> {
  console.error("[japlan.freeform] rolling back unclaimed task", { taskId });
  const { error } = await getServiceClient().from("tasks").delete().eq("id", taskId);
  if (error) console.error("[japlan.freeform] rollback task failed", error);
}

export async function submitFreeformClaim(opts: {
  text: string;
  hasPhoto: boolean;
  photo: { url: string; mime: string } | null;
  claimant: ParticipantRow;
  people: ParticipantRow[];
  trip: TripRow;
  tasks: TaskRow[];
  claims: ClaimRow[];
  send: SendFn;
  provider?: LLMProvider;
  extraction?: FreeformExtraction | null;
  nextStep: string;
}): Promise<boolean> {
  return tryHandleFreeform(opts);
}

export async function applyLatePhotoBonus(opts: {
  task: TaskRow;
  claim: ClaimRow;
  claimant: ParticipantRow;
  trip: TripRow;
  photo: { url: string; mime: string };
  send: SendFn;
  provider?: LLMProvider;
  alsoConfirmTo?: string | null;
}): Promise<void> {
  claimStep("photo_bonus.late", { code: opts.task.code, claimId: opts.claim.id });
  if (opts.claim.capped) {
    claimStep("photo_bonus.already_capped", { code: opts.task.code });
    const { error } = await getServiceClient()
      .from("claims")
      .update({ photo_claimed_at: new Date().toISOString() })
      .eq("id", opts.claim.id);
    if (error) throw error;
    await claimAwait("outbound.send", { reason: "photo_capped" }, () =>
      opts.send(
        opts.trip.linq_chat_id,
        photoBonusLine({
          code: opts.task.code,
          bonus: 0,
          total: opts.claimant.score,
          capped: true,
        }),
      ),
    );
    return;
  }
  let loaded: LoadedPhoto;
  try {
    loaded = await loadPhoto(opts.photo, "late_bonus");
  } catch (err) {
    claimStep("photo.load_failed", {
      code: opts.task.code,
      reason: "late_bonus",
      error: err instanceof Error ? err.message : String(err),
    });
    await claimAwait("outbound.send", { reason: "photo_unreadable" }, () =>
      opts.send(opts.trip.linq_chat_id, photoCheckFailedLine(opts.task.code)),
    );
    return;
  }
  const imageHash = loaded.hash;
  const hashes = await tripHashes(opts.trip.id);
  if (hashAlreadyUsed(hashes, imageHash)) {
    await claimAwait("outbound.send", { reason: "reused_photo" }, () =>
      opts.send(opts.trip.linq_chat_id, reusedPhotoLine()),
    );
    return;
  }
  const takenAt = loaded.takenAt;
  const vision = await scoreVision({
    provider: opts.provider,
    title: opts.task.title,
    photoBonusMax: photoBonusMaxFor(opts.task),
    photo: loaded,
    code: opts.task.code,
    reason: "late_bonus",
  });
  if (vision.status === "failed") {
    await claimAwait("outbound.send", { reason: "vision_failed" }, () =>
      opts.send(opts.trip.linq_chat_id, photoCheckFailedLine(opts.task.code)),
    );
    return;
  }
  if (!vision.showsTask) {
    claimStep("photo_bonus.no_match", { code: opts.task.code });
    await claimAwait("outbound.send", { reason: "photo_no_match" }, () =>
      opts.send(opts.trip.linq_chat_id, visionRejectedLine(opts.task.code)),
    );
    return;
  }
  const bonus = applyPhotoBonusRules({
    fidelity: vision.fidelity,
    hasExif: Boolean(takenAt),
    takenAt,
    tripStart: opts.trip.start_date,
    tripEnd: opts.trip.end_date,
    photoBonusMax: photoBonusMaxFor(opts.task),
    taskCreatedOn: taskCreatedOn(opts.task, opts.trip),
  });
  if (bonus.reject) {
    claimStep("photo_bonus.exif_reject", { code: opts.task.code });
    await claimAwait("outbound.send", { reason: "photo_outside_trip" }, () =>
      opts.send(opts.trip.linq_chat_id, photoOutsideTripLine(opts.task.code)),
    );
    return;
  }
  const incoming = clampPhotoBonus(bonus.bonus, photoBonusMaxFor(opts.task));
  const cap = opts.trip.daily_points_cap ?? DEFAULT_DAILY_POINTS_CAP;
  const memberIds = opts.task.team_id
    ? Array.from(
        new Set([
          opts.claimant.id,
          ...(await teamMemberIds(opts.task.team_id)),
        ]),
      )
    : [opts.claimant.id];

  let claimantTotal = opts.claimant.score;
  let claimantCapped = false;
  let claimantAwardedBonus = 0;
  const claimedAt = new Date().toISOString();
  for (const participantId of memberIds) {
    const pointsToday = await pointsAwardedOnDay(
      participantId,
      opts.trip.id,
      opts.task.day,
    );
    const capped = applyDailyPointsCap({
      pointsToday,
      incoming,
      cap,
    });
    const { data: memberClaim, error: lookupErr } = await getServiceClient()
      .from("claims")
      .select(CLAIM_COLS)
      .eq("task_id", opts.task.id)
      .eq("participant_id", participantId)
      .eq("status", "awarded")
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    const prior = (memberClaim as ClaimRow | null)?.awarded_points ?? 0;
    const { error } = await claimAwait(
      "photo_bonus.write",
      { code: opts.task.code, participantId, bonus: capped.awarded_points },
      async () =>
        await getServiceClient()
          .from("claims")
          .update({
            awarded_points: prior + capped.awarded_points,
            evidence_url: opts.photo.url,
            image_hash: imageHash,
            photo_claimed_at: claimedAt,
            capped: Boolean((memberClaim as ClaimRow | null)?.capped) || capped.capped,
            resolution_json: {
              ...(((memberClaim as ClaimRow | null)?.resolution_json as
                | Record<string, unknown>
                | null) ?? {}),
              photo_bonus: capped.awarded_points,
              photo_capped: capped.capped,
            },
          })
          .eq("task_id", opts.task.id)
          .eq("participant_id", participantId)
          .eq("status", "awarded"),
    );
    if (error) throw error;
    // The claim now carries a photo (if it did not already) and, when it
    // paid, a bonus: the same facts the row now stores.
    await bumpStats(opts.trip.id, participantId, {
      photos_submitted: (memberClaim as ClaimRow | null)?.evidence_url ? 0 : 1,
      photo_bonuses_earned: capped.awarded_points > 0 ? 1 : 0,
    });
    if (capped.awarded_points > 0) {
      const total = await bumpScore(participantId, capped.awarded_points);
      if (participantId === opts.claimant.id) claimantTotal = total;
    }
    if (participantId === opts.claimant.id) {
      claimantCapped = capped.capped;
      claimantAwardedBonus = capped.awarded_points;
    }
  }

  if (incoming === 0 && !claimantCapped) {
    // Matched, but fidelity scored 0: still answer the photo.
    await claimAwait("outbound.send", { reason: "photo_zero" }, () =>
      opts.send(opts.trip.linq_chat_id, visionRejectedLine(opts.task.code)),
    );
    return;
  }

  const groupUpdate = opts.trip.play_mode === "individual" && opts.alsoConfirmTo
    ? await individualClaimGroupUpdate({
        tripId: opts.trip.id,
        day: opts.task.day,
        name: opts.claimant.display_name,
        code: opts.task.code,
        title: opts.task.title,
        awardedPoints: claimantAwardedBonus,
      })
    : null;
  const targets = [opts.trip.linq_chat_id, ...(opts.alsoConfirmTo && opts.alsoConfirmTo !== opts.trip.linq_chat_id ? [opts.alsoConfirmTo] : [])];
  for (const target of targets) {
    const text = target === opts.trip.linq_chat_id && groupUpdate
      ? groupUpdate
      : photoBonusLine({
        code: opts.task.code,
        bonus: claimantCapped ? 0 : incoming,
        total: claimantTotal,
        capped: claimantCapped,
      });
    await claimAwait("outbound.confirm", { reason: "photo_bonus", code: opts.task.code, chatId: target }, () =>
      opts.send(target, text),
    );
  }
}

// Whether a bare photo from this sender should count as addressed: they have
// an awarded claim, inside the bonus window, on a task that pays a photo
// bonus, with no photo yet. This replaces the 60s in-memory code binding for
// the late-photo case; that memory is per isolate and far shorter than the
// bonus window, so a photo sent minutes later used to be dropped as chat.
export async function photoBonusOpenFor(
  chatId: string,
  phone: string,
  now = Date.now(),
): Promise<boolean> {
  const trip = await claimAwait("photo_bonus.window.trip", { chatId }, () =>
    getTripByChatId(chatId),
  );
  if (!trip) return false;
  const participant = await claimAwait("photo_bonus.window.participant", { tripId: trip.id }, () =>
    findParticipantOnTrip(trip.id, phone),
  );
  if (!participant) return false;
  const since = new Date(now - photoBonusWindowMs()).toISOString();
  const { data: claimRows, error } = await claimAwait(
    "photo_bonus.window.claims",
    { participantId: participant.id, since },
    async () =>
      await getServiceClient()
        .from("claims")
        .select("task_id")
        .eq("participant_id", participant.id)
        .eq("status", "awarded")
        .is("photo_claimed_at", null)
        .gte("created_at", since),
  );
  if (error) throw error;
  const taskIds = (claimRows ?? []).map((row) => (row as { task_id: string }).task_id);
  if (taskIds.length === 0) return false;
  const { data: bonusTasks, error: taskErr } = await claimAwait(
    "photo_bonus.window.tasks",
    { count: taskIds.length },
    async () =>
      await getServiceClient()
        .from("tasks")
        .select("id")
        .in("id", taskIds)
        .gt("photo_bonus_max", 0),
  );
  if (taskErr) throw taskErr;
  return (bonusTasks ?? []).length > 0;
}

export async function handleGroupClaim(
  data: Record<string, unknown>,
  deps: ClaimHandlerDeps = {},
): Promise<ClaimFallthrough | null> {
  claimStep("handler.enter");
  try {
    const fallthrough = await handleGroupClaimInner(data, deps);
    claimStep("handler.exit");
    return fallthrough ?? null;
  } catch (err) {
    claimThrow("handler.throw", err);
  }
}

async function handleGroupClaimInner(
  data: Record<string, unknown>,
  deps: ClaimHandlerDeps,
): Promise<ClaimFallthrough | null | undefined> {
  const send = deps.send ?? sendText;
  const chatId = chatIdFromData(data);
  if (!chatId) {
    claimStep("handler.no_chat");
    return;
  }
  const sourceMessageId = typeof data.id === "string" ? data.id : null;

  const sender = senderFromData(data);
  if (!sender) {
    claimStep("handler.no_sender");
    return;
  }
  const text = textFromParts(data.parts);
  const media = photoPartsFrom(data.parts);
  const hasPhoto = media.length > 0;
  const photo = media[0] ?? null;
  claimStep("photo.detect", {
    hasPhoto,
    mime: photo?.mime ?? null,
    photoBonusOpen: Boolean(deps.photoBonusOpen),
  });
  const isDm = isDirectChat(data);
  const recentCode = recentCodeFor(chatId, sender.handle, deps.now);
  const codeMatch = findTaskCode(text);
  const codeInText = codeMatch?.code ?? null;
  // Loose codes ("see you b4 dinner") are only remembered once they resolve.
  if (codeMatch?.strict) {
    rememberTaskMention(chatId, sender.handle, codeMatch.code, deps.now);
  }
  const address = evaluateAddress({
    text,
    isDm,
    openTaskContext: hasPhoto && (Boolean(recentCode) || Boolean(deps.photoBonusOpen)),
    engaged: deps.engaged,
  });
  // Addressed only by a loose code: silent unless it is the sender's own task.
  const tentative = address.reason === "loose_task_code";
  claimStep("handler.parsed", {
    chatId,
    hasPhoto,
    codeInText,
    tentative,
    textPreview: text.slice(0, 80),
  });
  await Promise.resolve();
  claimStep("loadTripContext.call", { chatId });

  const ctx = await loadTripContext(deps.tripChatId ?? chatId);
  if (!ctx) {
    claimStep("trip.context.miss", { chatId, tentative });
    if (!tentative) {
      const latest = await claimAwait("trip.latest", { chatId }, () =>
        getLatestTripByChatId(chatId),
      );
      const line = latest?.state === "complete" ? TRIP_OVER_LINE : tripNotReadyLine();
      await claimAwait("outbound.send", { reason: "no_open_trip" }, () => send(chatId, line));
    }
    return null;
  }
  const claimant = await claimAwait(
    "participant.lookup",
    { tripId: ctx.trip.id, phone: sender.handle },
    () => findParticipantOnTrip(ctx.trip.id, sender.handle),
  );
  if (!claimant) {
    claimStep("participant.lookup.miss", {
      tripId: ctx.trip.id,
      phone: sender.handle,
      tentative,
    });
    if (!tentative) {
      await claimAwait("outbound.send", { reason: "not_on_trip" }, () =>
        send(chatId, notOnTripLine()),
      );
    }
    return null;
  }
  const memberships = await claimAwait(
    "team_membership.lookup",
    { participantId: claimant.id },
    () => teamMembershipsFor(claimant.id),
  );
  const teams = splitTeamsByClaimWindow(
    memberships,
    ctx.trip.timezone,
    new Date(deps.now ?? Date.now()),
  );
  const claimantTeamIds = teams.active;
  // Codes repeat per owner, so everything below works on the claimant's tasks.
  const claimable = tasksClaimableBy(ctx.tasks, claimant.id, claimantTeamIds);
  const nextStep = nextStepClause(
    openCodesFor(ctx.tasks, ctx.claims, claimant.id, claimantTeamIds),
  );

  const miss = (): ClaimFallthrough => ({
    data,
    text,
    hasPhoto,
    photo,
    claimant,
    claimantTeamIds,
    people: ctx.people,
    trip: ctx.trip,
    tasks: ctx.tasks,
    claims: ctx.claims,
    chatId,
    isDm,
    send,
    provider: deps.provider,
    now: deps.now,
    nextStep,
    engaged: deps.engaged,
  });

  if (hasPhoto && photo) {
    const bind = pickLatePhotoTarget({
      hasPhoto: true,
      code: codeInText ?? recentCode,
      claimantId: claimant.id,
      claims: ctx.claims,
      tasks: claimable,
      now: deps.now ?? Date.now(),
      windowMs: photoBonusWindowMs(),
    });
    claimStep("photo_bonus.bind", { kind: bind.kind, code: codeInText ?? recentCode });
    if (bind.kind === "already_bonused") {
      const code = (codeInText ?? recentCode) as string;
      await claimAwait("outbound.send", { reason: "already_bonused" }, () =>
        send(chatId, photoAlreadyBonusedLine(code, nextStep)),
      );
      return null;
    }
    if (bind.kind === "bonus") {
      const task = ctx.tasks.find((row) => row.id === bind.taskId);
      const claim = ctx.claims.find((row) => row.id === bind.claimId);
      if (task && claim) {
        await applyLatePhotoBonus({
          task,
          claim,
          claimant,
          trip: ctx.trip,
          photo,
          send,
          provider: deps.provider,
          alsoConfirmTo: chatId !== ctx.trip.linq_chat_id ? chatId : null,
        });
        return null;
      }
    }
  }

  const openTasks = claimable.filter((task) => isOpenTask(task.id, ctx.claims));

  const decision = decideClaim({
    text,
    hasPhoto,
    recentCode,
    isDm,
    openTaskContext: hasPhoto && Boolean(recentCode),
    address,
  });
  claimStep("decision", {
    type: decision.type,
    step: decision.type === "code" ? decision.step : null,
    code: decision.type === "code" ? decision.code : null,
    withPhoto: decision.type === "code" ? decision.withPhoto : hasPhoto,
    taskCount: ctx.tasks.length,
    openCount: openTasks.length,
  });

  if (
    decision.type === "code" &&
    !isDm &&
    (ctx.trip.play_mode === "individual" || ctx.trip.play_mode === "teams")
  ) {
    await send(chatId, PRIVATE_BOARD_CLAIM_IN_DM_LINE);
    return null;
  }

  if (decision.type === "code" && isDm && ctx.trip.play_mode === "full_group") {
    await send(chatId, SHARED_BOARD_CLAIM_IN_GROUP_LINE);
    return null;
  }

  if (decision.type === "silent") {
    claimStep("decision.silent", {
      reason: decision.reason,
    });
    if (decision.reason === "no_match") return miss();
    return null;
  }

  if (decision.type === "code") {
    claimStep("task.lookup.before", { code: decision.code });
    const lookup = findTaskByCodeFor(
      ctx.tasks,
      decision.code,
      claimant.id,
      claimantTeamIds,
      teams.expired,
    );
    const task = lookup.kind === "task" ? lookup.task : undefined;
    claimStep("task.lookup.after", {
      code: decision.code,
      result: lookup.kind,
      tentative: decision.tentative,
      verification: task?.verification ?? null,
      taskId: task?.id ?? null,
    });
    if (!task && decision.tentative) {
      // "see you b4 dinner": b4 is not this person's task, so it was chat.
      claimStep("task.lookup.tentative_miss", { code: decision.code });
      return null;
    }
    if (lookup.kind === "not_yours") {
      await claimAwait("outbound.send", { reason: "not_your_task" }, () =>
        send(chatId, notYourTaskLine(decision.code, nextStep)),
      );
      return null;
    }
    if (lookup.kind === "team_expired") {
      await claimAwait("outbound.send", { reason: "team_expired" }, () =>
        send(chatId, teamTaskExpiredLine(decision.code, nextStep)),
      );
      return null;
    }
    if (!task) {
      claimStep("task.lookup.miss", {
        code: decision.code,
        knownCodes: claimable.map((t) => t.code),
      });
      await claimAwait("outbound.send", { reason: "unknown_code" }, () =>
        send(chatId, unknownCodeLine(decision.code, nextStep)),
      );
      return null;
    }
    if (decision.tentative) {
      rememberTaskMention(chatId, sender.handle, task.code, deps.now);
    }
    claimStep("gemini.skip", {
      reason: "ladder_step_1_or_2_code",
      code: decision.code,
      step: decision.step,
    });
    await resolveKnownTask({
      task,
      claimant,
      claimantTeamIds,
      nextStep,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: decision.withPhoto,
      photo,
      chatId,
      send,
      provider: decision.withPhoto ? deps.provider : undefined,
      decision,
      sourceMessageId,
    });
    return;
  }

  if (decision.type === "fuzzy") {
    // "give me the first day plans" asks for the board; it is not a claim.
    // Straight to the conversation layer, which answers without a model.
    if (isBoardRequest(decision.text) || isRedoRequest(decision.text)) {
      claimStep("fuzzy.skip", { reason: "board_request" });
      return miss();
    }
    const match = await claimAwait(
      "gemini.matchClaimText",
      { textPreview: decision.text.slice(0, 80) },
      () =>
        matchClaimText({
          provider: deps.provider,
          text: decision.text,
          tasks: openTasks.map((t) => ({ code: t.code, title: t.title })),
        }),
    );
    if (
      !match ||
      match.confidence < CLAIM_MATCH_CONFIDENCE_MIN ||
      !match.task_code
    ) {
      return miss();
    }
    const task = openTasks.find(
      (t) => t.code.toUpperCase() === match.task_code.toUpperCase(),
    );
    if (!task) return miss();
    await resolveKnownTask({
      task,
      claimant,
      claimantTeamIds,
      nextStep,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: hasPhoto,
      photo,
      chatId,
      send,
      provider: deps.provider,
      decision,
      sourceMessageId,
    });
    return;
  }

  if (decision.type === "vision") {
    if (!photo) return miss();
    let loaded: LoadedPhoto;
    try {
      loaded = await loadPhoto(photo, "vision_scan");
    } catch (err) {
      claimStep("photo.load_failed", {
        reason: "vision_scan",
        error: err instanceof Error ? err.message : String(err),
      });
      return miss();
    }
    const hashes = await tripHashes(ctx.trip.id);
    if (hashAlreadyUsed(hashes, loaded.hash)) {
      await claimAwait("outbound.send", { reason: "reused_photo" }, () =>
        send(chatId, reusedPhotoLine()),
      );
      return;
    }
    const scored: { code: string; fidelity: number }[] = [];
    for (const task of openTasks.filter((t) => photoBonusMaxFor(t) > 0)) {
      const result = await scoreVision({
        provider: deps.provider,
        title: task.title,
        photoBonusMax: photoBonusMaxFor(task),
        photo: loaded,
        code: task.code,
        reason: "vision_scan",
      });
      if (result.status === "scored" && result.showsTask) {
        scored.push({ code: task.code, fidelity: result.fidelity });
      }
    }
    if (scored.length === 0) {
      return miss();
    }
    if (scored.length > 1) {
      await claimAwait("outbound.send", { reason: "two_match" }, () =>
        send(chatId, twoMatchAskLine(scored[0].code, scored[1].code)),
      );
      return;
    }
    const task = openTasks.find((t) => t.code === scored[0].code);
    if (!task) return miss();
    await resolveKnownTask({
      task,
      claimant,
      claimantTeamIds,
      nextStep,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: true,
      photo,
      chatId,
      send,
      provider: deps.provider,
      decision,
      photoBonusOverride: scored[0].fidelity,
      sourceMessageId,
    });
    return null;
  }

  return miss();
}

export async function handlePeerReaction(
  data: Record<string, unknown>,
  deps: ClaimHandlerDeps = {},
): Promise<void> {
  const send = deps.send ?? sendText;
  const reactionType = typeof data.reaction_type === "string" ? data.reaction_type : "";
  if (reactionType !== "like" && reactionType !== "love") return;
  if (data.is_from_me === true) return;

  const messageId = typeof data.message_id === "string" ? data.message_id : null;
  const chatId = chatIdFromData(data);
  if (!messageId || !chatId) return;

  const fromHandle =
    data.from_handle && typeof data.from_handle === "object"
      ? (data.from_handle as { handle?: string }).handle
      : typeof data.from === "string"
        ? data.from
        : null;

  const peerLog = (outcome: string, fields: Record<string, unknown> = {}) =>
    console.info("[japlan.reaction] peer", { outcome, messageId, chatId, ...fields });

  const { data: rows, error } = await getServiceClient()
    .from("claims")
    .select(CLAIM_COLS)
    .eq("status", "pending_peer");
  if (error) throw error;
  const pending = asClaims(rows).find((claim) => {
    const json = claim.resolution_json as { peer_message_id?: string } | null;
    return json?.peer_message_id === messageId;
  });
  if (!pending) {
    peerLog("no_pending_claim_for_message");
    return;
  }
  if (pending.expires_at && Date.parse(pending.expires_at) <= Date.now()) {
    peerLog("pending_claim_lapsed", { claimId: pending.id });
    return;
  }

  const { data: taskRow, error: taskErr } = await getServiceClient()
    .from("tasks")
    .select(TASK_COLS)
    .eq("id", pending.task_id)
    .maybeSingle();
  if (taskErr) throw taskErr;
  if (!taskRow) return;
  const task = taskRow as TaskRow;

  const ctx = await loadTripContext(chatId);
  if (!ctx) return;
  const claimant = ctx.people.find((p) => p.id === pending.participant_id);
  if (!claimant) return;
  if (isClaimantTapback(fromHandle ?? null, claimant.phone)) {
    peerLog("self_tapback_ignored", { claimId: pending.id });
    return;
  }

  // Only the call that actually removes the pending row may award it, so two
  // tapbacks on one prompt cannot both pay.
  const { data: removed, error: delErr } = await getServiceClient()
    .from("claims")
    .delete()
    .eq("id", pending.id)
    .eq("status", "pending_peer")
    .select("id");
  if (delErr) throw delErr;
  if (!removed || removed.length === 0) {
    peerLog("already_resolved_or_lapsed", { claimId: pending.id });
    return;
  }
  peerLog("confirmed", { claimId: pending.id, code: task.code });

  const pendingJson = pending.resolution_json as {
    peer_message_id?: string;
    photoBonus?: number;
  } | null;
  await applyAwards({
    task,
    claimant,
    people: ctx.people,
    photoBonus: pendingJson?.photoBonus ?? 0,
    evidenceUrl: pending.evidence_url,
    imageHash: pending.image_hash,
    resolvedBy: "peer",
    resolution: { peer_message_id: messageId },
    trip: ctx.trip,
    send,
  });
}
