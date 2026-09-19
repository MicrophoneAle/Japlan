-- Supports inspectable draft itinerary generation without changing existing trip semantics.
alter table places add column if not exists source_metadata jsonb;
alter table itinerary add column if not exists draft_status text;
alter table itinerary add column if not exists draft_generation_id uuid;
alter table itinerary add column if not exists planned_end_time timestamptz;

create table if not exists itinerary_generations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id),
  status text not null,
  mode text not null,
  config_json jsonb not null,
  research_json jsonb,
  itinerary_json jsonb,
  browserbase_session_id text,
  browserbase_dashboard_url text,
  error_text text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists itinerary_generations_trip_created_idx on itinerary_generations(trip_id, created_at desc);
