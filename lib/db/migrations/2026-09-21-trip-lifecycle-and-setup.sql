-- Run AFTER 2026-09-20-intro-once-and-peer-expiry.sql.
--   1. One open trip per chat (partial unique index) so a completed trip frees
--      the chat for "japlan new trip".
--   2. ON DELETE CASCADE down the whole trip tree, so removing a trip is one
--      statement: delete from trips where id = '...';
--   3. Trip lifecycle and organizer setup columns.

begin;

-- 1. The repo schema had a plain UNIQUE on linq_chat_id, which allows exactly
-- one trip per chat forever. Replace it with a partial index that only counts
-- trips that are not complete. If the live database already has an
-- equivalent partial index under another name, this adds a harmless twin.
alter table trips drop constraint if exists trips_linq_chat_id_key;
create unique index if not exists trips_one_open_trip_per_chat
  on trips (linq_chat_id)
  where state <> 'complete';
create index if not exists trips_linq_chat_id_idx on trips (linq_chat_id);

-- 3. Lifecycle and setup.
alter table trips add column if not exists completed_at timestamptz;
-- Who answers the organizer setup. Linq never tells us who added the bot, so
-- this is whoever sent the first group message (or the solo participant).
alter table trips add column if not exists organizer_participant_id uuid;
-- destination | dates | difficulty | stake while asking; 'deferred' when the
-- organizer skipped a required answer; 'done'; null before it starts.
alter table trips add column if not exists setup_state text;

-- 2. Cascades. Every FK that would block deleting a trip, a participant, or a
-- row beneath them. Default constraint names are <table>_<column>_fkey.
alter table participants drop constraint if exists participants_trip_id_fkey,
  add constraint participants_trip_id_fkey
  foreign key (trip_id) references trips (id) on delete cascade;

alter table teams drop constraint if exists teams_trip_id_fkey,
  add constraint teams_trip_id_fkey
  foreign key (trip_id) references trips (id) on delete cascade;

alter table team_members drop constraint if exists team_members_team_id_fkey,
  add constraint team_members_team_id_fkey
  foreign key (team_id) references teams (id) on delete cascade;
alter table team_members drop constraint if exists team_members_participant_id_fkey,
  add constraint team_members_participant_id_fkey
  foreign key (participant_id) references participants (id) on delete cascade;

alter table places drop constraint if exists places_trip_id_fkey,
  add constraint places_trip_id_fkey
  foreign key (trip_id) references trips (id) on delete cascade;

alter table itinerary drop constraint if exists itinerary_trip_id_fkey,
  add constraint itinerary_trip_id_fkey
  foreign key (trip_id) references trips (id) on delete cascade;
alter table itinerary drop constraint if exists itinerary_place_id_fkey,
  add constraint itinerary_place_id_fkey
  foreign key (place_id) references places (id) on delete cascade;

alter table tasks drop constraint if exists tasks_trip_id_fkey,
  add constraint tasks_trip_id_fkey
  foreign key (trip_id) references trips (id) on delete cascade;
alter table tasks drop constraint if exists tasks_participant_id_fkey,
  add constraint tasks_participant_id_fkey
  foreign key (participant_id) references participants (id) on delete cascade;
alter table tasks drop constraint if exists tasks_team_id_fkey,
  add constraint tasks_team_id_fkey
  foreign key (team_id) references teams (id) on delete cascade;

alter table claims drop constraint if exists claims_task_id_fkey,
  add constraint claims_task_id_fkey
  foreign key (task_id) references tasks (id) on delete cascade;
alter table claims drop constraint if exists claims_participant_id_fkey,
  add constraint claims_participant_id_fkey
  foreign key (participant_id) references participants (id) on delete cascade;

alter table ratings drop constraint if exists ratings_participant_id_fkey,
  add constraint ratings_participant_id_fkey
  foreign key (participant_id) references participants (id) on delete cascade;
alter table ratings drop constraint if exists ratings_place_id_fkey,
  add constraint ratings_place_id_fkey
  foreign key (place_id) references places (id) on delete cascade;

-- events keep their rows: linq_event_id is the idempotency guard, and deleting
-- it would let a late Linq retry of an old event be processed again.
alter table events drop constraint if exists events_trip_id_fkey,
  add constraint events_trip_id_fkey
  foreign key (trip_id) references trips (id) on delete set null;

alter table trips drop constraint if exists trips_organizer_participant_id_fkey,
  add constraint trips_organizer_participant_id_fkey
  foreign key (organizer_participant_id) references participants (id) on delete set null;

commit;

notify pgrst, 'reload schema';
