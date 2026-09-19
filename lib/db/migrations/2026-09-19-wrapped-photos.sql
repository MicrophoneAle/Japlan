-- Durable private source files for public Wrapped recaps.
alter table claims add column if not exists storage_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-photos', 'claim-photos', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false;

-- Only the backend service role uses this private bucket. Signed URLs are
-- issued by the public Wrapped route after it checks the trip is complete.
