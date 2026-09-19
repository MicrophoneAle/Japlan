import type { SurveyAnswers } from "@/lib/game/survey";

export type TripRow = {
  id: string;
  linq_chat_id: string;
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string;
  difficulty: string | null;
  stake_text: string | null;
  timezone: string | null;
};

export type ParticipantRow = {
  id: string;
  trip_id: string;
  phone: string;
  display_name: string;
  score: number;
  survey_json: SurveyAnswers | null;
  survey_state: string | null;
  sidequests_muted: boolean;
  consented_at: string | null;
};
