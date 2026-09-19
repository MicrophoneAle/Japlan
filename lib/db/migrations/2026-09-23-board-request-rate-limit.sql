-- Run AFTER 2026-09-22-on-demand-boards.sql.
-- board_requests stops being a once-per-day cap (it blocked looking ahead at
-- your own trip) and becomes a log: which boards someone asked for, and the
-- refills they asked for, which are rate-limited per day in code.

begin;

alter table board_requests
  drop constraint if exists board_requests_trip_id_participant_id_requested_on_key;

-- generate: made a board for a day that had none. refill: more tasks for a
-- day whose board they cleared (the only way to regenerate the same day).
alter table board_requests add column if not exists kind text not null default 'generate';

create index if not exists board_requests_by_person_day
  on board_requests (trip_id, participant_id, day, kind);

commit;

notify pgrst, 'reload schema';
