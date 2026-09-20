-- Run AFTER 2026-09-21-trip-lifecycle-and-setup.sql.
--   1. trips.board_time: local start of the trip day (default 08:00).
--   2. boards: one row per trip-day. Existence, provisional flag, delivery,
--      and a lock: the row is inserted before generating, so two requests
--      cannot generate the same day twice.
--   3. board_requests: the abuse guard, one on-demand generation per person
--      per trip-local day, enforced by a unique index.

begin;

alter table trips add column if not exists board_time text not null default '08:00';
alter table trips drop constraint if exists trips_board_time_format;
alter table trips add constraint trips_board_time_format
  check (board_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

create table if not exists boards (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  day integer not null,
  local_date date not null,
  -- generating while the pipeline runs; ready once its tasks are written.
  status text not null default 'generating',
  -- Made ahead of its day: refreshed the first time someone requests it that day.
  provisional boolean not null default false,
  requested_by uuid references participants (id) on delete set null,
  -- Last time a board was generated or deliberately delivered.
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, day)
);

create table if not exists board_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  -- Trip-local date of the request (not of the board).
  requested_on date not null,
  day integer not null,
  created_at timestamptz not null default now(),
  unique (trip_id, participant_id, requested_on)
);

-- Days that already have tasks become ready boards, so a request reuses them.
insert into boards (trip_id, day, local_date, status, delivered_at)
select
  k.trip_id,
  k.day,
  coalesce(t.start_date + (k.day - 1), min(k.created_at)::date),
  'ready',
  min(k.created_at)
from tasks k
join trips t on t.id = k.trip_id
group by k.trip_id, k.day, t.start_date
on conflict (trip_id, day) do nothing;

commit;

notify pgrst, 'reload schema';
