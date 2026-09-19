@AGENTS.md

# Japlan

## What Japlan is

Japlan is an iMessage group-chat bot that turns a trip into a points game. Players get a daily board of tasks, claim them in the group chat, and standings are per person.

Spec of record: `docs/PLAN.md`. On any disagreement with code comments, PLAN.md wins. If PLAN is silent, add a TODO and ask; do not invent.

## Architecture

| Layer | Owns |
| --- | --- |
| Linq | Transport only: send, receive, tapbacks, typing, media, groups |
| Next.js on Vercel | Webhook, cron, dispatch. `maxDuration=60` on webhook and daily-board |
| Supabase | Postgres. App uses the **service role**. RLS is off on every public table |
| Gemini | Survey, generation, claim match, vision, conversation tools. Fast vs smart via `GEMINI_FAST_MODEL` / `GEMINI_SMART_MODEL` |
| Foursquare | Places search at trip-create time only |
| Browserbase | Scraping with no clean API. Off the webhook path |

`lib/linq` and `lib/browserbase` are adapters: no game logic. `lib/game` is pure logic: no network calls. Scoring is unit-testable without a phone.

Scoring unit is the individual. Teams are time-bounded, not a score holder. A team task writes the **full** point value to every member, never a split.

## Non-negotiable rules

- **Webhook never blocks.** `/api/linq/webhook` verifies the **raw body**, inserts `events`, returns **200**, then `after()` runs `dispatchLinqEvent`. Linq retries on timeout; awaiting LLM / Browserbase / Foursquare before 200 awards points twice.
- **Idempotency is `payload.event_id` only.** Store it as `events.linq_event_id UNIQUE`. Duplicate insert `23505` is a no-op 200. Never use the `webhook-id` header; it mismatched `event_id` on 19/19 captured deliveries.
- **LLM proposes six axes. `lib/game/scoring.ts` computes points.** Drop any model-supplied `points` / `base_points` on parse. A tool that returns an invented point value is a bug. Conversation must call `get_standings` before stating a score.
- **DM stays in DM.** Budget, diet, allergies, social graph never appear in a group message. Enforce in the prompt and with a test. Group conversation context gets a public survey slice only.
- **Addressed messages always get a reply.** Silence is only for unaddressed traffic (no keyword, not a DM, no task code, no open task context). A valid code that used to die on photo-verification was a bug: photos are a **bonus**, not a gate. Honor and photo resolve on code; only `peer` still needs someone else's tapback.
- **Browserbase never runs on the webhook path.**
- **Foursquare is never called from the webhook path.** Batch at trip creation, or not at all.

Validation after generation (code, not prompt): booking, over lowest budget ceiling, diet/allergy/mobility conflict, unsafe/illegal/permanent, duplicate completed, cannot finish before expiry.

## Payload facts (verified against `.captures`)

Do not re-guess these.

- `participant.added` and `chat.created` **never fire** when the bot is added to an iMessage group. Bootstrap is first human `message.received` with `chat.is_group === true` (`lib/handlers/bootstrap.ts`). Ignore `is_me` and outbound.
- Chat id is **both** `data.chat.id` and `data.chat_id`. `chatIdFromData` checks both.
- Sender is `data.sender_handle.handle` (E.164). The object has `is_me`. `is_me` events are ignored. Display name is on the handle object, not the phone string; survey `first_name` can replace it.
- Media is `data.parts[]`, `type=media`, fetchable `url`, `mime` / `mime_type`.
- Foursquare venue id is **`fsq_place_id`**, not `fsq_id`. Drop results that only have the legacy field.
- Task codes: `[A-Za-z]\d{1,2}` as a standalone token (`findTaskCode` in `lib/game/addressing.ts`). Strict: the whole message, or anywhere with the keyword. Loose: a token in a message of 6 words or fewer with no keyword; loose is tentative and stays silent unless it resolves to the sender's own task. Codes repeat per owner (everyone's personal board is A1-A3), unique on `(trip_id, day, participant_id, team_id, code)`; resolve with `findTaskByCodeFor`. Wake keyword: `japlan` (`JAPLAN_WAKE_KEYWORD`), case-insensitive, word boundary.

## Known open problems

These are current, not intended.

- **Second Supabase call in an isolate hangs; the first succeeds.** Suspected client-per-request / PostgREST. `getServiceClient()` is a module singleton, still hangs. Nested embeds (`claims` with `tasks!inner`) were a suspect. Every DB call needs a **timeout**; a hang must not look like silence. `claimAwait` / `dispatchAwait` log `.before` then `.after`; the last `.before` with no `.after` is the hang. `claimAwait` yields once after `.before` so the log can flush.
- Use `.maybeSingle()`, never `.single()` (PGRST116 on 0 or 2 rows). Participant uniqueness is `(trip_id, phone)`. Same phone on two trips: always query with `trip_id`.
- **`reaction.added` has never been seen in a capture.** Peer confirmation is implemented and untested against live Linq.
- **Foursquare is out of credits.** Destination profile is hand-seeded: `npx tsx scripts/seed-profile.ts` writes `TOKYO_HAND_PROFILE` from `lib/game/tokyo-profile.ts`.
- **RLS is off** on every public table. Service role only. Do not expose that key.
- **Cron is daily**, `vercel.json` `0 23 * * *` (23:00 UTC). Correct for one timezone (Tokyo 08:00). Hobby plan blocks hourly. Daily board also checks local 8:00 unless `force=1`.
- **Foursquare PAYG storage:** do not cache names/hours in `places` indefinitely. Only `fsq_place_id`, photo ids, and address ids may be stored long-term. Current `places` rows still store names; do not add more cache of licensed fields.

## Placeholders that still need writing

- Organizer survey (destination, dates, timezone, stake, team sizes): `ORGANIZER_QUESTIONS_PLACEHOLDER` in `lib/game/survey-questions.ts`. This is why trips need **manual SQL** (or `seed-profile.ts`) after bootstrap.
- `SETUP_COMPLETE` (and `GROUP_INTRO`, `SURVEY_DONE_DM`) in `lib/game/copy.ts` still literally say `PLACEHOLDER`.
- 5 of the intended 20-30 templates exist in `lib/game/templates.ts`. Boards look repetitive until the bank is filled.

## Conventions

- All user-facing strings live in `lib/game/copy.ts`, never inline. Conversation system prompt: `CONVERSATION_SYSTEM_PROMPT`. Help: `HELP_TEXT`.
- House style: lowercase, no exclamation marks, no emoji except existing status glyphs (`✅` `📸` `👍`), one message never two.
- **No em dashes** anywhere: code, comments, copy, this file.
- Claim/dispatch steps log `[japlan.claim] step` / `[japlan.dispatch] step` with `.before` / `.after`. Hang = last `.before` without `.after`.
- Photos: `photo_bonus_max` is a ceiling, not a requirement. Bare code awards `base_points`. A matching photo within `JAPLAN_PHOTO_BONUS_WINDOW_MS` (default 2h) adds bonus onto the existing claim (`claims.photo_claimed_at` blocks a second bonus). Daily cap 120 still applies to the bonus.
- Addressed fallthrough (no code, no claim match) goes to the conversation tool loop (`lib/handlers/conversation.ts`), not silence. Help (`japlan help`, `japlan ?`, etc.) is an addressing intent and never a freeform claim.
- `lib/game` must stay network-free. Handlers own I/O.

## How to run and test

Env: `.env.example` / Vercel project env. Solo flag: `JAPLAN_SOLO_MODE=true` (also `1` / `yes`). Group behaviour must not change when the flag is false.

Solo DM loop (does not exist unless the flag is on):

1. DM `japlan solo` -> creates `trips.is_solo` row, starts survey.
2. `japlan skipsurvey` -> default answers, activates.
3. `npx tsx scripts/seed-profile.ts` -> Tokyo profile + `start_date` today JST. Set `TRIP_ID` if more than one solo trip.
4. Trigger the board:
   `curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/daily-board?force=1&trip_id=<uuid>"`
5. Claim by sending a code (`A1`). Photo is optional bonus.
6. Wipe board, keep profile: `TRIP_ID=<uuid> npx tsx scripts/reset-trip.ts`

`japlan resurvey` is **not implemented**. To re-run the survey, set `participants.survey_state` / `survey_json` in SQL.

Hand-written day-1 board: `npx tsx scripts/seed-tasks.ts`.

Local: `npm test` (vitest). Capture inspector: `npx tsx scripts/inspect-captures.ts`. Claim-query probe: `npx tsx scripts/probe-claim-queries.ts`.

Logs: `vercel logs --follow` drops lines under concurrency. **Vercel dashboard logs are the source of truth.** Prefixes: `[japlan.webhook]`, `[japlan.dispatch]`, `[japlan.claim]`, `[japlan.solo]`, `[japlan.conversation]`.
