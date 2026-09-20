-- Special days are worth more points, for everyone on the trip: a national
-- holiday (Nager.Date), a local festival (Browserbase). Weekends and friday
-- nights are computed in code (lib/game/multipliers.ts) and never stored, so
-- this table only holds what had to be looked up.
--
-- One row per trip per local date. The trip is the owner because trips differ
-- in destination and dates, and the lookup is cheap and off the request path.

create table if not exists multiplier_days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  local_date date not null,
  multiplier numeric not null,
  label text not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (trip_id, local_date)
);

alter table multiplier_days
  drop constraint if exists multiplier_days_source_check;

alter table multiplier_days
  add constraint multiplier_days_source_check
  check (source in ('holiday', 'festival'));

-- A bad lookup must never be able to award 40x. Code clamps too.
alter table multiplier_days
  drop constraint if exists multiplier_days_multiplier_check;

alter table multiplier_days
  add constraint multiplier_days_multiplier_check
  check (multiplier > 1 and multiplier <= 3);

create index if not exists multiplier_days_trip_date_idx
  on multiplier_days (trip_id, local_date);

-- When this trip's special days were last looked up. Deliberately NOT in
-- TRIP_COLS: only lib/handlers/holidays.ts selects it, so if this migration is
-- missed the refresh logs and stops instead of breaking every trip query
-- (which is how the last three outages happened).
alter table trips
  add column if not exists multipliers_checked_at timestamptz;

-- The multiplier a task was generated under, so a claim awards what the board
-- promised even if the local day rolls over between the board landing and the
-- claim. Not folded into base_points on purpose: base_points is the number the
-- board prints and the number tierForPoints reads, and doubling it would make
-- a medium task read as challenging.
--
--   day_multiplier      the factor on base_points (3 / 2 / 1.25). On a day
--                       that carries one, base_points is the task's UNSCALED
--                       worth: the multiplier REPLACES dayValueMultiplier
--                       rather than compounding with it, so a task can never
--                       be worth more than 3x its raw axes score.
--   multiplier_reason   what to call it: "golden week", "sports day"
--
-- Both nullable: a task written before this migration, or on an ordinary day,
-- simply has no multiplier and pays base_points.
alter table tasks
  add column if not exists day_multiplier numeric;

alter table tasks
  add column if not exists multiplier_reason text;

alter table tasks
  drop constraint if exists tasks_day_multiplier_check;

alter table tasks
  add constraint tasks_day_multiplier_check
  check (day_multiplier is null or (day_multiplier > 1 and day_multiplier <= 3));
