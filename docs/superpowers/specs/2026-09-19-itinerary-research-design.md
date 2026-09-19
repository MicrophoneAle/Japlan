# Itinerary research and draft generation design

## Scope

Add a development-only itinerary workflow at `/itinerary` to the existing
Next.js application. It is explicitly separate from the starter home page and
the existing Linq webhook flow. The route generates a *draft*, never a
validated, booked, routed, or final itinerary.

## Configuration boundary

`lib/itinerary/config.ts` holds the Toronto development fixture: destination,
inclusive local dates, group size, qualitative budget, dietary/allergy, and
mobility preferences. A development-only trip identity guard prevents this
fixture from being associated with arbitrary persisted trips. Services accept a
normalized configuration, allowing a real trip-preferences adapter later.

## Research and generation boundary

`BrowserResearchService` runs bounded Stagehand research in a Browserbase
session and returns validated activity candidates, visited URLs, action/error
logs, and session metadata. It only navigates and extracts; it never submits
forms, reserves, purchases, or uses payment details.

Real mode requires `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, Gemini
credentials, and an explicitly non-mock environment. Missing/failed real
research is an error. Mock mode is entered only when
`ITINERARY_RESEARCH_MODE=mock` and is rejected when `NODE_ENV=production`.

`ItineraryGenerationService` receives only validated candidates and passes
their IDs plus constraints to Gemini. Its strict schema and post-validation
require selected IDs to exist in research, inherit factual candidate metadata,
cover every inclusive local trip date, avoid duplicate activities and overlaps,
and surface unsupported constraints as gaps. Limited corrective retries handle
invalid model output.

## Persistence

The existing `places` and `itinerary` tables store selected stops. A minimal
migration adds draft/source metadata necessary for the selected place records
and adds an itinerary-generation snapshot table for research candidates, logs,
visited pages, model selections, generation state, and Browserbase session
metadata. A transaction-like replacement policy writes a new complete draft
only after research and generation validate; a failed request leaves an
existing draft untouched. Regeneration replaces prior generated draft stops,
not user-authored records.

## Interface and inspection

`/itinerary` provides a dark, Japlan-aligned generator UI: real lifecycle
states, an explicitly marked draft result grouped by day, and a development-only
Research Inspector. The inspector displays actual stored status, URLs, actions,
errors, candidate fields/sources, selected/excluded candidates, and a
Browserbase dashboard link when a session ID exists. Polling observes persisted
status rather than inventing progress. Reduced-motion mode preserves content.

## Testing

Unit tests mock Browserbase/Stagehand, Gemini, and persistence. They cover
inclusive dates, fixture isolation, source-bearing candidate validation,
constraint propagation, invalid/candidate-inventing model output, replacement
safety, mock-mode production rejection, and cleanup paths. Live research is
optional and never runs in automated tests.
