import { sendText } from "@/lib/linq/send";
import { getServiceClient } from "@/lib/db/client";
import {
  applyReply,
  isSidequestClarificationRequest,
  isSidequestQuestion,
  startSurvey,
  type SurveyAnswers,
  type SurveyAwaiting,
} from "@/lib/game/survey";
import { defaultWakeKeyword, findTaskCode, stripWakeKeyword } from "@/lib/game/addressing";
import { isStandingsRequest } from "@/lib/game/commands";
import { isBoardRequest } from "@/lib/game/board-schedule";
import {
  extractPreferredName,
  fallbackPreferredName,
  interpretSurveyReply,
} from "@/lib/llm/gemini";
import { checkReply } from "@/lib/game/reply-check";
import { saveSurveyResult } from "./profiles";
import { QUESTIONS, type QuestionId } from "@/lib/game/survey-questions";
import { isSetupQuestion, missingRequiredSetup, type SetupFields } from "@/lib/game/setup";
import {
  SURVEY_DONE_DM,
  dmUnknownPersonLine,
  surveyDoneLine,
  UNDER_AGE_LINE,
  groupSetupPendingDmLine,
  surveyProgressGroupLine,
  sidequestClarificationLine,
  ONBOARDING_ACK_LINE,
} from "@/lib/game/copy";
import type { LLMProvider } from "@/lib/llm";
import {
  findOpenSurveyByPhone,
  getTripById,
  maybeActivateTrip,
  persistSurveyProgress,
  sidequestPromptIfNew,
} from "./bootstrap";
import { boardForNewlyReady } from "./board-request";
import { handleGroupClaim } from "./claims";
import { handleConversation } from "./conversation";
import { answerSetup, needsSetupResume, resumeSetup, setupPromptFor } from "./setup";
import { importSurveySuggestions } from "./plan-changes";
import { isUnderAge } from "@/lib/game/preferences";

// Every DM is addressed, so every branch here sends exactly one message.
// Order: the organizer's trip setup, then the personal survey, then claims
// guidance once both are done.
export async function handleSurveyDm(opts: {
  phone: string;
  chatId: string;
  text: string;
  provider?: LLMProvider;
  // The raw inbound message, for routing a done participant's DM to their trip.
  data?: Record<string, unknown>;
}): Promise<void> {
  console.log("[japlan.dispatch] step", {
    step: "survey.lookup.before",
    chatId: opts.chatId,
  });
  const match = await findOpenSurveyByPhone(opts.phone, opts.chatId);
  console.log("[japlan.dispatch] step", {
    step: "survey.lookup.after",
    chatId: opts.chatId,
    found: Boolean(match),
    tripId: match?.trip.id ?? null,
    surveyState: match?.participant.survey_state ?? null,
    setupState: match?.trip.setup_state ?? null,
  });
  if (!match) {
    await sendText(opts.chatId, dmUnknownPersonLine());
    return;
  }

  const { trip, participant } = match;
  const isOrganizer = trip.organizer_participant_id === participant.id;
  const state = participant.survey_state;
  const surveyInProgress = Boolean(state && state !== "done" && state !== "not_started");

  if (!trip.is_solo && isSetupQuestion(trip.setup_state)) {
    const { data: organizerRow, error } = await getServiceClient()
      .from("participants")
      .select("display_name")
      .eq("id", trip.organizer_participant_id ?? "")
      .maybeSingle();
    if (error) throw error;
    const organizerName = (organizerRow as { display_name?: string } | null)?.display_name ?? "the organizer";
    await sendText(opts.chatId, groupSetupPendingDmLine(organizerName));
    return;
  }

  if (isOrganizer && trip.is_solo && isSetupQuestion(trip.setup_state)) {
    const reply = await answerSetup({
      trip,
      organizer: participant,
      text: opts.text,
      deps: { provider: opts.provider },
    });
    await sendText(opts.chatId, reply);
    return;
  }

  // Skipped setup is asked again on the organizer's next message, never on a
  // timer. Not mid-survey, so a survey answer is never swallowed.
  if (isOrganizer && !surveyInProgress && needsSetupResume(trip)) {
    await sendText(opts.chatId, await resumeSetup(trip));
    return;
  }

  if (!state || state === "not_started") {
    const started = startSurvey();
    if (started.prompt === null) {
      throw new Error("initial survey step must include a prompt");
    }
    await persistSurveyProgress({
      participantId: participant.id,
      awaiting: started.state.awaiting,
      answers: started.state.answers,
    });
    await sendText(opts.chatId, started.prompt);
    return;
  }

  if (state === "done") {
    if (isSimpleAcknowledgement(opts.text)) {
      await sendText(opts.chatId, ONBOARDING_ACK_LINE);
      return;
    }
    // Survey done: this DM is a claim, a board request, or conversation about
    // their trip. Handle it here rather than sending them to the group chat.
    // Replies stay in this DM; a claim confirmation also posts to the group.
    console.log("[japlan.dispatch] step", {
      step: "survey.done.route_to_trip",
      chatId: opts.chatId,
      tripId: trip.id,
    });
    if (!opts.data) {
      await sendText(opts.chatId, dmUnknownPersonLine());
      return;
    }
    const miss = await handleGroupClaim(opts.data, { tripChatId: trip.linq_chat_id });
    if (miss) await handleConversation(miss);
    return;
  }

  if (!opts.text.trim()) {
    // A photo or empty DM mid-survey: ask the current question again.
    const q = QUESTIONS[state as QuestionId];
    if (q) await sendText(opts.chatId, q.reask ?? q.prompt);
    return;
  }

  // Mid-onboarding is not a lock: clear task codes, board requests, and
  // standings requests go to the game. A prefixed survey answer stays here.
  if (opts.data && isGameMessage(opts.text) && trip.state === "active") {
    const miss = await handleGroupClaim(opts.data, { tripChatId: trip.linq_chat_id });
    if (miss) await handleConversation(miss);
    return;
  }

  if (
    (state === "sidequest_level" || state === "sidequest_red_lines") &&
    isSidequestClarificationRequest(opts.text)
  ) {
    const question = QUESTIONS[state];
    await sendText(
      opts.chatId,
      `${sidequestClarificationLine(state)}\n${question.prompt}`,
    );
    return;
  }

  const answersBefore = (participant.survey_json ?? {}) as SurveyAnswers;
  const machine = { awaiting: state as SurveyAwaiting, answers: answersBefore };
  const ctx = { isSolo: Boolean(trip.is_solo) };
  let step = applyReply(machine, opts.text, ctx);
  let offTopic: string | null = null;

  if (step.unclear) {
    // The parser could not read it: the model either reads it as an answer
    // (a sentence, a loose "the food one obviously") or answers it as the
    // off-topic message it was. Then the question comes back, reworded.
    const q = QUESTIONS[state as QuestionId];
    const read = await interpretSurveyReply({
      provider: opts.provider,
      question: q.prompt,
      options: q.sides ? [q.sides.a, q.sides.b, "both", "neither"] : q.choices?.map((c) => c.label),
      text: opts.text,
    });
    surveyStep("interpret", { state, answered: Boolean(read?.answer), offTopic: Boolean(read?.reply) });
    if (read?.answer) {
      const retry = applyReply({ awaiting: machine.awaiting, answers: step.state.answers }, read.answer, ctx);
      if (!retry.unclear) step = retry;
    } else if (read?.reply) {
      // Held to the same rule as the conversation: no codes, numbers, people
      // or places it was not given. A failed check drops the aside and just
      // re-asks.
      const check = checkReply(read.reply, {
        taskCodes: [],
        people: [],
        toolText: "",
        userText: opts.text,
        contextText: "",
        // A survey aside is chat, never an action. It may not claim one.
        stateChanged: false,
      });
      if (check.ok) offTopic = read.reply;
      else console.warn("[japlan.survey] aside discarded", { participantId: participant.id, reason: check.reason });
    }
  }

  if (state === "first_name" && !step.unclear) {
    const rawAnswer = step.state.answers.first_name?.value;
    const rawName = rawAnswer ? stripWakeKeyword(rawAnswer, defaultWakeKeyword()).trim() : undefined;
    if (rawAnswer && !rawName) {
      await sendText(opts.chatId, "i couldn't pick out a name there. what should i call you? just the name is fine, or say skip.");
      return;
    }
    if (rawName) {
      let preferredName: string | null = null;
      try {
        preferredName = await extractPreferredName({ provider: opts.provider, text: rawName });
      } catch (err) {
        console.warn("[japlan.survey] preferred-name extraction failed", {
          participantId: participant.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      preferredName ??= fallbackPreferredName(rawName);
      if (!preferredName) {
        await sendText(opts.chatId, "i couldn't pick out a name there. what should i call you? just the name is fine, or say skip.");
        return;
      }
      const answer = step.state.answers.first_name;
      if (!answer) throw new Error("preferred-name answer missing from survey state");
      step = {
        ...step,
        state: {
          ...step.state,
          answers: {
            ...step.state.answers,
            first_name: { ...answer, value: preferredName },
          },
        },
      };
    }
  }

  await persistSurveyProgress({
    participantId: participant.id,
    awaiting: step.state.awaiting,
    answers: step.state.answers,
  });

  if (step.unclear) {
    const lead = offTopic ?? (step.noted ? "noted." : null);
    await sendText(opts.chatId, lead ? `${lead} ${step.prompt}` : (step.prompt ?? ""));
    return;
  }

  // The sidequest onboarding finished: store what it means and say so.
  if (step.completed && isSidequestQuestion(state)) {
    // Saved with what the answers imply (red lines -> sociability), so the
    // progress write must carry those too, not the raw answers.
    const saved = await saveSurveyResult(trip, participant, step.state.answers);
    await persistSurveyProgress({ participantId: participant.id, awaiting: "done", answers: saved });
    await sendText(opts.chatId, step.prompt ?? "noted.");
    return;
  }

  if (step.completed) {
    const answers = await saveSurveyResult(trip, participant, step.state.answers);
    // Their own list of places joins the trip's suggestions, credited to them.
    try {
      await importSurveySuggestions(trip, participant, answers);
    } catch (err) {
      console.error("[japlan.suggest] survey import failed", err);
    }
    if (!trip.is_solo) {
      const peopleRes = await getServiceClient()
        .from("participants")
        .select("id, display_name, survey_state")
        .eq("trip_id", trip.id);
      if (peopleRes.error) throw peopleRes.error;
      const waiting = (peopleRes.data ?? [])
        .filter((row) => (row as { survey_state: string | null }).survey_state !== "done")
        .map((row) => (row as { display_name: string }).display_name);
      await sendText(trip.linq_chat_id, surveyProgressGroupLine(participant.display_name, waiting));
    }
    if (isUnderAge(answers)) {
      await sendText(opts.chatId, `${SURVEY_DONE_DM} ${UNDER_AGE_LINE}`);
      if (!trip.is_solo) await maybeActivateTrip(trip, { quietFor: participant.id });
      return;
    }
    // No destination or dates yet: nothing to make a board for. The organizer
    // is asked their next setup question in the same message.
    const setupPending = missingRequiredSetup(trip as SetupFields).length > 0;
    if (setupPending || (isOrganizer && (needsSetupResume(trip) || isSetupQuestion(trip.setup_state)))) {
      let reply = surveyDoneLine(0, setupPending);
      if (isOrganizer && needsSetupResume(trip)) {
        reply = `${reply} ${await resumeSetup(trip)}`;
      } else if (isOrganizer && isSetupQuestion(trip.setup_state)) {
        reply = `${reply} ${setupPromptFor(trip, trip.setup_state)}`;
      }
      await sendText(opts.chatId, reply);
      return;
    }
    // Ready. The trip goes live on the first finished survey (announced in
    // the group; a solo trip's chat is this DM, so it joins this reply). The
    // person gets instructions to request a board plus the sidequest question.
    const live = await maybeActivateTrip(trip, { announce: !trip.is_solo, quietFor: participant.id });
    const fresh = (await getTripById(trip.id)) ?? trip;
    const active = fresh.state === "active";
    const board = active ? await boardForNewlyReady(fresh, participant.id, new Date()) : null;
    const sidequests = active ? await sidequestPromptIfNew(participant.id, answers) : null;
    const head = board ? SURVEY_DONE_DM : surveyDoneLine(0, false);
    const opening = trip.is_solo && live ? `${head} ${live}` : head;
    surveyStep("completed.reply", {
      participantId: participant.id,
      activated: Boolean(live),
      board: Boolean(board),
      sidequests: Boolean(sidequests),
    });
    await sendText(opts.chatId, [opening, board, sidequests].filter(Boolean).join("\n\n"));
    return;
  }

  if (step.prompt) {
    const lead = offTopic ?? (step.noted ? "noted." : null);
    await sendText(opts.chatId, lead ? `${lead} ${step.prompt}` : step.prompt);
  }
}

function surveyStep(step: string, fields: Record<string, unknown>): void {
  console.log("[japlan.survey] step", { step, ...fields });
}

// Clear game requests can interrupt the survey. A wake keyword on its own
// cannot: people naturally use it when replying to Japlan's question.
function isGameMessage(text: string): boolean {
  const code = findTaskCode(text);
  const reportsCompletion =
    /\b(?:i|we)\s+(?:just\s+)?(?:did|finished|completed|claimed|got|nailed|managed)\b/i.test(text) ||
    /\b(?:done|finished|completed)\s+(?:with\s+)?(?:the\s+)?(?:task\s+)?[a-z]\d{1,2}\b/i.test(text);
  return Boolean(code?.strict || (code && reportsCompletion)) || isBoardRequest(text) || isStandingsRequest(text);
}

function isSimpleAcknowledgement(text: string): boolean {
  const body = stripWakeKeyword(text, defaultWakeKeyword())
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  return /^(?:ok(?:ay)?|k|got it|thanks|thank you|cool|nice|sounds good|yep|yeah|👍|👌)$/i.test(body);
}
