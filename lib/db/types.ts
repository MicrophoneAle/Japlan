import type { SurveyAnswers } from "@/lib/game/survey";

export type TripRow = {
  id: string;
  linq_chat_id: string;
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  play_mode?: "individual" | "teams" | "full_group" | null;
  state: string;
  difficulty: string | null;
  stake_text: string | null;
  timezone: string | null;
  destination_profile_json?: unknown | null;
  is_solo?: boolean;
  daily_points_cap?: number;
  organizer_participant_id?: string | null;
  setup_state?: string | null;
  completed_at?: string | null;
  // Local HH:MM the daily board posts. Default 08:00.
  board_time?: string | null;
  // Categories the group asked to avoid, category -> weight below 1.
  category_weights?: Record<string, number> | null;
  // The group's aggregate written profile, and whether the bot is currently
  // part of the group conversation.
  group_profile_md?: string | null;
  engagement_json?: unknown;
  created_at?: string;
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
  source?: string;
  // Rough time of day on the board (morning / afternoon / evening) and the
  // code's duration estimate. Null on tasks made before day planning.
  slot?: string | null;
  duration_minutes?: number | null;
  // What the board promised on a special day: the factor on base_points and
  // what to call it. Null on an ordinary day and on tasks made before day
  // multipliers.
  day_multiplier?: number | null;
  multiplier_reason?: string | null;
  created_at?: string;
};

export type ClaimRow = {
  id: string;
  task_id: string;
  participant_id: string;
  evidence_url: string | null;
  image_hash: string | null;
  storage_path?: string | null;
  status: string;
  awarded_points: number | null;
  resolved_by: string | null;
  resolution_json: unknown;
  capped?: boolean;
  photo_claimed_at?: string | null;
  expires_at?: string | null;
  created_at?: string;
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
  note?: string | null;
};

export type TeamRow = {
  id: string;
  trip_id: string;
  name: string;
  color: string;
  formed_at: string;
  dissolved_at: string | null;
  // One group of a conversational split: its trip day, own start, where it
  // is going, and when and where it rejoins everyone (local HH:MM).
  day?: number | null;
  starts_at?: string | null;
  rejoin_at?: string | null;
  rejoin_place?: string | null;
  area?: string | null;
};

export type ParticipantRow = {
  id: string;
  trip_id: string;
  phone: string;
  display_name: string;
  score: number;
  survey_json: SurveyAnswers | null;
  // Survey v2 weights with confidence (lib/game/prefs.ts) and the written
  // profile. Both DM-private, like survey_json.
  prefs_json?: unknown;
  profile_md?: string | null;
  survey_state: string | null;
  sidequests_muted: boolean;
  // Read in its own query (not in the standard participant selects).
  survey_nudged_on?: string | null;
  consented_at: string | null;
  created_at?: string;
};

export type SidequestRow = {
  id: string;
  trip_id: string;
  day: number;
  local_date: string;
  template_id: string;
  title: string;
  points: number;
  photo_bonus_max: number;
  trigger: string;
  status: "open" | "won" | "closed";
  won_by: string | null;
  won_at: string | null;
  created_at?: string;
};

export type SidequestOfferStatus = "queued" | "live" | "won" | "lost" | "expired" | "declined" | "dropped";

export type SidequestOfferRow = {
  id: string;
  sidequest_id: string;
  trip_id: string;
  participant_id: string;
  status: SidequestOfferStatus;
  queued_at: string | null;
  fired_at: string | null;
  expires_at: string | null;
  resolved_at: string | null;
  awarded_points: number | null;
  photo_bonus: number;
  created_at?: string;
};

// A day worth more points for everyone on the trip. Only looked-up days are
// stored; weekends are computed (lib/game/multipliers.ts).
export type MultiplierDayRow = {
  id: string;
  trip_id: string;
  local_date: string;
  multiplier: number;
  label: string;
  source: "holiday" | "festival";
  created_at?: string;
};
