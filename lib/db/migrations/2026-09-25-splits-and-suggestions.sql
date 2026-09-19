-- Ad-hoc splits and the group's own suggestions.
-- Run after 2026-09-24-task-day-planning.sql, before deploying.

-- A team is one group of a conversational split, for one trip day: its own
-- start time (the late group's board_time), where it is going, and when and
-- where it rejoins everyone. dissolved_at still ends it early ("we're back").
alter table teams add column if not exists day integer;
alter table teams add column if not exists starts_at text;      -- local HH:MM
alter table teams add column if not exists rejoin_at text;      -- local HH:MM
alter table teams add column if not exists rejoin_place text;
alter table teams add column if not exists area text;

-- "we don't want to do temples": category -> weight below 1, for this trip.
alter table trips add column if not exists category_weights jsonb not null default '{}'::jsonb;

-- Suggestions are places rows with source 'suggestion' and suggested_by the
-- participant id. note keeps the words they used ("a jazz bar in golden gai").
alter table places add column if not exists note text;
create index if not exists places_trip_source on places (trip_id, source);
create index if not exists itinerary_trip_day on itinerary (trip_id, day);
create index if not exists teams_trip_day on teams (trip_id, day);
