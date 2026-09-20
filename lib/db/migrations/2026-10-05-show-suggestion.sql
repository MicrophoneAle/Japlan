-- One show suggestion per trip, ever. Tracked on the trip row so a second
-- cron tick, a redeploy or a retry cannot send a second one: the guard and
-- the write are the same statement (update ... where show_suggested_at is
-- null), so two ticks racing cannot both win.
--
-- Not in TRIP_COLS on purpose: only lib/handlers/show-suggestion.ts selects
-- it, so a missed migration stops the suggestion rather than breaking every
-- trip query, which is how three outages happened.
alter table trips
  add column if not exists show_suggested_at timestamptz;
