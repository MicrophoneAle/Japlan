create table if not exists group_decisions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  prompt text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid not null references participants (id) on delete cascade,
  selected_option integer,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  last_reminded_at timestamptz
);

create unique index if not exists group_decisions_one_open_per_trip
  on group_decisions (trip_id) where status = 'open';

create table if not exists group_decision_options (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references group_decisions (id) on delete cascade,
  option_index integer not null check (option_index > 0),
  label text not null,
  message_id text,
  unique (decision_id, option_index)
);

create unique index if not exists group_decision_options_message_id_key
  on group_decision_options (message_id) where message_id is not null;

create table if not exists group_decision_votes (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references group_decisions (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  option_index integer not null check (option_index > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (decision_id, participant_id)
);
