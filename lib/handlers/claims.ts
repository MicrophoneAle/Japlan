import { getServiceClient } from "@/lib/db/client";
import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { formatMorningStandings } from "@/lib/game/board";
import {
  CLAIM_MATCH_CONFIDENCE_MIN,
  applyPhotoBonusRules,
  awardFanout,
  canResolveNow,
  decideClaim,
  extractTaskCode,
  hashAlreadyUsed,
  isOpenTask,
  type ClaimDecision,
} from "@/lib/game/claims";
import {
  alreadyClaimedLine,
  claimConfirmedLine,
  freeformAlreadyUsedLine,
  freeformPeerLine,
  freeformRejectedLine,
  peerConfirmLine,
  reusedPhotoLine,
  twoMatchAskLine,
  visionRejectedLine,
} from "@/lib/game/copy";
import {
  FREEFORM_PHOTO_BONUS_MAX,
  FREEFORM_SOURCE,
  hasFreeformClaimToday,
  isClaimantTapback,
  openPersonalTaskIds,
  parseFreeformExtraction,
} from "@/lib/game/freeform";
import { perceptualHash, imageTakenAt } from "@/lib/game/image-hash";
import { nextFreeformCode } from "@/lib/game/generate";
import {
  applyDailyPointsCap,
  DEFAULT_DAILY_POINTS_CAP,
  pointsForFreeform,
  tripLengthDays,
} from "@/lib/game/scoring";
import { verificationForSolo } from "@/lib/game/solo";
import type { SurveyAnswers } from "@/lib/game/survey";
import { validateGeneratedTask } from "@/lib/game/validate";
import { findParticipantOnTrip, getTripByChatId } from "@/lib/handlers/bootstrap";
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
  mediaFromParts,
  senderFromData,
  textFromParts,
} from "@/lib/linq/payload";
import { sendText } from "@/lib/linq/send";

const TASK_COLS =
  "id, trip_id, participant_id, team_id, code, title, tier, axes_json, base_points, photo_bonus_max, verification, day, expires_at, neighborhood, source";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";
const CLAIM_COLS =
  "id, task_id, participant_id, evidence_url, image_hash, status, awarded_points, resolved_by, resolution_json, capped, created_at";

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
  try {
    const result = await run();
    claimStep(`${step}.after`, fields);
    return result;
  } catch (err) {
    claimThrow(`${step}.throw`, err, fields);
  }
}

type SendFn = (chatId: string, text: string) => Promise<{ messageId: string }>;

export type ClaimHandlerDeps = {
  send?: SendFn;
  provider?: LLMProvider;
  now?: number;
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
  const trip = await claimAwait("trip.lookup", { chatId }, () =>
    getTripByChatId(chatId),
  );
  if (!trip) {
    claimStep("trip.lookup.miss", { chatId });
    return null;
  }
  const supabase = getServiceClient();
  const [tasksRes, peopleRes] = await claimAwait(
    "tasks_people.lookup",
    { tripId: trip.id },
    async () =>
      Promise.all([
        supabase.from("tasks").select(TASK_COLS).eq("trip_id", trip.id),
        supabase
          .from("participants")
          .select(PARTICIPANT_COLS)
          .eq("trip_id", trip.id),
      ]),
  );
  if (tasksRes.error) throw tasksRes.error;
  if (peopleRes.error) throw peopleRes.error;
  const tasks = asTasks(tasksRes.data);
  let claims: ClaimRow[] = [];
  if (tasks.length > 0) {
    const claimsRes = await claimAwait(
      "open_claims.lookup",
      { tripId: trip.id, taskCount: tasks.length },
      async () =>
        await supabase
          .from("claims")
          .select(CLAIM_COLS)
          .in(
            "task_id",
            tasks.map((task) => task.id),
          ),
    );
    if (claimsRes.error) throw claimsRes.error;
    claims = asClaims(claimsRes.data);
  }
  return {
    trip,
    tasks,
    people: asParticipants(peopleRes.data),
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

async function fetchPhoto(url: string): Promise<Buffer> {
  const res = await claimAwait("photo.fetch", { url }, () => fetch(url));
  if (!res.ok) throw new Error(`photo fetch HTTP ${res.status}`);
  const bytes = await claimAwait("photo.bytes", { url }, () => res.arrayBuffer());
  return Buffer.from(bytes);
}

async function bumpScore(participantId: string, delta: number): Promise<number> {
  const supabase = getServiceClient();
  const { data, error } = await claimAwait(
    "score.select",
    { participantId, delta },
    async () =>
      await supabase
        .from("participants")
        .select("score")
        .eq("id", participantId)
        .maybeSingle(),
  );
  if (error) throw error;
  if (!data) throw new Error(`participant not found: ${participantId}`);
  const next = ((data as { score: number }).score ?? 0) + delta;
  const updated = await claimAwait(
    "score.update",
    { participantId, next },
    async () =>
      await supabase
        .from("participants")
        .update({ score: next })
        .eq("id", participantId)
        .select("score")
        .maybeSingle(),
  );
  if (updated.error) throw updated.error;
  if (!updated.data) throw new Error(`participant score update failed: ${participantId}`);
  return (updated.data as { score: number }).score;
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
}): Promise<void> {
  const { error } = await claimAwait(
    "claim.insert",
    {
      taskId: row.task_id,
      participantId: row.participant_id,
      status: row.status,
    },
    async () =>
      await getServiceClient().from("claims").insert({
        ...row,
        capped: row.capped ?? false,
      }),
  );
  if (error) {
    if (error.code === "23505") {
      const conflict = new Error("claim_conflict");
      (conflict as Error & { code: string }).code = "23505";
      throw conflict;
    }
    throw error;
  }
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
    supabase.from("participants").select("display_name, score").eq("trip_id", tripId),
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
  const text = formatMorningStandings({
    day,
    standings: (peopleRes.data ?? []) as { display_name: string; score: number }[],
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
  const rows = awardFanout({
    teamId: opts.task.team_id,
    claimantId: opts.claimant.id,
    teamMemberIds: memberIds,
    basePoints: opts.task.base_points,
    photoBonus: opts.photoBonus,
  });
  const cap = opts.trip.daily_points_cap ?? DEFAULT_DAILY_POINTS_CAP;
  const confirmChatId = opts.trip.linq_chat_id;

  let claimantTotal = opts.claimant.score;
  let claimantCapped = false;
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
    const resolution =
      typeof opts.resolution === "object" && opts.resolution !== null
        ? { ...(opts.resolution as Record<string, unknown>), capped: capped.capped }
        : { capped: capped.capped };
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
    });
    if (capped.awarded_points > 0) {
      const total = await bumpScore(row.participantId, capped.awarded_points);
      if (row.participantId === opts.claimant.id) claimantTotal = total;
    }
    if (row.participantId === opts.claimant.id) claimantCapped = capped.capped;
  }

  const name =
    opts.people.find((p) => p.id === opts.claimant.id)?.display_name ??
    opts.claimant.display_name;
  await claimAwait(
    "outbound.confirm",
    { chatId: confirmChatId, code: opts.task.code },
    () =>
      opts.send(
        confirmChatId,
        claimConfirmedLine({
          code: opts.task.code,
          name,
          base: opts.task.base_points,
          photoBonus: opts.photoBonus,
          total: claimantTotal,
          capped: claimantCapped,
        }),
      ),
  );
  console.info("[japlan.claim]", {
    task: opts.task.code,
    participant: opts.claimant.id,
    points: claimantCapped ? 0 : opts.task.base_points + opts.photoBonus,
    capped: claimantCapped,
    photo: Boolean(opts.evidenceUrl),
    at: new Date().toISOString(),
  });

  if (
    opts.task.participant_id === opts.claimant.id &&
    opts.task.source !== FREEFORM_SOURCE
  ) {
    const { data: personal, error: personalErr } = await claimAwait(
      "refill.personal_tasks",
      { tripId: opts.trip.id, participantId: opts.claimant.id },
      async () =>
        await getServiceClient()
          .from("tasks")
          .select("id, participant_id, source")
          .eq("trip_id", opts.trip.id)
          .eq("participant_id", opts.claimant.id),
    );
    if (personalErr) throw personalErr;
    const { data: claimRows, error: claimErr } = await claimAwait(
      "refill.personal_claims",
      { participantId: opts.claimant.id },
      async () =>
        await getServiceClient()
          .from("claims")
          .select("task_id, status")
          .eq("participant_id", opts.claimant.id),
    );
    if (claimErr) throw claimErr;
    const remaining = openPersonalTaskIds(
      (personal ?? []) as {
        id: string;
        participant_id: string | null;
        source?: string | null;
      }[],
      (claimRows ?? []) as { task_id: string; status: string }[],
      opts.claimant.id,
    ).length;
    await claimAwait(
      "refill.generate",
      { remainingOpenPersonal: remaining },
      () =>
        refillPersonalTasksIfNeeded({
          trip: opts.trip,
          claimant: opts.claimant,
          people: opts.people,
          remainingOpenPersonal: remaining,
        }),
    );
  }
}

async function resolveKnownTask(opts: {
  task: TaskRow;
  claimant: ParticipantRow;
  people: ParticipantRow[];
  trip: TripRow;
  withPhoto: boolean;
  photo: { url: string; mime: string } | null;
  chatId: string;
  send: SendFn;
  provider?: LLMProvider;
  decision: ClaimDecision;
  photoBonusOverride?: number;
}): Promise<void> {
  const existing = await existingClaimsForTask(opts.task.id);
  const blocking = existing.filter(
    (c) => c.status === "awarded" || c.status === "pending_peer",
  );
  if (blocking.length > 0) {
    claimStep("already_claimed.hit", { code: opts.task.code });
    await claimAwait("outbound.send", { reason: "already_claimed" }, () =>
      opts.send(opts.chatId, alreadyClaimedLine(opts.task.code)),
    );
    return;
  }

  if (!canResolveNow(opts.task.verification, opts.withPhoto)) {
    claimStep("resolve.need_photo", {
      code: opts.task.code,
      verification: opts.task.verification,
      withPhoto: opts.withPhoto,
    });
    return;
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
  let bytes: Buffer | null = null;
  let takenAt: Date | null = null;

  if (opts.withPhoto && opts.photo) {
    evidenceUrl = opts.photo.url;
    bytes = await fetchPhoto(opts.photo.url);
    imageHash = await claimAwait("photo.hash", {}, () => perceptualHash(bytes as Buffer));
    takenAt = await claimAwait("photo.exif", {}, () => imageTakenAt(bytes as Buffer));
    const hashes = await tripHashes(opts.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await claimAwait("outbound.send", { reason: "reused_photo" }, () =>
        opts.send(opts.chatId, reusedPhotoLine()),
      );
      return;
    }
  }

  if (opts.task.verification === "peer") {
    const sent = await claimAwait("outbound.send", { reason: "peer_confirm" }, () =>
      opts.send(
        opts.trip.linq_chat_id,
        peerConfirmLine({
          name: opts.claimant.display_name,
          code: opts.task.code,
          title: opts.task.title,
        }),
      ),
    );
    await insertClaim({
      task_id: opts.task.id,
      participant_id: opts.claimant.id,
      evidence_url: evidenceUrl,
      image_hash: imageHash,
      status: "pending_peer",
      awarded_points: null,
      resolved_by: "peer",
      resolution_json: { peer_message_id: sent.messageId },
    });
    return;
  }

  if (opts.task.verification === "photo") {
    const priorReject = existing.find(
      (c) =>
        c.participant_id === opts.claimant.id &&
        c.status === "rejected" &&
        c.resolved_by === "vision",
    );
    if (priorReject) {
      claimStep("resolve.prior_reject", { code: opts.task.code });
      return;
    }

    let scoredFidelity = opts.photoBonusOverride;
    if (scoredFidelity === undefined) {
      if (!bytes || !opts.photo) {
        claimStep("resolve.photo_missing", { code: opts.task.code });
        return;
      }
      const scored = await claimAwait(
        "gemini.scorePhotoFidelity",
        { code: opts.task.code },
        () =>
          scorePhotoFidelity({
            provider: opts.provider,
            title: opts.task.title,
            photoBonusMax: opts.task.photo_bonus_max,
            image: {
              data: bytes.toString("base64"),
              mime: opts.photo?.mime || "image/jpeg",
            },
          }),
      );
      if (!scored || !scored.shows_task) {
        await insertClaim({
          task_id: opts.task.id,
          participant_id: opts.claimant.id,
          evidence_url: evidenceUrl,
          image_hash: imageHash,
          status: "rejected",
          awarded_points: 0,
          resolved_by: "vision",
          resolution_json: scored,
        });
        await claimAwait("outbound.send", { reason: "vision_rejected" }, () =>
          opts.send(opts.chatId, visionRejectedLine(opts.task.code)),
        );
        return;
      }
      scoredFidelity = scored.fidelity;
    }

    const bonus = applyPhotoBonusRules({
      fidelity: scoredFidelity,
      hasExif: Boolean(takenAt),
      takenAt,
      tripStart: opts.trip.start_date,
      tripEnd: opts.trip.end_date,
    });
    // TODO: plan requires EXIF inside the trip window where present, but gives no outbound copy for a miss.
    if (bonus.reject) {
      claimStep("resolve.exif_reject", { code: opts.task.code });
      return;
    }
    photoBonus = bonus.bonus;
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
    });
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === "23505") {
      await claimAwait("outbound.send", { reason: "claim_conflict" }, () =>
        opts.send(opts.chatId, alreadyClaimedLine(opts.task.code)),
      );
      return;
    }
    throw err;
  }
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
}): Promise<void> {
  if (!opts.text.trim()) return;
  const day = currentTripDay(opts.trip, new Date());
  if (
    hasFreeformClaimToday({
      tasks: opts.tasks,
      claims: opts.claims,
      participantId: opts.claimant.id,
      day,
    })
  ) {
    await opts.send(opts.trip.linq_chat_id, freeformAlreadyUsedLine());
    return;
  }

  const raw = await claimAwait("gemini.extractFreeform", {}, () =>
    extractFreeformActivity({
      provider: opts.provider,
      text: opts.text,
    }),
  );
  const extracted = parseFreeformExtraction(raw);
  if (!extracted) return;

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
    await opts.send(opts.trip.linq_chat_id, freeformRejectedLine());
    return;
  }

  const tripDays = tripLengthDays(opts.trip.start_date, opts.trip.end_date);
  const scored = pointsForFreeform(extracted.axes, { day, tripDays });
  const verification = verificationForSolo(
    "peer",
    Boolean(opts.trip.is_solo),
  );
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
          photo_bonus_max: FREEFORM_PHOTO_BONUS_MAX,
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

  let imageHash: string | null = null;
  let evidenceUrl: string | null = null;
  let photoBonus = 0;
  if (opts.hasPhoto && opts.photo) {
    evidenceUrl = opts.photo.url;
    const bytes = await fetchPhoto(opts.photo.url);
    imageHash = await perceptualHash(bytes);
    const hashes = await tripHashes(opts.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await opts.send(opts.trip.linq_chat_id, reusedPhotoLine());
      return;
    }
    const takenAt = await imageTakenAt(bytes);
    const scoredPhoto = await claimAwait(
      "gemini.scorePhotoFidelity",
      { reason: "freeform" },
      () =>
        scorePhotoFidelity({
          provider: opts.provider,
          title: extracted.title,
          photoBonusMax: FREEFORM_PHOTO_BONUS_MAX,
          image: {
            data: bytes.toString("base64"),
            mime: opts.photo?.mime || "image/jpeg",
          },
        }),
    );
    if (scoredPhoto?.shows_task) {
      const bonus = applyPhotoBonusRules({
        fidelity: scoredPhoto.fidelity,
        hasExif: Boolean(takenAt),
        takenAt,
        tripStart: opts.trip.start_date,
        tripEnd: opts.trip.end_date,
      });
      if (!bonus.reject) {
        photoBonus = Math.min(bonus.bonus, FREEFORM_PHOTO_BONUS_MAX);
      }
    }
  }

  if (verification === "peer") {
    const sent = await opts.send(
      opts.trip.linq_chat_id,
      freeformPeerLine({
        name: opts.claimant.display_name,
        title: extracted.title,
        code,
      }),
    );
    await insertClaim({
      task_id: task.id,
      participant_id: opts.claimant.id,
      evidence_url: evidenceUrl,
      image_hash: imageHash,
      status: "pending_peer",
      awarded_points: null,
      resolved_by: "peer",
      resolution_json: { peer_message_id: sent.messageId, photoBonus },
    });
    return;
  }

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
  });
}

export async function handleGroupClaim(
  data: Record<string, unknown>,
  deps: ClaimHandlerDeps = {},
): Promise<void> {
  claimStep("handler.enter");
  try {
    await handleGroupClaimInner(data, deps);
    claimStep("handler.exit");
  } catch (err) {
    claimThrow("handler.throw", err);
  }
}

async function handleGroupClaimInner(
  data: Record<string, unknown>,
  deps: ClaimHandlerDeps,
): Promise<void> {
  const send = deps.send ?? sendText;
  const chatId = chatIdFromData(data);
  if (!chatId) {
    claimStep("handler.no_chat");
    return;
  }

  const sender = senderFromData(data);
  if (!sender) {
    claimStep("handler.no_sender");
    return;
  }
  const text = textFromParts(data.parts);
  const media = mediaFromParts(data.parts).filter(
    (part) => !part.mime || part.mime.startsWith("image/"),
  );
  const hasPhoto = media.length > 0;
  const photo = media[0] ?? null;
  const recentCode = recentCodeFor(chatId, sender.handle, deps.now);
  const codeInText = extractTaskCode(text);
  if (codeInText) rememberTaskMention(chatId, sender.handle, codeInText, deps.now);
  claimStep("handler.parsed", {
    chatId,
    hasPhoto,
    codeInText,
    textPreview: text.slice(0, 80),
  });

  const ctx = await loadTripContext(chatId);
  if (!ctx) {
    claimStep("trip.context.miss", { chatId });
    return;
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
    });
    return;
  }

  const openTasks = ctx.tasks.filter((task) => isOpenTask(task.id, ctx.claims));

  const decision = decideClaim({
    text,
    hasPhoto,
    recentCode,
    isDm: isDirectChat(data),
    openTaskContext: hasPhoto && Boolean(recentCode),
  });
  claimStep("decision", {
    type: decision.type,
    step: decision.type === "code" ? decision.step : null,
    code: decision.type === "code" ? decision.code : null,
    withPhoto: decision.type === "code" ? decision.withPhoto : hasPhoto,
    taskCount: ctx.tasks.length,
    openCount: openTasks.length,
  });

  if (decision.type === "silent") {
    claimStep("decision.silent", {
      reason: decision.reason,
    });
    return;
  }

  if (decision.type === "code") {
    claimStep("task.lookup.before", { code: decision.code });
    const task = ctx.tasks.find((t) => t.code === decision.code);
    claimStep("task.lookup.after", {
      code: decision.code,
      found: Boolean(task),
      verification: task?.verification ?? null,
      taskId: task?.id ?? null,
    });
    if (!task) {
      claimStep("task.lookup.miss", {
        code: decision.code,
        knownCodes: ctx.tasks.map((t) => t.code),
      });
      return;
    }
    claimStep("gemini.skip", {
      reason: "ladder_step_1_or_2_code",
      code: decision.code,
      step: decision.step,
    });
    await resolveKnownTask({
      task,
      claimant,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: decision.withPhoto,
      photo,
      chatId,
      send,
      provider: decision.withPhoto ? deps.provider : undefined,
      decision,
    });
    return;
  }

  if (decision.type === "fuzzy") {
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
      await tryHandleFreeform({
        text,
        hasPhoto,
        photo,
        claimant,
        people: ctx.people,
        trip: ctx.trip,
        tasks: ctx.tasks,
        claims: ctx.claims,
        send,
        provider: deps.provider,
      });
      return;
    }
    const task = openTasks.find(
      (t) => t.code.toUpperCase() === match.task_code.toUpperCase(),
    );
    if (!task) return;
    await resolveKnownTask({
      task,
      claimant,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: hasPhoto,
      photo,
      chatId,
      send,
      provider: deps.provider,
      decision,
    });
    return;
  }

  if (decision.type === "vision") {
    if (!photo) return;
    const bytes = await fetchPhoto(photo.url);
    const imageHash = await claimAwait("photo.hash", { reason: "vision" }, () =>
      perceptualHash(bytes),
    );
    const hashes = await tripHashes(ctx.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await claimAwait("outbound.send", { reason: "reused_photo" }, () =>
        send(chatId, reusedPhotoLine()),
      );
      return;
    }
    const image = { data: bytes.toString("base64"), mime: photo.mime || "image/jpeg" };
    const scored: { code: string; fidelity: number }[] = [];
    for (const task of openTasks.filter((t) => t.verification === "photo")) {
      const result = await claimAwait(
        "gemini.scorePhotoFidelity",
        { code: task.code, reason: "vision_scan" },
        () =>
          scorePhotoFidelity({
            provider: deps.provider,
            title: task.title,
            photoBonusMax: task.photo_bonus_max,
            image,
          }),
      );
      if (result?.shows_task) {
        scored.push({
          code: task.code,
          fidelity: result.fidelity,
        });
      }
    }
    if (scored.length === 0) {
      await tryHandleFreeform({
        text,
        hasPhoto,
        photo,
        claimant,
        people: ctx.people,
        trip: ctx.trip,
        tasks: ctx.tasks,
        claims: ctx.claims,
        send,
        provider: deps.provider,
      });
      return;
    }
    if (scored.length > 1) {
      await claimAwait("outbound.send", { reason: "two_match" }, () =>
        send(chatId, twoMatchAskLine(scored[0].code, scored[1].code)),
      );
      return;
    }
    const task = openTasks.find((t) => t.code === scored[0].code);
    if (!task) return;
    await resolveKnownTask({
      task,
      claimant,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: true,
      photo,
      chatId,
      send,
      provider: deps.provider,
      decision,
      photoBonusOverride: scored[0].fidelity,
    });
  }
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

  const { data: rows, error } = await getServiceClient()
    .from("claims")
    .select(CLAIM_COLS)
    .eq("status", "pending_peer");
  if (error) throw error;
  const pending = asClaims(rows).find((claim) => {
    const json = claim.resolution_json as { peer_message_id?: string } | null;
    return json?.peer_message_id === messageId;
  });
  if (!pending) return;

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
  if (isClaimantTapback(fromHandle ?? null, claimant.phone)) return;

  const { error: delErr } = await getServiceClient()
    .from("claims")
    .delete()
    .eq("id", pending.id)
    .eq("status", "pending_peer");
  if (delErr) throw delErr;

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
