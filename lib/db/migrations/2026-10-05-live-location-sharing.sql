-- Stores consent and the direct Linq chat used for on-demand location reads.
-- Coordinates and Linq location responses are never written to Supabase.
create table if not exists trip_location_shares (
  trip_id uuid not null references trips (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  direct_chat_id text not null,
  share_status text not null check (
    share_status in ('requested', 'active', 'stopped', 'expired', 'unsupported')
  ),
  expires_at timestamptz not null,
  primary key (trip_id, participant_id)
);

create index if not exists trip_location_shares_active_idx
  on trip_location_shares (trip_id, share_status, expires_at);
