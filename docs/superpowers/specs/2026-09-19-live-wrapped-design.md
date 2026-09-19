# Live Japlan Wrapped design

## Goal

Replace the fictional `/wrapped` demo with a public, per-completed-trip recap
at `/wrapped/[tripId]`. The recap uses the trip's actual standings, quests,
places, and claim photos. Anyone with the link may view participant names,
scores, and selected claim photos.

## Route and access

The recap is server-rendered from the existing service-role Supabase client.
It accepts only a completed trip UUID; missing, malformed, or non-completed
trips return `notFound`. The UUID link is shared in the final group message.
No browser Supabase credentials or direct database access are introduced.

## Wrapped data

The server loads the trip, participants, itinerary places, tasks, and awarded
claims. It converts them into the existing slide model rather than changing
the experience's visual structure:

- trip name, destination, and date range drive the intro and finale;
- participants create final standings and personal slides;
- awarded claims create completion counts and featured quests;
- itinerary rows create the places statistic and list;
- claim photos supply the hero, quest wall, personal slides, gallery, and
  finale.

Fallback copy is used for optional trip fields. A no-photo trip remains a
fully usable text-and-stats recap and never uses stock images.

## Photo selection

An eligible photo is an awarded claim with `photo_claimed_at` plus either a
durable stored photo or its original evidence URL. Selection is deterministic:

1. Each participant gets their strongest eligible photo, prioritising photo
   bonus, awarded points, and then a stable task/title tie-breaker.
2. The quest wall selects the strongest remaining photos, preferring distinct
   participants and trip days.
3. The gallery includes the remaining eligible photos up to the template's
   display limit, again preferring diversity.
4. The strongest overall photo supplies the hero/finale when needed.

Task titles provide photo captions. Photos are not arbitrarily duplicated to
fill layouts and another participant's photo is never presented as someone
else's.

## Durable claim photos

A `claim-photos` private Supabase Storage bucket stores photo bytes under
`<trip-id>/<claim-id>.<extension>`. Add nullable `claims.storage_path` to
record each object. The claim pipeline uploads the same bytes it already
downloads for hashing and vision processing; it preserves `evidence_url` as
the original Linq source and `image_hash` for duplicate detection.

The Wrapped server generates temporary signed URLs for selected stored photos.
The bucket stays private. If upload fails, game scoring and claim completion
still succeed; Wrapped uses the original Linq URL when possible, otherwise
omits the image.

Existing claim rows are not backfilled for launch. Their existing evidence
URLs remain the fallback.

## Completion and failure behaviour

`wrappedUrlFor` creates the absolute public link from the configured app
origin and the completed trip ID. The final standings message includes it.
Image failures, an unavailable original URL, and missing optional data do not
break the page. They remove only the affected image/layout element.

## Verification

Tests cover data aggregation, deterministic and diverse image selection,
no-photo recaps, completed-trip gating, signed stored-image URLs, storage
upload failure without claim failure, and final-message URL generation. A
manual check verifies desktop and mobile rendering of a real completed-trip
recap.
