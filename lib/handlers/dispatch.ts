import { getServiceClient } from "@/lib/db/client";
import { captureLinks } from "./social-links";
import { findUrls } from "@/lib/game/urls";
import { defaultWakeKeyword, evaluateAddress, findTaskCode, wakeKeywordRe } from "@/lib/game/addressing";
import { detectBoardTimeCommand, detectTeamNameCommand, detectTripCommand } from "@/lib/game/commands";
import { DISPATCH_ERROR_LINE } from "@/lib/game/copy";
import { handleBoardTimeCommand, handleTripCommand } from "@/lib/handlers/trip-lifecycle";
import { handleTeamNameCommand } from "@/lib/handlers/teams";
import { routeSoloDm, soloModeEnabled } from "@/lib/game/solo";
import {
  bootstrapGroupIfNeeded,
  findOpenSurveyByPhone,
  findParticipantOnTrip,
  listParticipants,
} from "@/lib/handlers/bootstrap";
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
import { handleGroupSetupMessage } from "@/lib/handlers/setup";
import {
  handleGroupDecisionMessage,
  handleGroupDecisionPollVote,
  handleGroupDecisionReaction,
} from "@/lib/handlers/group-decisions";
import {
  activateParticipantLocationSharing,
  handleLocationSharingWebhook,
  requestTripLocationSharing,
  stopParticipantLocationSharing,
} from "@/lib/handlers/live-location";
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

  // Links go on a queue and nothing more: one insert, no fetch, no model, no
  // browser. Resolution happens on the cron, off this path entirely, because
  // a session-free read is still a network call and the 200 comes first.
  if (text) {
    await dispatchAwait("capture_links", { chatId }, () => captureLinksFor(chatId, phone, text)).catch(
      (err) => dispatchStep("capture_links.failed", { chatId, error: err instanceof Error ? err.message : String(err) }),
    );
  }

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

  const locationRequest = text.trim().match(/^japlan\s+(?:request|share|turn on)\s+locations?(?:\s+sharing)?[.!?]*$/i);
  if (locationRequest && !isDm) {
    const trip = await dispatchAwait("location_request.trip_lookup", { chatId }, () =>
      getTripByChatId(chatId),
    );
    if (!trip || !phone) {
      await sendText(chatId, "i couldn't match this chat to an active trip yet.");
      return;
    }
    const [organizer, participants] = await Promise.all([
      findParticipantOnTrip(trip.id, phone),
      listParticipants(trip.id),
    ]);
    if (!organizer) {
      await sendText(chatId, "i couldn't match you to this trip's member list.");
      return;
    }
    const result = await dispatchAwait("location_request.send_consent", { tripId: trip.id }, () =>
      requestTripLocationSharing({ trip, organizer, participants }),
    );
    if (result.status === "organizer_only") {
      const owner = participants.find((person) => person.id === trip.organizer_participant_id);
      await sendText(chatId, `👑 ${owner?.display_name ?? "the organizer"} controls shared trip settings. ask them to request location sharing.`);
      return;
    }
    if (result.status === "not_active") {
      await sendText(chatId, "location sharing is available during the active trip. finish setup and start the trip first.");
      return;
    }
    const requested = result.people.filter((person) => person.status === "requested").length;
    const alreadyPending = result.people.filter((person) => person.status === "already_pending").length;
    const alreadyActive = result.people.filter((person) => person.status === "already_active").length;
    const unsupported = result.people.filter((person) => person.status === "unsupported").length;
    const failed = result.people.filter((person) => person.status === "failed").length;
    await sendText(
      chatId,
      `📍 sent private consent prompts to ${requested} ${requested === 1 ? "person" : "people"}.${alreadyPending ? ` ${alreadyPending} ${alreadyPending === 1 ? "person already has" : "people already have"} an open request.` : ""}${alreadyActive ? ` ${alreadyActive} ${alreadyActive === 1 ? "person is" : "people are"} already sharing.` : ""} sharing is optional; when someone accepts, i'll use a fresh location only when the group asks for a live plan. exact locations stay private.${unsupported ? ` ${unsupported} chat${unsupported === 1 ? "" : "s"} can't use Apple's location prompt.` : ""}${failed ? ` ${failed} prompt${failed === 1 ? "" : "s"} couldn't be sent.` : ""}`,
    );
    return;
  }

  const decisionHandled = await dispatchAwait("group_decision_command", { chatId, isDm }, () =>
    handleGroupDecisionMessage({ chatId, isDm, phone, text }),
  );
  if (decisionHandled) return;

  if (!isDm && phone) {
    const handled = await dispatchAwait("group_setup_answer", { chatId }, () =>
      handleGroupSetupMessage({ chatId, senderPhone: phone, text }),
    );
    if (handled) return;
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

  const dmTrip = await findOpenSurveyByPhone(phone, chatId);
  if (/^(?:japlan\s+)?(?:share|turn on)\s+(?:my\s+)?location(?:\s+sharing)?[.!?]*$/i.test(text.trim())) {
    if (!dmTrip) {
      await sendText(chatId, "location sharing is available during an active trip. finish setup and start the trip first.");
      return;
    }
    const status = await dispatchAwait("location_request.self", { tripId: dmTrip.trip.id }, () =>
      activateParticipantLocationSharing({
        trip: dmTrip.trip,
        participant: dmTrip.participant,
        directChatId: chatId,
      }),
    );
    const replies = {
      requested: "📍 accept Apple's prompt if you're comfortable. i'll check your location only when the group asks for a live plan, and share only your approximate area.",
      already_pending: "📍 there's already a location request waiting in this chat. accept it if you're comfortable.",
      already_active: "📍 you're already sharing. i'll only check when the group asks for a live plan; say “japlan stop location” to stop.",
      not_active: "location sharing is available during the active trip.",
      not_participant: "i couldn't match this direct chat to your trip profile.",
      failed: "i couldn't send the Apple location prompt just now. try again in a moment.",
      unsupported: "location sharing needs a 1:1 iMessage chat. you can still tell me your neighborhood for nearby ideas.",
    } as const;
    await sendText(chatId, replies[status]);
    return;
  }
  if (/^(?:japlan\s+)?stop\s+location(?:\s+sharing)?[.!?]*$/i.test(text.trim())) {
    if (!dmTrip) {
      await sendText(chatId, "there's no trip location sharing to stop here.");
      return;
    }
    const stopped = await dispatchAwait("location_request.stop", { tripId: dmTrip.trip.id }, () =>
      stopParticipantLocationSharing({
        tripId: dmTrip.trip.id,
        participantId: dmTrip.participant.id,
        phone,
      }),
    );
    await sendText(
      chatId,
      stopped === "stopped"
        ? "📍 done. i stopped using your location for Japlan. Apple may still show sharing until you turn it off in Messages too."
        : stopped === "unavailable"
          ? "📍 i've stopped using your location in Japlan across your trips, but couldn't confirm Apple's share ended. turn it off in Messages too."
          : "you're not sharing a location with Japlan right now.",
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
  const retryableLiveEvent =
    envelope.event_type === "poll.vote.added" ||
    envelope.event_type === "poll.vote.removed" ||
    envelope.event_type === "location.sharing.started" ||
    envelope.event_type === "location.sharing.stopped";
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
    } else if (
      envelope.event_type === "poll.vote.added" ||
      envelope.event_type === "poll.vote.removed"
    ) {
      if (!isRecord(envelope.data)) {
        dispatchIdle("poll_vote_not_a_record");
      } else {
        await dispatchAwait("group_decision_poll_vote", { eventType: envelope.event_type }, () =>
          handleGroupDecisionPollVote(envelope.event_type!, envelope.data as Record<string, unknown>),
        );
      }
    } else if (
      envelope.event_type === "location.sharing.started" ||
      envelope.event_type === "location.sharing.stopped"
    ) {
      if (!isRecord(envelope.data)) {
        dispatchIdle("location_event_not_a_record");
      } else {
        await dispatchAwait("location_sharing_webhook", { eventType: envelope.event_type }, () =>
          handleLocationSharingWebhook(envelope.event_type!, envelope.data as Record<string, unknown>),
        );
      }
    } else if (
      envelope.event_type === "reaction.added" ||
      envelope.event_type === "reaction.removed"
    ) {
      // Never seen in a real capture. Log the shape (not phone numbers or
      // text) so the first live tapback confirms or corrects the field names.
      const reaction = isRecord(envelope.data) ? envelope.data : null;
      console.info("[japlan.reaction] observed", {
        eventId: envelope.event_id ?? null,
        eventType: envelope.event_type,
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
        const decisionHandled = await dispatchAwait("group_decision_reaction", {}, () =>
          handleGroupDecisionReaction(
            envelope.data as Record<string, unknown>,
            envelope.event_type === "reaction.removed" ? "removed" : "added",
          ),
        );
        if (!decisionHandled && envelope.event_type === "reaction.added") {
          await dispatchAwait("peer_reaction", {}, () =>
            handlePeerReaction(envelope.data as Record<string, unknown>),
          );
        }
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
    // Addressed inbound messages get a user-facing error reply and are marked
    // processed. Poll and location webhooks have no reply path, so leave a
    // failed event unprocessed for the stalled-event sweep to retry once.
    if (!retryableLiveEvent) {
      await markProcessed(envelope.event_id).catch(() => {});
    } else {
      console.warn("[japlan.dispatch] live webhook left unprocessed for retry", {
        eventId: envelope.event_id ?? null,
        type: envelope.event_type ?? null,
      });
    }
  } finally {
    dispatchStep("dispatchLinqEvent.exit", {
      type: envelope.event_type ?? null,
      eventId: envelope.event_id ?? null,
    });
  }
}


// One insert per new link in a message. Never throws and never blocks: a link
// we fail to record is worth less than the message it arrived in.
async function captureLinksFor(
  chatId: string,
  phone: string | null,
  text: string,
): Promise<void> {
  if (findUrls(text).length === 0) return;
  const trip = await getTripByChatId(chatId);
  if (!trip) return;
  const participantId = phone ? await participantIdFor(trip.id, phone) : null;
  await captureLinks({ tripId: trip.id, participantId, chatId, text });
}

async function participantIdFor(tripId: string, phone: string): Promise<string | null> {
  const { data } = await getServiceClient()
    .from("participants")
    .select("id")
    .eq("trip_id", tripId)
    .eq("phone", phone)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
