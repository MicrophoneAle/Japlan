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
- **Foursquare is never called from the webhook path.** Batch at trip creation, or not at all. One narrow exception: the organizer setup resolves the destination answer with one `near` search (`resolveNearArea`, 6s timeout), which is trip creation.
- **No new external APIs.** Gemini, Supabase, Browserbase, Vercel, Foursquare. (Weather in `lib/game/weather.ts` predates this rule and still calls Open-Meteo.)

Validation after generation (code, not prompt): booking, over lowest budget ceiling, diet/allergy/mobility conflict, unsafe/illegal/permanent, duplicate completed, cannot finish before expiry.

## Payload facts (verified against `.captures`)

Do not re-guess these.

- `participant.added` and `chat.created` **never fire** when the bot is added to an iMessage group. Bootstrap is first human `message.received` with `chat.is_group === true` (`lib/handlers/bootstrap.ts`). Ignore `is_me` and outbound.
- Chat id is **both** `data.chat.id` and `data.chat_id`. `chatIdFromData` checks both.
- Sender is `data.sender_handle.handle` (E.164). The object has `is_me`. `is_me` events are ignored. Display name is on the handle object, not the phone string; survey `first_name` can replace it.
- Media is `data.parts[]`, `type=media`, fetchable `url`, `mime` / `mime_type`. **Unverified:** `.captures` holds no media part yet. `[japlan.dispatch] step photo.detect` logs every non-text part's keys; confirm against the first real photo. The declared mime is not trusted (`photoPartsFrom` drops only clear non-images); bytes are sniffed after fetch. iMessage photos are usually HEIC, which prebuilt `sharp` cannot decode: `imageFingerprint` falls back to an exact `sha256:` hash and EXIF is read from the raw bytes.
- Foursquare venue id is **`fsq_place_id`**, not `fsq_id`. Drop results that only have the legacy field.
- **Gemini: `gemini-3.5-flash-lite` rejects `thinkingBudget: 0`** with a bare 400 INVALID_ARGUMENT (verified 2026-09-19). Callers still pass `thinkingBudget: 0`; `thinkingConfigFor` in `lib/llm/gemini.ts` maps it to `thinkingLevel: minimal`, and a rejected thinking config is retried once without it. Never build a thinking config by hand.
- **Gemini tool calls carry a `thoughtSignature`** that must be replayed with the call in the next turn, or the request 400s ("missing a thought_signature"). `completeTurn` reads calls from the raw parts to keep it; the conversation loop echoes calls exactly as made. `gemini-3.5-flash-lite` also ignores `functionCallingConfig: NONE`, so a forced text reply replays tool history as plain text with no tools declared (`flattenToolHistory`).
- Prefer a deterministic parser before a model: dates go through `parseLooseDates` and destinations through `lookupCityTimezone` first; Gemini is only the fallback, and every path is logged `[japlan.setup] step`.
- Task codes: `[A-Za-z]\d{1,2}` as a standalone token (`findTaskCode` in `lib/game/addressing.ts`). Strict: the whole message, or anywhere with the keyword. Loose: a token in a message of 6 words or fewer with no keyword; loose is tentative and stays silent unless it resolves to the sender's own task. Codes repeat per owner (everyone's personal board is A1-A3), unique on `(trip_id, day, participant_id, team_id, code)`; resolve with `findTaskByCodeFor`. Wake keyword: `japlan` (`JAPLAN_WAKE_KEYWORD`), case-insensitive, word boundary.

## Known open problems

These are current, not intended.

- **Second Supabase call in an isolate hangs; the first succeeds.** Suspected client-per-request / PostgREST. `getServiceClient()` is a module singleton, still hangs. Nested embeds (`claims` with `tasks!inner`) were a suspect. Every DB call needs a **timeout**; a hang must not look like silence. `claimAwait` / `dispatchAwait` log `.before` then `.after`; the last `.before` with no `.after` is the hang. `claimAwait` yields once after `.before` so the log can flush.
- Use `.maybeSingle()`, never `.single()` (PGRST116 on 0 or 2 rows). Participant uniqueness is `(trip_id, phone)`. Same phone on two trips: always query with `trip_id`.
- **`reaction.added` has never been seen in a capture.** Peer confirmation is implemented and untested against live Linq.
- **Foursquare is out of credits.** Destination profile is hand-seeded: `npx tsx scripts/seed-profile.ts` writes `TOKYO_HAND_PROFILE` from `lib/game/tokyo-profile.ts`. Setup destinations will not resolve until credits return: the raw string is stored and Gemini's timezone (validated) is still used. A destination changed via `japlan setup` stores a `partial` profile; boards generate from it until Foursquare answers.
- **Organizer is a proxy.** Linq never reports who added the bot, so `trips.organizer_participant_id` is whoever sent the first group message (or ran `japlan new trip`). Legacy trips with no organizer: the first participant to run `japlan setup` / `japlan end trip` takes the role.
- **RLS is off** on every public table. Service role only. Do not expose that key.
- **Vercel cron is daily** (`vercel.json` `0 23 * * *`; Hobby blocks more). A board is due when local time is at or after `trips.board_time` (default 08:00) inside `start_date..end_date` (`boardDueNow`), so any tick after board_time posts a missing board. With only the daily tick, most zones get their board late or next tick; `lib/db/migrations/2026-09-22-optional-hourly-board-tick.sql` adds an hourly Supabase pg_cron tick. On-demand boards cover the gap either way.
- **Boards on demand, any day of the trip.** "japlan plans / tomorrow / day 3 / friday / oct 19 / the last day" (`isBoardRequest`, `parseBoardDay`) runs `answerBoardRequest` (`lib/handlers/board-request.ts`): lists the day's open tasks, or builds the board now through `buildBoardForDate`, the one pipeline the cron also uses. Every day is requestable once setup is done; before the trip starts, "plans" means day 1. `boards` (one row per trip-day, inserted before generating: the lock) tracks provisional and delivery; a request that finds the day generating waits for it. `board_requests` is a log (`kind` generate/refill, migration `2026-09-23-board-request-rate-limit.sql`); the only limit is `REFILLS_PER_DAY` (5) refills of the same day per person. Different days are never limited. Future days are provisional and regenerate on their morning unless something on them was claimed. Claimed tasks are never overwritten. A past day with no board stays empty (no retroactive tasks).
- **Generation covers whoever has answered** (`constraintsKnown`): someone mid-survey does not hold up anyone else's board. They get "finish your survey" for their own request, then a top-up on that day once done (`deliverExistingBoard`, late-joiner path in `answerBoardRequest`).
- **Stop refusing.** A decline is kept only when doing the thing would be wrong (someone else's task, double award, a day outside the trip, unknown allergies for the asker's own tasks, unsafe freeform). Removed on purpose, do not reintroduce: the conversation hourly cap, freeform once-per-day, one-generation-per-day, "trip hasn't started", "board being made, try later", "claim in the group" for DM claims (DM claims confirm in group and DM), "you're not on this trip" (someone new in the group chat is added and surveyed, `joinLateParticipant`). Day letters cycle past Z (`dayLetter`); `findTaskByCodeFor` prefers the latest day. Trips up to 90 days (longer is treated as a typo). Failures say "that's on me", not a refusal.
- **Foursquare PAYG storage:** do not cache names/hours in `places` indefinitely. Only `fsq_place_id`, photo ids, and address ids may be stored long-term. Current `places` rows still store names; do not add more cache of licensed fields.

## Placeholders that still need writing

- Organizer setup covers destination, dates, difficulty, stake (`lib/handlers/setup.ts`). PLAN's arrival/departure times and team sizes are not asked yet. Setup copy (`SETUP_QUESTIONS` in `copy.ts`) is draft wording.
- Wrapped is a fictional demo; `wrappedUrlFor` in `lib/handlers/trip-lifecycle.ts` returns null until a per-trip page exists.
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

Solo trips skip group-only survey questions (`GROUP_ONLY_QUESTIONS`: social graph, competitiveness) and the stake setup question, get no morning standings post, and fold "we're live" into the reply they are already getting (their DM is the trip chat).

Solo DM loop (does not exist unless the flag is on):

1. DM `japlan solo` -> creates `trips.is_solo` row, asks the organizer setup (you are the organizer), then the survey.
2. `japlan skipsurvey` -> default survey answers. A trip only activates once setup has a destination and dates, so answer those or run step 3.
3. `npx tsx scripts/seed-profile.ts` -> Tokyo profile, dates (today JST + 4 days), `setup_state=done`, activates if surveys are done. Set `TRIP_ID` if more than one solo trip.
4. Trigger the board:
   `curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/daily-board?force=1&trip_id=<uuid>"`
5. Claim by sending a code (`A1`). Photo is optional bonus.
6. Wipe board, keep profile: `TRIP_ID=<uuid> npx tsx scripts/reset-trip.ts`. Delete the trip and everything under it: add `--hard` (needs the cascade migration).

Trip lifecycle (organizer only, keyword required): `japlan board time 7am` (sets `trips.board_time`), `japlan setup` (re-run setup mid-trip), `japlan end trip` then `japlan end trip confirm` (state `complete`, final standings + stake), `japlan new trip` (only when no open trip; bootstraps the same chat again). One open trip per chat: `getTripByChatId` returns the newest non-complete trip.

Migrations live in `lib/db/migrations/`, run in filename order in the Supabase SQL editor. `lib/db/checks/one-open-trip-per-chat.sql` verifies the partial index and cascades inside a rolled-back transaction.

`japlan resurvey` is **not implemented**. To re-run the survey, set `participants.survey_state` / `survey_json` in SQL.

Hand-written day-1 board: `npx tsx scripts/seed-tasks.ts`.

Local: `npm test` (vitest). End-to-end handler tests run against `lib/test/fake-supabase.ts`, which enforces the schema's unique constraints. Capture inspector: `npx tsx scripts/inspect-captures.ts`. Claim-query probe: `npx tsx scripts/probe-claim-queries.ts`.

Logs: `vercel logs --follow` drops lines under concurrency. **Vercel dashboard logs are the source of truth.** Prefixes: `[japlan.webhook]`, `[japlan.dispatch]`, `[japlan.claim]`, `[japlan.solo]`, `[japlan.conversation]`.
