# Wrapped group-chat delivery

## Goal

When a trip finishes, Linq posts one message in that trip's group chat with
the final standings and a link to the live Wrapped page. A trip can finish
either when its organizer confirms the end-trip command or when its local end
date has passed.

## Scope

- Group-chat delivery only; do not DM participants.
- Keep the current organizer confirmation and final-standings message.
- Add the Wrapped URL to that message.
- Add automatic completion to the existing daily Vercel cron route.
- Do not add a `wrapped_sent` column or another delivery table.

## Completion and delivery flow

### Organizer ends the trip

1. The organizer sends `japlan end trip confirm`.
2. The existing guarded update changes the trip from an open state to
   `complete`.
3. Only the caller whose update returned the transitioned row builds the
   standings and sends the final group-chat message, including the Wrapped
   link.

### Date ends the trip

1. The existing daily cron invokes a lifecycle sweep after its board work.
2. The sweep reads open trips with an `end_date`.
3. It compares the trip's end date to the current date in
   `trips.timezone` (falling back to UTC). A trip is eligible after its
   local end date; it does not end during the final local calendar day.
4. For each eligible trip, the same guarded state update runs. The one update
   that returns a transitioned row sends the same group-chat message.

## Idempotency and failure behavior

The existing `state <> 'complete'` conditional update is the sole
idempotency mechanism. It ensures that concurrent end commands, cron retries,
and future cron runs cannot produce a second announcement.

No delivery record is stored. Therefore, if the database update succeeds but
the Linq send fails, the trip remains complete and the announcement is not
retried automatically. The failure is logged for operational follow-up; this
is the accepted trade-off for keeping the schema unchanged.

## URL and copy

The message links to `/wrapped/[tripId]` on the configured public app
origin. A required server-only `APP_URL` environment variable supplies that
origin in Vercel and local environments. The formatter preserves the current
standings/stake text and appends the recap link.

## Components

- `lib/handlers/trip-lifecycle.ts`: expose a shared
  `completeTripAndAnnounce` helper, use it from the organizer command, and
  build a real Wrapped URL.
- `lib/handlers/trip-expiry.ts`: find locally expired open trips and call
  the shared helper.
- `app/api/cron/daily-board/route.ts`: run the expiry sweep as part of the
  authenticated daily cron.
- `lib/game/copy.ts`: retain the existing final-standings format and include
  the generated recap URL.

## Verification

- Unit-test URL construction and local-date expiry boundaries.
- Extend lifecycle tests to assert that manual completion sends exactly one
  group message containing `/wrapped/<tripId>`.
- Add a cron/expiry test showing an expired trip completes and announces once,
  while a trip still on its final local date does not.
- Run the affected Vitest tests and `tsc --noEmit`.
