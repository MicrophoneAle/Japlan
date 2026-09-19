@AGENTS.md

# Japlan binding constraints

Authoritative spec: `docs/PLAN.md`. Do not invent behaviour that contradicts it. If something is underspecified, add a TODO and ask rather than guessing.

## Never block the webhook

`/api/linq/webhook` verifies the signature against the **raw body**, persists the event for idempotency, returns **200 immediately**, then dispatches. Never await LLM calls, Browserbase sessions, Foursquare, or other slow work before returning. Linq retries on timeout; blocking awards points twice.

## LLM proposes axes, code computes points

Task generation returns the six axes, never a point value. Points are computed only in `lib/game/scoring.ts`. Never let the model output points directly.

## DM stays in DM

Everything collected in a DM (budget, dietary, social graph, survey answers) stays in DM. Never surface one person's private answers in the group chat. Enforce this at the prompt level and with a deliberate test.

## Individuals are the scoring unit

Standings are per participant. Teams are time-bounded, not a score holder. When a team task completes, **every member receives the full point value**, never a split.

## Silent unless addressed

The bot stays quiet unless the message contains the wake keyword (`japlan`, case-insensitive, from `JAPLAN_WAKE_KEYWORD`), is a DM to the bot, contains a task code, or arrives inside an open task context the bot is already tracking. Everything else is ignored, including photos with no plausible claim match.

## Validation rejects

After task generation, reject in code (not in the prompt) any task that:

- Requires a booking or reservation
- Costs more than the lowest budget ceiling on that team
- Conflicts with a dietary, allergy, or mobility constraint of anyone on that team
- Is unsafe, illegal, or involves anything permanent
- Duplicates a completed task
- Cannot be done in the time window before it expires
