-- Per-leg destinations. A trip used to be one city: trips.destination,
-- trips.timezone, one cached destination_profile_json, one places pool. Day
-- five in Osaka generated Tokyo tasks, and board_time fired on the old city's
-- clock after a timezone change.
--
-- A leg is a city and the dates you are in it. Legs PARTITION the trip's
-- dates: no gaps, no overlaps, so every date belongs to exactly one leg.
-- `order` is a reserved word, so the column is leg_order.
--
-- Single-city trips are one leg and behave identically. The trips.destination
-- / timezone / destination_profile_json columns STAY, both as the display
-- fallback and so that code which never loaded legs (or a deploy where this
-- migration has not run) still works: lib/game/legs.ts synthesises a single
-- leg from those columns when the table is empty or unread.

create table if not exists trip_legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  -- 1-based, contiguous. The trip's cities in the order they happen.
  leg_order integer not null,
  city text not null,
  start_date date not null,
  end_date date not null,
  -- Null until the destination resolves, same as trips.timezone.
  timezone text,
  -- Fetched when this leg is first needed, not at trip creation: two
  -- Foursquare searches per leg is the whole point of doing it lazily.
  destination_profile_json jsonb,
  -- The first date of a leg that follows another one is a travel day: you
  -- arrive that day, so the board is light and transit-appropriate. Leg 1 is
  -- never a travel day.
  is_travel_day boolean not null default false,
  created_at timestamptz not null default now(),
  unique (trip_id, leg_order),
  constraint trip_legs_dates_ordered check (end_date >= start_date)
);

create index if not exists trip_legs_trip_dates_idx
  on trip_legs (trip_id, start_date, end_date);

-- Every existing trip becomes exactly one leg carrying what the trip already
-- held, so nothing about a single-city trip changes. Trips with no dates yet
-- (setup unfinished) get their leg when setup completes.
insert into trip_legs (trip_id, leg_order, city, start_date, end_date, timezone, destination_profile_json, is_travel_day)
select
  t.id,
  1,
  coalesce(nullif(trim(t.destination), ''), 'the trip'),
  t.start_date,
  t.end_date,
  t.timezone,
  t.destination_profile_json,
  false
from trips t
where t.start_date is not null
  and t.end_date is not null
  and not exists (select 1 from trip_legs l where l.trip_id = t.id);

-- Clustering must never route across cities: a Tokyo place can never be the
-- nearest neighbour of an Osaka task. Nullable, because a place saved before
-- its leg existed (a suggestion made during setup) still belongs to the trip.
alter table places
  add column if not exists leg_id uuid references trip_legs (id) on delete set null;

create index if not exists places_leg_idx on places (leg_id);

update places p
set leg_id = l.id
from trip_legs l
where l.trip_id = p.trip_id
  and l.leg_order = 1
  and p.leg_id is null;

-- Day multipliers are per COUNTRY, and a Tokyo to Seoul trip has two. The
-- holiday lookup now runs per leg, so a stored day records which leg's country
-- it came from. unique (trip_id, local_date) still holds: legs partition the
-- dates, so two legs can never claim the same one.
alter table multiplier_days
  add column if not exists leg_id uuid references trip_legs (id) on delete cascade;

update multiplier_days m
set leg_id = l.id
from trip_legs l
where l.trip_id = m.trip_id
  and l.leg_order = 1
  and m.leg_id is null;
