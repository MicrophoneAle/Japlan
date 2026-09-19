-- Verifies the partial unique index after the 2026-09-21 migration.
-- Run in the Supabase SQL editor. Everything happens inside one transaction
-- that is rolled back, so it leaves no rows behind. Read the NOTICE lines:
-- all four should say PASS.

begin;

do $$
declare
  chat text := 'verify-chat-' || gen_random_uuid();
  first_id uuid;
begin
  insert into trips (linq_chat_id, name, state)
  values (chat, 'verify one', 'active')
  returning id into first_id;
  raise notice 'PASS 1: first open trip inserted';

  begin
    insert into trips (linq_chat_id, name, state) values (chat, 'verify two', 'surveying');
    raise notice 'FAIL 2: a second open trip was allowed on the same chat';
  exception when unique_violation then
    raise notice 'PASS 2: second open trip on the same chat rejected';
  end;

  update trips set state = 'complete' where id = first_id;
  insert into trips (linq_chat_id, name, state) values (chat, 'verify three', 'bootstrapping');
  raise notice 'PASS 3: completing the trip freed the chat for a new one';

  begin
    update trips set state = 'active' where id = first_id;
    raise notice 'FAIL 4: reopening the old trip beside the new one was allowed';
  exception when unique_violation then
    raise notice 'PASS 4: cannot reopen a completed trip while another is open';
  end;
end $$;

-- One-statement cleanup check: deleting a trip removes its whole tree.
do $$
declare
  t uuid;
  p uuid;
  k uuid;
  left_over int;
begin
  insert into trips (linq_chat_id, name, state)
  values ('verify-cascade-' || gen_random_uuid(), 'cascade', 'active') returning id into t;
  insert into participants (trip_id, phone, display_name) values (t, '+10000000000', 'x')
    returning id into p;
  insert into tasks (trip_id, participant_id, code, title, tier, axes_json, base_points,
                     photo_bonus_max, verification, day)
  values (t, p, 'A1', 'x', 'Light', '{}', 5, 0, 'honor', 1) returning id into k;
  insert into claims (task_id, participant_id, status, awarded_points)
  values (k, p, 'awarded', 5);

  delete from trips where id = t;

  select (select count(*) from participants where trip_id = t)
       + (select count(*) from tasks where trip_id = t)
       + (select count(*) from claims where task_id = k)
    into left_over;
  if left_over = 0 then
    raise notice 'PASS 5: deleting the trip cascaded to participants, tasks, claims';
  else
    raise notice 'FAIL 5: % child rows survived the trip delete', left_over;
  end if;
end $$;

rollback;
