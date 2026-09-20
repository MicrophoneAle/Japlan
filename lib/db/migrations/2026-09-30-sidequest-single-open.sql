-- Only one sidequest race may be open in a trip at once, including when a
-- timed trigger and a task-completion trigger arrive together.

create unique index if not exists sidequests_one_open_per_trip
  on sidequests (trip_id) where status = 'open';

notify pgrst, 'reload schema';
