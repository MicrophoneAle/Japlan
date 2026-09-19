import { sendText } from "@/lib/linq/send";
import { applyReply, type SurveyAnswers, type SurveyAwaiting } from "@/lib/game/survey";
import { QUESTIONS, type QuestionId } from "@/lib/game/survey-questions";
import { isSetupQuestion, missingRequiredSetup, type SetupFields } from "@/lib/game/setup";
import {
  SURVEY_DONE_DM,
  dmClaimInGroupLine,
  dmUnknownPersonLine,
  surveyDoneLine,
} from "@/lib/game/copy";
import type { LLMProvider } from "@/lib/llm";
import {
  countSurveysPending,
  findOpenSurveyByPhone,
  maybeActivateTrip,
  persistSurveyProgress,
} from "./bootstrap";
import { nextStepForParticipant } from "./claims";
import { answerSetup, needsSetupResume, resumeSetup, setupPromptFor } from "./setup";

// Every DM is addressed, so every branch here sends exactly one message.
// Order: the organizer's trip setup, then the personal survey, then claims
// guidance once both are done.
export async function handleSurveyDm(opts: {
  phone: string;
  chatId: string;
  text: string;
  provider?: LLMProvider;
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

  if (isOrganizer && isSetupQuestion(trip.setup_state)) {
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

  if (!state || state === "done") {
    // Survey finished and solo mode is off: claims belong in the group.
    console.log("[japlan.dispatch] step", {
      step: "survey.already_done",
      chatId: opts.chatId,
      tripId: trip.id,
    });
    const next = await nextStepForParticipant(trip, participant.id);
    await sendText(opts.chatId, dmClaimInGroupLine(next));
    return;
  }

  if (!opts.text.trim()) {
    // A photo or empty DM mid-survey: ask the current question again.
    const prompt = QUESTIONS[state as QuestionId]?.prompt;
    if (prompt) await sendText(opts.chatId, prompt);
    return;
  }

  const step = applyReply(
    {
      awaiting: state as SurveyAwaiting,
      answers: (participant.survey_json ?? {}) as SurveyAnswers,
    },
    opts.text,
    { isSolo: Boolean(trip.is_solo) },
  );

  await persistSurveyProgress({
    participantId: participant.id,
    awaiting: step.state.awaiting,
    answers: step.state.answers,
  });

  if (step.completed) {
    if (trip.is_solo) {
      // Solo: this DM is also the trip chat, so "we're live" joins this reply.
      const live = await maybeActivateTrip(trip, { announce: false });
      if (live) {
        await sendText(opts.chatId, `${SURVEY_DONE_DM} ${live}`);
        return;
      }
    }
    const waitingOn = await countSurveysPending(trip.id);
    const setupPending = missingRequiredSetup(trip as SetupFields).length > 0;
    let reply = surveyDoneLine(waitingOn, setupPending);
    if (isOrganizer && needsSetupResume(trip)) {
      // The organizer owes setup answers: ask the next one in the same message.
      reply = `${reply} ${await resumeSetup(trip)}`;
    } else if (isOrganizer && isSetupQuestion(trip.setup_state)) {
      reply = `${reply} ${setupPromptFor(trip, trip.setup_state)}`;
    }
    await sendText(opts.chatId, reply);
    if (!trip.is_solo) await maybeActivateTrip(trip);
    return;
  }

  if (step.prompt) {
    await sendText(opts.chatId, step.prompt);
  }
}
