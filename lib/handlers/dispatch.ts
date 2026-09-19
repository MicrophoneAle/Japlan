import { getServiceClient } from "@/lib/db/client";
import { defaultWakeKeyword, evaluateAddress, findTaskCode, wakeKeywordRe } from "@/lib/game/addressing";
import { detectBoardTimeCommand, detectTeamNameCommand, detectTripCommand } from "@/lib/game/commands";
import { DISPATCH_ERROR_LINE } from "@/lib/game/copy";
import { handleBoardTimeCommand, handleTripCommand } from "@/lib/handlers/trip-lifecycle";
import { handleTeamNameCommand } from "@/lib/handlers/teams";
import { routeSoloDm, soloModeEnabled } from "@/lib/game/solo";
import { bootstrapGroupIfNeeded } from "@/lib/handlers/bootstrap";
import {
  handleGroupClaim,
  handlePeerReaction,
  photoBonusOpenFor,
  recentCodeFor,
  rememberTaskMention,
  type ClaimHandlerDeps,
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
  describeNonTextParts,
  photoPartsFrom,
  senderFromData,
  textFromParts,
  type LinqEnvelope,
} from "@/lib/linq/payload";
import { markRead, sendText } from "@/lib/linq/send";
import { recordMessage } from "@/lib/chat/transcript";
import { engagementFor, type EngagementDecision } from "@/lib/handlers/engagement";
import { getTripByChatId } from "@/lib/handlers/bootstrap";
import { STOP_LINE } from "@/lib/game/copy";

// Set once a message is known to be addressed, so a later failure can still
// answer it. Addressed means answered, even when something breaks.
type AddressedMarker = { chatId: string | null };

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
  deps: ClaimHandlerDeps & { photoOnly?: boolean } = {},
): Promise<void> {
  const miss = await handleGroupClaim(data, deps);
  if (!miss) return;
  // Joined only to check a photo against open tasks: no match is silence.
  if (deps.photoOnly) return;
  await handleConversation(miss);
}

async function onMessageReceived(data: unknown): Promise<void> {
  dispatchStep("onMessageReceived.enter");
  const addressed: AddressedMarker = { chatId: null };
  try {
    await onMessageReceivedInner(data, addressed);
  } catch (err) {
    if (addressed.chatId) {
      try {
        await sendText(addressed.chatId, DISPATCH_ERROR_LINE);
        dispatchStep("error_reply.sent", { chatId: addressed.chatId });
      } catch (sendErr) {
        console.error("[japlan.dispatch] error reply failed", sendErr);
      }
    }
    dispatchThrow("onMessageReceived.throw", err);
  } finally {
    dispatchStep("onMessageReceived.exit");
  }
}

async function onMessageReceivedInner(
  data: unknown,
  addressed: AddressedMarker,
): Promise<void> {
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
    const bootstrapSender = senderFromData(data);
    await dispatchAwait("bootstrap_group", { chatId }, () =>
      bootstrapGroupIfNeeded(chatId, {
        isGroup,
        senderPhone: bootstrapSender?.handle ?? null,
        senderName: bootstrapSender?.display_name ?? null,
      }),
    );
  }

  const text = textFromParts(data.parts);
  const nonText = describeNonTextParts(data.parts);
  const media = photoPartsFrom(data.parts);
  if (nonText.length > 0) {
    // No real photo capture exists yet; this confirms the live media shape.
    dispatchStep("photo.detect", {
      chatId,
      parts: nonText,
      photoCount: media.length,
    });
  }
  const isDm = isDirectChat(data);
  const sender = senderFromData(data);
  const phone = sender?.handle ?? null;
  const senderName = sender?.display_name ?? null;
  // The transcript every conversational call reads, this message included.
  await recordMessage({
    chatId,
    role: "user",
    senderHandle: phone,
    senderName,
    text: text || (media.length > 0 ? "[sent a photo]" : ""),
  });

  // Groups: is the bot part of this conversation? (DMs always are.)
  let engagement: EngagementDecision | null = null;
  if (isGroup && !isDm) {
    const trip = await getTripByChatId(chatId);
    if (trip) {
      engagement = await dispatchAwait("engagement", { chatId }, () =>
        engagementFor({
          trip,
          chatId,
          text,
          addressed: wakeKeywordRe(defaultWakeKeyword()).test(text),
          hasPhoto: media.length > 0,
        }),
      );
      if (engagement.stop) {
        await sendText(chatId, STOP_LINE);
        return;
      }
    }
  }
  const recentCode = chatId && phone ? recentCodeFor(chatId, phone) : null;
  // Loose codes are remembered by the claim handler only once they resolve.
  const codeMatch = findTaskCode(text);
  if (chatId && phone && codeMatch?.strict) {
    rememberTaskMention(chatId, phone, codeMatch.code);
  }
  let decision = evaluateAddress({
    text,
    isDm,
    openTaskContext: media.length > 0 && Boolean(recentCode),
    engaged: engagement?.engaged ?? false,
  });

  // A bare group photo is addressed when the sender has a claim still open
  // for a photo bonus. Checked only for photos that would otherwise be dropped.
  let photoBonusOpen = false;
  if (!decision.respond && media.length > 0 && phone && !isDm) {
    photoBonusOpen = await dispatchAwait("photo_bonus.window", { chatId }, () =>
      photoBonusOpenFor(chatId, phone),
    );
    dispatchStep("photo_bonus.window.result", { chatId, photoBonusOpen });
    if (photoBonusOpen) {
      decision = evaluateAddress({ text, isDm, openTaskContext: true });
    }
  }

  if (!decision.respond) {
    dispatchIdle("addressing_silent", {
      reason: decision.reason,
      chatId,
      textPreview: text.slice(0, 80),
    });
    return;
  }

  // A loose code alone is tentative: the claim handler decides whether it was
  // a claim, so an error there should not answer ordinary chat.
  if (decision.reason !== "loose_task_code") addressed.chatId = chatId;

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

  const boardTime = detectBoardTimeCommand(text);
  if (boardTime) {
    await dispatchAwait("board_time", { chatId }, () =>
      handleBoardTimeCommand({ chatId, isDm, phone, time: boardTime.time }),
    );
    return;
  }

  const teamName = detectTeamNameCommand(text);
  if (teamName) {
    await dispatchAwait("team_name", { chatId }, () =>
      handleTeamNameCommand({ chatId, phone, name: teamName.name }),
    );
    return;
  }

  const command = detectTripCommand(text);
  if (command) {
    await dispatchAwait("trip_command", { chatId, command }, () =>
      handleTripCommand({ command, chatId, isDm, phone, displayName: senderName }),
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
      runClaimThenConversation(data as Record<string, unknown>, {
        photoBonusOpen,
        engaged: engagement?.engaged ?? false,
        photoOnly: engagement?.photoOnly ?? false,
      }),
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
  await handleSurveyDm({ phone, chatId, text, data: data as Record<string, unknown> });
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
      // Never seen in a real capture. Log the shape (not phone numbers or
      // text) so the first live tapback confirms or corrects the field names.
      const reaction = isRecord(envelope.data) ? envelope.data : null;
      console.info("[japlan.reaction] observed", {
        eventId: envelope.event_id ?? null,
        keys: reaction ? Object.keys(reaction) : null,
        reactionType: reaction?.reaction_type ?? null,
        hasMessageId: typeof reaction?.message_id === "string",
        chatId: reaction ? chatIdFromData(reaction) : null,
        fromShape: reaction?.from_handle
          ? "from_handle"
          : typeof reaction?.from === "string"
            ? "from"
            : "none",
      });
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
