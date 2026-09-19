-- Group onboarding records how the trip should assign its daily plans.
alter table trips
  add column if not exists play_mode text;

-- Existing trips keep their former behavior. New trips leave this null until
-- the organizer selects a mode during group setup.

alter table trips
  drop constraint if exists trips_play_mode_check;

alter table trips
  add constraint trips_play_mode_check
  check (play_mode in ('individual', 'teams', 'full_group'));
