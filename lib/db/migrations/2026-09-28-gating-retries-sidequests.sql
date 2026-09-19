-- Boards per person, survey nudges, event retries, and sidequest delivery.
-- Run after 2026-09-27-clamp-photo-bonus.sql, before deploying.
--
-- None of these columns are in TRIP_COLS or the participant selects: the code
-- reads them in their own queries, so a missed run breaks only the features
-- below (nudges, the waiting notice, retries, sidequests), never trip lookups.

begin;

-- One "your next question" DM per unfinished person per local day.
alter table participants add column if not exists survey_nudged_on date;

-- "waiting on X and Y" goes to the group once, only while nobody has finished.
alter table trips add column if not exists waiting_notice_sent_at timestamptz;

-- Sidequest tick bookkeeping: today's random fire times, how many fired,
-- last weather seen, last tick. { date, random_at: [min], fired: n, wet, ... }
alter table trips add column if not exists sidequest_state jsonb;

-- An inbound message still unprocessed after 2 minutes is dispatched again,
-- once. Older than 30 minutes it is logged as dropped instead (a reply hours
-- late is worse than none). retried_at marks either outcome.
alter table events add column if not exists retried_at timestamptz;
create index if not exists events_unprocessed_received
  on events (created_at)
  where processed_at is null and retried_at is null and type = 'message.received';

-- A sidequest: one small task offered privately to one or more people at
-- once. First to finish wins; the win is announced in the group.
create table if not exists sidequests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  day integer not null,
  local_date date not null,
  template_id text not null,
  title text not null,
  -- 5-15, computed in code (lib/game/sidequests.ts), never by the model.
  points integer not null check (points between 5 and 15),
  photo_bonus_max integer not null default 0 check (photo_bonus_max between 0 and 2),
  -- gap | idle | weather | anchor | challenging | random
  trigger text not null,
  -- open | won | closed
  status text not null default 'open',
  won_by uuid references participants (id) on delete set null,
  won_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sidequests_trip_date on sidequests (trip_id, local_date);

-- One row per person a sidequest was offered to.
create table if not exists sidequest_offers (
  id uuid primary key default gen_random_uuid(),
  sidequest_id uuid not null references sidequests (id) on delete cascade,
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  -- queued | live | won | lost | expired | declined | dropped
  status text not null,
  queued_at timestamptz,
  fired_at timestamptz,
  expires_at timestamptz,
  resolved_at timestamptz,
  awarded_points integer,
  photo_bonus integer not null default 0,
  created_at timestamptz not null default now()
);
-- One live sidequest per person, ever; at most one waiting behind it.
create unique index if not exists sidequest_offers_one_live
  on sidequest_offers (participant_id) where status = 'live';
create unique index if not exists sidequest_offers_one_queued
  on sidequest_offers (participant_id) where status = 'queued';
-- First write wins.
create unique index if not exists sidequest_offers_one_winner
  on sidequest_offers (sidequest_id) where status = 'won';
create index if not exists sidequest_offers_trip on sidequest_offers (trip_id, status);

alter table sidequests disable row level security;
alter table sidequest_offers disable row level security;

commit;
