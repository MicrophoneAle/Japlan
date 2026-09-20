-- Links people drop in the group chat, resolved into places.
--
-- One table is both the QUEUE and the ATTEMPT LOG. Every attempt keeps the
-- text we actually extracted and why it ended the way it did, so the real hit
-- rate per source comes out of live traffic instead of a guess:
--
--   select kind, status, count(*) from social_links group by 1, 2;
--
-- An unresolved link is a first-class outcome, not an error. Measured before
-- building this: 1 of 4 Instagram URLs returned nothing at all, and TikTok
-- blocks a headless fetch outright (which is why TikTok goes through its
-- keyless oEmbed endpoint and never through a browser).

create table if not exists social_links (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  -- Who posted it. Null if they are not a participant yet.
  participant_id uuid references participants (id) on delete set null,
  chat_id text,
  url text not null,
  -- tiktok | instagram | maps | article
  kind text not null,
  -- queued    : waiting for the worker
  -- resolved  : became a place (fsq_place_id may still be null)
  -- unresolved: we read something but found no venue; extracted_text is kept
  --             so the group can clarify later
  -- failed    : could not read the page at all (blocked, empty, timeout)
  -- skipped   : over the hourly cap or a duplicate
  status text not null default 'queued',
  attempts integer not null default 0,
  -- What we actually read. The hit-rate evidence, and the caption we keep
  -- when there was no venue in it.
  extracted_text text,
  -- A short machine reason: blocked, empty_page, no_venue, no_api_key, ...
  outcome text,
  place_id uuid references places (id) on delete set null,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  resolved_at timestamptz,
  -- The same link twice in a chat is one job.
  unique (trip_id, url)
);

create index if not exists social_links_queue_idx
  on social_links (trip_id, status, created_at);

-- Where a place came from, and whether it still needs a Foursquare id.
-- Foursquare is out of credits, so a social place is stored with its name and
-- whatever address the caption carried and fsq_place_id left null. That is
-- enough to put it on a day. A backfill picks up exactly:
--
--   select * from places where source = 'social' and fsq_place_id is null;
--
alter table places
  add column if not exists source_url text;

-- When the place was resolved from its link, so a later Foursquare backfill
-- knows what to pick up and in what order.
alter table places
  add column if not exists resolved_at timestamptz;

-- The street address off a caption, when there was one. Not a licensed
-- Foursquare field: this came from the poster's own text.
alter table places
  add column if not exists address text;

create index if not exists places_needs_fsq_idx
  on places (trip_id, source)
  where fsq_place_id is null;
