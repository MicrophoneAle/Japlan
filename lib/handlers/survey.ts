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
  if (!opts.text.trim()) return;
  const match = await findOpenSurveyByPhone(opts.phone);
  if (!match) return;
  if (!match.participant.survey_state || match.participant.survey_state === "done") {
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
