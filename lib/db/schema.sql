-- Japlan Postgres schema, taken from the Data model section of docs/PLAN.md.
--
-- TODO: plan does not specify id types; using uuid + gen_random_uuid() (Supabase default).
-- created_at is on every game table except teams (which already has formed_at).
-- TODO: plan does not specify FK delete/update behaviour; using the Postgres default (NO ACTION).
-- TODO: events.trip_id is nullable because inbound webhooks can arrive before a trip row exists.
-- TODO: a `channel` field is required later for RCS/WhatsApp, but is not in the Data model; omitted.
-- TODO: enum values for trips.state, trips.difficulty, tasks.tier, tasks.verification, claims.status are unspecified; stored as text.

create table trips (
  id uuid primary key default gen_random_uuid(),
  linq_chat_id text not null unique,
  name text not null,
  -- TODO: destination/dates/difficulty/timezone are unknown at bot-added bootstrap.
  destination text,
  start_date date,
  end_date date,
  state text not null,
  difficulty text,
  stake_text text,
  timezone text,
  destination_profile_json jsonb,
  is_solo boolean not null default false,
  daily_points_cap integer not null default 120,
  -- Set when the group intro goes out; it is posted at most once per chat.
  intro_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id),
  phone text not null,
  display_name text not null,
  score integer not null default 0,
  survey_json jsonb,
  survey_state text,
  sidequests_muted boolean not null default false,
  consented_at timestamptz,
  created_at timestamptz not null default now(),
  unique (trip_id, phone)
);

create index participants_phone_idx on participants (phone);
create index participants_trip_id_idx on participants (trip_id);

create table teams (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id),
  name text not null,
  color text not null,
  formed_at timestamptz not null,
  dissolved_at timestamptz
);

create table team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id),
  participant_id uuid not null references participants (id),
  created_at timestamptz not null default now()
);

create table places (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id),
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
  created_at timestamptz not null default now(),
  unique (trip_id, fsq_place_id)
);

create table itinerary (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id),
  day integer not null,
  anchor_order integer not null,
  place_id uuid not null references places (id),
  planned_time timestamptz,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id),
  participant_id uuid references participants (id),
  team_id uuid references teams (id),
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
  source text not null default 'generated',
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
  task_id uuid not null references tasks (id),
  participant_id uuid not null references participants (id),
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

create table events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips (id),
  linq_event_id text not null unique,
  type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table ratings (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants (id),
  place_id uuid not null references places (id),
  score integer not null,
  created_at timestamptz not null default now()
);

-- Credential smoke test only. Not part of the game data model.
create table if not exists smoke_scratch (
  id uuid primary key default gen_random_uuid(),
  marker text not null,
  created_at timestamptz not null default now()
);
