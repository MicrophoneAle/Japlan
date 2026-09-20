-- Poll toggles and location sharing-state events need the same one-shot retry
-- path as inbound messages after transient handler failures.
drop index if exists events_unprocessed_received;

create index events_unprocessed_received
  on events (created_at)
  where processed_at is null and retried_at is null and type in (
    'message.received',
    'poll.vote.added',
    'poll.vote.removed',
    'location.sharing.started',
    'location.sharing.stopped'
  );
