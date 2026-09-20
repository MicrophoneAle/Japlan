-- "the organizer is setting the shared city..." is said ONCE per person, not
-- on every message. Repeating it on every DM is what made the setup handoff
-- read as an infinite loop with no state change.
--
-- Not in the participants column list used by hot queries beyond what already
-- selects it, and nullable, so a missed migration means the notice is simply
-- repeated rather than anything breaking.
alter table participants
  add column if not exists setup_pending_told_at timestamptz;
