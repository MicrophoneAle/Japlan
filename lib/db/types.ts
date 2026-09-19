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
  destination_profile_json?: unknown | null;
  is_solo?: boolean;
};

export type TaskRow = {
  id: string;
  trip_id: string;
  participant_id: string | null;
  team_id: string | null;
  code: string;
  title: string;
  tier: string;
  axes_json: unknown;
  base_points: number;
  photo_bonus_max: number;
  verification: string;
  day: number;
  expires_at: string | null;
  neighborhood: string | null;
};

export type ClaimRow = {
  id: string;
  task_id: string;
  participant_id: string;
  evidence_url: string | null;
  image_hash: string | null;
  status: string;
  awarded_points: number | null;
  resolved_by: string | null;
  resolution_json: unknown;
};

export type PlaceRow = {
  id: string;
  trip_id: string;
  fsq_place_id: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  category: string | null;
  source: string | null;
  suggested_by: string | null;
  hours_json: unknown;
  price_band: number | null;
  score: number | null;
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
