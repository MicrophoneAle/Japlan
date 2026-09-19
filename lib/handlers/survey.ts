import { sendText } from "@/lib/linq/send";
import { applyReply, type SurveyAnswers, type SurveyAwaiting } from "@/lib/game/survey";
import { QUESTIONS, type QuestionId } from "@/lib/game/survey-questions";
import {
  dmClaimInGroupLine,
  dmUnknownPersonLine,
  surveyDoneLine,
} from "@/lib/game/copy";
import {
  countSurveysPending,
  findOpenSurveyByPhone,
  maybeActivateTrip,
  persistSurveyProgress,
} from "./bootstrap";
import { nextStepForParticipant } from "./claims";

// Every DM is addressed, so every branch here sends exactly one message.
export async function handleSurveyDm(opts: {
  phone: string;
  chatId: string;
  text: string;
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
  });
  if (!match) {
    console.log("[japlan.dispatch] step", {
      step: "survey.no_participant_for_chat",
      chatId: opts.chatId,
    });
    await sendText(opts.chatId, dmUnknownPersonLine());
    return;
  }

  const state = match.participant.survey_state;
  if (!state || state === "done") {
    // Survey finished and solo mode is off: claims belong in the group.
    console.log("[japlan.dispatch] step", {
      step: "survey.already_done",
      chatId: opts.chatId,
      tripId: match.trip.id,
    });
    const next = await nextStepForParticipant(match.trip, match.participant.id);
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
      answers: (match.participant.survey_json ?? {}) as SurveyAnswers,
    },
    opts.text,
  );

  await persistSurveyProgress({
    participantId: match.participant.id,
    awaiting: step.state.awaiting,
    answers: step.state.answers,
  });

  if (step.completed) {
    const waitingOn = await countSurveysPending(match.trip.id);
    await sendText(opts.chatId, surveyDoneLine(waitingOn));
    await maybeActivateTrip(match.trip);
    return;
  }

  if (step.prompt) {
    await sendText(opts.chatId, step.prompt);
  }
}
