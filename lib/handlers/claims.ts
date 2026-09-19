import { getServiceClient } from "@/lib/db/client";
import type { ClaimRow, ParticipantRow, TaskRow, TripRow } from "@/lib/db/types";
import { formatDailyBoard } from "@/lib/game/board";
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
  peerConfirmLine,
  reusedPhotoLine,
  twoMatchAskLine,
  visionRejectedLine,
} from "@/lib/game/copy";
import { perceptualHash, imageTakenAt } from "@/lib/game/image-hash";
import { getTripByChatId } from "@/lib/handlers/bootstrap";
import type { LLMProvider } from "@/lib/llm";
import {
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
  "id, trip_id, participant_id, team_id, code, title, tier, axes_json, base_points, photo_bonus_max, verification, day, expires_at, neighborhood";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";
const CLAIM_COLS =
  "id, task_id, participant_id, evidence_url, image_hash, status, awarded_points, resolved_by, resolution_json";

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
  const trip = await getTripByChatId(chatId);
  if (!trip) return null;
  const supabase = getServiceClient();
  const [tasksRes, peopleRes] = await Promise.all([
    supabase.from("tasks").select(TASK_COLS).eq("trip_id", trip.id),
    supabase.from("participants").select(PARTICIPANT_COLS).eq("trip_id", trip.id),
  ]);
  if (tasksRes.error) throw tasksRes.error;
  if (peopleRes.error) throw peopleRes.error;
  const tasks = asTasks(tasksRes.data);
  let claims: ClaimRow[] = [];
  if (tasks.length > 0) {
    const claimsRes = await supabase
      .from("claims")
      .select(CLAIM_COLS)
      .in(
        "task_id",
        tasks.map((task) => task.id),
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
  const { data, error } = await getServiceClient()
    .from("claims")
    .select("image_hash, tasks!inner(trip_id)")
    .eq("tasks.trip_id", tripId)
    .not("image_hash", "is", null);
  if (error) throw error;
  return (data ?? [])
    .map((row) => (row as { image_hash: string | null }).image_hash)
    .filter((value): value is string => Boolean(value));
}

async function existingClaimsForTask(taskId: string): Promise<ClaimRow[]> {
  const { data, error } = await getServiceClient()
    .from("claims")
    .select(CLAIM_COLS)
    .eq("task_id", taskId);
  if (error) throw error;
  return asClaims(data);
}

async function fetchPhoto(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo fetch HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function bumpScore(participantId: string, delta: number): Promise<number> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("participants")
    .select("score")
    .eq("id", participantId)
    .single();
  if (error) throw error;
  const next = ((data as { score: number }).score ?? 0) + delta;
  const updated = await supabase
    .from("participants")
    .update({ score: next })
    .eq("id", participantId)
    .select("score")
    .single();
  if (updated.error) throw updated.error;
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
}): Promise<void> {
  const { error } = await getServiceClient().from("claims").insert(row);
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
    .single();
  if (tripRes.error) throw tripRes.error;
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
  const text = formatDailyBoard({
    day,
    tasks,
    standings: (peopleRes.data ?? []) as { display_name: string; score: number }[],
  });
  await send(trip.linq_chat_id, text);
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
  chatId: string;
  send: SendFn;
}): Promise<void> {
  const memberIds = opts.task.team_id
    ? Array.from(new Set([opts.claimant.id, ...(await teamMemberIds(opts.task.team_id))]))
    : [opts.claimant.id];
  const rows = awardFanout({
    teamId: opts.task.team_id,
    claimantId: opts.claimant.id,
    teamMemberIds: memberIds,
    basePoints: opts.task.base_points,
    photoBonus: opts.photoBonus,
  });

  let claimantTotal = opts.claimant.score;
  for (const row of rows) {
    await insertClaim({
      task_id: opts.task.id,
      participant_id: row.participantId,
      evidence_url: opts.evidenceUrl,
      image_hash: opts.imageHash,
      status: "awarded",
      awarded_points: row.points,
      resolved_by: opts.resolvedBy,
      resolution_json: opts.resolution,
    });
    const total = await bumpScore(row.participantId, row.points);
    if (row.participantId === opts.claimant.id) claimantTotal = total;
  }

  const name =
    opts.people.find((p) => p.id === opts.claimant.id)?.display_name ??
    opts.claimant.display_name;
  await opts.send(
    opts.chatId,
    claimConfirmedLine({
      code: opts.task.code,
      name,
      base: opts.task.base_points,
      photoBonus: opts.photoBonus,
      total: claimantTotal,
    }),
  );
  console.info("[japlan.claim]", {
    task: opts.task.code,
    participant: opts.claimant.id,
    points: opts.task.base_points + opts.photoBonus,
    photo: Boolean(opts.evidenceUrl),
    at: new Date().toISOString(),
  });
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
    await opts.send(opts.chatId, alreadyClaimedLine(opts.task.code));
    return;
  }

  if (!canResolveNow(opts.task.verification, opts.withPhoto)) {
    return;
  }

  let imageHash: string | null = null;
  let photoBonus = 0;
  let evidenceUrl: string | null = null;
  let bytes: Buffer | null = null;
  let takenAt: Date | null = null;

  if (opts.withPhoto && opts.photo) {
    evidenceUrl = opts.photo.url;
    bytes = await fetchPhoto(opts.photo.url);
    imageHash = await perceptualHash(bytes);
    takenAt = await imageTakenAt(bytes);
    const hashes = await tripHashes(opts.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await opts.send(opts.chatId, reusedPhotoLine());
      return;
    }
  }

  if (opts.task.verification === "peer") {
    const sent = await opts.send(
      opts.chatId,
      peerConfirmLine({
        name: opts.claimant.display_name,
        code: opts.task.code,
        title: opts.task.title,
      }),
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
    if (priorReject) return;

    let scoredFidelity = opts.photoBonusOverride;
    if (scoredFidelity === undefined) {
      if (!bytes || !opts.photo) return;
      const scored = await scorePhotoFidelity({
        provider: opts.provider,
        title: opts.task.title,
        photoBonusMax: opts.task.photo_bonus_max,
        image: {
          data: bytes.toString("base64"),
          mime: opts.photo.mime || "image/jpeg",
        },
      });
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
        await opts.send(opts.chatId, visionRejectedLine(opts.task.code));
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
    if (bonus.reject) return;
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
      chatId: opts.chatId,
      send: opts.send,
    });
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === "23505") {
      await opts.send(opts.chatId, alreadyClaimedLine(opts.task.code));
      return;
    }
    throw err;
  }
}

export async function handleGroupClaim(
  data: Record<string, unknown>,
  deps: ClaimHandlerDeps = {},
): Promise<void> {
  const send = deps.send ?? sendText;
  const chatId = chatIdFromData(data);
  if (!chatId) return;

  const sender = senderFromData(data);
  if (!sender) return;
  const text = textFromParts(data.parts);
  const media = mediaFromParts(data.parts).filter(
    (part) => !part.mime || part.mime.startsWith("image/"),
  );
  const hasPhoto = media.length > 0;
  const photo = media[0] ?? null;
  const recentCode = recentCodeFor(chatId, sender.handle, deps.now);
  const codeInText = extractTaskCode(text);
  if (codeInText) rememberTaskMention(chatId, sender.handle, codeInText, deps.now);

  const ctx = await loadTripContext(chatId);
  if (!ctx) return;
  const claimant = ctx.people.find((p) => p.phone === sender.handle);
  if (!claimant) return;

  const openTasks = ctx.tasks.filter((task) => isOpenTask(task.id, ctx.claims));

  const decision = decideClaim({
    text,
    hasPhoto,
    recentCode,
    isDm: isDirectChat(data),
    openTaskContext: hasPhoto && Boolean(recentCode),
  });

  if (decision.type === "silent") return;

  if (decision.type === "code") {
    const task = ctx.tasks.find((t) => t.code === decision.code);
    if (!task) return;
    await resolveKnownTask({
      task,
      claimant,
      people: ctx.people,
      trip: ctx.trip,
      withPhoto: decision.withPhoto,
      photo,
      chatId,
      send,
      provider: deps.provider,
      decision,
    });
    return;
  }

  if (decision.type === "fuzzy") {
    const match = await matchClaimText({
      provider: deps.provider,
      text: decision.text,
      tasks: openTasks.map((t) => ({ code: t.code, title: t.title })),
    });
    if (
      !match ||
      match.confidence < CLAIM_MATCH_CONFIDENCE_MIN ||
      !match.task_code
    ) {
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
    const imageHash = await perceptualHash(bytes);
    const hashes = await tripHashes(ctx.trip.id);
    if (hashAlreadyUsed(hashes, imageHash)) {
      await send(chatId, reusedPhotoLine());
      return;
    }
    const image = { data: bytes.toString("base64"), mime: photo.mime || "image/jpeg" };
    const scored: { code: string; fidelity: number }[] = [];
    for (const task of openTasks.filter((t) => t.verification === "photo")) {
      const result = await scorePhotoFidelity({
        provider: deps.provider,
        title: task.title,
        photoBonusMax: task.photo_bonus_max,
        image,
      });
      if (result?.shows_task) {
        scored.push({
          code: task.code,
          fidelity: result.fidelity,
        });
      }
    }
    if (scored.length === 0) return;
    if (scored.length > 1) {
      await send(chatId, twoMatchAskLine(scored[0].code, scored[1].code));
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
    .single();
  if (taskErr) throw taskErr;
  const task = taskRow as TaskRow;

  const ctx = await loadTripContext(chatId);
  if (!ctx) return;
  const claimant = ctx.people.find((p) => p.id === pending.participant_id);
  if (!claimant) return;
  if (fromHandle && fromHandle === claimant.phone) return;

  const { error: delErr } = await getServiceClient()
    .from("claims")
    .delete()
    .eq("id", pending.id)
    .eq("status", "pending_peer");
  if (delErr) throw delErr;

  await applyAwards({
    task,
    claimant,
    people: ctx.people,
    photoBonus: 0,
    evidenceUrl: pending.evidence_url,
    imageHash: pending.image_hash,
    resolvedBy: "peer",
    resolution: { peer_message_id: messageId },
    chatId,
    send,
  });
}
