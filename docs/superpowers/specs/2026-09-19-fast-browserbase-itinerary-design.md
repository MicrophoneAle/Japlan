# Fast Browserbase itinerary design

## Goal

Replace the normal itinerary research path with a source-enriched workflow
that normally completes within 75 seconds while retaining Browserbase in every
real generation. Keep the existing Stagehand workflow as an explicit deep
research mode only.

## Normal workflow

1. Run parallel Foursquare searches for attractions, neighborhoods/markets,
   outdoor venues, experiences, and vegetarian dining.
2. Use Browserbase Search to find two authoritative pages that fill the most
   important gaps: one schedule/accessibility source and one dining source.
3. Fetch those pages concurrently through Browserbase Fetch. No remote browser
   session or Stagehand extension is created in this path.
4. Use Gemini Flash-Lite to extract source-backed factual fields from the
   fetched markdown in parallel.
5. Merge, de-duplicate, balance, and constraint-filter Foursquare and fetched
   candidates, then use Gemini 3.6 Flash once to create the detailed draft.

## Latency budget

The controller has a 65-second internal deadline. Foursquare discovery and
Browserbase search/fetch run concurrently where possible; Flash-Lite extraction
is parallel per page. Gemini 3.6 Flash receives one bounded candidate list for
final scheduling. If Browserbase enrichment fails or times out, the draft may
still use Foursquare candidates, but affected factual fields are explicitly
unverified; it never claims the enrichment succeeded.

## Deep research

`ITINERARY_RESEARCH_STRATEGY=deep` retains the serial Stagehand implementation
for intentional slower investigations. `fast` is the development default and
is the only strategy used by the normal Generate button.

## Verification

Unit tests mock all external calls and cover concurrent discovery, enrichment
fallback, candidate source provenance, timeout behavior, and strategy routing.
The development inspector labels Foursquare and Browserbase sources separately.
