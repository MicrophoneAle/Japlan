-- Ticketable events for a trip, in the shape a Discovery result would arrive
-- in. The matcher reads THIS table and never an API, so the same matching,
-- attribution and copy run whether a row came from Ticketmaster or was seeded
-- by hand. Only the inventory differs.
--
-- Why seeded rows exist at all: probed 2026-10-04 with a live key, Discovery
-- has no usable Japan inventory. countryCode=JP returns one sporting feed
-- with 0% venue coordinates, 0% priceRanges and 0% purchase URL, and the
-- purchase URL was the whole mechanism. A London control had 100% of all
-- three, so the client stays useful for non-Japan trips.
create table if not exists trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  -- Which leg's city this event is in, so a Tokyo show is never suggested on
  -- the Osaka half of a trip. Null falls back to the trip's own dates.
  leg_id uuid references trip_legs (id) on delete set null,

  name text not null,
  venue text,
  lat double precision,
  lng double precision,
  -- The real clock constraint: everything else that day plans around it.
  starts_at timestamptz not null,
  -- One of our seven interest keys where it maps, else free text.
  category text,
  url text not null,
  -- Deliberately a NOTE, not a number. priceRanges was 0% filled in every
  -- Discovery market probed (London, New York, US-wide), so there is nothing
  -- to check a budget against. Say what is known and let a human look.
  price_note text,

  -- 'seed' | 'discovery'. Distinguishable on purpose.
  source text not null default 'seed',
  created_at timestamptz not null default now(),
  -- The same event seeded twice is one row.
  unique (trip_id, url)
);

alter table trip_events
  drop constraint if exists trip_events_source_check;
alter table trip_events
  add constraint trip_events_source_check check (source in ('seed', 'discovery'));

create index if not exists trip_events_trip_starts_idx
  on trip_events (trip_id, starts_at);
