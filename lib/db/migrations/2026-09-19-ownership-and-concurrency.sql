-- Brings an existing database in line with lib/db/schema.sql for:
--   1. per-owner task codes (everyone's personal board is A1-A3)
--   2. first-write-wins claims enforced by a constraint
--   3. atomic score increments
-- Run once in the Supabase SQL editor. Requires Postgres 15+ (nulls not distinct).

begin;

-- 1. Task codes unique per (trip, day, owner), not per trip.
alter table tasks drop constraint if exists tasks_trip_id_code_key;
alter table tasks add constraint tasks_owner_code_key unique nulls not distinct
  (trip_id, day, participant_id, team_id, code);

-- 2. One live primary claim per task.
alter table claims add column if not exists primary_claim boolean not null default true;

-- Existing team fanout rows (and any double awards from the old race) all
-- default to primary. Keep the earliest live claim per task as the winner.
update claims c
set primary_claim = false
where c.status in ('awarded', 'pending_peer')
  and exists (
    select 1
    from claims d
    where d.task_id = c.task_id
      and d.status in ('awarded', 'pending_peer')
      and (d.created_at, d.id) < (c.created_at, c.id)
  );

create unique index if not exists claims_one_winner_per_task on claims (task_id)
  where primary_claim and status in ('awarded', 'pending_peer');

-- 3. Atomic score bump.
create or replace function increment_participant_score(
  p_participant_id uuid,
  p_delta integer
) returns integer
language sql
as $$
  update participants
  set score = score + p_delta
  where id = p_participant_id
  returning score;
$$;

revoke execute on function increment_participant_score(uuid, integer)
  from public, anon, authenticated;
grant execute on function increment_participant_score(uuid, integer)
  to service_role;

commit;

-- PostgREST caches the schema; reload so .rpc() sees the new function.
notify pgrst, 'reload schema';
