-- Per-person trip stats, kept live as things happen (not computed at the
-- end), for Wrapped. Everyone starts at zero; counters move only on real
-- events. Run after 2026-09-28-gating-retries-sidequests.sql.
--
-- Every write goes through bump_participant_stats: one row lock, one
-- statement's worth of arithmetic, so two claims landing together cannot
-- lose an increment (the lost-update bug increment_participant_score fixed
-- for scores). The counters are also derivable from claims and tasks:
-- recomputeStats in lib/handlers/stats.ts rebuilds them, and
-- statsDrift compares, so drift is visible rather than silently plausible.

begin;

create table if not exists participant_stats (
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  -- Tasks generated for this person still on their boards (a redo subtracts
  -- what it replaced, so a reroll does not inflate it).
  itinerary_items_total integer not null default 0,
  -- Awarded claims, capped ones included: capped still means done.
  tasks_completed integer not null default 0,
  -- Awarded claims that carry a photo.
  photos_submitted integer not null default 0,
  -- Awarded claims whose photo earned a bonus.
  photo_bonuses_earned integer not null default 0,
  sidequests_claimed integer not null default 0,
  freeform_claims integer not null default 0,
  -- Distinct trip days with a completed claim; derived from activity_days.
  days_with_activity integer not null default 0,
  -- Summed between consecutive claim locations. Claims store no location
  -- yet, so this stays 0 until they do.
  distance_km numeric not null default 0,
  -- Distinct places across claimed tasks; derived from place_keys.
  places_visited integer not null default 0,
  activity_days integer[] not null default '{}',
  place_keys text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (trip_id, participant_id)
);

alter table participant_stats disable row level security;

create or replace function bump_participant_stats(
  p_trip_id uuid,
  p_participant_id uuid,
  p_deltas jsonb default '{}'::jsonb,
  p_day integer default null,
  p_place text default null
) returns participant_stats
language plpgsql
as $$
declare
  result participant_stats;
begin
  insert into participant_stats (trip_id, participant_id)
  values (p_trip_id, p_participant_id)
  on conflict (trip_id, participant_id) do nothing;

  update participant_stats set
    itinerary_items_total = greatest(0, itinerary_items_total + coalesce((p_deltas ->> 'itinerary_items_total')::int, 0)),
    tasks_completed = greatest(0, tasks_completed + coalesce((p_deltas ->> 'tasks_completed')::int, 0)),
    photos_submitted = greatest(0, photos_submitted + coalesce((p_deltas ->> 'photos_submitted')::int, 0)),
    photo_bonuses_earned = greatest(0, photo_bonuses_earned + coalesce((p_deltas ->> 'photo_bonuses_earned')::int, 0)),
    sidequests_claimed = greatest(0, sidequests_claimed + coalesce((p_deltas ->> 'sidequests_claimed')::int, 0)),
    freeform_claims = greatest(0, freeform_claims + coalesce((p_deltas ->> 'freeform_claims')::int, 0)),
    distance_km = greatest(0, distance_km + coalesce((p_deltas ->> 'distance_km')::numeric, 0)),
    activity_days = case
      when p_day is null or p_day = any (activity_days) then activity_days
      else array_append(activity_days, p_day)
    end,
    place_keys = case
      when p_place is null or p_place = any (place_keys) then place_keys
      else array_append(place_keys, p_place)
    end,
    updated_at = now()
  where trip_id = p_trip_id and participant_id = p_participant_id;

  update participant_stats set
    days_with_activity = cardinality(activity_days),
    places_visited = cardinality(place_keys)
  where trip_id = p_trip_id and participant_id = p_participant_id
  returning * into result;
  return result;
end;
$$;

revoke execute on function bump_participant_stats(uuid, uuid, jsonb, integer, text)
  from public, anon, authenticated;
grant execute on function bump_participant_stats(uuid, uuid, jsonb, integer, text)
  to service_role;

commit;

-- PostgREST caches the schema; reload so .rpc() sees the new function.
notify pgrst, 'reload schema';
