-- Run AFTER 2026-09-19-ownership-and-concurrency.sql.
--   1. trips.intro_sent_at: the group intro is posted at most once per chat.
--   2. claims.expires_at: pending_peer claims lapse at end of the local day.

begin;

alter table trips add column if not exists intro_sent_at timestamptz;

-- Trips already past bootstrapping have posted their intro.
update trips
set intro_sent_at = created_at
where intro_sent_at is null
  and state <> 'bootstrapping';

alter table claims add column if not exists expires_at timestamptz;

-- Existing pending_peer claims get end of their creation day, in the trip's
-- timezone (UTC if unset). Any already past that instant lapse now.
update claims c
set expires_at = (
  (date_trunc('day', c.created_at at time zone coalesce(t.timezone, 'UTC'))
    + interval '1 day' - interval '1 second')
  at time zone coalesce(t.timezone, 'UTC')
)
from tasks k
join trips t on t.id = k.trip_id
where k.id = c.task_id
  and c.status = 'pending_peer'
  and c.expires_at is null;

update claims
set status = 'expired'
where status = 'pending_peer'
  and expires_at <= now();

create index if not exists claims_pending_expiry_idx on claims (expires_at)
  where status = 'pending_peer';

commit;

notify pgrst, 'reload schema';
