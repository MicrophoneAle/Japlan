alter table group_decisions
  add column if not exists poll_message_id text,
  add column if not exists voting_mode text not null default 'reactions';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'group_decisions_voting_mode_check'
      and conrelid = 'group_decisions'::regclass
  ) then
    alter table group_decisions
      add constraint group_decisions_voting_mode_check
      check (voting_mode in ('reactions', 'native_poll'));
  end if;
end $$;

create unique index if not exists group_decisions_poll_message_id_key
  on group_decisions (poll_message_id)
  where poll_message_id is not null;

alter table group_decision_options
  add column if not exists poll_option_id text;

create unique index if not exists group_decision_options_poll_option_id_key
  on group_decision_options (poll_option_id)
  where poll_option_id is not null;

-- Native polls allow one participant to select several options. Reaction
-- ballots remain one-choice in the handler by replacing the participant's row.
alter table group_decision_votes
  drop constraint if exists group_decision_votes_decision_id_participant_id_key;

create unique index if not exists group_decision_votes_decision_participant_option_key
  on group_decision_votes (decision_id, participant_id, option_index);
