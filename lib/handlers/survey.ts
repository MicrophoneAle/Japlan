import { sendText } from "@/lib/linq/send";
import { applyReply, type SurveyAnswers, type SurveyAwaiting } from "@/lib/game/survey";
import {
  findOpenSurveyByPhone,
  maybeActivateTrip,
  persistSurveyProgress,
} from "./bootstrap";

export async function handleSurveyDm(opts: {
  phone: string;
  chatId: string;
  text: string;
}): Promise<void> {
  if (!opts.text.trim()) {
    console.log("[japlan.dispatch] idle", {
      reason: "survey_empty_text",
      chatId: opts.chatId,
    });
    return;
  }
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
    console.log("[japlan.dispatch] idle", {
      reason: "survey_no_participant_for_chat",
      chatId: opts.chatId,
    });
    return;
  }
  if (!match.participant.survey_state || match.participant.survey_state === "done") {
    console.log("[japlan.dispatch] idle", {
      reason: "survey_already_done",
      chatId: opts.chatId,
      tripId: match.trip.id,
      surveyState: match.participant.survey_state,
    });
    return;
  }

  const step = applyReply(
    {
      awaiting: match.participant.survey_state as SurveyAwaiting,
      answers: (match.participant.survey_json ?? {}) as SurveyAnswers,
    },
    opts.text,
  );

  await persistSurveyProgress({
    participantId: match.participant.id,
    awaiting: step.state.awaiting,
    answers: step.state.answers,
  });

  if (step.prompt) {
    await sendText(opts.chatId, step.prompt);
  }

  if (step.completed) {
    await maybeActivateTrip(match.trip);
  }
}
