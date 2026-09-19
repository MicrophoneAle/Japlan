import { getServiceClient } from "@/lib/db/client";
import { evaluateAddress } from "@/lib/game/addressing";
import { extractTaskCode } from "@/lib/game/claims";
import { routeSoloDm, soloModeEnabled } from "@/lib/game/solo";
import { bootstrapGroupIfNeeded } from "@/lib/handlers/bootstrap";
import {
  handleGroupClaim,
  handlePeerReaction,
  recentCodeFor,
  rememberTaskMention,
} from "@/lib/handlers/claims";
import { sendHelpGuide } from "@/lib/handlers/help";
import { handleConversation } from "@/lib/handlers/conversation";
import {
  bootstrapSoloIfNeeded,
  skipSoloSurvey,
  soloTripForChat,
} from "@/lib/handlers/solo";
import { handleSurveyDm } from "@/lib/handlers/survey";
import {
  chatIdFromData,
  isDirectChat,
  isFromMe,
  isGroupChat,
  mediaFromParts,
  senderFromData,
  textFromParts,
  type LinqEnvelope,
} from "@/lib/linq/payload";
import { markRead } from "@/lib/linq/send";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dispatchStep(step: string, fields: Record<string, unknown> = {}): void {
  console.log("[japlan.dispatch] step", { step, ...fields });
}

function dispatchIdle(reason: string, fields: Record<string, unknown> = {}): void {
  console.log("[japlan.dispatch] idle", { reason, ...fields });
}

function dispatchThrow(
  step: string,
  err: unknown,
  fields: Record<string, unknown> = {},
): never {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error("[japlan.dispatch] step", {
    step,
    ...fields,
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
  });
  throw error;
}

async function dispatchAwait<T>(
  step: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  dispatchStep(`${step}.before`, fields);
  try {
    const result = await run();
    dispatchStep(`${step}.after`, fields);
    return result;
  } catch (err) {
    dispatchThrow(`${step}.throw`, err, fields);
  }
}

async function markProcessed(eventId: string | undefined, tripId?: string) {
  if (!eventId) {
    dispatchIdle("mark_processed_skipped", { hasEventId: false });
    return;
  }
  const patch: { processed_at: string; trip_id?: string } = {
    processed_at: new Date().toISOString(),
  };
  if (tripId) patch.trip_id = tripId;
  const { error } = await getServiceClient()
    .from("events")
    .update(patch)
    .eq("linq_event_id", eventId);
  if (error) {
    console.error("[japlan.dispatch] failed to mark processed", error);
  }
}

async function runClaimThenConversation(
  data: Record<string, unknown>,
): Promise<void> {
  const miss = await handleGroupClaim(data);
  if (!miss) return;
  await handleConversation(miss);
}

async function onMessageReceived(data: unknown): Promise<void> {
  dispatchStep("onMessageReceived.enter");
  try {
    await onMessageReceivedInner(data);
  } catch (err) {
    dispatchThrow("onMessageReceived.throw", err);
  } finally {
    dispatchStep("onMessageReceived.exit");
  }
}

async function onMessageReceivedInner(data: unknown): Promise<void> {
  if (!isRecord(data)) {
    dispatchIdle("not_a_record");
    return;
  }
  if (data.direction === "outbound") {
    dispatchIdle("outbound_ignored");
    return;
  }

  const chatId = chatIdFromData(data);
  if (!chatId) {
    dispatchIdle("no_chat_id");
    return;
  }

  const isGroup = isGroupChat(data);
  if (isGroup) {
    await dispatchAwait("bootstrap_group", { chatId }, () =>
      bootstrapGroupIfNeeded(chatId, { isGroup }),
    );
  }

  const text = textFromParts(data.parts);
  const media = mediaFromParts(data.parts);
  const isDm = isDirectChat(data);
  const sender = senderFromData(data);
  const phone = sender?.handle ?? null;
  const senderName = sender?.display_name ?? null;
  const recentCode = chatId && phone ? recentCodeFor(chatId, phone) : null;
  const codeInText = extractTaskCode(text);
  if (chatId && phone && codeInText) {
    rememberTaskMention(chatId, phone, codeInText);
  }
  const decision = evaluateAddress({
    text,
    isDm,
    openTaskContext: media.length > 0 && Boolean(recentCode),
  });

  if (!decision.respond) {
    dispatchIdle("addressing_silent", {
      reason: decision.reason,
      chatId,
      textPreview: text.slice(0, 80),
    });
    return;
  }

  const messageId = typeof data.id === "string" ? data.id : null;
  if (messageId) {
    try {
      await markRead(messageId);
    } catch (err) {
      console.error("[japlan.dispatch] markRead failed", err);
    }
  } else {
    dispatchIdle("mark_read_skipped", { reason: "no_message_id", chatId });
  }

  console.log("[japlan.dispatch] after markRead", {
    chatId,
    isDm,
    hasPhone: Boolean(phone),
    textPreview: text.slice(0, 80),
  });
  dispatchStep("after_markRead.next", {
    chatId,
    isDm,
    hasPhone: Boolean(phone),
    phoneLength: phone?.length ?? 0,
  });

  if (decision.intent === "help") {
    await dispatchAwait("help", { chatId, isDm }, () =>
      sendHelpGuide({ chatId, isDm }),
    );
    return;
  }

  if (!(isDm && phone)) {
    dispatchStep("group_or_no_phone.claim", {
      chatId,
      isDm,
      hasPhone: Boolean(phone),
    });
    await dispatchAwait("group_claim", { chatId }, () =>
      runClaimThenConversation(data as Record<string, unknown>),
    );
    return;
  }

  dispatchStep("dm_branch.enter", { chatId, textPreview: text.slice(0, 80) });
  const soloModeRaw = process.env.JAPLAN_SOLO_MODE ?? null;
  dispatchStep("dm_branch.env_read", {
    soloModeRaw,
    soloModeEnabledType: typeof soloModeEnabled,
  });
  let soloEnabled = false;
  try {
    soloEnabled = soloModeEnabled();
  } catch (err) {
    dispatchThrow("soloModeEnabled.throw", err, { chatId });
  }
  console.log("[japlan.solo] command check", {
    soloEnabled,
    soloModeRaw,
    textPreview: text.slice(0, 80),
  });

  const soloTrip = soloEnabled
    ? await dispatchAwait("soloTripForChat", { chatId }, () =>
        soloTripForChat(chatId),
      )
    : null;
  if (soloEnabled && !soloTrip) {
    dispatchIdle("solo_enabled_but_no_solo_trip", { chatId });
  }
  const soloRoute = routeSoloDm({
    enabled: soloEnabled,
    text,
    soloTripState: soloTrip?.state ?? null,
  });
  console.log("[japlan.solo] command check route", {
    soloRoute,
    soloTripState: soloTrip?.state ?? null,
    soloTripId: soloTrip?.id ?? null,
  });

  if (soloRoute === "solo_bootstrap") {
    await dispatchAwait("solo_bootstrap", { chatId }, () =>
      bootstrapSoloIfNeeded({ chatId, phone, displayName: senderName }),
    );
    return;
  }
  if (soloRoute === "solo_skip") {
    await dispatchAwait("solo_skip", { chatId }, () =>
      skipSoloSurvey({ chatId, phone, displayName: senderName }),
    );
    return;
  }
  if (soloRoute === "solo_claim") {
    console.log("[japlan.claim] step", { step: "solo_claim.before", chatId });
    try {
      await runClaimThenConversation(data);
    } finally {
      console.log("[japlan.claim] step", { step: "solo_claim.after", chatId });
    }
    return;
  }

  dispatchStep("survey_dm.before", {
    chatId,
    soloRoute,
    soloTripState: soloTrip?.state ?? null,
  });
  await handleSurveyDm({ phone, chatId, text });
  dispatchStep("survey_dm.after", { chatId });
}

export async function dispatchLinqEvent(envelope: LinqEnvelope): Promise<void> {
  dispatchStep("dispatchLinqEvent.enter", {
    type: envelope.event_type ?? null,
    eventId: envelope.event_id ?? null,
  });
  try {
    if (isFromMe(envelope.data)) {
      dispatchIdle("is_me", {
        type: envelope.event_type ?? null,
        eventId: envelope.event_id ?? null,
      });
      await markProcessed(envelope.event_id);
      return;
    }

    if (envelope.event_type === "message.received") {
      await onMessageReceived(envelope.data);
    } else if (envelope.event_type === "reaction.added") {
      if (isRecord(envelope.data)) {
        await dispatchAwait("peer_reaction", {}, () =>
          handlePeerReaction(envelope.data as Record<string, unknown>),
        );
      } else {
        dispatchIdle("reaction_not_a_record");
      }
    } else {
      dispatchIdle("unhandled_event_type", {
        type: envelope.event_type ?? null,
      });
    }
    await markProcessed(envelope.event_id);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("[japlan.dispatch]", {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    });
  } finally {
    dispatchStep("dispatchLinqEvent.exit", {
      type: envelope.event_type ?? null,
      eventId: envelope.event_id ?? null,
    });
  }
}
