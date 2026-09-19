import { getServiceClient } from "@/lib/db/client";
import type { TripRow } from "@/lib/db/types";
import { recentMessages, transcriptText } from "@/lib/chat/transcript";
import type { DestinationProfile } from "@/lib/game/destination";
import {
  entrySignal,
  IDLE,
  isStopCommand,
  obviousDisengage,
  type EngagementState,
} from "@/lib/game/engagement";
import { judgeShouldJoin, judgeStillEngaged } from "@/lib/llm/gemini";
import type { LLMProvider } from "@/lib/llm";

// Per-chat engagement for group chats. Every decision is logged with its
// reason ("[japlan.engage] decision"), so the judgement can be tuned from
// real transcripts. Stored on the trip (one group chat per trip).

export type EngagementDecision = {
  engaged: boolean;
  // "japlan chill": acknowledge and go quiet.
  stop?: boolean;
  // Joined only because a photo may match an open task: claims may use it,
  // but a miss is silence, not conversation.
  photoOnly?: boolean;
  reason: string;
};

function log(chatId: string, decision: EngagementDecision, via: string, extra: Record<string, unknown> = {}): void {
  console.info("[japlan.engage] decision", {
    chatId,
    engaged: decision.engaged,
    stop: Boolean(decision.stop),
    reason: decision.reason,
    via,
    ...extra,
  });
}

async function save(tripId: string, state: EngagementState): Promise<void> {
  const { error } = await getServiceClient().from("trips").update({ engagement_json: state }).eq("id", tripId);
  if (error) console.error("[japlan.engage] save failed", { tripId, error });
}

function placeNames(trip: TripRow): string[] {
  const profile = (trip.destination_profile_json ?? null) as DestinationProfile | null;
  return [...(profile?.landmarks ?? []), ...(profile?.neighborhoods ?? [])].map((p) => p.name);
}

export async function engagementFor(opts: {
  trip: TripRow;
  chatId: string;
  text: string;
  addressed: boolean;
  hasPhoto: boolean;
  now?: number;
  provider?: LLMProvider;
}): Promise<EngagementDecision> {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const state = { ...IDLE, ...((opts.trip.engagement_json ?? {}) as Partial<EngagementState>) };

  // The last resort, and final: only a direct mention undoes it.
  if (isStopCommand(opts.text)) {
    const decision = { engaged: false, stop: true, reason: "told_to_stop" };
    await save(opts.trip.id, { engaged: false, stopped: true, reason: decision.reason, at });
    log(opts.chatId, decision, "stop_command");
    return decision;
  }
  if (opts.addressed) {
    const decision = { engaged: true, reason: "addressed" };
    if (!state.engaged || state.stopped) {
      await save(opts.trip.id, { engaged: true, stopped: false, reason: decision.reason, at });
    }
    log(opts.chatId, decision, "keyword");
    return decision;
  }
  if (state.stopped) {
    const decision = { engaged: false, reason: "stopped_until_mentioned" };
    log(opts.chatId, decision, "stopped");
    return decision;
  }

  const lines = await recentMessages(opts.chatId, 15);
  const transcript = transcriptText(lines);

  if (state.engaged) {
    const obvious = obviousDisengage(lines, now);
    if (obvious) {
      const decision = { engaged: false, reason: obvious };
      await save(opts.trip.id, { engaged: false, stopped: false, reason: obvious, at });
      log(opts.chatId, decision, "rule", { context: lines.length });
      return decision;
    }
    const judged = await judgeStillEngaged({ provider: opts.provider, transcript, message: opts.text });
    // No judgement (timeout, bad output): leave. Early beats late.
    const engaged = judged?.decision ?? false;
    const decision = { engaged, reason: judged ? judged.reason || (engaged ? "still_with_me" : "moved_on") : "judge_unavailable" };
    if (!engaged) await save(opts.trip.id, { engaged: false, stopped: false, reason: decision.reason, at });
    log(opts.chatId, decision, "model", { context: lines.length });
    return decision;
  }

  // Not engaged: only a message plainly about the game is worth asking about.
  const signal = entrySignal(opts.text, placeNames(opts.trip));
  if (!signal) {
    if (opts.hasPhoto) {
      const decision = { engaged: true, photoOnly: true, reason: "photo_may_match_a_task" };
      log(opts.chatId, decision, "photo");
      return decision;
    }
    return { engaged: false, reason: "no_signal" };
  }
  const judged = await judgeShouldJoin({ provider: opts.provider, transcript, message: opts.text });
  const engaged = judged?.decision ?? false;
  const decision = { engaged, reason: `${signal}: ${judged ? judged.reason || (engaged ? "join" : "stay_out") : "judge_unavailable"}` };
  if (engaged) await save(opts.trip.id, { engaged: true, stopped: false, reason: decision.reason, at });
  log(opts.chatId, decision, "model_entry", { signal, context: lines.length });
  return decision;
}
