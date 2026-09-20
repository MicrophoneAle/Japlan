-- Japlan Postgres schema, taken from the Data model section of docs/PLAN.md.
--
-- TODO: plan does not specify id types; using uuid + gen_random_uuid() (Supabase default).
-- created_at is on every game table except teams (which already has formed_at).
-- FKs cascade down the trip tree so "delete from trips where id = ..." removes
-- everything beneath it. events.trip_id is SET NULL: event rows are the
-- idempotency guard and must outlive the trip.
-- TODO: events.trip_id is nullable because inbound webhooks can arrive before a trip row exists.
-- TODO: a `channel` field is required later for RCS/WhatsApp, but is not in the Data model; omitted.
-- TODO: enum values for trips.state, trips.difficulty, tasks.tier, tasks.verification, claims.status are unspecified; stored as text.

create table trips (
  id uuid primary key default gen_random_uuid(),
  -- One open trip per chat: see trips_one_open_trip_per_chat below.
  linq_chat_id text not null,
  name text not null,
  -- TODO: destination/dates/difficulty/timezone are unknown at bot-added bootstrap.
  destination text,
  start_date date,
  end_date date,
  play_mode text
    constraint trips_play_mode_check check (play_mode in ('individual', 'teams', 'full_group')),
  state text not null,
  difficulty text,
  stake_text text,
  timezone text,
  destination_profile_json jsonb,
  is_solo boolean not null default false,
  daily_points_cap integer not null default 120,
  -- Set when the group intro goes out; it is posted at most once per chat.
  intro_sent_at timestamptz,
  completed_at timestamptz,
  -- Answers the organizer setup. Linq never says who added the bot, so this is
  -- whoever sent the first group message (or the solo participant). FK added
  -- after participants exists, below.
  organizer_participant_id uuid,
  -- destination | dates | play_mode | difficulty | stake while asking,
  -- 'deferred' when a required answer was skipped, 'done', or null before setup.
  setup_state text,
  -- Local HH:MM the daily board posts.
  board_time text not null default '08:00'
    constraint trips_board_time_format check (board_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Categories the group asked to avoid ("no temples"): category -> weight.
  category_weights jsonb not null default '{}'::jsonb,
  -- Group aggregate profile (no names) and group-chat engagement state.
  group_profile_md text,
  engagement_json jsonb,
  -- "waiting on X and Y": sent once, only while nobody has finished.
  waiting_notice_sent_at timestamptz,
  -- Sidequest tick bookkeeping (lib/handlers/sidequests.ts).
  sidequest_state jsonb,
  -- When this trip's holidays were last fetched (lib/handlers/holidays.ts).
  -- Not in TRIP_COLS on purpose: only the holiday refresh selects it.
  multipliers_checked_at timestamptz,
  -- One show suggestion per trip, ever (lib/handlers/show-suggestion.ts).
  -- Also deliberately out of TRIP_COLS.
  show_suggested_at timestamptz,
  created_at timestamptz not null default now()
);

-- A completed trip frees the chat for "japlan new trip".
create unique index trips_one_open_trip_per_chat on trips (linq_chat_id)
  where state <> 'complete';
create index trips_linq_chat_id_idx on trips (linq_chat_id);

create table participants (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  phone text not null,
  display_name text not null,
  score integer not null default 0,
  survey_json jsonb,
  survey_state text,
  sidequests_muted boolean not null default false,
  -- Survey v2 weights with confidence, and the written profile. DM-private.
  prefs_json jsonb,
  profile_md text,
  -- Last local day this person got a "your next question" DM at board time.
  survey_nudged_on date,
  consented_at timestamptz,
  created_at timestamptz not null default now(),
  unique (trip_id, phone)
);

alter table trips add constraint trips_organizer_participant_id_fkey
  foreign key (organizer_participant_id) references participants (id) on delete set null;

create index participants_phone_idx on participants (phone);
create index participants_trip_id_idx on participants (trip_id);

-- Consent and the one-to-one Linq chat needed for on-demand location reads.
-- Coordinates and provider location responses are never persisted.
create table trip_location_shares (
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  direct_chat_id text not null,
  share_status text not null check (
    share_status in ('requested', 'active', 'stopped', 'expired', 'unsupported')
  ),
  expires_at timestamptz not null,
  primary key (trip_id, participant_id)
);

create index trip_location_shares_active_idx
  on trip_location_shares (trip_id, share_status, expires_at);

-- Shared group choices. Native polls allow several selections per person;
-- unsupported chats use one-choice option-message tapbacks. Silence is an
-- abstention, and the organizer makes the final call.
create table group_decisions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  prompt text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid not null references participants (id) on delete cascade,
  selected_option integer,
  poll_message_id text,
  voting_mode text not null default 'reactions'
    constraint group_decisions_voting_mode_check check (voting_mode in ('reactions', 'native_poll')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  last_reminded_at timestamptz
);

create unique index group_decisions_one_open_per_trip
  on group_decisions (trip_id) where status = 'open';
create unique index group_decisions_poll_message_id_key
  on group_decisions (poll_message_id) where poll_message_id is not null;

create table group_decision_options (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references group_decisions (id) on delete cascade,
  option_index integer not null check (option_index > 0),
  label text not null,
  message_id text,
  poll_option_id text,
  unique (decision_id, option_index)
);

create unique index group_decision_options_message_id_key
  on group_decision_options (message_id) where message_id is not null;
create unique index group_decision_options_poll_option_id_key
  on group_decision_options (poll_option_id) where poll_option_id is not null;

create table group_decision_votes (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references group_decisions (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  option_index integer not null check (option_index > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (decision_id, participant_id, option_index)
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  name text not null,
  color text not null,
  formed_at timestamptz not null,
  dissolved_at timestamptz,
  -- A conversational split: trip day, own start, area, rejoin time and place.
  day integer,
  starts_at text,
  rejoin_at text,
  rejoin_place text,
  area text
);

create table team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table places (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  fsq_place_id text,
  name text not null,
  lat double precision,
  lng double precision,
  category text,
  source text,
  -- TODO: plan does not specify whether suggested_by is a participant id or a free-text handle.
  suggested_by text,
  hours_json jsonb,
  price_band integer,
  score numeric,
  -- source 'suggestion': the words used ("a jazz bar in golden gai").
  note text,
  -- Which city this place is in. Clustering never routes across legs, so a
  -- Tokyo place can never be the nearest neighbour of an Osaka task.
  leg_id uuid references trip_legs (id) on delete set null,
  -- source 'social': the link it came from, the street address off the
  -- caption (the poster's own words, not a licensed Foursquare field), and
  -- when it resolved. fsq_place_id stays null while Foursquare has no
  -- credits; places_needs_fsq is the backfill query.
  source_url text,
  address text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (trip_id, fsq_place_id)
);

create table itinerary (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  day integer not null,
  anchor_order integer not null,
  place_id uuid not null references places (id) on delete cascade,
  planned_time timestamptz,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid references participants (id) on delete cascade,
  team_id uuid references teams (id) on delete cascade,
  code text not null,
  title text not null,
  tier text not null,
  axes_json jsonb not null,
  base_points integer not null,
  photo_bonus_max integer not null,
  verification text not null,
  day integer not null,
  expires_at timestamptz,
  neighborhood text,
  -- generated | freeform | curveball
  source text not null default 'generated',
  -- Day planning: rough time of day and the code's duration estimate.
  slot text,
  duration_minutes integer,
  -- What the board promised on a special day (lib/game/multipliers.ts): the
  -- factor on base_points, and what to call it. Kept off base_points so the
  -- printed points and the tier band stay the task's own worth; on a
  -- multiplier day base_points is the task's UNSCALED worth, because the
  -- multiplier replaces dayValueMultiplier rather than compounding with it.
  day_multiplier numeric check (day_multiplier is null or (day_multiplier > 1 and day_multiplier <= 3)),
  multiplier_reason text,
  created_at timestamptz not null default now(),
  -- Shared board tasks may have both assignee columns null (first write wins).
  -- Split-team tasks set team_id; personal tasks set participant_id. Never both.
  constraint tasks_at_most_one_assignee check (
    not (participant_id is not null and team_id is not null)
  ),
  -- Codes repeat per owner: everyone's personal board is A1-A3. nulls not
  -- distinct so shared (both null) and team tasks are still unique per day.
  constraint tasks_owner_code_key unique nulls not distinct
    (trip_id, day, participant_id, team_id, code)
);

create index tasks_trip_id_day_idx on tasks (trip_id, day);

create table claims (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  evidence_url text,
  image_hash text,
  status text not null,
  awarded_points integer,
  resolved_by text,
  resolution_json jsonb,
  capped boolean not null default false,
  photo_claimed_at timestamptz,
  -- The claimant's own row. Team fanout rows for other members are false.
  primary_claim boolean not null default true,
  -- pending_peer only: end of the local day it was made. Swept to 'expired'.
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index claims_task_participant_key on claims (task_id, participant_id);
-- First write wins: one live primary claim per task, enforced by the database.
create unique index claims_one_winner_per_task on claims (task_id)
  where primary_claim and status in ('awarded', 'pending_peer');
create index claims_image_hash_idx on claims (image_hash);
create index claims_pending_expiry_idx on claims (expires_at)
  where status = 'pending_peer';

-- Atomic score bump. Read-then-write in the app lost increments under
-- concurrent claims. Returns the new score, or null if no such participant.
create or replace function increment_participant_score(
  p_participant_id uuid,
  p_delta integer
) returns integer
language sql
as $$
  update participants
  set score = score + p_delta
  where id = p_participant_id
  returning score;
$$;

revoke execute on function increment_participant_score(uuid, integer)
  from public, anon, authenticated;
grant execute on function increment_participant_score(uuid, integer)
  to service_role;

-- One row per trip-day board: existence, provisional flag, delivery, and a
-- lock (inserted before generating, so a day is never generated twice).
create table boards (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  day integer not null,
  local_date date not null,
  status text not null default 'generating',
  provisional boolean not null default false,
  requested_by uuid references participants (id) on delete set null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, day)
);

-- Log of boards and refills people asked for. Refills of the same day are
-- rate-limited in code; asking for different days never is.
create table board_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  requested_on date not null,
  day integer not null,
  kind text not null default 'generate',
  created_at timestamptz not null default now()
);

create index board_requests_by_person_day
  on board_requests (trip_id, participant_id, day, kind);

create table events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips (id) on delete set null,
  linq_event_id text not null unique,
  type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  -- Set when a stalled message was re-dispatched, or logged as dropped.
  retried_at timestamptz,
  created_at timestamptz not null default now()
);

create index events_unprocessed_received
  on events (created_at)
  where processed_at is null and retried_at is null and type in (
    'message.received',
    'poll.vote.added',
    'poll.vote.removed',
    'location.sharing.started',
    'location.sharing.stopped'
  );

-- Every message in and out, per chat: the conversation's context.
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  role text not null check (role in ('user', 'bot')),
  sender_handle text,
  sender_name text,
  text text not null,
  created_at timestamptz not null default now()
);
create index chat_messages_by_chat on chat_messages (chat_id, created_at desc);

-- Sidequests: offered privately, first to finish wins, win announced in group.
create table sidequests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  day integer not null,
  local_date date not null,
  template_id text not null,
  title text not null,
  points integer not null check (points between 5 and 15),
  photo_bonus_max integer not null default 0 check (photo_bonus_max between 0 and 2),
  trigger text not null,
  status text not null default 'open',
  won_by uuid references participants (id) on delete set null,
  won_at timestamptz,
  created_at timestamptz not null default now()
);

create index sidequests_trip_date on sidequests (trip_id, local_date);

create table sidequest_offers (
  id uuid primary key default gen_random_uuid(),
  sidequest_id uuid not null references sidequests (id) on delete cascade,
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  status text not null,
  queued_at timestamptz,
  fired_at timestamptz,
  expires_at timestamptz,
  resolved_at timestamptz,
  awarded_points integer,
  photo_bonus integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index sidequest_offers_one_live on sidequest_offers (participant_id) where status = 'live';
create unique index sidequest_offers_one_queued on sidequest_offers (participant_id) where status = 'queued';
create unique index sidequest_offers_one_winner on sidequest_offers (sidequest_id) where status = 'won';
create index sidequest_offers_trip on sidequest_offers (trip_id, status);

create table ratings (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants (id) on delete cascade,
  place_id uuid not null references places (id) on delete cascade,
  score integer not null,
  created_at timestamptz not null default now()
);

-- A trip is a list of legs: a city and the dates you are in it. Legs
-- partition the trip's dates (no gaps, no overlaps), so every date belongs to
-- exactly one. A single-city trip is one leg and behaves identically; the
-- trips.destination / timezone / destination_profile_json columns stay as the
-- display fallback and as what lib/game/legs.ts synthesises a leg from when
-- none are loaded.
create table trip_legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  -- 1-based and contiguous. "order" is reserved, hence leg_order.
  leg_order integer not null,
  city text not null,
  start_date date not null,
  end_date date not null,
  timezone text,
  -- Fetched when the leg is first needed, not at trip creation: two Foursquare
  -- searches per leg is the point of doing it lazily.
  destination_profile_json jsonb,
  -- First date of a leg that follows another one: you arrive that day, so the
  -- board is light and transit-shaped. Leg 1 is never a travel day.
  is_travel_day boolean not null default false,
  created_at timestamptz not null default now(),
  unique (trip_id, leg_order),
  constraint trip_legs_dates_ordered check (end_date >= start_date)
);
create index trip_legs_trip_dates on trip_legs (trip_id, start_date, end_date);

-- Days worth more points for everyone: national holidays (Nager.Date) and
-- local festivals (Browserbase), looked up per leg (a Tokyo to Seoul trip has
-- two countries). Weekends and friday
-- nights are computed in lib/game/multipliers.ts and never stored.
create table multiplier_days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  local_date date not null,
  multiplier numeric not null check (multiplier > 1 and multiplier <= 3),
  label text not null,
  source text not null check (source in ('holiday', 'festival')),
  -- Which leg's country this came from. unique (trip_id, local_date) still
  -- holds: legs partition the dates, so two legs never claim the same one.
  leg_id uuid references trip_legs (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (trip_id, local_date)
);
create index multiplier_days_trip_date on multiplier_days (trip_id, local_date);

-- Links dropped in the chat, resolved into places. One table is both the
-- queue and the attempt log: every try keeps the text it extracted and why it
-- ended the way it did, so the real hit rate per source comes from live
-- traffic (select kind, status, count(*) from social_links group by 1, 2).
create table social_links (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid references participants (id) on delete set null,
  chat_id text,
  url text not null,
  -- tiktok | instagram | maps | article
  kind text not null,
  -- queued | resolved | unresolved | failed | skipped. "unresolved" means we
  -- read something but it named no venue: a first-class outcome, and the
  -- caption is kept so the group can clarify later.
  status text not null default 'queued',
  attempts integer not null default 0,
  extracted_text text,
  outcome text,
  place_id uuid references places (id) on delete set null,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  resolved_at timestamptz,
  unique (trip_id, url)
);
create index social_links_queue on social_links (trip_id, status, created_at);

-- Ticketable events for a trip, in the shape a Discovery result arrives in.
-- The matcher reads this table and never an API, so matching, attribution and
-- copy are the same whether a row came from Ticketmaster or a seed. Japan has
-- no usable Discovery inventory (no purchase URLs), hence source='seed'.
create table trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  leg_id uuid references trip_legs (id) on delete set null,
  name text not null,
  venue text,
  lat double precision,
  lng double precision,
  starts_at timestamptz not null,
  category text,
  url text not null,
  -- A note, not a number: priceRanges is 0% filled in every Discovery market.
  price_note text,
  source text not null default 'seed' check (source in ('seed', 'discovery')),
  created_at timestamptz not null default now(),
  unique (trip_id, url)
);
create index trip_events_trip_starts on trip_events (trip_id, starts_at);

-- Credential smoke test only. Not part of the game data model.
create table if not exists smoke_scratch (
  id uuid primary key default gen_random_uuid(),
  marker text not null,
  created_at timestamptz not null default now()
);
